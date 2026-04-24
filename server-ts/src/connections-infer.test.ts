import { describe, expect, test } from "bun:test";

import { inferConnections, jaccard, type WorkflowLike } from "./connections-infer.ts";

describe("jaccard", () => {
  test("identical sets → 1", () => {
    expect(jaccard(["a", "b"], ["a", "b"])).toBe(1);
  });

  test("disjoint sets → 0", () => {
    expect(jaccard(["a"], ["b"])).toBe(0);
  });

  test("partial overlap", () => {
    expect(jaccard(["a", "b", "c"], ["b", "c", "d"])).toBeCloseTo(0.5, 5);
  });

  test("empty on one side → 0", () => {
    expect(jaccard([], ["a"])).toBe(0);
  });

  test("deduplicates within a set", () => {
    expect(jaccard(["a", "a", "b"], ["a", "b"])).toBe(1);
  });

  test("ignores empty strings", () => {
    expect(jaccard(["a", "", "  "], ["a"])).toBe(1);
  });
});

describe("inferConnections", () => {
  test("no overlap → no connections", () => {
    const workflows: WorkflowLike[] = [
      { id: "alpha", skills_involved: ["a", "b"] },
      { id: "beta", skills_involved: ["c", "d"] },
    ];
    expect(inferConnections(workflows)).toEqual([]);
  });

  test("full overlap → one complementary connection, strength 1", () => {
    const workflows: WorkflowLike[] = [
      { id: "alpha", skills_involved: ["a", "b"] },
      { id: "beta", skills_involved: ["a", "b"] },
    ];
    expect(inferConnections(workflows)).toEqual([
      { from: "alpha", to: "beta", type: "complementary", strength: 1 },
    ]);
  });

  test("below MIN_OVERLAP (0.15) → dropped", () => {
    const workflows: WorkflowLike[] = [
      // 1 shared out of 10 union = 0.1 < 0.15
      { id: "a", skills_involved: ["s1", "s2", "s3", "s4", "s5"] },
      { id: "b", skills_involved: ["s1", "x1", "x2", "x3", "x4"] },
    ];
    expect(inferConnections(workflows)).toEqual([]);
  });

  test("at/above MIN_OVERLAP → kept", () => {
    const workflows: WorkflowLike[] = [
      // 2 shared out of 6 union = 0.333
      { id: "a", skills_involved: ["s1", "s2", "s3", "s4"] },
      { id: "b", skills_involved: ["s1", "s2", "x1", "x2"] },
    ];
    const conns = inferConnections(workflows);
    expect(conns).toHaveLength(1);
    expect(conns[0]).toMatchObject({ from: "a", to: "b", type: "complementary" });
    expect(conns[0]!.strength).toBeCloseTo(0.33, 2);
  });

  test("three workflows with chain of overlaps → two connections", () => {
    const workflows: WorkflowLike[] = [
      { id: "frontend", skills_involved: ["react", "css", "ui"] },
      { id: "backend", skills_involved: ["react", "api", "db"] }, // shares react w/ frontend
      { id: "devops", skills_involved: ["api", "db", "deploy"] }, // shares api+db w/ backend
    ];
    const conns = inferConnections(workflows);
    expect(conns.map((c) => `${c.from}→${c.to}`)).toEqual(["backend→devops", "backend→frontend"]);
  });

  test("output is sorted (stable) by (from, to)", () => {
    const workflows: WorkflowLike[] = [
      { id: "c", skills_involved: ["s1", "s2"] },
      { id: "a", skills_involved: ["s1", "s2"] },
      { id: "b", skills_involved: ["s1", "s2"] },
    ];
    const conns = inferConnections(workflows);
    const pairs = conns.map((c) => `${c.from}→${c.to}`);
    expect(pairs).toEqual(["a→b", "a→c", "b→c"]);
  });

  test("workflows without skills → skipped (no spurious connections)", () => {
    const workflows: WorkflowLike[] = [
      { id: "a", skills_involved: [] },
      { id: "b", skills_involved: ["s1"] },
      { id: "c", skills_involved: null },
    ];
    expect(inferConnections(workflows)).toEqual([]);
  });

  test("workflow paired with itself (dup id) → ignored", () => {
    const workflows: WorkflowLike[] = [
      { id: "same", skills_involved: ["s1"] },
      { id: "same", skills_involved: ["s1"] },
    ];
    expect(inferConnections(workflows)).toEqual([]);
  });

  test("deterministic — same input always yields same output", () => {
    const workflows: WorkflowLike[] = [
      { id: "alpha", skills_involved: ["a", "b", "c"] },
      { id: "beta", skills_involved: ["b", "c", "d"] },
      { id: "gamma", skills_involved: ["a", "d"] },
    ];
    const first = inferConnections(workflows);
    const second = inferConnections(workflows);
    expect(first).toEqual(second);
  });

  test("does not mutate input", () => {
    const workflows: WorkflowLike[] = [
      { id: "a", skills_involved: ["s1", "s2"] },
      { id: "b", skills_involved: ["s1", "s2"] },
    ];
    const snapshot = JSON.stringify(workflows);
    inferConnections(workflows);
    expect(JSON.stringify(workflows)).toBe(snapshot);
  });
});
