/** Inter-workflow connection inference — deterministic, rule-based.
 *
 * The SubRegionGraph panel renders arrows between workflows that share
 * context — but upstream always writes `connections: []`, so the graph
 * displays as isolated nodes with no narrative flow.
 *
 * This module infers connections from `skills_involved` overlap: if two
 * workflows share enough skills, they're likely complementary domains
 * (e.g. "backend" and "devops" sharing "deploy", "logs", "monitoring").
 *
 * Algorithm:
 *   - For every unordered pair of workflows (i, j):
 *     - Compute Jaccard similarity: |A ∩ B| / |A ∪ B|
 *     - If the overlap is below MIN_OVERLAP, drop the pair
 *     - Else emit {from: i, to: j, type: 'complementary', strength: J}
 *   - Sort by (from, to) for stable output across runs
 *
 * Deterministic: identical input → identical output, no LLM call. */

export type ConnectionType = "workflow" | "complementary" | "prerequisite";

export interface Connection {
  from: string;
  to: string;
  type: ConnectionType;
  strength: number;
}

export interface WorkflowLike {
  id: string;
  skills_involved?: string[] | null;
}

/** Minimum Jaccard similarity required to emit a complementary connection.
 * 0.15 = roughly 1 shared skill out of 6–7 union — enough to suggest
 * relation without drowning the graph in noise. */
const MIN_OVERLAP = 0.15;

/** Round strength to 2 decimals so the persisted JSON diffs stay stable. */
function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/** Compute the Jaccard similarity between two skill sets. Empty sets on
 * either side return 0 so they never produce a spurious connection. */
export function jaccard(a: Iterable<string>, b: Iterable<string>): number {
  const setA = new Set(Array.from(a).filter((s) => !!s && s.trim() !== ""));
  const setB = new Set(Array.from(b).filter((s) => !!s && s.trim() !== ""));
  if (setA.size === 0 || setB.size === 0) return 0;
  let intersection = 0;
  for (const s of setA) if (setB.has(s)) intersection += 1;
  const union = setA.size + setB.size - intersection;
  if (union === 0) return 0;
  return intersection / union;
}

/** Infer connections from a workflows array. Pure function — takes the
 * current map's workflows slice and returns the connections that should
 * replace `map.connections`. Never mutates the input. */
export function inferConnections(workflows: WorkflowLike[]): Connection[] {
  const out: Connection[] = [];
  for (let i = 0; i < workflows.length; i += 1) {
    const a = workflows[i]!;
    if (!a.id) continue;
    const skillsA = a.skills_involved ?? [];
    if (skillsA.length === 0) continue;
    for (let j = i + 1; j < workflows.length; j += 1) {
      const b = workflows[j]!;
      if (!b.id || b.id === a.id) continue;
      const skillsB = b.skills_involved ?? [];
      if (skillsB.length === 0) continue;
      const strength = jaccard(skillsA, skillsB);
      if (strength < MIN_OVERLAP) continue;
      // Stable direction: lexicographically smaller id is `from`.
      const [from, to] = a.id < b.id ? [a.id, b.id] : [b.id, a.id];
      out.push({ from, to, type: "complementary", strength: round2(strength) });
    }
  }
  out.sort((x, y) => (x.from === y.from ? x.to.localeCompare(y.to) : x.from.localeCompare(y.from)));
  return out;
}
