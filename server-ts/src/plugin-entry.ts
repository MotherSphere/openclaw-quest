/** OpenClaw plugin entry — packages the Quest dashboard as a native plugin.
 *
 * The Quest backend is written for Bun (bun:sqlite + Bun's Fastify stack),
 * but OpenClaw itself runs on Node. This entry file therefore stays
 * Node-compatible and only *spawns* the backend as a Bun child process. It
 * must not statically import any backend module that depends on Bun APIs. */

import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { platform } from "node:os";

import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";

interface QuestPluginConfig {
  port?: number;
  host?: string;
  cycleEnabled?: boolean;
  cycleAgentId?: string;
  cycleThinking?: string;
  cycleLlmTimeoutSec?: number;
  autoStart?: boolean;
  bunBin?: string;
}

const HERE = dirname(fileURLToPath(import.meta.url));
const MAIN_ENTRY = join(HERE, "main.ts");

function resolveBun(override?: string): string | null {
  if (override && existsSync(override)) return override;
  const bunInstall = process.env.BUN_INSTALL;
  if (bunInstall) {
    const candidate = join(bunInstall, "bin", "bun");
    if (existsSync(candidate)) return candidate;
  }
  for (const p of (process.env.PATH ?? "").split(":")) {
    if (!p) continue;
    const candidate = join(p, "bun");
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

function buildBackendEnv(cfg: QuestPluginConfig): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  if (cfg.port !== undefined) env.QUEST_PORT = String(cfg.port);
  if (cfg.host !== undefined) env.QUEST_HOST = cfg.host;
  if (cfg.cycleEnabled !== undefined) env.QUEST_CYCLE_ENABLED = cfg.cycleEnabled ? "1" : "0";
  if (cfg.cycleAgentId !== undefined) env.QUEST_CYCLE_AGENT_ID = cfg.cycleAgentId;
  if (cfg.cycleThinking !== undefined) env.QUEST_CYCLE_THINKING = cfg.cycleThinking;
  if (cfg.cycleLlmTimeoutSec !== undefined) {
    env.QUEST_CYCLE_LLM_TIMEOUT = String(cfg.cycleLlmTimeoutSec);
  }
  return env;
}

function dashboardUrl(cfg: QuestPluginConfig): string {
  const port = cfg.port ?? 8420;
  const rawHost = cfg.host ?? "127.0.0.1";
  const host = rawHost === "0.0.0.0" ? "localhost" : rawHost;
  return `http://${host}:${port}`;
}

export default definePluginEntry({
  id: "openclaw-quest",
  name: "OpenClaw Quest",
  description: "RPG-style observability dashboard for OpenClaw agents.",
  register(api) {
    const cfg = (api.pluginConfig ?? {}) as QuestPluginConfig;
    const url = dashboardUrl(cfg);

    let child: ChildProcess | null = null;

    if (cfg.autoStart !== false) {
      api.registerService({
        id: "openclaw-quest-backend",
        start: async () => {
          const bun = resolveBun(cfg.bunBin);
          if (!bun) {
            api.logger.warn(
              "OpenClaw Quest backend not started: `bun` binary not found on PATH. " +
                "Install Bun (https://bun.sh) or set the `bunBin` plugin config, " +
                "or disable `autoStart` to silence this message.",
            );
            return;
          }
          if (!existsSync(MAIN_ENTRY)) {
            api.logger.warn(
              `OpenClaw Quest backend not started: entrypoint missing at ${MAIN_ENTRY}`,
            );
            return;
          }
          try {
            child = spawn(bun, [MAIN_ENTRY], {
              env: buildBackendEnv(cfg),
              stdio: ["ignore", "inherit", "inherit"],
              detached: false,
            });
            child.on("exit", (code, signal) => {
              if (code !== 0 && code !== null) {
                api.logger.warn(
                  `OpenClaw Quest backend exited with code ${code}${signal ? ` (${signal})` : ""}`,
                );
              }
              child = null;
            });
            child.on("error", (err) => {
              api.logger.warn(`OpenClaw Quest backend error: ${err.message}`);
            });
            api.logger.info?.(`OpenClaw Quest backend starting on ${url} (pid ${child.pid})`);
          } catch (err) {
            api.logger.warn(`Failed to spawn OpenClaw Quest backend: ${(err as Error).message}`);
          }
        },
        stop: async () => {
          if (child && !child.killed) {
            child.kill("SIGTERM");
            child = null;
          }
        },
      });
    }

    api.registerCli(
      (ctx) => {
        ctx.program
          .command("quest")
          .description("Open the OpenClaw Quest dashboard in your browser")
          .option("--no-open", "Print the URL instead of launching a browser")
          .action((opts: { open?: boolean }) => {
            if (opts.open === false) {
              ctx.logger.info(url);
              return;
            }
            const os = platform();
            const opener = os === "darwin" ? "open" : os === "win32" ? "cmd" : "xdg-open";
            const args = os === "win32" ? ["/c", "start", "", url] : [url];
            try {
              const proc = spawn(opener, args, { detached: true, stdio: "ignore" });
              proc.unref();
              ctx.logger.info(`Opening ${url}`);
            } catch (err) {
              ctx.logger.warn(`Could not launch browser: ${(err as Error).message}`);
              ctx.logger.info(url);
            }
          });
      },
      {
        descriptors: [
          {
            name: "quest",
            description: "Open the OpenClaw Quest dashboard",
            hasSubcommands: false,
          },
        ],
      },
    );
  },
});
