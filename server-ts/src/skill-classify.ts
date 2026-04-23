/** LLM-based skill classification — port of server/skill_classify.py.
 *
 * Takes the DB's current skill list + the user's defined sites, asks the
 * agent for a {skill_name → site_id} mapping, then rewrites
 * knowledge-map.json so every workflow's `skills_involved` is populated.
 * Without this step, freshly seeded workflows carry empty skill arrays and
 * the SubRegionGraph panel renders as an empty canvas.
 *
 * Concurrency: a module-level `inFlight` promise serialises calls. A
 * trailing trigger during an in-flight run is coalesced into one replay
 * with a fresh read of SITES_FILE. */

import { readFile, writeFile } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { MAP_FILE, SITES_FILE } from "./config.ts";
import { callAgent } from "./openclaw-agent.ts";
import { getSkills, type SkillRow } from "./models.ts";
import { manager } from "./ws-manager.ts";

const PROMPTS_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "prompts");
const CLASSIFY_TEMPLATE_PATH = join(PROMPTS_DIR, "skills", "classify.md");
const CLASSIFY_LLM_TIMEOUT_MS = 60_000;

const logger = {
  info: (msg: string, ...args: unknown[]) => console.log(`[skill-classify] ${msg}`, ...args),
  warn: (msg: string, ...args: unknown[]) => console.warn(`[skill-classify] ${msg}`, ...args),
  error: (msg: string, ...args: unknown[]) => console.error(`[skill-classify] ${msg}`, ...args),
};

interface Site {
  id: string;
  name: string | null;
  is_default: boolean;
  defined: boolean;
  domain: string | null;
  workflow_id?: string | null;
  sprite?: string | null;
}

interface Workflow {
  id: string;
  skills_involved?: string[];
  [key: string]: unknown;
}

interface KnowledgeMap {
  workflows?: Workflow[];
  [key: string]: unknown;
}

function tryParseJson(raw: string): Record<string, string> | null {
  // Strategy 1: direct parse
  try {
    const result = JSON.parse(raw) as unknown;
    if (result && typeof result === "object" && !Array.isArray(result)) {
      return result as Record<string, string>;
    }
  } catch {
    /* fall through */
  }
  // Strategy 2: extract from markdown code fence
  const fenceMatch = raw.match(/```(?:json)?\s*(\{[\s\S]*?\})\s*```/);
  if (fenceMatch) {
    try {
      const parsed = JSON.parse(fenceMatch[1]!) as unknown;
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        return parsed as Record<string, string>;
      }
    } catch {
      /* fall through */
    }
  }
  // Strategy 3: outermost braces
  const braceMatch = raw.match(/\{[\s\S]*\}/);
  if (braceMatch) {
    const text = braceMatch[0];
    try {
      const parsed = JSON.parse(text) as unknown;
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        return parsed as Record<string, string>;
      }
    } catch {
      /* fall through */
    }
    // Strategy 4: strip trailing commas
    const fixed = text.replace(/,\s*([}\]])/g, "$1");
    try {
      const parsed = JSON.parse(fixed) as unknown;
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        return parsed as Record<string, string>;
      }
    } catch {
      /* fall through */
    }
  }
  return null;
}

function loadTemplate(): { instruction: string } {
  let instruction =
    "You classify skills into knowledge map sites. Return ONLY valid JSON, no markdown, no explanation. Follow the rules exactly.";
  try {
    if (existsSync(CLASSIFY_TEMPLATE_PATH)) {
      const body = readFileSync(CLASSIFY_TEMPLATE_PATH, "utf8");
      const m = body.match(/instruction:\s*"([^"]+)"/);
      if (m) instruction = m[1]!;
    }
  } catch {
    /* ignore — fallback to inline prompt */
  }
  return { instruction };
}

async function readSitesFile(): Promise<Site[]> {
  if (!existsSync(SITES_FILE)) return [];
  try {
    const raw = await readFile(SITES_FILE, "utf8");
    return JSON.parse(raw) as Site[];
  } catch {
    return [];
  }
}

async function readMapFile(): Promise<KnowledgeMap | null> {
  if (!existsSync(MAP_FILE)) return null;
  try {
    const raw = await readFile(MAP_FILE, "utf8");
    return JSON.parse(raw) as KnowledgeMap;
  } catch {
    return null;
  }
}

/** Ask the agent to classify each skill into a site_id.
 * Skills not placed by the LLM default to starter-town; invalid site_ids
 * also fall back to starter-town. */
export async function classifySkillsToSites(
  skills: SkillRow[],
  sites: Site[],
): Promise<Record<string, string>> {
  const allSkillNames = new Set(
    skills.map((s) => s.name).filter((n): n is string => !!n && n.trim() !== ""),
  );

  const skillLines = skills.map((s) => {
    const desc = ((s.description && s.description.trim()) || s.category || "general").slice(0, 120);
    return `- ${s.name}: ${desc}`;
  });
  const skillsStr = skillLines.join("\n");

  const definedSites = sites.filter((s) => s.defined && s.id);
  const siteLines = definedSites.map(
    (s) => `- ${s.id} (${s.name ?? "unnamed"}): domain=${s.domain ?? "general"}`,
  );
  const sitesStr = siteLines.join("\n");

  const validSiteIds = new Set(definedSites.map((s) => s.id));

  const { instruction } = loadTemplate();
  const userPrompt =
    `${instruction}\n\n` +
    "Classify each skill into the most appropriate site. " +
    "Return ONLY a JSON object mapping skill_name to site_id.\n\n" +
    `SITES:\n${sitesStr}\n\n` +
    `SKILLS:\n${skillsStr}\n\n` +
    "Rules:\n" +
    "- Each skill goes to exactly ONE site\n" +
    '- If unclear, assign to "starter-town"\n' +
    "- Match by domain relevance (skill category/description vs site domain)\n" +
    "- Return ALL skills, not just a subset\n\n" +
    'Return ONLY valid JSON like: {"skill-name": "site-id", ...}';

  const final: Record<string, string> = {};

  let raw: string | null = null;
  try {
    raw = await callAgent(userPrompt, { thinking: "off", timeoutMs: CLASSIFY_LLM_TIMEOUT_MS });
  } catch (err) {
    logger.error("agent call threw:", (err as Error).message);
  }

  if (raw) {
    const parsed = tryParseJson(raw);
    if (parsed) {
      let matched = 0;
      for (const [skillName, siteId] of Object.entries(parsed)) {
        if (!skillName || !skillName.trim()) continue;
        if (!allSkillNames.has(skillName)) continue;
        const resolved = typeof siteId === "string" && validSiteIds.has(siteId) ? siteId : "starter-town";
        final[skillName] = resolved;
        matched += 1;
      }
      logger.info(
        `LLM returned ${Object.keys(parsed).length} entries, ${matched} matched real skills`,
      );
    } else {
      logger.warn(`could not parse LLM response as JSON (length=${raw.length})`);
    }
  } else {
    logger.warn("agent returned null — classification will default to starter-town");
  }

  // Fill missing skills with starter-town
  let filledCount = 0;
  for (const name of allSkillNames) {
    if (!final[name]) {
      final[name] = "starter-town";
      filledCount += 1;
    }
  }
  logger.info(
    `classification result: ${Object.keys(final).length} total (${Object.keys(final).length - filledCount} from LLM, ${filledCount} defaulted)`,
  );
  return final;
}

let inFlight: Promise<void> | null = null;
let replayPending = false;

/** Reclassify every skill in the DB into a site, then rewrite
 * knowledge-map.json so each workflow's `skills_involved` is populated.
 * Concurrent calls are coalesced into one trailing replay. */
export function reclassifySkillsAfterSiteChange(): Promise<void> {
  if (inFlight) {
    replayPending = true;
    return inFlight;
  }
  inFlight = runOnce()
    .catch((err) => {
      logger.error("reclassify failed:", (err as Error).message);
    })
    .finally(() => {
      inFlight = null;
      if (replayPending) {
        replayPending = false;
        void reclassifySkillsAfterSiteChange();
      }
    });
  return inFlight;
}

async function runOnce(): Promise<void> {
  manager.broadcast({ type: "classify_status", data: { status: "started" } });

  const sites = await readSitesFile();
  const skills = getSkills().filter((s) => s.name && s.name.trim() !== "");

  if (skills.length === 0) {
    logger.info("no skills to classify");
    manager.broadcast({ type: "classify_status", data: { status: "completed", count: 0 } });
    return;
  }

  const definedSites = sites.filter((s) => s.defined);
  let classification: Record<string, string>;
  if (definedSites.length <= 1) {
    classification = Object.fromEntries(skills.map((s) => [s.name, "starter-town"]));
    logger.info(
      `only default site defined, assigning all ${skills.length} skills to starter-town`,
    );
  } else {
    classification = await classifySkillsToSites(skills, sites);
  }

  // Ensure every skill is accounted for — safety net if classifier skipped any.
  for (const s of skills) {
    if (!classification[s.name]) classification[s.name] = "starter-town";
  }

  const map = await readMapFile();
  if (!map) {
    logger.warn("knowledge-map.json missing — nothing to rewrite");
    manager.broadcast({
      type: "classify_status",
      data: { status: "completed", count: skills.length },
    });
    return;
  }

  const workflows = Array.isArray(map.workflows) ? map.workflows : [];
  const siteToWorkflow = new Map<string, string>();
  for (const s of sites) {
    if (s.workflow_id) siteToWorkflow.set(s.id, s.workflow_id);
  }

  // Clear every workflow's skills_involved before re-populating.
  for (const wf of workflows) wf.skills_involved = [];

  const unplaced: string[] = [];
  for (const [skillName, siteId] of Object.entries(classification)) {
    if (!skillName.trim()) continue;
    const wfId = siteToWorkflow.get(siteId);
    const wf = wfId ? workflows.find((w) => w.id === wfId) : undefined;
    if (wf) {
      (wf.skills_involved ??= []).push(skillName);
    } else {
      unplaced.push(skillName);
    }
  }
  if (unplaced.length > 0) {
    const starter = workflows.find((w) => w.id === "starter-town");
    if (starter) {
      (starter.skills_involved ??= []).push(...unplaced);
      logger.info(`${unplaced.length} skills placed in starter-town (no matching workflow)`);
    } else {
      logger.warn(`${unplaced.length} skills unplaced — no starter-town workflow in map`);
    }
  }

  // Sort + dedupe, drop empties.
  for (const wf of workflows) {
    const cleaned = Array.from(
      new Set((wf.skills_involved ?? []).filter((s): s is string => !!s && s.trim() !== "")),
    ).sort();
    wf.skills_involved = cleaned;
  }

  const totalInMap = workflows.reduce((acc, wf) => acc + (wf.skills_involved?.length ?? 0), 0);
  if (totalInMap !== skills.length) {
    logger.warn(`skill count mismatch: ${totalInMap} in map vs ${skills.length} in DB`);
  }

  map.workflows = workflows;
  await writeFile(MAP_FILE, JSON.stringify(map, null, 2), "utf8");

  logger.info(`reclassified ${skills.length} skills into ${definedSites.length} sites`);
  manager.broadcast({ type: "map", data: map });
  manager.broadcast({
    type: "classify_status",
    data: { status: "completed", count: skills.length },
  });
  manager.broadcast({ type: "skills_reclassified", data: { count: skills.length } });
}
