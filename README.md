# OpenClaw-Quest

An RPG-style observability dashboard for [OpenClaw](https://github.com/openclaw/openclaw) and its agents. Turn your agent's cron runs, flows, tasks, skills and logs into a guided, observable adventure with real LLM narration and a feedback loop that actually steers the next cycle.

Zero writes to `~/.openclaw/` from the dashboard itself — it reads what the agent produces, and when the cycle runs it's your own OpenClaw agent reasoning, not a simulation.

---

## Credits — Built on Hermes Quest

Fork of **[Hermes Quest](https://github.com/nemoaigc/hermes-quest)** by [@nemoaigc](https://github.com/nemoaigc), licensed MIT. Every architectural idea here — the 4-phase REFLECT → PLAN → EXECUTE → REPORT cycle, `feedback-digest.json`, the fog-of-war domain map, the LLM-powered tavern NPCs — comes from Nemo's original design. Go star and support the upstream: https://github.com/nemoaigc/hermes-quest

The unmodified original README is preserved as [`UPSTREAM_README.md`](./UPSTREAM_README.md).

---

## What it does

- **Observes**: reads `~/.openclaw/tasks/runs.sqlite` and `~/.openclaw/openclaw.json` read-only. The EVE tab shows your agent's live task runs with status / runtime / "ago" columns; the TopBar pill tracks total tasks and failures.
- **Runs cycles**: a manual "CYCLE" button spawns an LLM-driven REFLECT → PLAN → EXECUTE → REPORT loop, using `openclaw agent` under the hood. Events stream live into the Chronicle; phases show progress in the CYCLE FLOW panel.
- **Auto-discovers workflows**: on first run against an empty map, the LLM names 2-3 workflow domains based on your agent's actual task history (not generic placeholders).
- **Proposes + completes quests**: each cycle drafts a concrete quest for the current workflow, completes it, logs XP and gold, and drops a **research-note markdown** into the INVENTORY bag.
- **Closes the feedback loop**: 👍/👎 on any cycle event updates `~/.openclaw/quest/feedback-digest.json`. The next cycle's REFLECT prompt includes that feedback and the LLM adapts — down-vote a skill once, the next cycle pivots away from it and says so in its narration.
- **Tavern NPCs**: five LLM-powered characters (Lyra the guild master, Aldric the cartographer, Kael the quartermaster, Gus the bartender, Orin the sage) chat in-character via `openclaw agent`. Pixel-art portraits shipped with the repo.
- **ClawHub integration**: the SHOP tab searches and installs skills from the native OpenClaw registry via `openclaw skills search/install`.

Every LLM call goes through `openclaw agent` — the dashboard has no API keys of its own. It uses whatever credentials your OpenClaw runtime is already configured with.

---

## Architecture

```
┌─────────────────┐    HTTP + WS     ┌──────────────────┐
│  React / Vite   │ ◄──────────────► │  FastAPI backend │
│  localhost:5173 │                  │  localhost:8420  │
└─────────────────┘                  └────────┬─────────┘
                                              │
                          read-only           │   subprocess
                   ┌─────────────────┐        │   ┌─────────────────────┐
                   │ ~/.openclaw/    │ ◄──────┼──►│ /usr/bin/openclaw   │
                   │  tasks/         │        │   │  agent              │
                   │  openclaw.json  │        │   │  skills search/...  │
                   └─────────────────┘        │   └─────────────────────┘
                                              │
                   ┌─────────────────┐        │
                   │ ~/.openclaw/    │ ◄──────┘  (writes, quest-owned)
                   │  quest/         │
                   │    events.jsonl │
                   │    state.json   │
                   │    sites.json   │
                   │    quests.json  │
                   │    knowledge-map.json
                   │    feedback-digest.json
                   │    completions/*.md
                   └─────────────────┘
```

- **`server/main.py`** — FastAPI app, ~2300 lines, 43 endpoints.
- **`server/openclaw_agent.py`** — `call_agent(prompt, ...)` helper, shared by the cycle and NPC chat. Shells out to `openclaw agent --json` and parses `finalAssistantVisibleText`.
- **`server/openclaw_bridge.py`** — read-only SQLite reader for `runs.sqlite` + config parser. Serves `/api/openclaw/tasks` and `/api/openclaw/status`.
- **`server/quest_cycle.py`** — the REFLECT → PLAN → EXECUTE → REPORT runner, spawned as a detached subprocess when you click CYCLE. Writes events to `events.jsonl` which the watcher broadcasts via WebSocket.
- **`server/watcher.py`** — polls `~/.openclaw/quest/` for new events, state changes, map updates and broadcasts them.
- **`server/npc_chat.py`** — tavern NPC dialogue via `call_agent` with personas loaded from `server/prompts/npcs/*.md`.

---

## Quickstart

Requires a local OpenClaw install at `/usr/bin/openclaw` (the AUR `openclaw` package or equivalent) with a working agent profile. The dashboard uses OpenClaw's credentials; it never asks for your own.

```bash
git clone https://github.com/MotherSphere/openclaw-quest.git
cd openclaw-quest

# Backend
python -m venv .venv
.venv/bin/pip install -r server/requirements.txt

# Frontend
npm install

# Run (two terminals)
QUEST_CYCLE_ENABLED=1 .venv/bin/python server/main.py       # :8420
npm run dev                                                  # :5173
```

Then open **http://localhost:5173**.

First cycle: click **CYCLE** in the COMMAND panel. It takes ~150 seconds (three LLM calls: REFLECT, REPORT, and either a workflow seed or a quest proposal). Watch the CYCLE FLOW panel fill with real phases, then the WORLD MAP paint in with your first continent, then a research note appear in INVENTORY.

---

## Configuration

All env vars optional. Defaults in parentheses.

| Variable | Default | Purpose |
|---|---|---|
| `QUEST_CYCLE_ENABLED` | `0` | Must be `1` for the CYCLE button to spawn anything |
| `QUEST_OPENCLAW_BIN` | `which openclaw` or `/usr/bin/openclaw` | Override the runtime binary path |
| `QUEST_CYCLE_AGENT_ID` | `main` | Which OpenClaw agent to invoke for cycles + NPCs |
| `QUEST_CYCLE_THINKING` | `minimal` | `off` / `minimal` / `low` / `medium` / `high` |
| `QUEST_CYCLE_LLM_TIMEOUT` | `90` | Per-call timeout in seconds |
| `QUEST_PORT` / `QUEST_HOST` | `8420` / `0.0.0.0` | Backend listen address |
| `VITE_BACKEND_URL` | `http://localhost:8420` | Used by the Vite dev-server proxy |

---

## Roadmap (delivered)

- ✅ **Phase 1** — read-only bridge to `~/.openclaw/`, EVE tab, TopBar pill
- ✅ **Phase 2** — native cycle runner, real LLM REFLECT/REPORT, deterministic PLAN/EXECUTE
- ✅ **Phase 3** — feedback loop closed: 👍/👎 → digest → next cycle pivots
- ✅ **Phase 4** — tavern NPCs via `openclaw agent` + SPA route ordering fix
- ✅ **Phase 5** — five pixel-art NPC portraits (SpriteCook) + workflow seeding from task history
- ✅ **Phase 6** — skills persist to DB, cycles propose and complete quests
- ✅ **Phase 7** — ClawHub wired via `openclaw skills`; rumors, tavern ambient, reflection letter ported to `call_agent`; sites.json seeding so the World Map actually renders
- ✅ **Phase 8** — dead-code cleanup, research notes drop into INVENTORY on quest completion, "SHOW TO NPC" no longer re-fires on tab switch

## Roadmap (optional polish)

- Click-to-upload avatar for the character portrait and NPC sprites
- Elapsed timer in the "thinking..." indicator (`thinking — 23s / ~60s`)
- Varied item drops (potions, map fragments) instead of research notes only
- NPC ambient chatter auto-refresh every N cycles
- Connections / edges between related workflows on the World Map

---

## License

MIT — see [`LICENSE`](./LICENSE). Copyright remains with the original author (Nemo, 2026); OpenClaw-Quest adaptations are distributed under the same license.
