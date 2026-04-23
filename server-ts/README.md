# Openclaw-Quest

RPG-style observability dashboard for OpenClaw agents, packaged as a native OpenClaw plugin.

Your agent's activity shows up as quests, workflows, skills, and bag drops — a knowledge-map replaces raw logs, an NPC tavern replaces a chat history, and a cycle runner drafts new quests from recent task labels. Read-only over your `~/.openclaw` tree (never writes there); state persists under `~/.openclaw/quest/`.

## Install

```bash
openclaw plugins install openclaw-quest
openclaw gateway restart
openclaw quest
```

The `openclaw quest` CLI opens the dashboard in your browser. The backend boots as a gateway service on `127.0.0.1:8420` when the gateway starts; it's killed when the gateway stops.

## Requirements

- OpenClaw `>= 2026.4.20`
- [Bun](https://bun.sh) `>= 1.1` (backend runtime; the plugin spawns it as a child process)

## What you get

- **World Map** — workflow domains as continents, discovered through your activity
- **Knowledge panel** — SubRegionGraph with skill nodes per workflow, populated by an LLM classifier
- **Guild board** — accept/complete/fail quests; LLM drafts new ones when the board is empty
- **Bag** — every quest completion drops a research-note scroll you can reopen later
- **Tavern** — 5 NPCs (Guild Master, Cartographer, Quartermaster, Bartender, Sage) with portraits, replying through `openclaw agent`
- **Feedback loop** — thumbs up/down on events feeds back into the cycle's workflow sentiment

## Configuration

All knobs are set on the plugin entry in `openclaw.plugin.json` and read from the gateway config. Defaults work out of the box; the most commonly tuned ones:

| Key                          | Default        | Purpose                                   |
| ---------------------------- | -------------- | ----------------------------------------- |
| `port`                       | `8420`         | Backend HTTP + WebSocket port             |
| `host`                       | `127.0.0.1`    | Bind address                              |
| `cycleEnabled`               | `false`        | Auto-run the quest cycle on a timer       |
| `cycleAgentId`               | `main`         | Agent ID passed to `openclaw agent`       |
| `cycleThinking`              | `minimal`      | Thinking level for cycle narration        |
| `cycleLlmTimeoutSec`         | `90`           | Cap per LLM call                          |
| `autoStart`                  | `true`         | Spawn the backend when the gateway boots  |

## Credits

Fork of [hermes-quest](https://github.com/nemoaigc/hermes-quest) by [@nemoaigc](https://github.com/nemoaigc) (MIT). The source layout, panel designs, and quest-cycle mechanics are Nemo's; this fork retargets it to OpenClaw, rewrites the backend from Python/FastAPI to TypeScript/Bun/Fastify, and ships it as a single-command plugin install.

## Links

- Source: https://github.com/MotherSphere/openclaw-quest
- Issues: https://github.com/MotherSphere/openclaw-quest/issues
- OpenClaw plugin docs: https://docs.openclaw.ai/cli/plugins

## License

MIT.
