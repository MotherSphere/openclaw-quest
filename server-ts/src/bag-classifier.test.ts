import { describe, expect, test } from "bun:test";

import {
  classifyCompletion,
  classifyRarity,
  classifyType,
  extractBrief,
  extractRank,
  type Rarity,
} from "./bag-classifier.ts";

describe("extractRank", () => {
  test("parses `- rank: **A**` header", () => {
    expect(extractRank("- rank: **A**\n")).toBe("A");
  });

  test("is case-insensitive", () => {
    expect(extractRank("- rank: **s**")).toBe("S");
  });

  test("accepts rank without asterisks", () => {
    expect(extractRank("- rank: B")).toBe("B");
  });

  test("returns null when rank missing", () => {
    expect(extractRank("no rank here")).toBeNull();
  });

  test("ignores unknown rank letters", () => {
    expect(extractRank("- rank: **Z**")).toBeNull();
  });
});

describe("classifyRarity", () => {
  test.each([
    ["S", "legendary"],
    ["A", "epic"],
    ["B", "rare"],
    ["C", "uncommon"],
    ["D", "common"],
  ] as const)("rank %s → %s", (letter, rarity) => {
    expect(classifyRarity(`- rank: **${letter}**`)).toBe(rarity as Rarity);
  });

  test("missing rank defaults to common", () => {
    expect(classifyRarity("no rank header")).toBe("common");
  });
});

describe("extractBrief", () => {
  test("pulls out the Brief section body", () => {
    const md = [
      "# Title",
      "",
      "- rank: **B**",
      "",
      "## Brief",
      "Simplify the status text.",
      "",
      "## Reflection",
      "Went well.",
    ].join("\n");
    expect(extractBrief(md)).toBe("Simplify the status text.");
  });

  test("falls back to title when Brief missing", () => {
    expect(extractBrief("# Refactor the viewer")).toBe("Refactor the viewer");
  });

  test("empty input returns empty", () => {
    expect(extractBrief("")).toBe("");
  });
});

describe("classifyType", () => {
  test("code intent → code_snippet/scroll", () => {
    expect(classifyType("## Brief\nImplement the login flow", "login-flow")).toEqual({
      type: "code_snippet",
      icon: "scroll",
    });
  });

  test("fix/patch intent → code_snippet", () => {
    expect(classifyType("## Brief\nFix the broken router", "router-bug")).toMatchObject({
      type: "code_snippet",
    });
  });

  test("UI/viewer intent → training_report/book", () => {
    expect(classifyType("## Brief\nRefine viewer loading feel", "refine-viewer")).toEqual({
      type: "training_report",
      icon: "book",
    });
  });

  test("design/architecture intent → map_fragment/map", () => {
    expect(classifyType("## Brief\nDesign the plugin architecture", "plugin-arch")).toEqual({
      type: "map_fragment",
      icon: "map",
    });
  });

  test("research intent → research_note", () => {
    expect(classifyType("## Brief\nInvestigate the perf regression", "perf-invest")).toMatchObject({
      type: "research_note",
    });
  });

  test("guide/tutorial intent → book", () => {
    expect(classifyType("## Brief\nWrite a tutorial for new contributors", "tut")).toMatchObject({
      type: "book",
    });
  });

  test("unmatched content → research_note fallback", () => {
    expect(classifyType("## Brief\nQuiet afternoon", "nothing")).toEqual({
      type: "research_note",
      icon: "scroll",
    });
  });

  test("matches via title stem when Brief missing", () => {
    expect(classifyType("", "refactor-the-world")).toMatchObject({
      type: "code_snippet",
    });
  });
});

describe("classifyCompletion", () => {
  test("real completion — calm-the-viewer-status-line (B, viewer UI)", () => {
    const md = [
      "# Calm The Viewer Status Line",
      "",
      "- rank: **B**",
      "- workflow: viewer-forge",
      "",
      "## Brief",
      "Simplify the status text so it stays informative without pulling attention away from the image.",
    ].join("\n");
    expect(classifyCompletion({ raw: md, stem: "calm-the-viewer-status-line" })).toEqual({
      type: "training_report",
      rarity: "rare",
      icon: "book",
    });
  });

  test("real completion — master-autonomous-craft-loop (A, design)", () => {
    const md = [
      "# Master: Autonomous Craft Loop",
      "",
      "- rank: **A**",
      "- workflow: unknown",
      "",
      "## Brief",
      "Push Autonomous Craft Loop to the next level.",
    ].join("\n");
    const result = classifyCompletion({ raw: md, stem: "master-autonomous-craft-loop" });
    expect(result.rarity).toBe("epic");
  });

  test("empty raw → fallback", () => {
    expect(classifyCompletion({ raw: "", stem: "anything" })).toEqual({
      type: "research_note",
      rarity: "common",
      icon: "scroll",
    });
  });

  test("idempotent — same input gives same output", () => {
    const md = "# Fix the bug\n- rank: **C**\n## Brief\nFix the bug";
    const a = classifyCompletion({ raw: md, stem: "fix-bug" });
    const b = classifyCompletion({ raw: md, stem: "fix-bug" });
    expect(a).toEqual(b);
  });
});
