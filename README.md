# OpenClaw-Quest

An RPG dashboard for [OpenClaw](https://github.com/openclaw/openclaw) and its agents (notably **EVE**) — turn your agent's cron runs, flows, tasks, memory and logs into a guided, observable adventure with feedback-driven steering.

> **Work in progress.** This repository is an initial import of Hermes Quest. The OpenClaw adaptation (swap of the Hermes Agent runtime for OpenClaw's `~/.openclaw/` data model, flows and cron) is the next step — see *Roadmap* below.

---

## Credits — Built on Hermes Quest

This project is a fork of **[Hermes Quest](https://github.com/nemoaigc/hermes-quest)** by [@nemoaigc](https://github.com/nemoaigc), licensed MIT.

Hermes Quest is a brilliant piece of work: it turns aimless AI evolution into goal-directed growth by layering a pixel-RPG dashboard over the [Hermes Agent](https://github.com/NousResearch/hermes-agent) runtime, with a real prompt-level RLHF feedback loop. Every architectural idea here — the 4-phase REFLECT→PLAN→EXECUTE→REPORT cycle, `feedback-digest.json`, the fog-of-war domain map, the LLM-powered tavern NPCs — comes from Nemo's original design.

**Huge thanks to Nemo** for open-sourcing it under MIT. Go star and support the original: https://github.com/nemoaigc/hermes-quest

The unmodified original README is preserved as [`UPSTREAM_README.md`](./UPSTREAM_README.md).

---

## What changes here vs. Hermes Quest

Hermes Quest targets the **Hermes Agent** runtime (Nous Research). This fork retargets it to **OpenClaw**, which happens to expose a very compatible shape:

| Hermes Quest concept       | OpenClaw equivalent                                |
| -------------------------- | -------------------------------------------------- |
| `~/.hermes/quest/state.json` | `~/.openclaw/openclaw.json` (+ derived stats)    |
| `events.jsonl` (chronicle) | `~/.openclaw/logs/`                                |
| `knowledge-map.json`       | Derived from `~/.openclaw/agents/` + `subagents/` + `memory/` |
| `SKILL.md` (cycle agent)   | An OpenClaw flow + cron entry                      |
| Quests                     | `~/.openclaw/tasks/` + `cron/`                     |
| `feedback-digest.json`     | New file under `~/.openclaw/quest/`, read by the flow |

Most of the React dashboard and FastAPI backend are expected to port with path/endpoint changes only. The real work is porting the `SKILL.md` cycle agent to an OpenClaw flow/subagent.

---

## Roadmap

1. **Phase 0 — this commit.** Verbatim import of Hermes Quest @ `a5eff40e` from upstream.
2. **Phase 1 — read-only OpenClaw dashboard.** Swap file paths and endpoints so the dashboard reads `~/.openclaw/` (tasks, logs, memory, agents) and renders the RPG UI without modifying any EVE state. Safe MVP.
3. **Phase 2 — feedback loop.** Write `~/.openclaw/quest/feedback-digest.json` from the dashboard (thumbs up/down on tasks), and add a small OpenClaw flow/subagent that reads it at the start of each cycle.
4. **Phase 3 — observable cycle.** Port REFLECT → PLAN → EXECUTE → REPORT to an OpenClaw flow, streaming events back to the dashboard.
5. **Phase 4 — polish.** NPCs, shop, world map — as desired.

Panels that don't apply to OpenClaw (Hermes Hub skill shop, potions, etc.) will be removed or repurposed.

---

## License

MIT — see [`LICENSE`](./LICENSE). Copyright remains with the original author (Nemo, 2026); OpenClaw-Quest adaptations are distributed under the same license.
