#!/usr/bin/env bun
/** Native Phase 2 quest cycle runner — port of server/quest_cycle.py.
 *
 * Spawned as a detached child process by POST /api/cycle/start. Runs
 * REFLECT → PLAN → EXECUTE → REPORT, writing events to events.jsonl which
 * the backend watcher picks up and broadcasts to the dashboard.
 *
 * REFLECT and REPORT call the OpenClaw agent for real LLM narration; PLAN
 * and EXECUTE stay deterministic. On first run against an empty map, also
 * seeds workflows + sites.json from recent task labels. When the guild
 * board is empty for the chosen workflow, drafts a quest via LLM, completes
 * it in the same cycle, and drops a research-note markdown into
 * completions/ for the Bag panel. */

import { existsSync, readFileSync } from "node:fs";
import { appendFileSync, mkdirSync, writeFileSync, unlinkSync } from "node:fs";
import { join, dirname } from "node:path";

import {
  COMPLETIONS_DIR,
  CYCLE_LOCK_FILE,
  EVENTS_FILE,
  FEEDBACK_DIGEST_FILE,
  GAME_BALANCE,
  MAP_FILE,
  QUESTS_V2_FILE,
  SITES_FILE,
  STATE_FILE,
} from "./config.ts";
import { callAgent } from "./openclaw-agent.ts";
import { readTaskRuns } from "./openclaw-bridge.ts";
import { reclassifySkillsAfterSiteChange } from "./skill-classify.ts";

type Any = Record<string, unknown>;

interface CyclePlan {
  workflowId: string | null;
  workflowName: string | null;
  targetSkill: string | null;
  questId: string | null;
  questTitle: string | null;
  reason: string;
  avoidedSkills: string[];
  prioritizedSkills: string[];
  feedbackItems: number;
}

function nowIso(): string {
  return new Date().toISOString();
}

function readJson<T>(path: string, fallback: T): T {
  if (!existsSync(path)) return fallback;
  try {
    return JSON.parse(readFileSync(path, "utf8")) as T;
  } catch {
    return fallback;
  }
}

function writeJson(path: string, data: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(data, null, 2), "utf8");
}

function writeEvent(type: string, data: Any): void {
  const event = { ts: nowIso(), type, region: null, data };
  mkdirSync(dirname(EVENTS_FILE), { recursive: true });
  appendFileSync(EVENTS_FILE, JSON.stringify(event) + "\n", "utf8");
}

function slug(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "");
}

async function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

class QuestCycleRunner {
  trigger: string;
  startedAt = Date.now() / 1000;
  state: Any;
  mapData: Any;
  quests: Any[];
  digest: Any;
  plan: CyclePlan | null = null;
  completedQuest: Any | null = null;
  skillsGained: string[] = [];
  outcomes: string[] = [];
  reflectSummaryText: string | null = null;

  constructor(trigger = "manual") {
    this.trigger = trigger;
    this.state = readJson<Any>(STATE_FILE, {});
    this.mapData = readJson<Any>(MAP_FILE, {});
    this.quests = readJson<Any[]>(QUESTS_V2_FILE, []);
    this.digest = readJson<Any>(FEEDBACK_DIGEST_FILE, {
      summary: { total_positive: 0, total_negative: 0, net_sentiment: 0 },
      recent_feedback: [],
      skill_sentiment: {},
      workflow_sentiment: {},
      user_corrections: [],
    });
  }

  async run(): Promise<number> {
    try {
      writeEvent("cycle_start", { trigger: this.trigger, started_at: nowIso() });
      this.plan = await this.reflectAndPlan();
      await this.execute();
      await this.report("success");
      return 0;
    } catch (exc) {
      const msg = (exc as Error).message ?? String(exc);
      this.outcomes.push(`Cycle failed: ${msg}`);
      writeEvent("cycle_phase", {
        phase: "report",
        outcomes: this.outcomes,
        skills_gained: this.skillsGained,
        quest_completed: this.completedQuest?.["title"] ?? null,
        status: "error",
      });
      writeEvent("cycle_end", {
        status: "error",
        duration_seconds: Math.round((Date.now() / 1000 - this.startedAt) * 100) / 100,
        skills_gained: this.skillsGained,
        error: msg,
      });
      return 1;
    } finally {
      this.clearLock();
    }
  }

  private async reflectAndPlan(): Promise<CyclePlan> {
    const wasEmpty = !(((this.mapData?.["workflows"] as unknown[]) ?? []).length > 0);
    await this.seedWorkflowsIfEmpty();
    this.ensureSitesFromWorkflows();
    if (wasEmpty && ((this.mapData?.["workflows"] as unknown[]) ?? []).length > 0) {
      // Fire-and-forget: classify any pre-existing skills into the new workflows
      // so the SubRegionGraph has something to render on first load.
      reclassifySkillsAfterSiteChange().catch(() => {
        /* logged inside */
      });
    }

    const workflows = Array.isArray((this.mapData as Any)["workflows"])
      ? ((this.mapData as Any)["workflows"] as Any[])
      : [];
    const skillSent = ((this.digest["skill_sentiment"] as Any) ?? {}) as Any;
    const wfSent = ((this.digest["workflow_sentiment"] as Any) ?? {}) as Any;
    const recentFeedback = ((this.digest["recent_feedback"] as Any[]) ?? []) as Any[];
    const corrections = ((this.digest["user_corrections"] as unknown[]) ?? []) as unknown[];

    const avoidedSkills = Object.entries(skillSent)
      .filter(([, s]) => {
        const sent = s as { up?: number; down?: number };
        return (sent.down ?? 0) > (sent.up ?? 0) * 2;
      })
      .map(([k]) => k)
      .sort();
    const prioritizedSkills = Object.entries(skillSent)
      .filter(([, s]) => {
        const sent = s as { up?: number; down?: number };
        return (sent.up ?? 0) > Math.max(1, sent.down ?? 0);
      })
      .map(([k]) => k)
      .sort();
    const avoidedWorkflows = new Set(
      Object.entries(wfSent)
        .filter(([, s]) => {
          const sent = s as { up?: number; down?: number };
          return (sent.down ?? 0) > (sent.up ?? 0) * 2;
        })
        .map(([k]) => k),
    );
    const prioritizedWorkflows = new Set(
      Object.entries(wfSent)
        .filter(([, s]) => {
          const sent = s as { up?: number; down?: number };
          return (sent.up ?? 0) > 3 && (sent.down ?? 0) === 0;
        })
        .map(([k]) => k),
    );

    if (recentFeedback.length >= 3) {
      const latestThree = recentFeedback.slice(0, 3);
      const sameSkill = new Set(latestThree.map((i) => i["skill"]).filter(Boolean));
      if (sameSkill.size === 1) avoidedSkills.push(...(sameSkill as Set<string>));
    }

    const feedbackItems = recentFeedback.length;
    const morale = Number(this.state["mp"] ?? this.state["energy"] ?? 50);

    let candidate: [Any, Any | null] | null = null;
    let bestScore: number | null = null;
    for (const workflow of workflows) {
      const wfName = (workflow["name"] as string) ?? "";
      if (!wfName || avoidedWorkflows.has(wfName)) continue;
      let score = Number(workflow["mastery"] ?? 0);
      if (prioritizedWorkflows.has(wfName)) score -= 0.35;
      const subNodes = ((workflow["sub_nodes"] as Any[]) ?? []) as Any[];
      let prioritizedNode: Any | null = null;
      let fallbackNode: Any | null = null;
      for (const node of subNodes) {
        const skillName = node["name"] as string;
        if (!skillName || avoidedSkills.includes(skillName)) continue;
        if (prioritizedSkills.includes(skillName)) {
          prioritizedNode = node;
          score -= 0.2;
          break;
        }
        if (fallbackNode === null) fallbackNode = node;
      }
      const node = prioritizedNode ?? fallbackNode;
      if (morale < 30) score += 0.2;
      if (bestScore === null || score < bestScore) {
        candidate = [workflow, node];
        bestScore = score;
      }
    }

    const workflow = candidate ? candidate[0] : workflows[0] ?? {};
    const node = candidate ? candidate[1] : null;
    const workflowId = (workflow["id"] as string) ?? null;
    const workflowName = (workflow["name"] as string) ?? null;
    const targetSkill = (node?.["name"] as string) ?? null;

    const activeQuests = this.quests.filter((q) =>
      ["active", "in_progress", "pending"].includes(q["status"] as string),
    );
    let targetQuest: Any | null = null;
    if (workflowId) {
      targetQuest = activeQuests.find((q) => q["workflow_id"] === workflowId) ?? null;
    }
    if (targetQuest === null && activeQuests.length > 0) targetQuest = activeQuests[0] ?? null;
    if (targetQuest === null && workflow && workflowName) {
      targetQuest = await this.proposeQuest(workflow, targetSkill);
    }

    const reasons: string[] = [];
    if (corrections.length > 0) reasons.push(`follow user corrections first (${corrections.length})`);
    if (targetSkill && prioritizedSkills.includes(targetSkill)) {
      reasons.push(`prioritize skill ${targetSkill} from positive feedback`);
    }
    if (workflowName && prioritizedWorkflows.has(workflowName)) {
      reasons.push(`workflow ${workflowName} has strong positive sentiment`);
    }
    if (avoidedSkills.length > 0) {
      reasons.push(`avoid skills: ${[...new Set(avoidedSkills)].sort().slice(0, 4).join(", ")}`);
    }
    if (morale < 30) reasons.push("low morale, choose a safer target");
    if (reasons.length === 0) reasons.push("focus on the weakest currently available workflow");

    const deterministicSummary = [
      `Morale at ${morale}`,
      avoidedSkills.length > 0
        ? `avoiding skills ${[...new Set(avoidedSkills)].sort().slice(0, 4).join(", ")}`
        : "no blocked skills",
      prioritizedSkills.length > 0
        ? `prioritizing ${prioritizedSkills.slice(0, 4).join(", ")}`
        : "no strongly preferred skills",
      `workflow target ${workflowName ?? "unknown"}`,
    ].join("; ");

    const llmReflect = await this.llmReflect({
      morale,
      workflowName,
      targetSkill,
      avoidedSkills: [...new Set(avoidedSkills)].sort(),
      prioritizedSkills,
      recentFeedback,
      corrections,
    });
    const reflectSummary = llmReflect ?? deterministicSummary;
    const llmUsed = reflectSummary !== deterministicSummary;
    const feedbackInfluenced = llmUsed && feedbackItems > 0;
    this.reflectSummaryText = reflectSummary;

    writeEvent("reflect", {
      chosen_training_target: targetSkill ?? workflowName ?? "unknown",
      weaknesses: workflowName ? [workflowName] : [],
      summary: reflectSummary,
      feedback_items: feedbackItems,
      llm: llmUsed,
      feedback_influenced: feedbackInfluenced,
    });
    writeEvent("cycle_phase", {
      phase: "reflect",
      summary: reflectSummary,
      feedback_items: feedbackItems,
    });
    const planReason = reasons.join("; ");
    writeEvent("cycle_phase", {
      phase: "plan",
      target_workflow: workflowName,
      target_quest: targetQuest?.["title"] ?? null,
      reason: planReason,
    });
    writeEvent("train_start", {
      target: targetSkill ?? workflowName ?? "unknown",
      skill_name: targetSkill,
      plan: planReason,
      workflow_id: workflowId,
      workflow: workflowName,
    });

    return {
      workflowId,
      workflowName,
      targetSkill,
      questId: (targetQuest?.["id"] as string) ?? null,
      questTitle: (targetQuest?.["title"] as string) ?? null,
      reason: planReason,
      avoidedSkills: [...new Set(avoidedSkills)].sort(),
      prioritizedSkills,
      feedbackItems,
    };
  }

  private async execute(): Promise<void> {
    if (!this.plan) return;
    const steps: Array<[number, string]> = [
      [0.2, `Surveying ${this.plan.workflowName ?? "current workflow"} for the next move`],
      [0.55, `Practicing ${this.plan.targetSkill ?? this.plan.workflowName ?? "core skill"}`],
      [0.9, "Consolidating results for report"],
    ];
    for (const [progress, detail] of steps) {
      writeEvent("cycle_phase", { phase: "execute", progress, detail });
      await sleep(150);
    }
    this.awardTrainingSkill();
    this.completeTargetQuest();
    this.updateStateFields();
  }

  private awardTrainingSkill(): void {
    if (!this.plan) return;
    const skillName = this.plan.targetSkill ?? this.plan.workflowName;
    if (!skillName) return;
    this.skillsGained.push(skillName);
    this.outcomes.push(`Improved ${skillName}`);
    writeEvent("skill_drop", {
      skill: skillName,
      skill_name: skillName,
      rarity: "common",
      category: this.plan.workflowName,
    });
    writeEvent("xp_gain", {
      amount: 25,
      reason: `Training progress in ${skillName}`,
    });
  }

  private completeTargetQuest(): void {
    if (!this.plan?.questId) return;
    let rewardXp: number = GAME_BALANCE.default_reward_xp;
    let rewardGold: number = GAME_BALANCE.default_reward_gold;
    let updated = false;
    for (const quest of this.quests) {
      if (quest["id"] !== this.plan.questId) continue;
      if (!["active", "in_progress", "pending"].includes(quest["status"] as string)) return;
      quest["status"] = "completed";
      quest["completed_at"] = nowIso();
      rewardXp = Number(quest["reward_xp"] ?? rewardXp);
      rewardGold = Number(quest["reward_gold"] ?? rewardGold);
      this.completedQuest = quest;
      updated = true;
      break;
    }
    if (!updated) return;
    writeJson(QUESTS_V2_FILE, this.quests);
    this.outcomes.push(`Completed quest ${this.completedQuest?.["title"] ?? ""}`);
    writeEvent("quest_complete", {
      quest_id: this.plan.questId,
      title: this.completedQuest?.["title"] ?? "",
      reward_xp: rewardXp,
      reward_gold: rewardGold,
    });
    this.state["xp"] = Number(this.state["xp"] ?? 0) + rewardXp;
    this.state["gold"] = Number(this.state["gold"] ?? 0) + rewardGold;
  }

  private updateStateFields(): void {
    const setDefault = (key: string, value: unknown): void => {
      if (this.state[key] === undefined || this.state[key] === null) this.state[key] = value;
    };
    setDefault("name", "EVE");
    setDefault("level", 1);
    setDefault("class", "adventurer");
    setDefault("title", "Novice");
    setDefault(
      "hp_max",
      GAME_BALANCE.hp_base + Number(this.state["level"] ?? 1) * GAME_BALANCE.hp_per_level,
    );
    setDefault("hp", Number(this.state["hp_max"] ?? GAME_BALANCE.hp_base));
    setDefault("mp_max", GAME_BALANCE.mp_max);
    setDefault("mp", 50);
    setDefault("xp", 0);
    setDefault(
      "xp_to_next",
      Math.max(100, Number(this.state["level"] ?? 1) * GAME_BALANCE.xp_per_level),
    );

    const xpBonus = this.skillsGained.length > 0 ? 25 : 10;
    this.state["xp"] = Number(this.state["xp"] ?? 0) + xpBonus;
    this.state["total_cycles"] = Number(this.state["total_cycles"] ?? 0) + 1;
    this.state["last_cycle_at"] = nowIso();
    this.state["last_interaction_at"] = nowIso();
    this.state["mp"] = Math.min(
      Number(this.state["mp"] ?? 50) + 2,
      Number(this.state["mp_max"] ?? GAME_BALANCE.mp_max),
    );

    let leveledUp = false;
    while (Number(this.state["xp"]) >= Number(this.state["xp_to_next"])) {
      this.state["xp"] = Number(this.state["xp"]) - Number(this.state["xp_to_next"]);
      this.state["level"] = Number(this.state["level"]) + 1;
      this.state["xp_to_next"] = Number(this.state["level"]) * GAME_BALANCE.xp_per_level;
      this.state["hp_max"] =
        GAME_BALANCE.hp_base + Number(this.state["level"]) * GAME_BALANCE.hp_per_level;
      this.state["hp"] = this.state["hp_max"];
      leveledUp = true;
    }

    writeJson(STATE_FILE, this.state);
    if (leveledUp) {
      writeEvent("level_up", {
        level: this.state["level"],
        new_level: this.state["level"],
        title: this.state["title"] ?? "Hero",
      });
    }
  }

  private async report(status: string): Promise<void> {
    const questTitle = (this.completedQuest?.["title"] as string) ?? null;
    if (questTitle && !this.outcomes.includes(`Completed quest ${questTitle}`)) {
      this.outcomes.push(`Completed quest ${questTitle}`);
    }
    if (this.outcomes.length === 0) this.outcomes.push("Maintained steady progress");

    const llmSummary = await this.llmReport(status, questTitle);
    if (llmSummary) this.outcomes = [llmSummary, ...this.outcomes];

    if (this.completedQuest) this.writeCompletionNote(llmSummary);

    writeEvent("cycle_phase", {
      phase: "report",
      outcomes: this.outcomes,
      skills_gained: this.skillsGained,
      quest_completed: questTitle,
      status,
      llm: llmSummary !== null,
    });
    writeEvent("cycle_end", {
      status,
      duration_seconds: Math.round((Date.now() / 1000 - this.startedAt) * 100) / 100,
      skills_gained: this.skillsGained,
      quest_completed: questTitle,
    });
  }

  private writeCompletionNote(llmSummary: string | null): void {
    const quest = this.completedQuest ?? {};
    const title = (quest["title"] as string) ?? "Cycle report";
    const stem = slug(title) || `cycle-${Math.floor(Date.now() / 1000)}`;
    const fname = `${stem}.md`;
    const parts: string[] = [
      `# ${title}`,
      "",
      `- rank: **${quest["rank"] ?? "C"}**`,
      `- workflow: ${quest["workflow_id"] ?? "unknown"}`,
      `- xp earned: ${quest["reward_xp"] ?? 0}`,
      `- gold earned: ${quest["reward_gold"] ?? 0}`,
      `- completed: ${quest["completed_at"] ?? nowIso()}`,
      "",
      "## Brief",
      (quest["description"] as string) ?? "(no description)",
      "",
    ];
    if (this.plan?.reason) parts.push("## Plan reasoning", this.plan.reason, "");
    if (this.skillsGained.length > 0) {
      parts.push("## Skills practiced", this.skillsGained.join(", "), "");
    }
    if (llmSummary) parts.push("## Reflection", llmSummary, "");
    try {
      mkdirSync(COMPLETIONS_DIR, { recursive: true });
      writeFileSync(join(COMPLETIONS_DIR, fname), parts.join("\n"), "utf8");
    } catch (err) {
      console.warn(`failed to write completion note ${fname}:`, (err as Error).message);
    }
  }

  private async seedWorkflowsIfEmpty(): Promise<void> {
    const existing = (this.mapData?.["workflows"] as unknown[]) ?? [];
    if (existing.length > 0) return;

    const taskLabels: string[] = [];
    try {
      for (const t of readTaskRuns(20)) {
        const label = (t.label ?? "").trim();
        if (label && !taskLabels.includes(label)) taskLabels.push(label);
      }
    } catch {
      /* ignore */
    }
    const labelsBlock =
      taskLabels.slice(0, 10).map((l) => `- ${l}`).join("\n") || "(no recent labels)";
    const prompt =
      "You are drafting the initial atlas of a self-evolving learning agent.\n" +
      'Name 2 or 3 distinct "workflow domains" the agent is currently practising, ' +
      "based on the recent task labels below. Each MUST be on its own line in this " +
      "EXACT format, nothing else (no preamble, no epilogue, no markdown, no " +
      "bullet points):\n\n" +
      "WORKFLOW: <evocative 2-4 word name> | <category: coding|research|automation|creative> | <one short sentence description>\n\n" +
      `Recent task labels:\n${labelsBlock}\n`;
    const reply = await callAgent(prompt, { thinking: "off" });
    if (!reply) return;

    const categories = new Set(["coding", "research", "automation", "creative"]);
    const positions: Array<[number, number]> = [
      [0.3, 0.3],
      [0.7, 0.4],
      [0.5, 0.75],
      [0.25, 0.65],
      [0.75, 0.72],
    ];
    const workflows: Any[] = [];
    const now = nowIso();
    for (const rawLine of reply.split("\n")) {
      const line = rawLine.trim();
      if (!line.toLowerCase().startsWith("workflow:")) continue;
      const body = line.slice(line.indexOf(":") + 1);
      const parts = body.split("|").map((p) => p.trim());
      if (parts.length < 3) continue;
      const name = (parts[0] ?? "").slice(0, 60);
      let category = (parts[1] ?? "").toLowerCase().trim();
      if (!categories.has(category)) category = "research";
      const description = (parts[2] ?? "").slice(0, 240);
      const wfId = slug(name) || `workflow-${workflows.length + 1}`;
      const posIdx = workflows.length % positions.length;
      const pos = positions[posIdx] ?? [0.5, 0.5];
      workflows.push({
        id: wfId,
        name,
        description,
        category,
        position: { x: pos[0], y: pos[1] },
        discovered_at: now,
        last_active: now,
        interaction_count: 1,
        correction_count: 0,
        mastery: 0.1,
        skills_involved: [],
        sub_nodes: [],
      });
      if (workflows.length >= 3) break;
    }
    if (workflows.length === 0) return;
    this.mapData = {
      version: 2,
      generated_at: now,
      workflows,
      connections: [],
      fog_regions: [],
    };
    writeJson(MAP_FILE, this.mapData);
    console.log(`[quest-cycle] seeded ${workflows.length} starter workflows into the atlas`);
    for (const wf of workflows) {
      writeEvent("region_unlock", {
        name: wf["name"],
        workflow_id: wf["id"],
        category: wf["category"],
        reason: wf["description"],
      });
    }
  }

  private ensureSitesFromWorkflows(): void {
    try {
      if (existsSync(SITES_FILE)) {
        const existing = readJson<unknown[]>(SITES_FILE, []);
        if (Array.isArray(existing) && existing.length > 0) return;
      }
    } catch {
      /* ignore */
    }
    const workflows = Array.isArray((this.mapData as Any)["workflows"])
      ? ((this.mapData as Any)["workflows"] as Any[])
      : [];
    if (workflows.length === 0) return;

    const categorySprite: Record<string, string> = {
      coding: "software-engineering",
      research: "research-knowledge",
      automation: "automation-tools",
      creative: "creative-arts",
    };
    const slotIds = ["starter-town", "site-1", "site-2", "site-3", "site-4", "site-5"];
    const sites: Any[] = [];
    for (let idx = 0; idx < workflows.length; idx++) {
      const wf = workflows[idx] ?? {};
      const slot = slotIds[idx] ?? `site-${idx}`;
      sites.push({
        id: slot,
        name: wf["name"] ?? null,
        is_default: slot === "starter-town",
        defined: true,
        domain: String((wf["name"] as string) ?? "").toLowerCase() || null,
        workflow_id: wf["id"] ?? null,
        sprite: categorySprite[wf["category"] as string] ?? "software-engineering",
      });
    }
    for (let idx = workflows.length; idx < slotIds.length; idx++) {
      const slot = slotIds[idx]!;
      sites.push({
        id: slot,
        name: null,
        is_default: slot === "starter-town",
        defined: false,
        domain: null,
        workflow_id: null,
        sprite: null,
      });
    }
    writeJson(SITES_FILE, sites);
    console.log(
      `[quest-cycle] backfilled sites.json with ${sites.length} slots (${sites.filter((s) => s["defined"]).length} defined)`,
    );
  }

  private async proposeQuest(workflow: Any, targetSkill: string | null): Promise<Any | null> {
    const wfName = (workflow["name"] as string) ?? "";
    const wfDesc = (workflow["description"] as string) ?? "";
    const skillHint = targetSkill ?? "open (any skill in this workflow)";
    const prompt =
      "You are the guild board clerk writing a new quest posting for a self-evolving " +
      `learning agent currently practising the workflow "${wfName}" — ${wfDesc}. ` +
      `Suggested training focus: ${skillHint}.\n\n` +
      "Output EXACTLY ONE line in this format, nothing else (no preamble, no epilogue, " +
      "no markdown, no bullet points):\n\n" +
      "QUEST: <concrete imperative title, 3 to 8 words> | <rank: A|B|C> | <one short sentence describing the task>\n";
    const reply = await callAgent(prompt, { thinking: "off" });
    if (!reply) return null;

    for (const rawLine of reply.split("\n")) {
      const line = rawLine.trim();
      if (!line.toLowerCase().startsWith("quest:")) continue;
      const body = line.slice(line.indexOf(":") + 1);
      const parts = body.split("|").map((p) => p.trim());
      if (parts.length < 3) continue;
      const title = (parts[0] ?? "").slice(0, 80);
      let rank = (parts[1] ?? "").toUpperCase();
      if (!["A", "B", "C"].includes(rank)) rank = "C";
      const description = (parts[2] ?? "").slice(0, 240);

      const rewardsKey = `reward_${rank}` as "reward_A" | "reward_B" | "reward_C";
      const rewards = GAME_BALANCE[rewardsKey];
      const rewardXp = Math.floor(rewards.xp_base);
      const rewardGold = Math.floor(rewards.gold_base);

      const quest: Any = {
        id: `${slug(title) || "quest"}-${Math.floor(Date.now() / 1000)}`,
        title,
        description,
        rank,
        status: "active",
        workflow_id: workflow["id"],
        reward_xp: rewardXp,
        reward_gold: rewardGold,
        created_at: nowIso(),
        source: "cycle-proposed",
      };
      this.quests.push(quest);
      writeJson(QUESTS_V2_FILE, this.quests);
      writeEvent("quest_create", {
        quest_id: quest["id"],
        title: quest["title"],
        rank: quest["rank"],
        workflow_id: quest["workflow_id"],
        reward_xp: rewardXp,
        reward_gold: rewardGold,
        source: "cycle-proposed",
      });
      console.log(
        `[quest-cycle] proposed quest ${quest["id"]} (rank ${rank}) for workflow ${wfName}`,
      );
      return quest;
    }
    return null;
  }

  private async llmReflect(opts: {
    morale: number;
    workflowName: string | null;
    targetSkill: string | null;
    avoidedSkills: string[];
    prioritizedSkills: string[];
    recentFeedback: Any[];
    corrections: unknown[];
  }): Promise<string | null> {
    const fbLines: string[] = [];
    for (const item of opts.recentFeedback.slice(0, 5)) {
      if (typeof item !== "object" || item === null) continue;
      const verdict =
        (item["feedback"] as string) ??
        (item["sentiment"] as string) ??
        (item["type"] as string) ??
        "?";
      const subject =
        (item["skill"] as string) ??
        (item["workflow"] as string) ??
        (item["quest_context"] as string) ??
        (item["event_type"] as string) ??
        "?";
      const reason = String(item["event_summary"] ?? item["reason"] ?? "").trim();
      fbLines.push(`- ${verdict} on ${subject}${reason ? `: ${reason}` : ""}`);
    }
    const corrLines: string[] = [];
    for (const item of opts.corrections.slice(-3)) {
      let text = "";
      if (typeof item === "string") text = item.trim();
      else if (typeof item === "object" && item !== null) {
        const o = item as Any;
        text = String(o["text"] ?? o["reason"] ?? o["detail"] ?? "").trim();
      }
      if (text) corrLines.push(`- ${text}`);
    }
    const fbBlock = fbLines.length > 0 ? fbLines.join("\n") : "(none)";
    const corrBlock = corrLines.length > 0 ? corrLines.join("\n") : "(none)";

    const prompt =
      "You are the reflection voice of an RPG-style self-evolving learning agent. " +
      "Based on the state below, write ONE or TWO short sentences (max ~280 characters total) " +
      "summarising the agent's current situation and the training direction it should take next. " +
      "Be concrete, first-person is fine. No headings, no bullet points, no preamble.\n\n" +
      `Morale (MP): ${opts.morale}/100\n` +
      `Candidate target workflow: ${opts.workflowName ?? "unknown"}\n` +
      `Candidate target skill: ${opts.targetSkill ?? "none"}\n` +
      `Skills flagged by user as avoid: ${opts.avoidedSkills.join(", ") || "none"}\n` +
      `Skills preferred by user: ${opts.prioritizedSkills.slice(0, 8).join(", ") || "none"}\n` +
      `Recent feedback items:\n${fbBlock}\n` +
      `User corrections:\n${corrBlock}\n`;
    return callAgent(prompt);
  }

  private async llmReport(status: string, questTitle: string | null): Promise<string | null> {
    const duration = Math.round((Date.now() / 1000 - this.startedAt) * 100) / 100;
    const skills = this.skillsGained.length > 0 ? this.skillsGained.join(", ") : "none";
    const struct = this.outcomes.map((o) => `- ${o}`).join("\n") || "- (no structural outcomes)";
    const reflect = this.reflectSummaryText ?? "(reflection unavailable)";
    const prompt =
      "You are the narrator of an RPG-style learning cycle. A cycle just finished. " +
      "Write ONE short paragraph (max ~300 characters) summarising what happened — " +
      "tone: lucid, grounded, light fantasy flavour ok but no purple prose. " +
      "No headings, no bullet points.\n\n" +
      `Cycle status: ${status}\n` +
      `Duration: ${duration}s\n` +
      `Reflection at the start: ${reflect}\n` +
      `Skills practiced: ${skills}\n` +
      `Quest completed: ${questTitle ?? "none"}\n` +
      `Structural outcomes:\n${struct}\n`;
    return callAgent(prompt);
  }

  private clearLock(): void {
    try {
      if (existsSync(CYCLE_LOCK_FILE)) unlinkSync(CYCLE_LOCK_FILE);
    } catch {
      /* ignore */
    }
  }
}

// --- Entry point (run as: bun src/quest-cycle.ts [trigger]) ---
const trigger = process.argv[2] ?? process.env["QUEST_CYCLE_TRIGGER"] ?? "manual";
const rc = await new QuestCycleRunner(trigger).run();
process.exit(rc);
