/** /api/map — reads knowledge-map.json straight off disk. */

import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import type { FastifyInstance } from "fastify";

import { MAP_FILE } from "../config.ts";

export async function registerMapRoutes(app: FastifyInstance): Promise<void> {
  app.get("/api/map", async (_request, reply) => {
    if (!existsSync(MAP_FILE)) {
      return { version: 2, generated_at: null, workflows: [], connections: [], fog_regions: [] };
    }
    try {
      const raw = await readFile(MAP_FILE, "utf8");
      return JSON.parse(raw);
    } catch (err) {
      app.log.warn({ err }, "failed to read knowledge-map.json");
      return reply.code(500).send({ error: "map_read_failed" });
    }
  });
}
