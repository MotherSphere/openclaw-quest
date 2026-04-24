/** /api/quests + /api/quest/* — quest CRUD.
 *
 * Quests live in both quests.json (frontend-friendly shape, watcher
 * broadcasts on mtime change) and the SQLite `quests` table (legacy DB
 * surface — the watcher mirrors quest_accept/complete/fail events into
 * it). This module reads/writes both when they disagree. */

import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import type { FastifyInstance } from "fastify";

import { EVENTS_FILE, GAME_BALANCE, QUESTS_V2_FILE, STATE_FILE } from "../config.ts";
import { manager } from "../ws-manager.ts";
import { getQuests, insertEvent, upsertState } from "../models.ts";

interface Quest {
  id: string;
  title: string;
  description?: string;
  rank?: string;
  status?: string;
  workflow_id?: string | null;
  reward_xp?: number;
  reward_gold?: number;
  created_at?: string;
  completed_at?: string | null;
  source?: string;
}

async function readQuestsJson(): Promise<Quest[]> {
  if (!existsSync(QUESTS_V2_FILE)) return [];
  try {
    const raw = await readFile(QUESTS_V2_FILE, "utf8");
    return JSON.parse(raw) as Quest[];
  } catch {
    return [];
  }
}

async function writeQuestsJson(quests: Quest[]): Promise<void> {
  await writeFile(QUESTS_V2_FILE, JSON.stringify(quests, null, 2));
}

function rewardsFor(rank: string): { xp: number; gold: number } {
  const key = `reward_${rank}` as const;
  const preset = (GAME_BALANCE as Record<string, unknown>)[key] as
    | { xp_base?: number; gold_base?: number }
    | undefined;
  return {
    xp: preset?.xp_base ?? GAME_BALANCE.default_reward_xp,
    gold: preset?.gold_base ?? GAME_BALANCE.default_reward_gold,
  };
}

export async function registerQuestRoutes(app: FastifyInstance): Promise<void> {
  app.get<{ Querystring: { status?: string } }>("/api/quests", async (request) => {
    const quests = await readQuestsJson();
    if (request.query.status) {
      return quests.filter((q) => q.status === request.query.status);
    }
    return quests;
  });

  app.get("/api/quest/active", async () => {
    const quests = await readQuestsJson();
    const active = quests.filter(
      (q) => q.status === "active" || q.status === "in_progress" || q.status === "pending",
    );
    const completed = quests.filter((q) => q.status === "completed");
    return { quests: active, completed_count: completed.length };
  });

  app.post<{
    Body: { title?: string; description?: string; rank?: string; workflow_id?: string };
  }>("/api/quest/create", async (request, reply) => {
    const body = request.body ?? {};
    const title = (body.title ?? "").trim();
    if (!title || title.length > 80) {
      return reply.code(400).send({ error: "title required (1-80 chars)" });
    }
    const rank = (body.rank ?? "C").toUpperCase();
    if (!["A", "B", "C"].includes(rank)) {
      return reply.code(400).send({ error: "rank must be A|B|C" });
    }
    const rewards = rewardsFor(rank);
    const quests = await readQuestsJson();
    const slug = title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "") || "quest";
    const quest: Quest = {
      id: `${slug}-${Math.floor(Date.now() / 1000)}`,
      title,
      description: body.description ?? "",
      rank,
      status: "active",
      workflow_id: body.workflow_id ?? null,
      reward_xp: rewards.xp,
      reward_gold: rewards.gold,
      created_at: new Date().toISOString(),
      source: "user",
    };
    quests.push(quest);
    await writeQuestsJson(quests);
    manager.broadcast({
      type: "quest",
      data: {
        quests: quests.filter(
          (q) => q.status === "active" || q.status === "in_progress" || q.status === "pending",
        ),
      },
    });
    return { ok: true, quest };
  });

  app.post<{ Body: { quest_id?: string; title?: string; description?: string; rank?: string } }>(
    "/api/quest/edit",
    async (request, reply) => {
      const body = request.body ?? {};
      const questId = body.quest_id;
      if (!questId) return reply.code(400).send({ error: "quest_id required" });
      const quests = await readQuestsJson();
      const q = quests.find((x) => x.id === questId);
      if (!q) return reply.code(404).send({ error: "quest_not_found" });
      if (body.title !== undefined) q.title = body.title.slice(0, 80);
      if (body.description !== undefined) q.description = body.description.slice(0, 240);
      if (body.rank && ["A", "B", "C"].includes(body.rank.toUpperCase())) {
        q.rank = body.rank.toUpperCase();
      }
      await writeQuestsJson(quests);
      manager.broadcast({
        type: "quest",
        data: {
          quests: quests.filter(
            (qq) => qq.status === "active" || qq.status === "in_progress" || qq.status === "pending",
          ),
        },
      });
      return { ok: true, quest: q };
    },
  );

  app.post<{ Body: { quest_id?: string } }>(
    "/api/quest/cancel",
    async (request, reply) => {
      const questId = request.body?.quest_id;
      if (!questId) return reply.code(400).send({ error: "quest_id required" });
      const quests = await readQuestsJson();
      const remaining = quests.filter((q) => q.id !== questId);
      if (remaining.length === quests.length) {
        return reply.code(404).send({ error: "quest_not_found" });
      }
      await writeQuestsJson(remaining);
      manager.broadcast({
        type: "quest",
        data: {
          quests: remaining.filter(
            (q) => q.status === "active" || q.status === "in_progress" || q.status === "pending",
          ),
        },
      });
      return { ok: true };
    },
  );

  app.post<{ Body: { quest_id?: string } }>(
    "/api/quest/accept",
    async (request, reply) => {
      const questId = request.body?.quest_id;
      if (!questId) return reply.code(400).send({ error: "quest_id required" });
      const quests = await readQuestsJson();
      const q = quests.find((x) => x.id === questId);
      if (!q) return reply.code(404).send({ error: "quest_not_found" });
      if (q.status !== "pending" && q.status !== "active") {
        return reply.code(400).send({ error: "quest not available" });
      }
      q.status = "active";
      await writeQuestsJson(quests);
      manager.broadcast({
        type: "quest",
        data: {
          quests: quests.filter(
            (qq) => qq.status === "active" || qq.status === "in_progress" || qq.status === "pending",
          ),
        },
      });
      return { ok: true, quest: q };
    },
  );

  app.post<{ Body: { quest_id?: string } }>(
    "/api/quest/fail",
    async (request, reply) => {
      const questId = request.body?.quest_id;
      if (!questId) return reply.code(400).send({ error: "quest_id required" });
      const quests = await readQuestsJson();
      const q = quests.find(
        (x) =>
          x.id === questId &&
          (x.status === "active" || x.status === "in_progress" || x.status === "pending"),
      );
      if (!q) return reply.code(404).send({ error: "quest_not_found_or_not_active" });
      q.status = "failed";
      q.completed_at = new Date().toISOString();
      await writeQuestsJson(quests);

      // Apply HP/MP penalties (port of hermes-quest server/main.py quest_fail).
      // If HP hits zero, queue the reflection letter so the UI surfaces it.
      const hpPenalty = GAME_BALANCE.fail_hp_penalty;
      const mpPenalty = GAME_BALANCE.fail_mp_penalty;
      let state: Record<string, unknown> = {};
      if (existsSync(STATE_FILE)) {
        try {
          state = JSON.parse(await readFile(STATE_FILE, "utf8")) as Record<string, unknown>;
        } catch {
          state = {};
        }
      }
      state["hp"] = Math.max(0, Number(state["hp"] ?? 100) - hpPenalty);
      state["mp"] = Math.max(0, Number(state["mp"] ?? 100) - mpPenalty);
      if ((state["hp"] as number) <= 0) state["reflection_letter_pending"] = true;
      await writeFile(STATE_FILE, JSON.stringify(state, null, 2));
      upsertState(state);

      const event = {
        ts: new Date().toISOString(),
        type: "quest_fail",
        region: null,
        data: {
          quest_id: questId,
          title: q.title ?? "",
          hp_penalty: hpPenalty,
          mp_penalty: mpPenalty,
        },
      };
      await writeFile(EVENTS_FILE, JSON.stringify(event) + "\n", { flag: "a" });
      insertEvent(event);

      manager.broadcast({ type: "state", data: state });
      manager.broadcast({ type: "event", data: event });
      manager.broadcast({
        type: "quest",
        data: {
          quests: quests.filter(
            (qq) => qq.status === "active" || qq.status === "in_progress" || qq.status === "pending",
          ),
        },
      });
      return {
        ok: true,
        quest_id: questId,
        hp_penalty: hpPenalty,
        mp_penalty: mpPenalty,
      };
    },
  );

  app.post<{ Body: { quest_id?: string } }>(
    "/api/quest/complete",
    async (request, reply) => {
      const questId = request.body?.quest_id;
      if (!questId) return reply.code(400).send({ error: "quest_id required" });
      const quests = await readQuestsJson();
      const q = quests.find(
        (x) =>
          x.id === questId &&
          (x.status === "active" || x.status === "in_progress" || x.status === "pending"),
      );
      if (!q) return reply.code(404).send({ error: "quest_not_found_or_already_completed" });
      q.status = "completed";
      q.completed_at = new Date().toISOString();
      await writeQuestsJson(quests);

      // Award XP + gold, handle level-ups (port of hermes-quest main.py:1435-1466).
      // The auto quest-cycle path has its own inline copy of this logic in
      // quest-cycle.ts:completeTargetQuest; keep both in sync.
      const xpReward = Number(q.reward_xp ?? GAME_BALANCE.default_reward_xp);
      const goldReward = Number(q.reward_gold ?? GAME_BALANCE.default_reward_gold);
      let state: Record<string, unknown> = {};
      if (existsSync(STATE_FILE)) {
        try {
          state = JSON.parse(await readFile(STATE_FILE, "utf8")) as Record<string, unknown>;
        } catch {
          state = {};
        }
      }
      state["xp"] = Number(state["xp"] ?? 0) + xpReward;
      state["gold"] = Number(state["gold"] ?? 0) + goldReward;
      let leveledUp = false;
      while (
        Number(state["xp"] ?? 0) >=
        Number(state["xp_to_next"] ?? Number(state["level"] ?? 1) * GAME_BALANCE.xp_per_level)
      ) {
        state["xp"] = Number(state["xp"]) - Number(state["xp_to_next"]);
        state["level"] = Number(state["level"] ?? 1) + 1;
        state["xp_to_next"] = Number(state["level"]) * GAME_BALANCE.xp_per_level;
        state["hp_max"] =
          GAME_BALANCE.hp_base + Number(state["level"]) * GAME_BALANCE.hp_per_level;
        state["hp"] = state["hp_max"];
        leveledUp = true;
      }
      if (leveledUp) {
        const mpMax = Number(state["mp_max"] ?? GAME_BALANCE.mp_max);
        state["mp"] = Math.min(
          Number(state["mp"] ?? 0) + GAME_BALANCE.levelup_mp_restore,
          mpMax,
        );
      }
      if ((state["hp"] as number) <= 0) state["reflection_letter_pending"] = true;
      await writeFile(STATE_FILE, JSON.stringify(state, null, 2));
      upsertState(state);

      const event = {
        ts: new Date().toISOString(),
        type: "quest_complete",
        region: null,
        data: {
          quest_id: questId,
          title: q.title ?? "",
          reward_xp: xpReward,
          reward_gold: goldReward,
          leveled_up: leveledUp,
        },
      };
      await writeFile(EVENTS_FILE, JSON.stringify(event) + "\n", { flag: "a" });
      insertEvent(event);

      manager.broadcast({ type: "state", data: state });
      manager.broadcast({ type: "event", data: event });
      manager.broadcast({
        type: "quest",
        data: {
          quests: quests.filter(
            (qq) => qq.status === "active" || qq.status === "in_progress" || qq.status === "pending",
          ),
        },
      });
      return {
        ok: true,
        quest_id: questId,
        reward_xp: xpReward,
        reward_gold: goldReward,
        leveled_up: leveledUp,
      };
    },
  );

  // Kept for legacy DB read
  app.get<{ Querystring: { status?: string } }>(
    "/api/quests/db",
    async (request) => getQuests(request.query.status ?? null),
  );
}
