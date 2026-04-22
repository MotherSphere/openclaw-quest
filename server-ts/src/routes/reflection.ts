/** /api/reflection/latest + /api/reflection/acknowledge — reflection letter
 * generation (fires when HP hits 0), ported to `openclaw agent`. */

import { existsSync } from "node:fs";
import { readFile, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { FastifyInstance } from "fastify";

import {
  GAME_BALANCE,
  REFLECTION_LETTER_FILE,
  STATE_FILE,
} from "../config.ts";
import { callAgent } from "../openclaw-agent.ts";
import { getEvents, getQuests, upsertState } from "../models.ts";
import { manager } from "../ws-manager.ts";

const PROMPTS_DIR = join(process.cwd(), "server", "prompts");

export async function registerReflectionRoutes(app: FastifyInstance): Promise<void> {
  app.get("/api/reflection/latest", async () => {
    let state: Record<string, unknown> = {};
    if (existsSync(STATE_FILE)) {
      try {
        state = JSON.parse(await readFile(STATE_FILE, "utf8")) as Record<string, unknown>;
      } catch {
        /* ignore */
      }
    }
    const pending = (state["reflection_letter_pending"] as boolean | undefined) ?? false;
    if (existsSync(REFLECTION_LETTER_FILE)) {
      return { letter: await readFile(REFLECTION_LETTER_FILE, "utf8"), pending };
    }
    if (!pending) return { letter: "No reflection letter yet.", pending: false };

    try {
      const templatePath = join(PROMPTS_DIR, "reflection", "letter.md");
      let template: string;
      if (existsSync(templatePath)) {
        template = await readFile(templatePath, "utf8");
      } else {
        template =
          "Write a short heartfelt reflection letter from {{name}} — a Level {{level}} {{class}} — " +
          "who has just fallen. Reference recent events: {{recent_events}} and active quests: " +
          "{{active_quests}}. Total cycles so far: {{total_cycles}}. 3-5 short sentences, first person.";
      }
      template = template
        .replaceAll("{{name}}", (state["name"] as string) ?? "Adventurer")
        .replaceAll("{{level}}", String(state["level"] ?? 1))
        .replaceAll("{{class}}", (state["class"] as string) ?? "unknown");

      const events = getEvents(10);
      const recentText = events.length
        ? events.map((e) => ((e.data["title"] as string) ?? e.type).slice(0, 80)).join("; ")
        : "(no recent events)";
      template = template.replaceAll("{{recent_events}}", recentText);

      const quests = getQuests();
      const active = quests.filter(
        (q) => q.status === "active" || q.status === "in_progress" || q.status === "pending",
      );
      template = template.replaceAll(
        "{{active_quests}}",
        active.length ? active.map((q) => q.title).join("; ") : "(no active quests)",
      );
      template = template.replaceAll("{{total_cycles}}", String(state["total_cycles"] ?? 0));

      const letter = await callAgent(template, { thinking: "minimal" });
      if (letter) {
        await writeFile(REFLECTION_LETTER_FILE, letter);
        return { letter, pending: true };
      }
    } catch (err) {
      app.log.error({ err }, "Failed to generate reflection letter");
    }

    return {
      letter:
        "Your stability has reached zero. Take a moment to reflect on your journey. What went wrong? What can you learn?",
      pending: true,
    };
  });

  app.post("/api/reflection/acknowledge", async () => {
    if (!existsSync(STATE_FILE)) return { error: "no state" };
    const state = JSON.parse(await readFile(STATE_FILE, "utf8")) as Record<string, unknown>;
    const hpMax = Number(state["hp_max"] ?? 100);
    const ratio = GAME_BALANCE.reflection_hp_recovery_ratio;
    state["hp"] = Math.max(Number(state["hp"] ?? 0), Math.floor(hpMax * ratio));
    state["reflection_letter_pending"] = false;
    if ((state["hp"] as number) <= 0) state["reflection_letter_pending"] = true;
    await writeFile(STATE_FILE, JSON.stringify(state, null, 2));
    upsertState(state);

    try {
      if (existsSync(REFLECTION_LETTER_FILE)) await unlink(REFLECTION_LETTER_FILE);
    } catch {
      /* ignore */
    }
    manager.broadcast({ type: "state", data: state });
    return { ok: true, hp: state["hp"] };
  });
}
