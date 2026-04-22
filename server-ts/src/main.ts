/** OpenClaw Quest backend — TypeScript entry point.
 *
 * Step 9a of the port from Python/FastAPI: the Fastify server is wired up
 * and a single `/api/state` endpoint reads state.json straight off disk.
 * Subsequent steps will layer in the SQLite models, WebSocket fan-out,
 * watcher, cycle runner, and the full 43-endpoint REST surface. */

import Fastify from "fastify";
import cors from "@fastify/cors";
import websocket from "@fastify/websocket";

import { HOST, PORT } from "./config.ts";
import { initDb, getEvents, getState, getSkills, getQuests } from "./models.ts";
import { readStatusSummary, readTaskRuns } from "./openclaw-bridge.ts";
import { manager } from "./ws-manager.ts";
import { QuestWatcher } from "./watcher.ts";

const app = Fastify({ logger: { level: "info" } });

await app.register(cors, { origin: true });
await app.register(websocket);

initDb();
const watcher = new QuestWatcher();
await watcher.initialSync();
void watcher.start(2000);

app.get("/api/state", async () => {
  return getState() ?? {};
});

app.get<{ Querystring: { limit?: string; offset?: string } }>(
  "/api/events",
  async (request) => {
    const limit = Number.parseInt(request.query.limit ?? "50", 10);
    const offset = Number.parseInt(request.query.offset ?? "0", 10);
    return getEvents(Number.isFinite(limit) ? limit : 50, Number.isFinite(offset) ? offset : 0);
  },
);

app.get("/api/skills", async () => getSkills());

app.get<{ Querystring: { status?: string } }>("/api/quests", async (request) => {
  return getQuests(request.query.status ?? null);
});

app.get<{ Querystring: { limit?: string } }>("/api/openclaw/tasks", async (request) => {
  const limit = Number.parseInt(request.query.limit ?? "50", 10);
  return { tasks: readTaskRuns(Number.isFinite(limit) ? limit : 50) };
});

app.get("/api/openclaw/status", async () => readStatusSummary());

app.get("/ws", { websocket: true }, (socket) => {
  manager.connect(socket);
  // Send current state + recent events snapshot (matches Python behaviour).
  const state = getState();
  if (state) socket.send(JSON.stringify({ type: "state", data: state }));
  const recent = getEvents(20);
  for (const event of [...recent].reverse()) {
    socket.send(JSON.stringify({ type: "event", data: event }));
  }
});

app.get("/api/health", async () => ({
  ok: true,
  port: PORT,
  backend: "typescript",
  ws_clients: manager.size(),
}));

try {
  await app.listen({ host: HOST, port: PORT });
  app.log.info(`OpenClaw Quest TS backend started on ${HOST}:${PORT}`);
} catch (err) {
  app.log.error(err);
  process.exit(1);
}
