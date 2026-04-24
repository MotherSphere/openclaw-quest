/** Shared state-mutation helpers for quest completion + failure.
 *
 * The auto-cycle (`quest-cycle.ts`) and the manual HTTP path
 * (`routes/quests.ts`) both need to award XP/gold, loop level-ups, and
 * apply HP/MP penalties. Before this module existed the two paths each
 * inlined their own copy of the arithmetic, which drifted — notably
 * the +MP bonus on level-up lived only in the manual path, and the
 * fail penalty lived only in the HTTP route.
 *
 * These helpers mutate the `state` record in place and return a small
 * summary object the caller can include in broadcasts / responses.
 * Pure functions — no I/O, no LLM, deterministic. */

import { GAME_BALANCE } from "./config.ts";

export interface CompletionRewardsInput {
  /** XP awarded. Caller picks between quest.reward_xp and GAME_BALANCE.default_reward_xp. */
  xp: number;
  /** Gold awarded. Caller picks between quest.reward_gold and GAME_BALANCE.default_reward_gold. */
  gold: number;
  /** If the reward triggers a level-up, restore this many MP (clamped to mp_max).
   *  Pass 0 to preserve legacy auto-cycle behaviour (no MP bonus). */
  mpBonusOnLevelUp?: number;
}

export interface CompletionRewardsResult {
  leveledUp: boolean;
  /** How many levels gained (0 when no level-up). */
  levelsGained: number;
}

/** Loop level-ups until `xp < xp_to_next`. Every level-up:
 *  - increments `level`
 *  - recomputes `xp_to_next = level * xp_per_level`
 *  - recomputes `hp_max = hp_base + level * hp_per_level`
 *  - resets `hp = hp_max` (full heal, upstream Python parity)
 *
 *  If at least one level-up happened and `mpBonusOnLevelUp > 0`, also
 *  restores that many MP (clamped to `mp_max`).
 *
 *  Separated from `applyCompletionRewards` so the auto-cycle — which
 *  accumulates XP from multiple sources (quest reward + per-cycle bonus)
 *  before deciding to level up — can call this once at the end instead
 *  of each source triggering its own level-up pass.
 *
 *  Mutates `state` in place. */
export function applyLevelUps(
  state: Record<string, unknown>,
  opts: { mpBonusOnLevelUp?: number } = {},
): CompletionRewardsResult {
  const startingLevel = Number(state["level"] ?? 1);
  if (state["xp_to_next"] === undefined || state["xp_to_next"] === null) {
    state["xp_to_next"] = startingLevel * GAME_BALANCE.xp_per_level;
  }
  while (Number(state["xp"] ?? 0) >= Number(state["xp_to_next"])) {
    state["xp"] = Number(state["xp"]) - Number(state["xp_to_next"]);
    state["level"] = Number(state["level"] ?? 1) + 1;
    state["xp_to_next"] = Number(state["level"]) * GAME_BALANCE.xp_per_level;
    state["hp_max"] =
      GAME_BALANCE.hp_base + Number(state["level"]) * GAME_BALANCE.hp_per_level;
    state["hp"] = state["hp_max"];
  }

  const levelsGained = Number(state["level"] ?? startingLevel) - startingLevel;
  const leveledUp = levelsGained > 0;
  if (leveledUp && opts.mpBonusOnLevelUp && opts.mpBonusOnLevelUp > 0) {
    const mpMax = Number(state["mp_max"] ?? GAME_BALANCE.mp_max);
    state["mp"] = Math.min(Number(state["mp"] ?? 0) + opts.mpBonusOnLevelUp, mpMax);
  }

  return { leveledUp, levelsGained };
}

/** Award XP + gold from a quest completion, then loop level-ups.
 *  Convenience wrapper over `applyLevelUps` for the single-source path
 *  (HTTP `/api/quest/complete`). Mutates `state` in place. */
export function applyCompletionRewards(
  state: Record<string, unknown>,
  input: CompletionRewardsInput,
): CompletionRewardsResult {
  state["xp"] = Number(state["xp"] ?? 0) + input.xp;
  state["gold"] = Number(state["gold"] ?? 0) + input.gold;
  return applyLevelUps(state, { mpBonusOnLevelUp: input.mpBonusOnLevelUp });
}

export interface FailPenaltyInput {
  /** HP to subtract (clamped to 0). */
  hp: number;
  /** MP to subtract (clamped to 0). */
  mp: number;
}

export interface FailPenaltyResult {
  /** True when the new HP is <= 0. Caller should set
   *  `state.reflection_letter_pending = true` — we let the caller decide
   *  so existing call sites keep control of the exact flag semantics. */
  hpDepleted: boolean;
}

/** Subtract HP + MP penalties, clamp both to 0. Mutates state. */
export function applyFailPenalty(
  state: Record<string, unknown>,
  input: FailPenaltyInput,
): FailPenaltyResult {
  state["hp"] = Math.max(0, Number(state["hp"] ?? 100) - input.hp);
  state["mp"] = Math.max(0, Number(state["mp"] ?? 100) - input.mp);
  const hpDepleted = (state["hp"] as number) <= 0;
  return { hpDepleted };
}
