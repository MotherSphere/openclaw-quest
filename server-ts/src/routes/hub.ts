/** /api/hub/search + /api/hub/install — ClawHub via `openclaw skills`. */

import { spawn } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import type { FastifyInstance } from "fastify";

import { AGENT_RUNTIME_BIN, GAME_BALANCE, STATE_FILE } from "../config.ts";
import { upsertState } from "../models.ts";
import { manager } from "../ws-manager.ts";

interface ClawhubResult {
  score?: number;
  slug: string;
  displayName?: string;
  summary?: string;
  version?: string | null;
}

function runCli(args: string[], timeoutMs = 20000): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    if (!existsSync(AGENT_RUNTIME_BIN)) return resolve({ code: -1, stdout: "", stderr: "bin not found" });
    const child = spawn(AGENT_RUNTIME_BIN, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "", stderr = "";
    const timer = setTimeout(() => child.kill("SIGTERM"), timeoutMs);
    child.stdout.on("data", (c) => { stdout += c.toString(); });
    child.stderr.on("data", (c) => { stderr += c.toString(); });
    child.on("error", (err) => { clearTimeout(timer); resolve({ code: -1, stdout: "", stderr: err.message }); });
    child.on("close", (code) => { clearTimeout(timer); resolve({ code: code ?? -1, stdout, stderr }); });
  });
}

export async function registerHubRoutes(app: FastifyInstance): Promise<void> {
  app.get<{ Querystring: { q?: string } }>("/api/hub/search", async (request) => {
    const q = (request.query.q ?? "").trim();
    const args = ["skills", "search", "--json", "--limit", "20"];
    if (q) args.push(q);
    const { code, stdout } = await runCli(args);
    if (code !== 0) return [];
    try {
      const payload = JSON.parse(stdout) as { results?: ClawhubResult[] };
      return (payload.results ?? [])
        .filter((h) => h.slug)
        .map((h) => ({
          name: h.displayName ?? h.slug,
          description: h.summary ?? "",
          source: "clawhub",
          identifier: h.slug,
          trust_level: "verified",
          tags: [] as string[],
        }));
    } catch {
      return [];
    }
  });

  app.post<{ Body: { identifier?: string } }>("/api/hub/install", async (request, reply) => {
    const identifier = (request.body?.identifier ?? "").trim();
    if (!identifier) return reply.code(400).send({ status: "error", message: "Missing identifier" });
    if (!existsSync(AGENT_RUNTIME_BIN)) {
      return reply.code(503).send({ status: "error", message: `OpenClaw runtime not found at ${AGENT_RUNTIME_BIN}` });
    }

    const skillCost = GAME_BALANCE.skill_install_cost;
    let state: Record<string, unknown> = {};
    try {
      state = JSON.parse(await readFile(STATE_FILE, "utf8")) as Record<string, unknown>;
    } catch {
      /* state missing */
    }
    if ((state["gold"] as number | undefined ?? 0) < skillCost) {
      return reply.code(400).send({ status: "error", message: `Not enough gold (need ${skillCost}G)` });
    }
    state["gold"] = (state["gold"] as number) - skillCost;
    await writeFile(STATE_FILE, JSON.stringify(state, null, 2));
    upsertState(state);

    const { code, stderr } = await runCli(["skills", "install", identifier], 120000);
    if (code !== 0) {
      // refund
      state["gold"] = (state["gold"] as number) + skillCost;
      await writeFile(STATE_FILE, JSON.stringify(state, null, 2));
      upsertState(state);
      return reply.code(502).send({
        status: "error",
        message: (stderr || "install failed").slice(0, 300),
      });
    }

    manager.broadcast({ type: "state", data: state });
    return {
      status: "installed",
      name: identifier,
      message: `Installed ${identifier} from ClawHub`,
    };
  });

  app.get("/api/hub-recommendations", async () => ({ recommendations: [] }));
}
