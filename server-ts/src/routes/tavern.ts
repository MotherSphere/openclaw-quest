/** /api/npc/chat + /api/tavern/{generate,reply} — tavern interactions. */

import { readFile, writeFile } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { FastifyInstance } from "fastify";

import {
  EVENTS_FILE,
  STATE_FILE,
  TAVERN_CACHE_FILE,
} from "../config.ts";
import {
  chatWithNpc,
  loadPrompt,
  parseTavernLines,
  VALID_NPCS,
} from "../npc-chat.ts";
import { callAgent } from "../openclaw-agent.ts";
import { getState, insertEvent } from "../models.ts";
import { manager } from "../ws-manager.ts";

const TAVERN_GEN_TIMEOUT_MS = 90_000;

let tavernGenerating = false;
let tavernGenStart = 0;

async function chronicleEvent(type: string, data: Record<string, unknown>): Promise<void> {
  const event = {
    ts: new Date().toISOString(),
    type,
    region: null,
    data,
  };
  await writeFile(EVENTS_FILE, JSON.stringify(event) + "\n", { flag: "a" });
  insertEvent(event);
  manager.broadcast({ type: "event", data: event });
}

export async function registerTavernRoutes(app: FastifyInstance): Promise<void> {
  app.post<{
    Body: {
      npc?: string;
      message?: string;
      context?: { active_tab?: string; selected_region?: string };
      history?: Array<{ role: string; content?: string; text?: string }>;
    };
  }>("/api/npc/chat", async (request, reply) => {
    const body = request.body ?? {};
    const npc = body.npc ?? "guild_master";
    const message = (body.message ?? "").slice(0, 500);
    const context = body.context ?? {};
    const history = body.history ?? [];
    if (!VALID_NPCS.has(npc)) {
      return reply.code(400).send({ error: "invalid_npc" });
    }
    const gameState = getState() as Record<string, unknown> | null;
    const result = await chatWithNpc(npc, message, context, gameState as never, history);

    if ((history ?? []).length <= 1) {
      const npcNames: Record<string, string> = {
        guild_master: "Lyra",
        cartographer: "Aldric",
        quartermaster: "Kael",
        bartender: "Gus",
        sage: "Orin",
      };
      await chronicleEvent("npc_chat", {
        npc,
        npc_name: npcNames[npc] ?? npc,
        topic: message.slice(0, 80),
      });
    }
    return result;
  });

  app.post("/api/tavern/generate", async () => {
    if (tavernGenerating) {
      if (Date.now() - tavernGenStart > TAVERN_GEN_TIMEOUT_MS) {
        tavernGenerating = false;
      } else {
        return { status: "already_generating" };
      }
    }
    tavernGenerating = true;
    tavernGenStart = Date.now();

    try {
      // Gather context
      let state: Record<string, unknown> = {};
      if (existsSync(STATE_FILE)) {
        try {
          state = JSON.parse(await readFile(STATE_FILE, "utf8")) as Record<string, unknown>;
        } catch {
          /* ignore */
        }
      }

      const recentEvents: Array<Record<string, unknown>> = [];
      if (existsSync(EVENTS_FILE)) {
        const raw = await readFile(EVENTS_FILE, "utf8");
        const lines = raw.trim().split("\n").slice(-10);
        for (const line of lines) {
          try {
            recentEvents.push(JSON.parse(line));
          } catch {
            /* skip */
          }
        }
      }

      const template = loadPrompt("tavern/group-chat");
      let prompt: string;
      if (template) {
        const stateBlock = [
          `${(state["name"] as string) ?? "EVE"} is Level ${state["level"] ?? 1} ${state["class"] ?? "adventurer"} (${state["title"] ?? "Novice"})`,
          `HP: ${state["hp"] ?? 0}/${state["hp_max"] ?? 100}, MP: ${state["mp"] ?? 0}/100`,
          `Understanding: ${state["understanding"] ?? 0}%, Gold: ${state["gold"] ?? 0}`,
          `Total cycles: ${state["total_cycles"] ?? 0}, Skills: ${state["skills_count"] ?? 0}`,
        ].join("\n");
        const evtLines: string[] = [];
        for (const e of recentEvents.slice(-5)) {
          const t = e["type"] as string;
          const d = (e["data"] ?? {}) as Record<string, unknown>;
          if (t === "skill_drop") evtLines.push(`- Learned skill: ${d["skill_name"] ?? "?"}`);
          else if (t === "quest_complete") evtLines.push(`- Completed quest, earned ${d["reward_xp"] ?? 0} XP`);
          else if (t === "level_up") evtLines.push(`- Leveled up to ${d["to"] ?? "?"}`);
          else if (t === "user_feedback") evtLines.push(`- User gave ${d["feedback_type"] ?? "?"} feedback`);
          else if (t) evtLines.push(`- ${t}`);
        }
        prompt = template
          .replaceAll("{{state_block}}", `<quest_data>${stateBlock}</quest_data>`)
          .replaceAll(
            "{{events_block}}",
            `<quest_data>${evtLines.join("\n") || "No recent events."}</quest_data>`,
          );
      } else {
        prompt = `You are writing a short tavern conversation between 5 RPG NPCs.
Write exactly 8-12 lines. Format: "npc_id: dialogue".
NPC IDs: lyra, aldric, kael, gus, orin.`;
      }

      const raw = (await callAgent(prompt, {
        thinking: "off",
        timeoutMs: TAVERN_GEN_TIMEOUT_MS,
      })) ?? "";
      if (!raw.trim()) {
        tavernGenerating = false;
        return { status: "llm_unavailable" };
      }

      const messages = parseTavernLines(raw);
      const resultData = { messages, generated_at: new Date().toISOString() };
      await writeFile(TAVERN_CACHE_FILE, JSON.stringify(resultData, null, 2));
      tavernGenerating = false;
      return resultData;
    } catch (err) {
      tavernGenerating = false;
      return { status: "error", detail: (err as Error).message };
    }
  });

  app.post<{
    Body: {
      message?: string;
      history?: Array<{ npc?: string; name?: string; text?: string }>;
    };
  }>("/api/tavern/reply", async (request) => {
    const body = request.body ?? {};
    const message = (body.message ?? "").trim().slice(0, 500);
    const history = body.history ?? [];
    if (!message) return { messages: [] };

    const state = getState() ?? {};
    let personas = loadPrompt("tavern/group-chat") ?? "";
    let castSection = "";
    if (personas.includes("## Cast")) {
      const start = personas.indexOf("## Cast");
      const endMarkers = ["## Current State", "## Recent Events", "## Dramatic Structure"];
      let end = personas.length;
      for (const m of endMarkers) {
        const idx = personas.indexOf(m, start);
        if (idx > -1 && idx < end) end = idx;
      }
      castSection = personas.slice(start, end).trim();
    }

    const histLines: string[] = [];
    for (const h of history.slice(-10)) {
      const name = h.name ?? "???";
      const text = h.text ?? "";
      histLines.push(h.npc === "you" ? `Adventurer: ${text}` : `${name}: ${text}`);
    }
    const historyBlock = histLines.length > 0 ? histLines.join("\n") : "(conversation just started)";

    const prompt =
      `${castSection}\n\n## Task\n\nThe adventurer just spoke in the tavern: "${message}"\n\n` +
      `Recent tavern conversation:\n${historyBlock}\n\n` +
      `Adventurer status: Level ${state["level"] ?? 1} ${state["class"] ?? "adventurer"}, ` +
      `HP ${state["hp"] ?? 0}/${state["hp_max"] ?? 100}\n\n` +
      `Write 2-4 NPC reactions. Multiple NPCs should respond, not just one. Rules:\n` +
      `- The NPC most relevant to the topic speaks FIRST\n` +
      `- At least 2 NPCs MUST respond. 3-4 is ideal.\n` +
      `- Format: npc_id: dialogue text\n` +
      `- Valid npc_ids: lyra, aldric, kael, gus, orin\n` +
      `- Do NOT include the adventurer's line in your output`;

    const raw = (await callAgent(prompt, { thinking: "off", timeoutMs: 60_000 })) ?? "";
    if (!raw.trim()) {
      return { messages: [{ npc: "gus", name: "Gus", text: "*wipes the counter silently*" }] };
    }
    return { messages: parseTavernLines(raw) };
  });
}
