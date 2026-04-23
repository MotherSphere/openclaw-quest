/** Filesystem watcher + side-effect handler — port of server/watcher.py.
 *
 * Polls events.jsonl (byte-offset tail), state.json, knowledge-map.json,
 * and quests.json every N seconds. On change: inserts events into the DB,
 * updates the state row, and broadcasts via WebSocket. Also handles the
 * event-type → side-effect matrix (skill_drop → upsert_skill,
 * cycle_phase report → clear cycle.lock, etc.).
 *
 * Kept poll-based (not chokidar) for parity with the Python version —
 * works identically on every filesystem, no fsevents oddities. */

import { readFile, stat, unlink } from "node:fs/promises";
import { existsSync } from "node:fs";
import { createReadStream } from "node:fs";

import {
  CYCLE_LOCK_FILE,
  EVENTS_FILE,
  FEEDBACK_DIGEST_FILE,
  MAP_FILE,
  QUESTS_V2_FILE,
  STATE_FILE,
} from "./config.ts";
import {
  insertEvent,
  upsertQuest,
  upsertSkill,
  upsertState,
  type EventInput,
} from "./models.ts";
import { reclassifySkillsAfterSiteChange } from "./skill-classify.ts";
import { manager } from "./ws-manager.ts";

const SKILL_CLASSIFY_DEBOUNCE_MS = 30_000;
let skillClassifyTimer: ReturnType<typeof setTimeout> | null = null;

function queueSkillReclassify(): void {
  if (skillClassifyTimer) clearTimeout(skillClassifyTimer);
  skillClassifyTimer = setTimeout(() => {
    skillClassifyTimer = null;
    reclassifySkillsAfterSiteChange().catch((err) => {
      console.warn("[watcher] skill reclassify failed:", (err as Error).message);
    });
  }, SKILL_CLASSIFY_DEBOUNCE_MS);
}

const logger = {
  info: (msg: string, ...args: unknown[]) => console.log(`[watcher] ${msg}`, ...args),
  warn: (msg: string, ...args: unknown[]) => console.warn(`[watcher] ${msg}`, ...args),
  error: (msg: string, ...args: unknown[]) => console.error(`[watcher] ${msg}`, ...args),
};

export class QuestWatcher {
  private eventsPos = 0;
  private stateMtime = 0;
  private mapMtime = 0;
  private questsMtime = 0;
  private running = false;
  private timer: ReturnType<typeof setTimeout> | null = null;

  async initialSync(): Promise<void> {
    // Replay events.jsonl into the DB (events table was just dropped in
    // initDb so we start clean).
    if (existsSync(EVENTS_FILE)) {
      try {
        const content = await readFile(EVENTS_FILE, "utf8");
        for (const raw of content.split("\n")) {
          const line = raw.trim();
          if (!line) continue;
          try {
            const event = JSON.parse(line) as EventInput;
            insertEvent(event);
            await this.handleEventSideEffects(event);
          } catch {
            logger.warn("Skipping malformed event line during initial sync");
          }
        }
        const stats = await stat(EVENTS_FILE);
        this.eventsPos = stats.size;
      } catch (err) {
        logger.error("Initial events replay failed:", (err as Error).message);
      }
    }

    if (existsSync(STATE_FILE)) {
      try {
        const raw = await readFile(STATE_FILE, "utf8");
        const state = JSON.parse(raw) as Record<string, unknown>;
        upsertState(state);
        const stats = await stat(STATE_FILE);
        this.stateMtime = stats.mtimeMs;
      } catch (err) {
        logger.warn("Initial state load failed:", (err as Error).message);
      }
    }
  }

  async pollOnce(): Promise<void> {
    await this.pollEvents();
    await this.pollState();
    await this.pollMap();
    await this.pollQuests();
  }

  async start(intervalMs = 2000): Promise<void> {
    if (this.running) return;
    this.running = true;
    logger.info(`started (polling every ${intervalMs}ms)`);
    const loop = async (): Promise<void> => {
      if (!this.running) return;
      try {
        await this.pollOnce();
      } catch (err) {
        logger.error("poll error:", (err as Error).message);
      }
      this.timer = setTimeout(loop, intervalMs);
    };
    this.timer = setTimeout(loop, intervalMs);
  }

  stop(): void {
    this.running = false;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  private async pollEvents(): Promise<void> {
    if (!existsSync(EVENTS_FILE)) return;
    const stats = await stat(EVENTS_FILE);
    if (stats.size < this.eventsPos) {
      // File was truncated/rotated — restart from top.
      this.eventsPos = 0;
    }
    if (stats.size <= this.eventsPos) return;

    const tail = await readTail(EVENTS_FILE, this.eventsPos, stats.size);
    this.eventsPos = stats.size;

    for (const raw of tail.split("\n")) {
      const line = raw.trim();
      if (!line) continue;
      try {
        const event = JSON.parse(line) as EventInput;
        insertEvent(event);
        await this.handleEventSideEffects(event);
        manager.broadcast({ type: "event", data: event });
      } catch {
        logger.warn("Skipping malformed event line");
      }
    }
  }

  private async pollState(): Promise<void> {
    if (!existsSync(STATE_FILE)) return;
    try {
      const stats = await stat(STATE_FILE);
      if (stats.mtimeMs <= this.stateMtime) return;
      this.stateMtime = stats.mtimeMs;
      const raw = await readFile(STATE_FILE, "utf8");
      const state = JSON.parse(raw) as Record<string, unknown>;
      upsertState(state);
      manager.broadcast({ type: "state", data: state });
    } catch {
      /* json/io error — try again next tick */
    }
  }

  private async pollMap(): Promise<void> {
    if (!existsSync(MAP_FILE)) return;
    try {
      const stats = await stat(MAP_FILE);
      if (stats.mtimeMs <= this.mapMtime) return;
      this.mapMtime = stats.mtimeMs;
      const raw = await readFile(MAP_FILE, "utf8");
      const mapData = JSON.parse(raw);
      manager.broadcast({ type: "map", data: mapData });
    } catch {
      /* retry */
    }
  }

  private async pollQuests(): Promise<void> {
    if (!existsSync(QUESTS_V2_FILE)) return;
    try {
      const stats = await stat(QUESTS_V2_FILE);
      if (stats.mtimeMs <= this.questsMtime) return;
      this.questsMtime = stats.mtimeMs;
      const raw = await readFile(QUESTS_V2_FILE, "utf8");
      const quests = JSON.parse(raw);
      manager.broadcast({ type: "quest", data: { quests } });
    } catch {
      /* retry */
    }
  }

  private async handleEventSideEffects(event: EventInput): Promise<void> {
    const etype = event.type ?? event.event ?? "";
    const data = (event.data ?? {}) as Record<string, unknown>;
    const ts = event.ts ?? event.timestamp ?? null;

    if (etype === "cycle_phase") {
      if (data["phase"] === "report") {
        try {
          if (existsSync(CYCLE_LOCK_FILE)) await unlink(CYCLE_LOCK_FILE);
        } catch {
          logger.warn("Failed to clear cycle lock after report phase");
        }
      }

      let feedbackInfluenced = false;
      if (data["phase"] === "reflect") {
        try {
          if (existsSync(FEEDBACK_DIGEST_FILE)) {
            const raw = await readFile(FEEDBACK_DIGEST_FILE, "utf8");
            const digest = JSON.parse(raw) as {
              summary?: { total_positive?: number; total_negative?: number };
            };
            const total =
              (digest.summary?.total_positive ?? 0) + (digest.summary?.total_negative ?? 0);
            feedbackInfluenced = total > 0;
          }
        } catch {
          /* ignore */
        }
      }

      manager.broadcast({
        type: "cycle_progress",
        data: {
          phase: data["phase"] ?? "unknown",
          summary: data["summary"] ?? data["detail"] ?? "",
          target_workflow: data["target_workflow"] ?? null,
          reason: data["reason"] ?? null,
          progress: data["progress"] ?? null,
          outcomes: data["outcomes"] ?? null,
          feedback_influenced: feedbackInfluenced,
          ts,
        },
      });
      return;
    }

    if (etype === "skill_drop") {
      const skillName = (data["skill"] as string | undefined) ?? "";
      if (!skillName.trim()) return;
      upsertSkill({
        name: skillName,
        rarity: (data["rarity"] as string) ?? "common",
        category: (data["category"] as string | null) ?? null,
        version: (data["version"] as number) ?? 1,
        created_at: ts,
        updated_at: ts,
        source: "training",
      });
      queueSkillReclassify();
      return;
    }

    if (etype === "hub_acquire") {
      const skillName = (data["skill"] as string | undefined) ?? "";
      if (!skillName.trim()) return;
      upsertSkill({
        name: skillName,
        rarity: "epic",
        category: null,
        version: 1,
        created_at: ts,
        updated_at: ts,
        source: (data["source"] as string) ?? "hub",
      });
      queueSkillReclassify();
      return;
    }

    if (etype === "quest_accept") {
      upsertQuest({
        id: (data["quest_id"] as string) ?? "",
        title: (data["title"] as string) ?? "",
        description: "",
        rank: "C",
        status: "active",
        reward_gold: (data["reward_gold"] as number) ?? null,
        reward_xp: (data["reward_xp"] as number) ?? null,
        created_at: ts,
        completed_at: null,
      });
      return;
    }

    if (etype === "quest_complete" || etype === "quest_fail") {
      const status = etype === "quest_complete" ? "completed" : "failed";
      const questId = (data["quest_id"] as string) ?? "";
      upsertQuest({ id: questId, title: "", status, completed_at: ts });
      // Also update quests.json so /api/quest/active reflects the change.
      if (questId && existsSync(QUESTS_V2_FILE)) {
        try {
          const raw = await readFile(QUESTS_V2_FILE, "utf8");
          const qs = JSON.parse(raw) as Array<Record<string, unknown>>;
          let mutated = false;
          for (const q of qs) {
            if (q["id"] === questId) {
              q["status"] = status;
              q["completed_at"] = ts;
              mutated = true;
              break;
            }
          }
          if (mutated) {
            const { writeFile } = await import("node:fs/promises");
            await writeFile(QUESTS_V2_FILE, JSON.stringify(qs, null, 2));
          }
        } catch {
          /* retry later */
        }
      }
    }
  }
}

async function readTail(path: string, from: number, to: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    const stream = createReadStream(path, { start: from, end: to - 1, encoding: "utf8" });
    stream.on("data", (chunk) => chunks.push(Buffer.from(chunk as string)));
    stream.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    stream.on("error", reject);
  });
}
