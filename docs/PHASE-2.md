# Phase 2 — port the cycle agent to OpenClaw natively

## What Phase 1 shipped

- `/api/cycle/start` returns **501 Not Implemented** (preserved unreachable Hermes spawn below it as a diff target).
- Dashboard reads OpenClaw's live `~/.openclaw/tasks/runs.sqlite` read-only via `server/openclaw_bridge.py` and surfaces it in the **EVE** tab + TopBar pill.
- No writes to `~/.openclaw/` from the dashboard.

## Why this is EVE's work

This phase requires writing an OpenClaw-native flow / subagent / cron that implements the **REFLECT → PLAN → EXECUTE → REPORT** loop. EVE already knows OpenClaw's conventions (flows registry, subagent invocation, cron scheduling, skills frontmatter), uses the runtime daily, and can iterate in her own workspace. Claude wrote Phase 1 in Python/TypeScript as an external observer; Phase 2 runs *inside* the runtime, so it should be written by whoever speaks that runtime natively.

## Goal

Replace the 501 stub with a real invocation that makes a cycle run end-to-end: EVE (or a dedicated subagent) reads the same inputs `templates/quest-skill.md` describes, produces the four phases, writes events and a terminal report the dashboard can display.

## Success criteria

1. `POST /api/cycle/start` launches a cycle and returns 200 within ~1s (not 501).
2. While the cycle runs, `GET /api/cycle/status` streams meaningful phase info (`phase ∈ {reflect, plan, execute, report}`) that the existing `MapBottomInfo` panel already knows how to render.
3. Events land in `~/.openclaw/quest/events.jsonl` (new file, owned by Phase 2 work — Phase 1 never writes there) with shapes the existing formatters in `src/utils/formatters.ts` recognize (`cycle_start`, `reflect`, `train_start`, `cycle_end`, etc.).
4. The cycle reads `~/.openclaw/quest/feedback-digest.json` if it exists (created by the dashboard in Phase 3) and adjusts its PLAN accordingly, exactly as `templates/quest-skill.md` specifies.
5. The EVE tab keeps working (the cycle runs must NOT interfere with EVE's existing cron workload — ideally it runs as a dedicated subagent so its task_runs show up cleanly labeled in the tab).
6. Feature is gated behind an env var (`QUEST_CYCLE_ENABLED=1`) so a clone without the flow installed still starts.

## Constraints

- **Do not modify Phase 1 work.** The bridge (`server/openclaw_bridge.py`, endpoints `/api/openclaw/*`) and the EVE panel should remain untouched except for minor consumption of new data if useful.
- **Do not touch EVE's existing crons/flows/subagents.** Add new ones under a clear namespace (e.g. `quest/` prefix). Never mutate existing registry rows.
- **One branch, one PR.** Branch name: `phase-2-cycle-flow`. Squash-merge target.
- Keep the unreachable Hermes spawn block in `main.py` only if it's still useful as a reference; delete it if the new spawn is clearly different.

## Files to read first (in this order)

1. `docs/PHASE-2.md` — this file.
2. `templates/quest-skill.md` — the behavior contract of the cycle (ported from Hermes — OpenClaw may need a different on-disk format, but the *logic* is the same).
3. `server/main.py` lines 1155–1250 — the current 501 stub + the preserved Hermes spawn, labeled `Phase 1a` in comments.
4. `server/config.py` — `AGENT_RUNTIME_BIN`, `AGENT_RUNTIME_HOME`, `QUEST_CYCLE_PROMPT`, `CYCLE_LOCK_FILE`, `CYCLE_LOG_FILE`.
5. `src/utils/formatters.ts` — event-type → UI text mapping. Your events must use these type names.
6. `server/ws_manager.py` — broadcast channel the dashboard listens on. Emit via `manager.broadcast({"type": "event", "data": {...}})`.

## Suggested delivery shape (not prescriptive)

- A new subagent or flow under `~/.openclaw/…` that performs the cycle, labeled clearly so its `task_runs` rows are recognizable ("quest-cycle" or similar).
- A thin spawn in `server/main.py` that calls the OpenClaw runtime the way OpenClaw expects (CLI, gateway RPC, whatever is idiomatic — you know this better than Claude did).
- Optionally: a small `server/quest_cycle.py` module so `main.py` stays readable.

## Task prompt for EVE (paste into the task runner)

> Read `docs/PHASE-2.md` in `/home/mothersphere/Documents/Repositories/Openclaw-Quest/` and execute Phase 2 as described. Create a branch `phase-2-cycle-flow`, work in small commits, and open a PR when the four success criteria (cycle spawns, status streams phase info, events are emitted with the expected types, feedback-digest is read) are all met on a manual smoke test. Keep the diff scoped: no changes to Phase 1 files unless you explain why in the PR body. When you're unsure about OpenClaw conventions, prefer minimal invention — use existing subagent/cron patterns from the installed runtime rather than inventing new ones.
