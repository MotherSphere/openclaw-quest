/** /api/state and /api/state/update — state.json reads + partial updates. */

import { writeFile } from "node:fs/promises";
import type { FastifyInstance } from "fastify";

import { STATE_FILE } from "../config.ts";
import { getState, upsertState } from "../models.ts";
import { manager } from "../ws-manager.ts";

export async function registerStateRoutes(app: FastifyInstance): Promise<void> {
  app.post<{ Body: Record<string, unknown> }>(
    "/api/state/update",
    async (request, reply) => {
      const body = request.body ?? {};
      const allowed = new Set(["name"]);
      const updates: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(body)) {
        if (allowed.has(k)) updates[k] = v;
      }
      if (Object.keys(updates).length === 0) {
        return reply.code(400).send({ error: "no valid fields" });
      }
      const name = updates["name"];
      if (typeof name === "string" && (name.length < 1 || name.length > 30)) {
        return reply.code(400).send({ error: "name must be 1-30 chars" });
      }

      const state = (getState() ?? {}) as Record<string, unknown>;
      Object.assign(state, updates);
      if (((state["hp"] as number | undefined) ?? 0) <= 0) {
        state["reflection_letter_pending"] = true;
      }
      await writeFile(STATE_FILE, JSON.stringify(state, null, 2));
      upsertState(state);
      manager.broadcast({ type: "state", data: state });
      return { ok: true };
    },
  );
}
