/** Thin wrapper around `openclaw agent --json` — port of
 * server/openclaw_agent.py.
 *
 * Exactly one subprocess, one JSON parse, one shot at `finalAssistantVisibleText`.
 * Callers MUST have a deterministic fallback for the `null` return — no
 * exception ever leaks out. */

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";

import {
  AGENT_RUNTIME_BIN,
  QUEST_CYCLE_AGENT_ID,
  QUEST_CYCLE_LLM_TIMEOUT_MS,
  QUEST_CYCLE_THINKING,
} from "./config.ts";

export interface CallAgentOptions {
  agentId?: string;
  thinking?: string;
  timeoutMs?: number;
}

/** Run one `openclaw agent` turn, return the visible assistant text or null. */
export async function callAgent(
  prompt: string,
  opts: CallAgentOptions = {},
): Promise<string | null> {
  if (!existsSync(AGENT_RUNTIME_BIN)) return null;

  const agentId = opts.agentId ?? QUEST_CYCLE_AGENT_ID;
  const thinking = opts.thinking ?? QUEST_CYCLE_THINKING;
  const timeoutMs = opts.timeoutMs ?? QUEST_CYCLE_LLM_TIMEOUT_MS;

  return new Promise<string | null>((resolve) => {
    const child = spawn(
      AGENT_RUNTIME_BIN,
      ["agent", "--agent", agentId, "--thinking", thinking, "--json", "-m", prompt],
      { stdio: ["ignore", "pipe", "pipe"] },
    );

    let stdout = "";
    let stderr = "";
    let timedOut = false;

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
    }, timeoutMs);

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });

    child.on("error", (err) => {
      clearTimeout(timer);
      console.warn("openclaw agent spawn error:", err.message);
      resolve(null);
    });

    child.on("close", (code) => {
      clearTimeout(timer);
      if (timedOut) {
        console.warn("openclaw agent call timed out");
        return resolve(null);
      }
      if (code !== 0) {
        console.warn(`openclaw agent returned ${code}: ${stderr.slice(0, 200)}`);
        return resolve(null);
      }
      let payload: unknown;
      try {
        payload = JSON.parse(stdout);
      } catch {
        console.warn("openclaw agent produced non-JSON output");
        return resolve(null);
      }
      const text =
        dig(payload, "finalAssistantVisibleText") ?? dig(payload, "finalAssistantRawText");
      if (!text) return resolve(null);
      const trimmed = text.trim();
      resolve(trimmed || null);
    });
  });
}

/** Recursive best-effort key lookup. The exact JSON shape of
 * `openclaw agent --json` has shifted across versions, so we dig for the
 * first matching string at any depth. */
function dig(obj: unknown, key: string): string | null {
  if (obj === null || typeof obj !== "object") return null;
  const rec = obj as Record<string, unknown>;
  const direct = rec[key];
  if (typeof direct === "string") return direct;
  for (const value of Object.values(rec)) {
    const found = dig(value, key);
    if (found !== null) return found;
  }
  return null;
}
