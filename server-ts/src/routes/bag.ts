/** /api/bag/* — inventory endpoints. Reads bag.json + auto-includes any
 * .md file under ~/.openclaw/quest/completions/, with type + rarity
 * derived from the completion content via bag-classifier. */

import { readFile, readdir, stat, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { FastifyInstance } from "fastify";

import { BAG_FILE, COMPLETIONS_DIR } from "../config.ts";
import { classifyCompletion } from "../bag-classifier.ts";
import { manager } from "../ws-manager.ts";

interface BagItem {
  id: string;
  name: string;
  description?: string;
  type?: string;
  rarity?: string;
  icon?: string;
  file_path?: string;
  source_quest?: string | null;
  created_at?: string;
}

export async function registerBagRoutes(app: FastifyInstance): Promise<void> {
  app.get("/api/bag/items", async () => {
    const items: BagItem[] = [];

    if (existsSync(BAG_FILE)) {
      try {
        const raw = await readFile(BAG_FILE, "utf8");
        const parsed = JSON.parse(raw) as BagItem[];
        for (const item of parsed) {
          if (!item.id) item.id = `bag-${item.name ?? "unknown"}`;
          items.push(item);
        }
      } catch {
        /* ignore and continue with completions */
      }
    }

    if (existsSync(COMPLETIONS_DIR)) {
      try {
        const entries = await readdir(COMPLETIONS_DIR);
        const mdFiles: Array<{ name: string; mtime: number; raw: string; path: string }> = [];
        for (const name of entries) {
          if (!name.endsWith(".md")) continue;
          const full = join(COMPLETIONS_DIR, name);
          try {
            const s = await stat(full);
            const raw = s.size > 0 ? await readFile(full, "utf8") : "";
            mdFiles.push({ name, mtime: s.mtimeMs, raw, path: full });
          } catch {
            /* skip */
          }
        }
        mdFiles.sort((a, b) => b.mtime - a.mtime);
        for (const f of mdFiles) {
          const stem = f.name.replace(/\.md$/i, "");
          const { type, rarity, icon } = classifyCompletion({ raw: f.raw, stem });
          items.push({
            id: `completion-${stem}`,
            type,
            name: completionDisplayName(f.raw, stem),
            description: completionPreview(f.raw),
            source_quest: null,
            created_at: new Date(f.mtime).toISOString(),
            file_path: f.path,
            icon,
            rarity,
          });
        }
      } catch {
        /* ignore */
      }
    }

    return { items: items.slice(0, 50) };
  });

  app.post<{ Body: { item_id?: string } }>("/api/bag/discard", async (request, reply) => {
    const itemId = request.body?.item_id;
    if (!itemId) return reply.code(400).send({ error: "item_id required" });
    if (!existsSync(BAG_FILE)) return reply.code(404).send({ error: "bag not found" });

    try {
      const raw = await readFile(BAG_FILE, "utf8");
      const items = JSON.parse(raw) as BagItem[];
      const original = items.length;
      const remaining = items.filter(
        (i) => i.id !== itemId && `bag-${i.name ?? "unknown"}` !== itemId,
      );
      if (remaining.length === original) {
        return reply.code(404).send({ error: "item not found" });
      }
      await writeFile(BAG_FILE, JSON.stringify(remaining, null, 2));
      manager.broadcast({ type: "bag", data: { items: remaining } });
      return { ok: true, remaining: remaining.length };
    } catch (err) {
      return reply.code(500).send({ error: (err as Error).message });
    }
  });

  app.get<{ Params: { id: string } }>(
    "/api/bag/item/:id/content",
    async (request, reply) => {
      const itemId = request.params.id;
      // Try completions/<stem>.md first (prefix completion- stripped)
      const stem = itemId.startsWith("completion-") ? itemId.slice("completion-".length) : null;
      if (stem && existsSync(COMPLETIONS_DIR)) {
        const full = join(COMPLETIONS_DIR, `${stem}.md`);
        if (existsSync(full)) {
          try {
            const content = await readFile(full, "utf8");
            return { content, path: full };
          } catch {
            /* fall through */
          }
        }
      }
      return reply.code(404).send({ error: "not found" });
    },
  );
}

function completionDisplayName(raw: string, fallbackStem: string): string {
  for (const line of raw.split("\n")) {
    const t = line.trim();
    if (t.startsWith("# ")) {
      const title = t.slice(2).trim();
      if (title) return title.slice(0, 80);
    }
  }
  return fallbackStem.replace(/-/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

function completionPreview(raw: string): string {
  if (!raw) return "";
  const lines = raw.split("\n").map((l) => l.replace(/\s+$/, ""));
  const idx = lines.findIndex((l) => l.trim().toLowerCase() === "## brief");
  if (idx >= 0) {
    for (const l of lines.slice(idx + 1)) {
      const s = l.trim();
      if (s && !s.startsWith("#")) return s.slice(0, 200);
    }
  }
  for (const l of lines) {
    const s = l.trim();
    if (s && !s.startsWith("#") && !s.startsWith("- ") && !s.startsWith("*")) {
      return s.slice(0, 200);
    }
  }
  return "";
}
