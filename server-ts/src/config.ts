/** Paths, env-driven knobs, and GAME_BALANCE constants — port of server/config.py.
 *
 * Every path resolves lazily from $HOME at import time so test environments
 * that override HOME get a consistent tree without any module reloads. The
 * AGENT_RUNTIME_BIN lookup mirrors Python's shutil.which fallback chain. */

import { homedir } from "node:os";
import { existsSync } from "node:fs";
import { join } from "node:path";

const HOME = homedir();

export const OPENCLAW_HOME = process.env.QUEST_OPENCLAW_HOME ?? join(HOME, ".openclaw");
export const QUEST_DIR = join(OPENCLAW_HOME, "quest");

export const EVENTS_FILE = join(QUEST_DIR, "events.jsonl");
export const STATE_FILE = join(QUEST_DIR, "state.json");
export const MAP_FILE = join(QUEST_DIR, "knowledge-map.json");
export const QUESTS_V2_FILE = join(QUEST_DIR, "quests.json");
export const QUESTS_PENDING_FILE = join(QUEST_DIR, "quests-pending.json");
export const HUB_RECOMMENDATIONS_FILE = join(QUEST_DIR, "hub-recommendations.json");
export const COMPLETIONS_DIR = join(QUEST_DIR, "completions");
export const ACCEPTED_REC_IDS_FILE = join(QUEST_DIR, "accepted_rec_ids.json");
export const BAG_FILE = join(QUEST_DIR, "bag.json");
export const CYCLE_LOCK_FILE = join(QUEST_DIR, "cycle.lock");
export const CYCLE_LOG_FILE = join(QUEST_DIR, "cycle.log");
export const REFLECTION_LETTER_FILE = join(QUEST_DIR, "reflection-letter.md");
export const TAVERN_CACHE_FILE = join(QUEST_DIR, "tavern-ambient.json");
export const SITES_FILE = join(QUEST_DIR, "sites.json");
export const FEEDBACK_DIGEST_FILE = join(QUEST_DIR, "feedback-digest.json");
export const QUEST_SKILL_DIR = join(OPENCLAW_HOME, "skills", "quest");
export const SKILLS_DIR = join(OPENCLAW_HOME, "skills");
export const DB_PATH = join(QUEST_DIR, "quest.db");

/** Path to the `openclaw` CLI binary. Shelled out to by the cycle runner,
 * NPC chat, and the ClawHub endpoints. */
function resolveAgentBin(): string {
  const override = process.env.QUEST_OPENCLAW_BIN;
  if (override && existsSync(override)) return override;
  // Mirror shutil.which("openclaw") — probe $PATH directories.
  const paths = (process.env.PATH ?? "").split(":");
  for (const p of paths) {
    if (!p) continue;
    const candidate = join(p, "openclaw");
    if (existsSync(candidate)) return candidate;
  }
  return "/usr/bin/openclaw";
}

export const AGENT_RUNTIME_BIN = resolveAgentBin();

export const QUEST_CYCLE_PROMPT = process.env.QUEST_CYCLE_PROMPT ?? "Run quest evolution cycle";
export const QUEST_CYCLE_ENABLED = process.env.QUEST_CYCLE_ENABLED === "1";
export const QUEST_CYCLE_AGENT_ID = process.env.QUEST_CYCLE_AGENT_ID ?? "main";
export const QUEST_CYCLE_THINKING = process.env.QUEST_CYCLE_THINKING ?? "minimal";
export const QUEST_CYCLE_LLM_TIMEOUT_MS =
  Number.parseInt(process.env.QUEST_CYCLE_LLM_TIMEOUT ?? "90", 10) * 1000;

export const PORT = Number.parseInt(process.env.QUEST_PORT ?? "8420", 10);
export const HOST = process.env.QUEST_HOST ?? "0.0.0.0";
export const INTERNAL_API_ORIGIN =
  process.env.QUEST_INTERNAL_API_ORIGIN ?? `http://127.0.0.1:${PORT}`;

export const QUEST_API_KEY = process.env.QUEST_API_KEY ?? "";

export const MODEL = process.env.QUEST_MODEL ?? "gpt-5.4-mini";
export const NPC_MODEL = process.env.QUEST_NPC_MODEL ?? "gpt-5.4-mini";

export const GAME_BALANCE = {
  hp_potion_cost: 200,
  hp_potion_heal: 20,
  mp_potion_cost: 150,
  mp_potion_heal: 20,
  refresh_cost: 50,
  quest_create_cost: 0,
  quest_retry_cost: 50,
  skill_install_cost: 300,
  feedback_mp_delta: 15,
  xp_per_level: 100,
  hp_base: 50,
  hp_per_level: 10,
  mp_max: 100,
  levelup_mp_restore: 30,
  mp_decay_rate: 2,
  mp_decay_grace_days: 1,
  reward_C: { gold_base: 100, gold_per_level: 15, xp_base: 100, xp_per_level: 25 },
  reward_B: { gold_base: 150, gold_per_level: 20, xp_base: 150, xp_per_level: 30 },
  reward_A: { gold_base: 200, gold_per_level: 30, xp_base: 200, xp_per_level: 50 },
  default_reward_xp: 100,
  default_reward_gold: 50,
  default_create_reward_xp: 300,
  default_create_reward_gold: 200,
  reflection_hp_recovery_ratio: 0.2,
  cycle_lock_timeout: 1800,
  tavern_gen_timeout: 60,
  fail_hp_penalty: 15,
  fail_mp_penalty: 10,
  weak_mastery_threshold: 0.5,
  rank_c_mastery_threshold: 15,
} as const;

export type GameBalance = typeof GAME_BALANCE;
