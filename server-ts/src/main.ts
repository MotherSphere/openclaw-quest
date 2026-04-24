/** OpenClaw Quest backend — TypeScript entry point.
 *
 * Step 9a of the port from Python/FastAPI: the Fastify server is wired up
 * and a single `/api/state` endpoint reads state.json straight off disk.
 * Subsequent steps will layer in the SQLite models, WebSocket fan-out,
 * watcher, cycle runner, and the full 43-endpoint REST surface. */

import { existsSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import Fastify from "fastify";
import cors from "@fastify/cors";
import websocket from "@fastify/websocket";
import fastifyStatic from "@fastify/static";

import { EVENTS_FILE, HOST, PORT, SKILLS_DIR } from "./config.ts";
import { deleteSkill, initDb, getEvents, getState, getSkills, insertEvent } from "./models.ts";
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

app.get("/api/skills", async () => getSkills());

// DELETE a skill: removes from DB + filesystem. Port of hermes-quest
// server/main.py:567-597. Matches by frontmatter `name:` in any
// SKILL.md under SKILLS_DIR, or by directory name as fallback.
app.delete<{ Params: { name: string } }>("/api/skills/:name", async (request, reply) => {
  const skillName = decodeURIComponent(request.params.name ?? "").trim();
  if (!skillName) return reply.code(400).send({ error: "skill_name required" });

  let deletedFs = false;
  if (existsSync(SKILLS_DIR)) {
    // Walk: each skill lives at any depth under SKILLS_DIR. A directory
    // is a skill iff it contains SKILL.md; otherwise it's a category dir.
    const stack: string[] = [SKILLS_DIR];
    while (stack.length > 0 && !deletedFs) {
      const dir = stack.pop()!;
      let entries: string[] = [];
      try {
        entries = readdirSync(dir);
      } catch {
        continue;
      }
      for (const entry of entries) {
        const full = join(dir, entry);
        let st;
        try {
          st = statSync(full);
        } catch {
          continue;
        }
        if (!st.isDirectory()) continue;
        const skillFile = join(full, "SKILL.md");
        if (existsSync(skillFile)) {
          let matches = entry === skillName;
          if (!matches) {
            try {
              const raw = readFileSync(skillFile, "utf8");
              const fm = raw.match(/^---\s*\n([\s\S]*?)\n---/);
              if (fm) {
                const nameLine = fm[1]!.match(/^name:\s*(.+)$/m);
                if (nameLine && nameLine[1]!.trim() === skillName) matches = true;
              }
            } catch {
              /* ignore parse errors — fall back to dir-name match */
            }
          }
          if (matches) {
            try {
              rmSync(full, { recursive: true, force: true });
              deletedFs = true;
            } catch {
              /* keep trying siblings */
            }
            break;
          }
        } else {
          // Category dir — descend.
          stack.push(full);
        }
      }
    }
  }

  const deletedDb = deleteSkill(skillName);
  if (!deletedFs && !deletedDb) {
    return reply.code(404).send({ error: "skill_not_found" });
  }

  const event = {
    ts: new Date().toISOString(),
    type: "skill_drop",
    region: null,
    data: { skill: skillName, action: "forget" },
  };
  try {
    await writeFile(EVENTS_FILE, JSON.stringify(event) + "\n", { flag: "a" });
    insertEvent(event);
  } catch {
    /* best-effort event log */
  }
  manager.broadcast({ type: "event", data: event });
  manager.broadcast({ type: "skill_deleted", data: { name: skillName } });
  return { status: "deleted", name: skillName };
});

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
