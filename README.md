# OpenClaw-Quest

An RPG-style observability dashboard for [OpenClaw](https://github.com/openclaw/openclaw) and its agents. Turn your agent's cron runs, flows, tasks, skills and logs into a guided, observable adventure with real LLM narration and a feedback loop that actually steers the next cycle.

Zero writes to `~/.openclaw/` outside the `quest/` subdir. When the cycle runs it's your own OpenClaw agent reasoning, not a simulation.

---

## Credits — Built on Hermes Quest

Fork of **[Hermes Quest](https://github.com/nemoaigc/hermes-quest)** by [@nemoaigc](https://github.com/nemoaigc), licensed MIT. Every architectural idea here — the 4-phase REFLECT → PLAN → EXECUTE → REPORT cycle, `feedback-digest.json`, the fog-of-war domain map, the LLM-powered tavern NPCs — comes from Nemo's original design. Go star and support the upstream: https://github.com/nemoaigc/hermes-quest

The unmodified original README is preserved as [`UPSTREAM_README.md`](./UPSTREAM_README.md).

---

## What it does

- **Observes**: reads `~/.openclaw/tasks/runs.sqlite` and `~/.openclaw/openclaw.json` read-only. The EVE tab shows your agent's live task runs; the TopBar pill tracks total tasks and failures.
- **Runs cycles**: a manual "CYCLE" button spawns an LLM-driven REFLECT → PLAN → EXECUTE → REPORT loop via `openclaw agent`. Events stream live into the Chronicle; phases show progress in the CYCLE FLOW panel.
- **Auto-discovers workflows**: on first run against an empty map, the LLM names 2-3 workflow domains based on your agent's actual task history.
- **Proposes + completes quests**: each cycle drafts a concrete quest for the current workflow, completes it, logs XP and gold, drops a research-note markdown into the INVENTORY bag.
- **Closes the feedback loop**: 👍/👎 on any cycle event updates `~/.openclaw/quest/feedback-digest.json`. The next cycle's REFLECT prompt includes that feedback and the LLM adapts — down-vote a skill once, the next cycle pivots away from it.
- **Tavern NPCs**: five LLM-powered characters (Lyra, Aldric, Kael, Gus, Orin) chat in-character via `openclaw agent`. Pixel-art portraits shipped with the repo.
- **ClawHub integration**: the SHOP tab searches and installs skills from the native OpenClaw registry via `openclaw skills search/install`.

Every LLM call goes through `openclaw agent` — the dashboard has no API keys of its own. It uses whatever credentials your OpenClaw runtime is already configured with.

---

## Architecture

```
┌─────────────────┐    HTTP + WS     ┌──────────────────┐
│  React / Vite   │ ◄──────────────► │  Fastify / Bun   │
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

- **`server-ts/src/main.ts`** — Fastify app, 43 endpoints, WebSocket at `/ws`.
- **`server-ts/src/openclaw-agent.ts`** — `callAgent(prompt, ...)` helper shared by the cycle runner and NPC chat. Spawns `openclaw agent --json`.
- **`server-ts/src/openclaw-bridge.ts`** — read-only `bun:sqlite` reader for `runs.sqlite` + `openclaw.json` parser.
- **`server-ts/src/quest-cycle.ts`** — the REFLECT → PLAN → EXECUTE → REPORT runner, spawned as a detached Bun child process when you click CYCLE.
- **`server-ts/src/watcher.ts`** — polls `~/.openclaw/quest/` for new events, state changes, map updates and broadcasts them.
- **`server-ts/src/npc-chat.ts`** — tavern NPC dialogue via `callAgent` with personas loaded from `server-ts/prompts/npcs/*.md`.
- **`server-ts/src/routes/*.ts`** — one file per concern (quests, bag, feedback, sites, reflection, tavern, hub, rumors, misc).

---

## Quickstart

Requires:
- [**Bun**](https://bun.sh) 1.3+ (runtime for the backend; single binary, install with `curl -fsSL https://bun.sh/install | bash`).
- **Node** for the Vite dev server (v22+).
- A local **OpenClaw** install at `/usr/bin/openclaw` (AUR `openclaw` package or equivalent) with a working agent profile. The dashboard uses OpenClaw's credentials; it never asks for your own.

```bash
git clone https://github.com/MotherSphere/openclaw-quest.git
cd openclaw-quest

# Backend deps (bun)
cd server-ts && bun install && cd ..

# Frontend deps (node)
npm install

# Run (two terminals)
cd server-ts && QUEST_CYCLE_ENABLED=1 bun src/main.ts         # :8420
npm run dev                                                    # :5173
```

Then open **http://localhost:5173**.

First cycle: click **CYCLE** in the COMMAND panel. It takes ~150 seconds (three LLM calls: REFLECT, REPORT, plus a workflow seed or quest proposal). Watch the CYCLE FLOW panel fill with real phases, then the WORLD MAP paint with continents, then a research note appear in INVENTORY.

---

## Configuration

All env vars optional. Defaults shown.

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
- ✅ **Phase 7** — ClawHub wired via `openclaw skills`; rumors, tavern ambient, reflection letter ported; sites.json seeding so the World Map actually renders
- ✅ **Phase 8** — dead-code cleanup, research notes drop into INVENTORY on quest completion, "SHOW TO NPC" no longer re-fires on tab switch
- ✅ **Phase 9** — full backend rewrite from Python/FastAPI to TypeScript/Bun/Fastify. Same 43 endpoints, same WS broadcasts, same cycle/NPC behaviour — now running on OpenClaw's own runtime in preparation for shipping as a native plugin

## Roadmap (next)

- Register Openclaw-Quest as an OpenClaw plugin so `openclaw plugins install openclaw-quest` auto-adds the "Quêtes" tab to the control UI
- Click-to-upload avatar for the character portrait and NPC sprites
- Elapsed timer in the "thinking..." indicator
- Varied item drops beyond research notes
- Connections between related workflows on the World Map

---

## License

MIT — see [`LICENSE`](./LICENSE). Copyright remains with the original author (Nemo, 2026); OpenClaw-Quest adaptations are distributed under the same license.
