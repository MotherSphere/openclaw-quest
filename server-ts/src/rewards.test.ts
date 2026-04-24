import { describe, expect, test } from "bun:test";

import { GAME_BALANCE } from "./config.ts";
import {
  applyCompletionRewards,
  applyFailPenalty,
  applyLevelUps,
} from "./rewards.ts";

function baseState(): Record<string, unknown> {
  return {
    hp: 50,
    hp_max: 60,
    mp: 40,
    mp_max: GAME_BALANCE.mp_max,
    xp: 0,
    xp_to_next: GAME_BALANCE.xp_per_level, // 100 at level 1
    gold: 0,
    level: 1,
  };
}

describe("applyCompletionRewards", () => {
  test("adds xp + gold without leveling when below threshold", () => {
    const s = baseState();
    const result = applyCompletionRewards(s, { xp: 40, gold: 50 });
    expect(s["xp"]).toBe(40);
    expect(s["gold"]).toBe(50);
    expect(s["level"]).toBe(1);
    expect(result).toEqual({ leveledUp: false, levelsGained: 0 });
  });

  test("level-up loop bumps level, recomputes hp_max, resets hp", () => {
    const s = baseState();
    const result = applyCompletionRewards(s, { xp: 100, gold: 0 });
    expect(s["level"]).toBe(2);
    expect(s["xp"]).toBe(0);
    expect(s["xp_to_next"]).toBe(2 * GAME_BALANCE.xp_per_level);
    expect(s["hp_max"]).toBe(GAME_BALANCE.hp_base + 2 * GAME_BALANCE.hp_per_level);
    expect(s["hp"]).toBe(s["hp_max"]);
    expect(result).toEqual({ leveledUp: true, levelsGained: 1 });
  });

  test("huge xp drop triggers multiple level-ups in one call", () => {
    const s = baseState();
    // 100 (lvl 1→2) + 200 (lvl 2→3) + 300 (lvl 3→4) = 600 covers 3 level-ups
    const result = applyCompletionRewards(s, { xp: 600, gold: 0 });
    expect(s["level"]).toBe(4);
    expect(result.levelsGained).toBe(3);
  });

  test("mpBonusOnLevelUp > 0 restores MP clamped to max on level-up", () => {
    const s = baseState();
    applyCompletionRewards(s, { xp: 100, gold: 0, mpBonusOnLevelUp: 30 });
    expect(s["mp"]).toBe(70); // 40 + 30
  });

  test("mpBonusOnLevelUp clamped to mp_max", () => {
    const s = baseState();
    s["mp"] = 95;
    applyCompletionRewards(s, { xp: 100, gold: 0, mpBonusOnLevelUp: 30 });
    expect(s["mp"]).toBe(s["mp_max"]); // 100
  });

  test("mpBonusOnLevelUp=0 (default) leaves MP alone even on level-up", () => {
    const s = baseState();
    applyCompletionRewards(s, { xp: 100, gold: 0 });
    expect(s["mp"]).toBe(40); // unchanged
  });

  test("mpBonusOnLevelUp is ignored when no level-up happened", () => {
    const s = baseState();
    applyCompletionRewards(s, { xp: 20, gold: 0, mpBonusOnLevelUp: 30 });
    expect(s["mp"]).toBe(40); // unchanged
  });

  test("missing state fields fall back to sensible defaults", () => {
    const s: Record<string, unknown> = {};
    applyCompletionRewards(s, { xp: 100, gold: 50 });
    expect(s["xp"]).toBe(0);
    expect(s["gold"]).toBe(50);
    expect(s["level"]).toBe(2);
  });

  test("does not touch unrelated keys", () => {
    const s = baseState();
    s["total_cycles"] = 17;
    s["name"] = "Hero";
    applyCompletionRewards(s, { xp: 10, gold: 5 });
    expect(s["total_cycles"]).toBe(17);
    expect(s["name"]).toBe("Hero");
  });
});

describe("applyLevelUps", () => {
  test("no-op when xp below threshold", () => {
    const s = baseState();
    s["xp"] = 50;
    const result = applyLevelUps(s);
    expect(s["level"]).toBe(1);
    expect(result).toEqual({ leveledUp: false, levelsGained: 0 });
  });

  test("levels up when xp meets threshold", () => {
    const s = baseState();
    s["xp"] = 150; // already accumulated by caller
    const result = applyLevelUps(s);
    expect(s["level"]).toBe(2);
    expect(s["xp"]).toBe(50);
    expect(result.levelsGained).toBe(1);
  });

  test("honors mpBonusOnLevelUp option", () => {
    const s = baseState();
    s["xp"] = 100;
    applyLevelUps(s, { mpBonusOnLevelUp: 30 });
    expect(s["mp"]).toBe(70);
  });

  test("materializes missing xp_to_next", () => {
    const s: Record<string, unknown> = { xp: 200, level: 1 };
    const result = applyLevelUps(s);
    expect(result.leveledUp).toBe(true);
    // No NaN regressions — xp should be a real number after loop
    expect(typeof s["xp"]).toBe("number");
    expect(Number.isNaN(s["xp"])).toBe(false);
  });
});

describe("applyFailPenalty", () => {
  test("subtracts hp + mp, returns hpDepleted=false when hp > 0", () => {
    const s = baseState();
    const r = applyFailPenalty(s, { hp: 10, mp: 5 });
    expect(s["hp"]).toBe(40);
    expect(s["mp"]).toBe(35);
    expect(r.hpDepleted).toBe(false);
  });

  test("clamps hp + mp to 0 and flags depleted", () => {
    const s = baseState();
    s["hp"] = 3;
    s["mp"] = 1;
    const r = applyFailPenalty(s, { hp: 15, mp: 10 });
    expect(s["hp"]).toBe(0);
    expect(s["mp"]).toBe(0);
    expect(r.hpDepleted).toBe(true);
  });

  test("hpDepleted=true when hp exactly 0", () => {
    const s = baseState();
    s["hp"] = 15;
    const r = applyFailPenalty(s, { hp: 15, mp: 0 });
    expect(s["hp"]).toBe(0);
    expect(r.hpDepleted).toBe(true);
  });

  test("missing hp/mp defaults to 100 (upstream default)", () => {
    const s: Record<string, unknown> = {};
    const r = applyFailPenalty(s, { hp: 15, mp: 10 });
    expect(s["hp"]).toBe(85);
    expect(s["mp"]).toBe(90);
    expect(r.hpDepleted).toBe(false);
  });
});
