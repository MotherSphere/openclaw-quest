/** OpenClaw Quest backend — TypeScript entry point.
 *
 * Step 9a of the port from Python/FastAPI: the Fastify server is wired up
 * and a single `/api/state` endpoint reads state.json straight off disk.
 * Subsequent steps will layer in the SQLite models, WebSocket fan-out,
 * watcher, cycle runner, and the full 43-endpoint REST surface. */

import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import Fastify from "fastify";
import cors from "@fastify/cors";
import websocket from "@fastify/websocket";
import fastifyStatic from "@fastify/static";

import { HOST, PORT } from "./config.ts";
import { initDb, getEvents, getState } from "./models.ts";
import { readStatusSummary, readTaskRuns } from "./openclaw-bridge.ts";
import { manager } from "./ws-manager.ts";
import { QuestWatcher } from "./watcher.ts";

import { registerStateRoutes } from "./routes/state.ts";
import { registerMapRoutes } from "./routes/map.ts";
import { registerBagRoutes } from "./routes/bag.ts";
import { registerSiteRoutes } from "./routes/sites.ts";
import { registerFeedbackRoutes } from "./routes/feedback.ts";
import { registerQuestRoutes } from "./routes/quests.ts";
import { registerReflectionRoutes } from "./routes/reflection.ts";
import { registerHubRoutes } from "./routes/hub.ts";
import { registerRumorRoutes } from "./routes/rumors.ts";
import { registerMiscRoutes } from "./routes/misc.ts";
import { registerSkillsRoutes } from "./routes/skills.ts";
import { registerTavernRoutes } from "./routes/tavern.ts";

const app = Fastify({ logger: { level: "info" } });

await app.register(cors, { origin: true });
await app.register(websocket);

initDb();
const watcher = new QuestWatcher();
await watcher.initialSync();
void watcher.start(2000);

// Core read endpoints wired directly to models/bridge
app.get("/api/state", async () => getState() ?? {});

app.get<{ Querystring: { limit?: string; offset?: string } }>(
  "/api/events",
  async (request) => {
    const limit = Number.parseInt(request.query.limit ?? "50", 10);
    const offset = Number.parseInt(request.query.offset ?? "0", 10);
    const rows = getEvents(
      Number.isFinite(limit) ? limit : 50,
      Number.isFinite(offset) ? offset : 0,
    );
    // Dedup by (ts, type, first 60 chars of data) — watcher and route
    // writers can race on the same event-ms and emit twins. Matches
    // hermes-quest main.py:546-556 so the Chronicle feed stops flickering.
    const seen = new Set<string>();
    const unique: typeof rows = [];
    for (const e of rows) {
      const key = `${e.ts}-${e.type}-${JSON.stringify(e.data ?? {}).slice(0, 60)}`;
      if (seen.has(key)) continue;
      seen.add(key);
      unique.push(e);
    }
    return unique;
  },
);


app.get<{ Querystring: { limit?: string } }>("/api/openclaw/tasks", async (request) => {
  const limit = Number.parseInt(request.query.limit ?? "50", 10);
  return { tasks: readTaskRuns(Number.isFinite(limit) ? limit : 50) };
});

app.get("/api/openclaw/status", async () => readStatusSummary());

// Route modules
await registerStateRoutes(app);
await registerMapRoutes(app);
await registerBagRoutes(app);
await registerSiteRoutes(app);
await registerFeedbackRoutes(app);
await registerQuestRoutes(app);
await registerReflectionRoutes(app);
await registerHubRoutes(app);
await registerRumorRoutes(app);
await registerSkillsRoutes(app);
await registerTavernRoutes(app);
await registerMiscRoutes(app);

// WebSocket — /ws serves the live event stream. Initial snapshot on
// connect so fresh clients don't wait for the next broadcast.
app.get("/ws", { websocket: true }, (socket) => {
  manager.connect(socket);
  const state = getState();
  if (state) socket.send(JSON.stringify({ type: "state", data: state }));
  const recent = getEvents(20);
  for (const event of [...recent].reverse()) {
    socket.send(JSON.stringify({ type: "event", data: event }));
  }
});

// Static SPA serving — only active when a Vite build has produced
// `server-ts/dist-frontend/`. In plain-dev mode the separate `npm run dev`
// on :5173 proxies /api and /ws here; in plugin-install mode this block
// hands the browser a ready-to-use dashboard directly from :8420.
const HERE = dirname(fileURLToPath(import.meta.url));
const FRONTEND_DIR = join(HERE, "..", "dist-frontend");
if (existsSync(FRONTEND_DIR)) {
  await app.register(fastifyStatic, {
    root: FRONTEND_DIR,
    prefix: "/",
    wildcard: false,
    index: ["index.html"],
  });
  app.setNotFoundHandler((request, reply) => {
    const url = request.url.split("?")[0] ?? "";
    if (url.startsWith("/api") || url.startsWith("/ws")) {
      reply.code(404).send({ error: "not found" });
      return;
    }
    reply.sendFile("index.html");
  });
  app.log.info(`Serving built dashboard from ${FRONTEND_DIR}`);
} else {
  app.log.warn(
    `Frontend bundle not found at ${FRONTEND_DIR}. Run \`npm run build\` at the repo root, or start Vite separately with \`npm run dev\`.`,
  );
}

try {
  await app.listen({ host: HOST, port: PORT });
  app.log.info(`OpenClaw Quest TS backend started on ${HOST}:${PORT}`);
} catch (err) {
  app.log.error(err);
  process.exit(1);
}
