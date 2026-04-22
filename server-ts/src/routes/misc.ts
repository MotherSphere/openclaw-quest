/** /api/cycle/status, /api/potion/use, /api/skill/quest/sync, /api/regions
 * + 501 stubs for /api/cycle/start and tavern endpoints (ported in 9e/9f). */

import { existsSync } from "node:fs";
import { readFile, stat, unlink, writeFile } from "node:fs/promises";
import type { FastifyInstance } from "fastify";

import {
  CYCLE_LOCK_FILE,
  GAME_BALANCE,
  QUEST_CYCLE_ENABLED,
  QUEST_SKILL_DIR,
  STATE_FILE,
} from "../config.ts";
import { upsertState } from "../models.ts";
import { manager } from "../ws-manager.ts";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";

interface Potion {
  cost: number;
  stat: "hp" | "mp";
  max_stat: "hp_max" | "mp_max";
  amount: number;
  name: string;
}

const POTIONS: Record<string, Potion> = {
  hp_potion: {
    cost: GAME_BALANCE.hp_potion_cost,
    stat: "hp",
    max_stat: "hp_max",
    amount: GAME_BALANCE.hp_potion_heal,
    name: "HP Potion",
  },
  mp_potion: {
    cost: GAME_BALANCE.mp_potion_cost,
    stat: "mp",
    max_stat: "mp_max",
    amount: GAME_BALANCE.mp_potion_heal,
    name: "MP Potion",
  },
};

export async function registerMiscRoutes(app: FastifyInstance): Promise<void> {
  // /api/cycle/status — reads cycle.lock existence + latest cycle_phase event
  app.get("/api/cycle/status", async () => {
    if (!existsSync(CYCLE_LOCK_FILE)) return { status: "idle", progress: null };
    try {
      const ts = Number.parseInt((await readFile(CYCLE_LOCK_FILE, "utf8")).trim(), 10);
      const ageSec = Math.floor(Date.now() / 1000) - ts;
      if (ageSec > GAME_BALANCE.cycle_lock_timeout) {
        await unlink(CYCLE_LOCK_FILE).catch(() => undefined);
        return { status: "idle", progress: null };
      }
      // Minimal progress — the watcher broadcasts detailed cycle_progress
      // on every cycle_phase event, so the UI primarily listens over WS.
      return {
        status: "running",
        progress: {
          phase: "reflect",
          summary: "Cycle started. Waiting for phase events...",
          ts: new Date(ts * 1000).toISOString(),
        },
      };
    } catch {
      return { status: "idle", progress: null };
    }
  });

  // /api/cycle/start — stub until 9f wires the real TS cycle runner.
  app.post("/api/cycle/start", async (_request, reply) => {
    if (!QUEST_CYCLE_ENABLED) {
      return reply.code(503).send({
        status: "disabled",
        message: "Quest cycle is disabled. Set QUEST_CYCLE_ENABLED=1 to enable.",
      });
    }
    return reply.code(501).send({
      status: "not_implemented",
      message: "Cycle runner lands in phase-9f of the TS port.",
    });
  });

  // /api/potion/use — spend gold, heal HP or restore MP
  app.post<{ Body: { potion_id?: string } }>(
    "/api/potion/use",
    async (request, reply) => {
      const id = request.body?.potion_id ?? "";
      const potion = POTIONS[id];
      if (!potion) return reply.code(400).send({ error: "invalid potion" });
      if (!existsSync(STATE_FILE)) return reply.code(500).send({ error: "no state" });

      const state = JSON.parse(await readFile(STATE_FILE, "utf8")) as Record<string, unknown>;
      if (((state["gold"] as number) ?? 0) < potion.cost) {
        return reply.code(400).send({ error: "not_enough_gold" });
      }
      state["gold"] = ((state["gold"] as number) ?? 0) - potion.cost;
      const current = (state[potion.stat] as number) ?? 0;
      const max = (state[potion.max_stat] as number) ?? 100;
      state[potion.stat] = Math.min(current + potion.amount, max);
      await writeFile(STATE_FILE, JSON.stringify(state, null, 2));
      upsertState(state);
      manager.broadcast({ type: "state", data: state });
      return { ok: true, potion: potion.name, healed: potion.amount };
    },
  );

  // /api/skill/quest/sync — harmless write of templates/quest-skill.md to the
  // OpenClaw skills dir. Kept for parity; OpenClaw itself does not consume it.
  app.post("/api/skill/quest/sync", async () => {
    const templatePath = join(process.cwd(), "templates", "quest-skill.md");
    if (!existsSync(templatePath)) return { ok: false, reason: "template_missing" };
    await mkdir(QUEST_SKILL_DIR, { recursive: true });
    const raw = await readFile(templatePath, "utf8");
    await writeFile(join(QUEST_SKILL_DIR, "SKILL.md"), raw);
    return { ok: true };
  });

  // /api/regions — static decorative list, kept for backward compat
  app.get("/api/regions", async () => {
    const state = (existsSync(STATE_FILE)
      ? (JSON.parse(await readFile(STATE_FILE, "utf8")) as Record<string, unknown>)
      : {}) as Record<string, unknown>;
    const regions = [
      { id: "emerald_forest", name: "Emerald Forest", domain: "Basic programming", boss: "Syntax Serpent" },
      { id: "shadow_cavern", name: "Shadow Cavern", domain: "Debugging", boss: "Memory Leak Ghost" },
      { id: "iron_forge", name: "Iron Forge Castle", domain: "Architecture", boss: "Monolith Colossus" },
      { id: "flame_peaks", name: "Flame Peaks", domain: "Performance", boss: "Deadlock Demon" },
      { id: "starlight_academy", name: "Starlight Academy", domain: "AI/ML", boss: "Overfitting Lich" },
      { id: "abyssal_rift", name: "Abyssal Rift", domain: "Advanced", boss: "???" },
      { id: "guild", name: "Adventurer's Guild", domain: "Quests", boss: null },
    ];
    const unlocked = new Set((state["regions_unlocked"] as string[] | undefined) ?? []);
    const cleared = new Set((state["regions_cleared"] as string[] | undefined) ?? []);
    const current = state["current_region"] ?? "";
    return regions.map((r) => ({
      ...r,
      unlocked: unlocked.has(r.id),
      cleared: cleared.has(r.id),
      current: r.id === current,
    }));
  });

  // /api/tavern/ambient — cache read. Generate comes in 9e.
  app.get("/api/tavern/ambient", async () => {
    const { TAVERN_CACHE_FILE } = await import("../config.ts");
    if (existsSync(TAVERN_CACHE_FILE)) {
      try {
        return JSON.parse(await readFile(TAVERN_CACHE_FILE, "utf8"));
      } catch {
        /* fall through */
      }
    }
    return { messages: [], generated_at: null };
  });

  // Health and version info
  app.get("/api/health", async () => ({
    ok: true,
    backend: "typescript",
    ws_clients: manager.size(),
  }));
}

// Prevent unused import warnings under noUnusedLocals during incremental port.
export const _unused = stat;
