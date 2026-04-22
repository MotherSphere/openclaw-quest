"""Native Phase 2 quest cycle runner for OpenClaw Quest.

Runs REFLECT -> PLAN -> EXECUTE -> REPORT as a detached process that appends
Quest events to ~/.openclaw/quest/events.jsonl. The FastAPI watcher picks up the
new events and forwards progress to the dashboard.

REFLECT and REPORT call the OpenClaw agent (`openclaw agent`) for a real LLM
summary; PLAN and EXECUTE stay deterministic (target choice is driven by the
feedback-digest heuristics, execution is structural). If the LLM call fails or
times out, the runner falls back to a templated summary so the cycle always
completes.
"""

from __future__ import annotations

import json
import logging
import os
import subprocess
import sys
import time
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from config import (
    AGENT_RUNTIME_BIN,
    EVENTS_FILE,
    FEEDBACK_DIGEST_FILE,
    GAME_BALANCE,
    MAP_FILE,
    QUESTS_V2_FILE,
    STATE_FILE,
    CYCLE_LOCK_FILE,
)


logger = logging.getLogger(__name__)

QUEST_DIR = EVENTS_FILE.parent

LLM_AGENT_ID = os.environ.get("QUEST_CYCLE_AGENT_ID", "main")
LLM_TIMEOUT_S = int(os.environ.get("QUEST_CYCLE_LLM_TIMEOUT", "90"))
LLM_THINKING = os.environ.get("QUEST_CYCLE_THINKING", "minimal")


def _call_openclaw_agent(prompt: str) -> str | None:
    """Run a single `openclaw agent` turn and return the visible text.

    Returns None on any failure (binary missing, timeout, non-zero exit, JSON
    parse error). Callers MUST have a deterministic fallback.
    """
    if not AGENT_RUNTIME_BIN.exists():
        return None
    cmd = [
        str(AGENT_RUNTIME_BIN),
        "agent",
        "--agent", LLM_AGENT_ID,
        "--thinking", LLM_THINKING,
        "--json",
        "-m", prompt,
    ]
    try:
        result = subprocess.run(
            cmd,
            capture_output=True,
            text=True,
            timeout=LLM_TIMEOUT_S,
        )
    except (subprocess.TimeoutExpired, OSError) as exc:
        logger.warning("openclaw agent call failed: %s", exc)
        return None
    if result.returncode != 0:
        logger.warning("openclaw agent returned %d: %s", result.returncode, result.stderr[:200])
        return None
    try:
        payload = json.loads(result.stdout)
    except json.JSONDecodeError:
        logger.warning("openclaw agent produced non-JSON output")
        return None
    # Shape: {"data": {..., "finalAssistantVisibleText": "..."}} — be defensive,
    # the exact nesting has shifted across openclaw versions.
    def _dig(obj: Any, key: str) -> str | None:
        if isinstance(obj, dict):
            if key in obj and isinstance(obj[key], str):
                return obj[key]
            for v in obj.values():
                found = _dig(v, key)
                if found:
                    return found
        return None
    text = _dig(payload, "finalAssistantVisibleText") or _dig(payload, "finalAssistantRawText")
    if not text:
        return None
    return text.strip() or None


@dataclass
class CyclePlan:
    workflow_id: str | None
    workflow_name: str | None
    target_skill: str | None
    quest_id: str | None
    quest_title: str | None
    reason: str
    avoided_skills: list[str]
    prioritized_skills: list[str]
    feedback_items: int


class QuestCycleRunner:
    def __init__(self, trigger: str = "manual"):
        self.trigger = trigger
        self.started_at = time.time()
        self.started_iso = self._now_iso()
        self.state = self._read_json(STATE_FILE, {})
        self.map_data = self._read_json(MAP_FILE, {})
        self.quests = self._read_json(QUESTS_V2_FILE, [])
        self.digest = self._read_json(FEEDBACK_DIGEST_FILE, {
            "summary": {"total_positive": 0, "total_negative": 0, "net_sentiment": 0.0},
            "recent_feedback": [],
            "skill_sentiment": {},
            "workflow_sentiment": {},
            "user_corrections": [],
        })
        self.plan: CyclePlan | None = None
        self.completed_quest: dict[str, Any] | None = None
        self.skills_gained: list[str] = []
        self.outcomes: list[str] = []
        self._reflect_summary_text: str | None = None

    def run(self) -> int:
        try:
            self._write_event("cycle_start", {"trigger": self.trigger, "started_at": self.started_iso})
            self.plan = self._reflect_and_plan()
            self._execute()
            self._report("success")
            return 0
        except Exception as exc:  # pragma: no cover - defensive safety path
            self.outcomes.append(f"Cycle failed: {exc}")
            self._write_event(
                "cycle_phase",
                {
                    "phase": "report",
                    "outcomes": self.outcomes or [f"Cycle failed: {exc}"],
                    "skills_gained": self.skills_gained,
                    "quest_completed": self.completed_quest["title"] if self.completed_quest else None,
                    "status": "error",
                },
            )
            self._write_event(
                "cycle_end",
                {
                    "status": "error",
                    "duration_seconds": round(time.time() - self.started_at, 2),
                    "skills_gained": self.skills_gained,
                    "error": str(exc),
                },
            )
            return 1
        finally:
            self._clear_lock()

    def _reflect_and_plan(self) -> CyclePlan:
        workflows = self.map_data.get("workflows", []) if isinstance(self.map_data, dict) else []
        skill_sentiment = self.digest.get("skill_sentiment", {}) if isinstance(self.digest, dict) else {}
        workflow_sentiment = self.digest.get("workflow_sentiment", {}) if isinstance(self.digest, dict) else {}
        recent_feedback = self.digest.get("recent_feedback", []) if isinstance(self.digest, dict) else []
        corrections = self.digest.get("user_corrections", []) if isinstance(self.digest, dict) else []

        avoided_skills = sorted(
            skill for skill, sentiment in skill_sentiment.items()
            if isinstance(sentiment, dict) and sentiment.get("down", 0) > sentiment.get("up", 0) * 2
        )
        prioritized_skills = sorted(
            skill for skill, sentiment in skill_sentiment.items()
            if isinstance(sentiment, dict) and sentiment.get("up", 0) > max(1, sentiment.get("down", 0))
        )
        avoided_workflows = {
            name for name, sentiment in workflow_sentiment.items()
            if isinstance(sentiment, dict) and sentiment.get("down", 0) > sentiment.get("up", 0) * 2
        }
        prioritized_workflows = {
            name for name, sentiment in workflow_sentiment.items()
            if isinstance(sentiment, dict) and sentiment.get("up", 0) > 3 and sentiment.get("down", 0) == 0
        }

        # Heuristic from quest-skill: repeated recent feedback can escalate avoidance.
        # recent_feedback is stored newest-first by update_feedback_digest; look
        # at the 3 most recent items, not the oldest.
        if len(recent_feedback) >= 3:
            latest_three = recent_feedback[:3]
            same_skill = {item.get("skill") for item in latest_three if item.get("skill")}
            if len(same_skill) == 1:
                avoided_skills.extend(list(same_skill))

        feedback_items = len(recent_feedback)
        morale = int(self.state.get("mp", self.state.get("energy", 50)) or 50)

        candidate = None
        best_score = None
        for workflow in workflows:
            wf_name = workflow.get("name")
            if not wf_name or wf_name in avoided_workflows:
                continue
            score = float(workflow.get("mastery", 0.0) or 0.0)
            if wf_name in prioritized_workflows:
                score -= 0.35
            sub_nodes = workflow.get("sub_nodes") or []
            prioritized_node = None
            fallback_node = None
            for node in sub_nodes:
                skill_name = node.get("name")
                if not skill_name or skill_name in avoided_skills:
                    continue
                if skill_name in prioritized_skills:
                    prioritized_node = node
                    score -= 0.2
                    break
                if fallback_node is None:
                    fallback_node = node
            node = prioritized_node or fallback_node
            if morale < 30:
                score += 0.2
            if best_score is None or score < best_score:
                candidate = (workflow, node)
                best_score = score

        workflow = candidate[0] if candidate else (workflows[0] if workflows else {})
        node = candidate[1] if candidate else None
        workflow_id = workflow.get("id") if isinstance(workflow, dict) else None
        workflow_name = workflow.get("name") if isinstance(workflow, dict) else None
        target_skill = node.get("name") if isinstance(node, dict) else None

        active_quests = [
            q for q in self.quests
            if isinstance(q, dict) and q.get("status") in ("active", "in_progress", "pending")
        ]
        target_quest = None
        if workflow_id:
            target_quest = next((q for q in active_quests if q.get("workflow_id") == workflow_id), None)
        if target_quest is None and active_quests:
            target_quest = active_quests[0]

        reasons = []
        if corrections:
            reasons.append(f"follow user corrections first ({len(corrections)})")
        if target_skill and target_skill in prioritized_skills:
            reasons.append(f"prioritize skill {target_skill} from positive feedback")
        if workflow_name in prioritized_workflows:
            reasons.append(f"workflow {workflow_name} has strong positive sentiment")
        if avoided_skills:
            reasons.append(f"avoid skills: {', '.join(sorted(set(avoided_skills))[:4])}")
        if morale < 30:
            reasons.append("low morale, choose a safer target")
        if not reasons:
            reasons.append("focus on the weakest currently available workflow")

        deterministic_summary = "; ".join(
            part for part in [
                f"Morale at {morale}",
                f"avoiding skills {', '.join(sorted(set(avoided_skills))[:4])}" if avoided_skills else "no blocked skills",
                f"prioritizing {', '.join(prioritized_skills[:4])}" if prioritized_skills else "no strongly preferred skills",
                f"workflow target {workflow_name or 'unknown'}",
            ] if part
        )

        reflect_summary = self._llm_reflect(
            morale=morale,
            workflow_name=workflow_name,
            target_skill=target_skill,
            avoided_skills=sorted(set(avoided_skills)),
            prioritized_skills=prioritized_skills,
            recent_feedback=recent_feedback,
            corrections=corrections,
        ) or deterministic_summary
        llm_used = reflect_summary != deterministic_summary

        self._reflect_summary_text = reflect_summary  # stored for REPORT context

        # feedback_influenced: the reflect was produced by an LLM call that
        # saw at least one feedback entry in its prompt. AdventureLog.tsx
        # already looks for this flag to mark influenced cycles with a purple
        # side-bar.
        feedback_influenced = llm_used and feedback_items > 0
        self._write_event(
            "reflect",
            {
                "chosen_training_target": target_skill or workflow_name or "unknown",
                "weaknesses": [workflow_name] if workflow_name else [],
                "summary": reflect_summary,
                "feedback_items": feedback_items,
                "llm": llm_used,
                "feedback_influenced": feedback_influenced,
            },
        )
        self._write_event(
            "cycle_phase",
            {
                "phase": "reflect",
                "summary": reflect_summary,
                "feedback_items": feedback_items,
            },
        )

        plan_reason = "; ".join(reasons)
        self._write_event(
            "cycle_phase",
            {
                "phase": "plan",
                "target_workflow": workflow_name,
                "target_quest": target_quest.get("title") if target_quest else None,
                "reason": plan_reason,
            },
        )
        self._write_event(
            "train_start",
            {
                "target": target_skill or workflow_name or "unknown",
                "skill_name": target_skill,
                "plan": plan_reason,
                "workflow_id": workflow_id,
                "workflow": workflow_name,
            },
        )

        return CyclePlan(
            workflow_id=workflow_id,
            workflow_name=workflow_name,
            target_skill=target_skill,
            quest_id=target_quest.get("id") if target_quest else None,
            quest_title=target_quest.get("title") if target_quest else None,
            reason=plan_reason,
            avoided_skills=sorted(set(avoided_skills)),
            prioritized_skills=prioritized_skills,
            feedback_items=feedback_items,
        )

    def _execute(self) -> None:
        assert self.plan is not None
        steps = [
            (0.2, f"Surveying {self.plan.workflow_name or 'current workflow'} for the next move"),
            (0.55, f"Practicing {self.plan.target_skill or self.plan.workflow_name or 'core skill'}"),
            (0.9, "Consolidating results for report"),
        ]
        for progress, detail in steps:
            self._write_event("cycle_phase", {"phase": "execute", "progress": progress, "detail": detail})
            time.sleep(0.15)

        self._award_training_skill()
        self._complete_target_quest()
        self._update_state()

    def _award_training_skill(self) -> None:
        if not self.plan or not self.plan.target_skill:
            return
        skill_name = self.plan.target_skill
        self.skills_gained.append(skill_name)
        self.outcomes.append(f"Improved {skill_name}")
        self._write_event(
            "skill_drop",
            {
                "skill": skill_name,
                "skill_name": skill_name,
                "rarity": "common",
                "category": self.plan.workflow_name,
            },
        )
        self._write_event(
            "xp_gain",
            {
                "amount": 25,
                "reason": f"Training progress in {skill_name}",
            },
        )

    def _complete_target_quest(self) -> None:
        if not self.plan or not self.plan.quest_id:
            return
        updated = False
        reward_xp = GAME_BALANCE["default_reward_xp"]
        reward_gold = GAME_BALANCE["default_reward_gold"]
        for quest in self.quests:
            if quest.get("id") != self.plan.quest_id:
                continue
            if quest.get("status") not in ("active", "in_progress", "pending"):
                return
            quest["status"] = "completed"
            quest["completed_at"] = self._now_iso()
            reward_xp = int(quest.get("reward_xp", reward_xp) or reward_xp)
            reward_gold = int(quest.get("reward_gold", reward_gold) or reward_gold)
            self.completed_quest = quest
            updated = True
            break
        if not updated:
            return
        self._write_json(QUESTS_V2_FILE, self.quests)
        self.outcomes.append(f"Completed quest {self.completed_quest.get('title')}")
        self._write_event(
            "quest_complete",
            {
                "quest_id": self.plan.quest_id,
                "title": self.completed_quest.get("title"),
                "reward_xp": reward_xp,
                "reward_gold": reward_gold,
            },
        )
        self.state["xp"] = int(self.state.get("xp", 0) or 0) + reward_xp
        self.state["gold"] = int(self.state.get("gold", 0) or 0) + reward_gold

    def _update_state(self) -> None:
        # Baseline fields that the rest of the app (feedback endpoint, UI,
        # level-up math) reads without defensive .get() everywhere. Fill them
        # only if missing — a fresh state.json or one created by an older
        # cycle version would otherwise crash POST /api/feedback on
        # state["hp"] lookup.
        self.state.setdefault("name", "EVE")
        self.state.setdefault("level", 1)
        self.state.setdefault("class", "adventurer")
        self.state.setdefault("title", "Novice")
        self.state.setdefault("hp_max", GAME_BALANCE["hp_base"] + int(self.state.get("level", 1)) * GAME_BALANCE["hp_per_level"])
        self.state.setdefault("hp", int(self.state.get("hp_max", GAME_BALANCE["hp_base"])))
        self.state.setdefault("mp_max", GAME_BALANCE["mp_max"])
        self.state.setdefault("mp", 50)
        self.state.setdefault("xp", 0)
        self.state.setdefault("xp_to_next", max(100, int(self.state.get("level", 1) or 1) * GAME_BALANCE["xp_per_level"]))

        xp_bonus = 25 if self.skills_gained else 10
        self.state["xp"] = int(self.state.get("xp", 0) or 0) + xp_bonus
        self.state["total_cycles"] = int(self.state.get("total_cycles", 0) or 0) + 1
        self.state["last_cycle_at"] = self._now_iso()
        self.state["last_interaction_at"] = self._now_iso()
        self.state["mp"] = min(int(self.state.get("mp", 50) or 50) + 2, int(self.state.get("mp_max", GAME_BALANCE["mp_max"]) or GAME_BALANCE["mp_max"]))

        leveled_up = False
        while self.state["xp"] >= self.state["xp_to_next"]:
            self.state["xp"] -= self.state["xp_to_next"]
            self.state["level"] = int(self.state.get("level", 1) or 1) + 1
            self.state["xp_to_next"] = int(self.state["level"]) * GAME_BALANCE["xp_per_level"]
            self.state["hp_max"] = GAME_BALANCE["hp_base"] + int(self.state["level"]) * GAME_BALANCE["hp_per_level"]
            self.state["hp"] = self.state["hp_max"]
            leveled_up = True

        self._write_json(STATE_FILE, self.state)
        if leveled_up:
            self._write_event(
                "level_up",
                {"level": self.state.get("level"), "new_level": self.state.get("level"), "title": self.state.get("title", "Hero")},
            )

    def _report(self, status: str) -> None:
        quest_title = self.completed_quest.get("title") if self.completed_quest else None
        if quest_title and f"Completed quest {quest_title}" not in self.outcomes:
            self.outcomes.append(f"Completed quest {quest_title}")
        if not self.outcomes:
            self.outcomes.append("Maintained steady progress")

        llm_summary = self._llm_report(status=status, quest_title=quest_title)
        if llm_summary:
            # Prepend the LLM narrative so it shows first in the report panel;
            # keep the structural outcomes after it so nothing is lost.
            self.outcomes = [llm_summary] + self.outcomes

        self._write_event(
            "cycle_phase",
            {
                "phase": "report",
                "outcomes": self.outcomes,
                "skills_gained": self.skills_gained,
                "quest_completed": quest_title,
                "status": status,
                "llm": llm_summary is not None,
            },
        )
        self._write_event(
            "cycle_end",
            {
                "status": status,
                "duration_seconds": round(time.time() - self.started_at, 2),
                "skills_gained": self.skills_gained,
                "quest_completed": quest_title,
            },
        )

    def _llm_reflect(
        self,
        *,
        morale: int,
        workflow_name: str | None,
        target_skill: str | None,
        avoided_skills: list[str],
        prioritized_skills: list[str],
        recent_feedback: list[dict[str, Any]],
        corrections: list[dict[str, Any]],
    ) -> str | None:
        fb_lines = []
        # Digest entries are written by main.update_feedback_digest with shape:
        # {ts, event_type, event_summary, feedback: "up"|"down", quest_context, skill}
        for item in recent_feedback[:5]:  # already ordered newest-first by the writer
            if not isinstance(item, dict):
                continue
            verdict = item.get("feedback") or item.get("sentiment") or item.get("type") or "?"
            subject = item.get("skill") or item.get("workflow") or item.get("quest_context") or item.get("event_type") or "?"
            reason = (item.get("event_summary") or item.get("reason") or "").strip()
            fb_lines.append(f"- {verdict} on {subject}" + (f": {reason}" if reason else ""))
        # main.update_feedback_digest writes corrections as plain strings,
        # but tolerate the older dict shape just in case.
        corr_lines = []
        for item in corrections[-3:]:
            text = ""
            if isinstance(item, str):
                text = item.strip()
            elif isinstance(item, dict):
                text = (item.get("text") or item.get("reason") or item.get("detail") or "").strip()
            if text:
                corr_lines.append(f"- {text}")
        fb_block = "\n".join(fb_lines) if fb_lines else "(none)"
        corr_block = "\n".join(corr_lines) if corr_lines else "(none)"

        prompt = (
            "You are the reflection voice of an RPG-style self-evolving learning agent. "
            "Based on the state below, write ONE or TWO short sentences (max ~280 characters total) "
            "summarising the agent's current situation and the training direction it should take next. "
            "Be concrete, first-person is fine. No headings, no bullet points, no preamble.\n\n"
            f"Morale (MP): {morale}/100\n"
            f"Candidate target workflow: {workflow_name or 'unknown'}\n"
            f"Candidate target skill: {target_skill or 'none'}\n"
            f"Skills flagged by user as avoid: {', '.join(avoided_skills) or 'none'}\n"
            f"Skills preferred by user: {', '.join(prioritized_skills[:8]) or 'none'}\n"
            f"Recent feedback items:\n{fb_block}\n"
            f"User corrections:\n{corr_block}\n"
        )
        return _call_openclaw_agent(prompt)

    def _llm_report(self, *, status: str, quest_title: str | None) -> str | None:
        duration = round(time.time() - self.started_at, 2)
        skills = ", ".join(self.skills_gained) if self.skills_gained else "none"
        struct = "\n".join(f"- {o}" for o in self.outcomes) or "- (no structural outcomes)"
        reflect = self._reflect_summary_text or "(reflection unavailable)"

        prompt = (
            "You are the narrator of an RPG-style learning cycle. A cycle just finished. "
            "Write ONE short paragraph (max ~300 characters) summarising what happened — "
            "tone: lucid, grounded, light fantasy flavour ok but no purple prose. "
            "No headings, no bullet points.\n\n"
            f"Cycle status: {status}\n"
            f"Duration: {duration}s\n"
            f"Reflection at the start: {reflect}\n"
            f"Skills practiced: {skills}\n"
            f"Quest completed: {quest_title or 'none'}\n"
            f"Structural outcomes:\n{struct}\n"
        )
        return _call_openclaw_agent(prompt)

    def _write_event(self, event_type: str, data: dict[str, Any]) -> None:
        event = {
            "ts": self._now_iso(),
            "type": event_type,
            "region": None,
            "data": data,
        }
        EVENTS_FILE.parent.mkdir(parents=True, exist_ok=True)
        with open(EVENTS_FILE, "a", encoding="utf-8") as f:
            f.write(json.dumps(event) + "\n")

    def _read_json(self, path: Path, default: Any) -> Any:
        try:
            return json.loads(path.read_text(encoding="utf-8"))
        except Exception:
            return default

    def _write_json(self, path: Path, data: Any) -> None:
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps(data, indent=2), encoding="utf-8")

    def _clear_lock(self) -> None:
        try:
            CYCLE_LOCK_FILE.unlink(missing_ok=True)
        except OSError:
            pass

    def _now_iso(self) -> str:
        return datetime.now(timezone.utc).isoformat()


def main(argv: list[str] | None = None) -> int:
    argv = argv if argv is not None else sys.argv[1:]
    trigger = argv[0] if argv else os.environ.get("QUEST_CYCLE_TRIGGER", "manual")
    return QuestCycleRunner(trigger=trigger).run()


if __name__ == "__main__":
    raise SystemExit(main())
