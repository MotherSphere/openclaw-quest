"""Native Phase 2 quest cycle runner for OpenClaw Quest.

Runs REFLECT -> PLAN -> EXECUTE -> REPORT as a detached process that appends
Quest events to ~/.openclaw/quest/events.jsonl. The FastAPI watcher picks up the
new events and forwards progress to the dashboard.
"""

from __future__ import annotations

import json
import os
import sys
import time
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from config import (
    EVENTS_FILE,
    FEEDBACK_DIGEST_FILE,
    GAME_BALANCE,
    MAP_FILE,
    QUESTS_V2_FILE,
    STATE_FILE,
    CYCLE_LOCK_FILE,
)


QUEST_DIR = EVENTS_FILE.parent


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
        if len(recent_feedback) >= 3:
            last_three = recent_feedback[-3:]
            same_skill = {item.get("skill") for item in last_three if item.get("skill")}
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

        reflect_summary = "; ".join(
            part for part in [
                f"Morale at {morale}",
                f"avoiding skills {', '.join(sorted(set(avoided_skills))[:4])}" if avoided_skills else "no blocked skills",
                f"prioritizing {', '.join(prioritized_skills[:4])}" if prioritized_skills else "no strongly preferred skills",
                f"workflow target {workflow_name or 'unknown'}",
            ] if part
        )
        self._write_event(
            "reflect",
            {
                "chosen_training_target": target_skill or workflow_name or "unknown",
                "weaknesses": [workflow_name] if workflow_name else [],
                "summary": reflect_summary,
                "feedback_items": feedback_items,
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
        xp_bonus = 25 if self.skills_gained else 10
        self.state["xp"] = int(self.state.get("xp", 0) or 0) + xp_bonus
        self.state["total_cycles"] = int(self.state.get("total_cycles", 0) or 0) + 1
        self.state["last_cycle_at"] = self._now_iso()
        self.state["last_interaction_at"] = self._now_iso()
        self.state.setdefault("xp_to_next", max(100, int(self.state.get("level", 1) or 1) * GAME_BALANCE["xp_per_level"]))
        self.state.setdefault("mp_max", GAME_BALANCE["mp_max"])
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
        self._write_event(
            "cycle_phase",
            {
                "phase": "report",
                "outcomes": self.outcomes,
                "skills_gained": self.skills_gained,
                "quest_completed": quest_title,
                "status": status,
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
