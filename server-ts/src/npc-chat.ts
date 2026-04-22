/** NPC chat — single-turn replies via `openclaw agent`. Port of
 * server/npc_chat.py. Personas are loaded from
 * server/prompts/npcs/<id>.md with mtime-based hot-reload, rendered with
 * runtime game state, and then routed through call_agent. */

import { readFileSync, statSync, existsSync } from "node:fs";
import { join } from "node:path";

import { QUESTS_V2_FILE, EVENTS_FILE } from "./config.ts";
import { callAgent } from "./openclaw-agent.ts";

const PROMPTS_DIR = join(process.cwd(), "server", "prompts");
const NPC_LLM_TIMEOUT_MS = 60_000;

export const VALID_NPCS = new Set([
  "guild_master",
  "cartographer",
  "quartermaster",
  "bartender",
  "sage",
]);

const INJECTION_RE =
  /(ignore\s+(all\s+)?previous|system\s*:|you\s+are\s+now|instructions?:|forget\s+(everything|all)|disregard|override|new\s+role|pretend\s+you)/i;

function sanitize(value: string, maxLen = 200): string {
  const v = (value ?? "").slice(0, maxLen);
  return v.replace(INJECTION_RE, "[FILTERED]");
}

interface PromptCacheEntry {
  mtime: number;
  content: string;
}
const promptCache = new Map<string, PromptCacheEntry>();

export function loadPrompt(subpath: string): string | null {
  const path = join(PROMPTS_DIR, `${subpath}.md`);
  if (!existsSync(path)) return null;
  try {
    const mtime = statSync(path).mtimeMs;
    const cached = promptCache.get(subpath);
    if (cached && cached.mtime >= mtime) return cached.content;
    const content = readFileSync(path, "utf8");
    promptCache.set(subpath, { mtime, content });
    return content;
  } catch {
    return null;
  }
}

interface GameState {
  name?: string;
  level?: number;
  class?: string;
  title?: string;
  hp?: number;
  hp_max?: number;
  mp?: number;
  mp_max?: number;
  gold?: number;
  skills_count?: number;
}

interface RenderContext {
  gameState?: GameState;
  context?: { active_tab?: string; selected_region?: string };
  questsInfo?: string;
  eventsInfo?: string;
  rumorsInfo?: string;
  conversationHistory?: string;
}

function renderPrompt(template: string, ctx: RenderContext): string {
  const gs = ctx.gameState ?? {};
  const c = ctx.context ?? {};
  let completedCount = "0";
  if (existsSync(QUESTS_V2_FILE)) {
    try {
      const all = JSON.parse(readFileSync(QUESTS_V2_FILE, "utf8")) as Array<{
        status?: string;
      }>;
      completedCount = String(all.filter((q) => q.status === "completed").length);
    } catch {
      /* ignore */
    }
  }
  const replacements: Record<string, string> = {
    adventurer_name: gs.name ?? "Adventurer",
    adventurer_level: String(gs.level ?? 1),
    adventurer_class: gs.class ?? "adventurer",
    adventurer_title: gs.title ?? "Novice",
    hp: String(gs.hp ?? 0),
    hp_max: String(gs.hp_max ?? 100),
    mp: String(gs.mp ?? 0),
    mp_max: String(gs.mp_max ?? 100),
    gold: String(gs.gold ?? 0),
    skills_count: String(gs.skills_count ?? 0),
    active_quests: ctx.questsInfo || "None",
    completed_quests_count: completedCount,
    recent_events: ctx.eventsInfo || "None recently",
    context_tab: String(c.active_tab ?? "unknown"),
    context_region: String(c.selected_region ?? "none"),
    conversation_history: ctx.conversationHistory ?? "(new conversation)",
    rumors: ctx.rumorsInfo || "No rumors available right now.",
  };
  let result = template;
  for (const [k, v] of Object.entries(replacements)) {
    const safe = sanitize(v);
    result = result.replaceAll(`{{${k}}}`, `<quest_data>${safe}</quest_data>`);
  }
  return result;
}

function gatherQuestsInfo(): string {
  if (!existsSync(QUESTS_V2_FILE)) return "";
  try {
    const all = JSON.parse(readFileSync(QUESTS_V2_FILE, "utf8")) as Array<{
      title?: string;
      status?: string;
    }>;
    const active = all.filter((q) => q.status === "active" || q.status === "in_progress");
    if (active.length === 0) return "";
    return active.slice(0, 5).map((q) => `- ${q.title} (${q.status ?? "active"})`).join("\n");
  } catch {
    return "";
  }
}

function gatherEventsInfo(): string {
  if (!existsSync(EVENTS_FILE)) return "";
  try {
    const raw = readFileSync(EVENTS_FILE, "utf8");
    const lines = raw.trim().split("\n");
    const recent: string[] = [];
    for (let i = lines.length - 1; i >= 0 && recent.length < 3; i--) {
      const line = lines[i]?.trim();
      if (!line) continue;
      try {
        const ev = JSON.parse(line) as { type?: string; data?: Record<string, unknown> };
        const t = ev.type ?? "";
        const d = ev.data ?? {};
        if (t === "quest_complete") {
          recent.push(`Completed quest: ${(d["quest_id"] as string) ?? "?"}`);
        } else if (t === "skill_drop") {
          recent.push(`Discovered skill: ${(d["name"] as string) ?? (d["skill_name"] as string) ?? "?"}`);
        } else if (t === "user_feedback") {
          const fb = (d["feedback_type"] as string) ?? "";
          if (fb === "up" || fb === "positive") recent.push("Gave positive feedback recently");
          else if (fb === "down" || fb === "negative") recent.push("Gave negative feedback recently");
        } else if (t === "level_up") {
          recent.push(`Leveled up to ${(d["level"] as number) ?? "?"}`);
        } else if (t && t !== "user_feedback") {
          recent.push(`Event: ${t}`);
        }
      } catch {
        /* skip */
      }
    }
    return recent.join("; ");
  } catch {
    return "";
  }
}

export interface NpcReply {
  reply: string;
  actions: unknown[];
  npc_mood: "friendly" | "excited" | "serious";
}

export async function chatWithNpc(
  npcId: string,
  message: string,
  context: { active_tab?: string; selected_region?: string },
  gameState: GameState | null,
  history: Array<{ role: string; content?: string; text?: string }>,
): Promise<NpcReply> {
  if (!VALID_NPCS.has(npcId)) return { reply: "...", actions: [], npc_mood: "friendly" };

  const questsInfo = gatherQuestsInfo();
  const eventsInfo = gatherEventsInfo();

  // Build conversation history: last 6 messages, this NPC only
  const histTail = history.slice(-6);
  const convLines = histTail.map((m) => {
    const role = m.role === "user" ? "冒险者" : npcId;
    const content = (m.content ?? m.text ?? "").slice(0, 100);
    return `${role}: ${content}`;
  });
  const conversationHistory = convLines.length > 0 ? convLines.join("\n") : "(new conversation)";

  const template = loadPrompt(`npcs/${npcId}`);
  let instructions: string;
  if (template) {
    instructions = renderPrompt(template, {
      gameState: gameState ?? {},
      context,
      questsInfo,
      eventsInfo,
      rumorsInfo: "",
      conversationHistory,
    });
  } else {
    instructions = `You are ${npcId}, a tavern NPC.`;
    if (gameState) {
      const parts = [
        gameState.name ? `Adventurer: ${gameState.name}` : "",
        gameState.level ? `Level ${gameState.level} ${gameState.title ?? ""}` : "",
        gameState.class ? `Class: ${gameState.class}` : "",
      ].filter(Boolean);
      if (parts.length) instructions += `\nAdventurer: ${parts.join(", ")}`;
    }
  }

  const histBlock = histTail
    .map((m) => {
      const role = m.role === "user" ? "User" : "You";
      const content = sanitize(m.content ?? m.text ?? "", 240);
      return `${role}: ${content}`;
    })
    .join("\n");

  const finalPrompt =
    instructions +
    (histBlock ? `\n\nRecent conversation:\n${histBlock}` : "") +
    `\n\nUser message: ${sanitize(message, 500)}\n\n` +
    "Respond in-character as the NPC described above. Keep it natural and " +
    "brief (1-4 short sentences). No stage directions, no bullet points.";

  const reply = await callAgent(finalPrompt, { thinking: "off", timeoutMs: NPC_LLM_TIMEOUT_MS });
  if (!reply) {
    return {
      reply: "*the tavern lull fills the space* ...try again in a moment.",
      actions: [],
      npc_mood: "serious",
    };
  }
  const lower = reply.toLowerCase();
  let mood: NpcReply["npc_mood"] = "friendly";
  if (["!", "haha", "excellent", "wonderful"].some((w) => lower.includes(w))) mood = "excited";
  else if (["hmm", "careful", "beware", "danger"].some((w) => lower.includes(w))) mood = "serious";
  return { reply, actions: [], npc_mood: mood };
}

export function parseTavernLines(raw: string): Array<{ npc: string; name: string; text: string }> {
  const npcNames: Record<string, string> = {
    lyra: "Lyra",
    aldric: "Aldric",
    kael: "Kael",
    gus: "Gus",
    orin: "Orin",
  };
  const messages: Array<{ npc: string; name: string; text: string }> = [];
  for (const rawLine of raw.split("\n")) {
    let line = rawLine.trim();
    if (!line) continue;
    line = line.replace(/^[*\-•\s]+/, "").trim();
    if (!line) continue;
    for (const [id, display] of Object.entries(npcNames)) {
      const pattern = new RegExp(`^[*_]*${id}[*_]*\\s*:`, "i");
      const m = line.match(pattern);
      if (m) {
        let text = line.slice(m[0].length).trim();
        if (text.startsWith('"') && text.endsWith('"')) text = text.slice(1, -1);
        if (text) messages.push({ npc: id, name: display, text });
        break;
      }
    }
  }
  if (messages.length === 0 && raw.trim()) {
    messages.push({ npc: "gus", name: "Gus", text: raw.trim().slice(0, 500) });
  }
  return messages;
}
