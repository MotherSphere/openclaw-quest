/** OpenClaw Quest backend — TypeScript entry point.
 *
 * Step 9a of the port from Python/FastAPI: the Fastify server is wired up
 * and a single `/api/state` endpoint reads state.json straight off disk.
 * Subsequent steps will layer in the SQLite models, WebSocket fan-out,
 * watcher, cycle runner, and the full 43-endpoint REST surface. */

import { readFile } from "node:fs/promises";
import Fastify from "fastify";
import cors from "@fastify/cors";

import { HOST, PORT, STATE_FILE } from "./config.ts";

const app = Fastify({ logger: { level: "info" } });

await app.register(cors, { origin: true });

app.get("/api/state", async (_request, reply) => {
  try {
    const raw = await readFile(STATE_FILE, "utf8");
    return JSON.parse(raw);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return reply.code(200).send({});
    }
    app.log.error({ err }, "failed to read state.json");
    return reply.code(500).send({ error: "state_read_failed" });
  }
});

app.get("/api/health", async () => ({ ok: true, port: PORT, backend: "typescript" }));

try {
  await app.listen({ host: HOST, port: PORT });
  app.log.info(`OpenClaw Quest TS backend started on ${HOST}:${PORT}`);
} catch (err) {
  app.log.error(err);
  process.exit(1);
}
