/** /api/skills + /api/skills/:name — skill inventory endpoints.
 *
 * GET: lists every row in the `skills` table (populated by the watcher
 * when the user runs `openclaw skills` or the cycle awards a skill).
 * DELETE: removes the skill directory under SKILLS_DIR and the matching
 * DB row, broadcasting a `skill_drop` event so tabs/components refresh.
 * Port of hermes-quest server/main.py:567-597. */

import { existsSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { FastifyInstance } from "fastify";

import { EVENTS_FILE, SKILLS_DIR } from "../config.ts";
import { deleteSkill, getSkills, insertEvent } from "../models.ts";
import { manager } from "../ws-manager.ts";

/** Walk SKILLS_DIR looking for the skill whose SKILL.md has matching
 * `name:` frontmatter, or whose directory name matches as fallback.
 * Returns true if a directory was removed. */
function rmSkillDir(skillName: string): boolean {
  if (!existsSync(SKILLS_DIR)) return false;
  const stack: string[] = [SKILLS_DIR];
  while (stack.length > 0) {
    const dir = stack.pop()!;
    let entries: string[] = [];
    try {
      entries = readdirSync(dir);
    } catch {
      continue;
    }
    for (const entry of entries) {
      const full = join(dir, entry);
      let st;
      try {
        st = statSync(full);
      } catch {
        continue;
      }
      if (!st.isDirectory()) continue;
      const skillFile = join(full, "SKILL.md");
      if (existsSync(skillFile)) {
        let matches = entry === skillName;
        if (!matches) {
          try {
            const raw = readFileSync(skillFile, "utf8");
            const fm = raw.match(/^---\s*\n([\s\S]*?)\n---/);
            if (fm) {
              const nameLine = fm[1]!.match(/^name:\s*(.+)$/m);
              if (nameLine && nameLine[1]!.trim() === skillName) matches = true;
            }
          } catch {
            /* ignore parse errors — fall back to dir-name match */
          }
        }
        if (matches) {
          try {
            rmSync(full, { recursive: true, force: true });
            return true;
          } catch {
            /* keep trying siblings */
          }
        }
      } else {
        // Category dir — descend.
        stack.push(full);
      }
    }
  }
  return false;
}

export async function registerSkillsRoutes(app: FastifyInstance): Promise<void> {
  app.get("/api/skills", async () => getSkills());

  app.delete<{ Params: { name: string } }>("/api/skills/:name", async (request, reply) => {
    const skillName = decodeURIComponent(request.params.name ?? "").trim();
    if (!skillName) return reply.code(400).send({ error: "skill_name required" });

    const deletedFs = rmSkillDir(skillName);
    const deletedDb = deleteSkill(skillName);
    if (!deletedFs && !deletedDb) {
      return reply.code(404).send({ error: "skill_not_found" });
    }

    const event = {
      ts: new Date().toISOString(),
      type: "skill_drop",
      region: null,
      data: { skill: skillName, action: "forget" },
    };
    try {
      await writeFile(EVENTS_FILE, JSON.stringify(event) + "\n", { flag: "a" });
      insertEvent(event);
    } catch {
      /* best-effort event log */
    }
    manager.broadcast({ type: "event", data: event });
    manager.broadcast({ type: "skill_deleted", data: { name: skillName } });
    return { status: "deleted", name: skillName };
  });
}
