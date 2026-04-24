/** Bag item classifier — deterministic rules.
 *
 * Upstream used to drop every completion into the bag as
 * `{type: "research_note", rarity: "common"}`, which meant the inventory
 * always looked the same regardless of what the agent actually accomplished.
 *
 * This module derives two things from a completion `.md`:
 *   - `rarity`: mapped from the completion's `- rank: **X**` metadata (S/A/B/C/D).
 *   - `type`:   keyword-based classification of the Brief + Reflection text.
 *
 * Pure, deterministic, no LLM. Idempotent: same input → same output.
 * If signals are missing the classifier falls back to research_note/common
 * so existing behaviour is preserved. */

export type Rarity = "common" | "uncommon" | "rare" | "epic" | "legendary";

export interface Classification {
  type: string;
  rarity: Rarity;
  icon: string;
}

export interface CompletionSignals {
  raw: string;
  stem: string;
}

const FALLBACK: Classification = {
  type: "research_note",
  rarity: "common",
  icon: "scroll",
};

/** Rank letter → rarity. Ranks come from the completion header
 * (`- rank: **A**`) and are set by quest-cycle when a quest completes. */
const RANK_TO_RARITY: Record<string, Rarity> = {
  S: "legendary",
  A: "epic",
  B: "rare",
  C: "uncommon",
  D: "common",
};

/** Ordered keyword → type rules. First match wins.
 *
 * Order matters: broad categories at the bottom, specific intents at the top.
 * Each rule gets an icon hint that matches icon-registry's typeMap so the
 * frontend renders a shaped icon instead of defaulting to a scroll. */
const TYPE_RULES: Array<{ type: string; icon: string; patterns: RegExp[] }> = [
  {
    type: "map_fragment",
    icon: "map",
    patterns: [
      /\b(?:design|architecture|diagram|flowchart|plan|roadmap|blueprint|topology|map)\b/i,
    ],
  },
  {
    type: "training_report",
    icon: "book",
    patterns: [
      /\b(?:ui|ux|viewer|interface|layout|render|display|animation|visual|theme|sprite|panel)\b/i,
    ],
  },
  {
    type: "code_snippet",
    icon: "scroll",
    patterns: [
      /\b(?:implement|implemented|refactor|refactored|fix|fixed|patch|patched|port|ported|bug|debug|hotfix|rewrite)\b/i,
    ],
  },
  {
    type: "book",
    icon: "book",
    patterns: [/\b(?:tutorial|guide|walkthrough|handbook|manual)\b/i],
  },
  {
    type: "research_note",
    icon: "scroll",
    patterns: [
      /\b(?:document|documented|research|investigat(?:e|ed|ion)|analyz(?:e|ed|is)|audit|survey|explore|explored)\b/i,
    ],
  },
];

/** Extract the `rank` metadata letter from the completion header, if any. */
export function extractRank(raw: string): string | null {
  const match = raw.match(/^[\s-]*rank:\s*\**([A-Za-z])\**/im);
  if (!match) return null;
  const letter = match[1]!.toUpperCase();
  return letter in RANK_TO_RARITY ? letter : null;
}

/** Extract the `## Brief` section body for keyword scanning. If missing,
 * falls back to the first non-heading, non-list line (same heuristic
 * completionPreview uses). Keeps the search space focused — the Reflection
 * paragraph is often flowery narrative that mis-classifies as "design". */
export function extractBrief(raw: string): string {
  if (!raw) return "";
  const lines = raw.split("\n").map((l) => l.trim());
  const briefIdx = lines.findIndex((l) => l.toLowerCase() === "## brief");
  if (briefIdx >= 0) {
    const collected: string[] = [];
    for (const l of lines.slice(briefIdx + 1)) {
      if (l.startsWith("#")) break;
      if (l) collected.push(l);
    }
    if (collected.length > 0) return collected.join(" ");
  }
  const title = lines.find((l) => l.startsWith("# "));
  return title ? title.slice(2) : "";
}

/** Classify the Brief + title into an item `type`. Runs through TYPE_RULES
 * in declared order and returns the first rule whose regex matches. */
export function classifyType(raw: string, stem: string): { type: string; icon: string } {
  const title = stem.replace(/-/g, " ");
  const brief = extractBrief(raw);
  const haystack = `${title} ${brief}`.toLowerCase();
  for (const rule of TYPE_RULES) {
    if (rule.patterns.some((re) => re.test(haystack))) {
      return { type: rule.type, icon: rule.icon };
    }
  }
  return { type: FALLBACK.type, icon: FALLBACK.icon };
}

/** Map a rank letter to a rarity tier. Unknown/missing rank → common. */
export function classifyRarity(raw: string): Rarity {
  const letter = extractRank(raw);
  if (!letter) return FALLBACK.rarity;
  return RANK_TO_RARITY[letter] ?? FALLBACK.rarity;
}

/** Classify a completion signal into {type, rarity, icon}. Pure function. */
export function classifyCompletion(signals: CompletionSignals): Classification {
  const { raw, stem } = signals;
  if (!raw) return { ...FALLBACK };
  const { type, icon } = classifyType(raw, stem);
  const rarity = classifyRarity(raw);
  return { type, rarity, icon };
}
