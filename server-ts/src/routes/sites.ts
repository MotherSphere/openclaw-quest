/** /api/sites and /api/sites/{define,rename,delete} — world-map site CRUD. */

import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import type { FastifyInstance } from "fastify";

import { MAP_FILE, SITES_FILE } from "../config.ts";
import { manager } from "../ws-manager.ts";

interface Site {
  id: string;
  name: string | null;
  is_default: boolean;
  defined: boolean;
  domain: string | null;
  workflow_id?: string | null;
  sprite?: string | null;
}

async function readSites(): Promise<Site[]> {
  if (!existsSync(SITES_FILE)) return [];
  try {
    const raw = await readFile(SITES_FILE, "utf8");
    return JSON.parse(raw) as Site[];
  } catch {
    return [];
  }
}

async function writeSites(sites: Site[]): Promise<void> {
  await writeFile(SITES_FILE, JSON.stringify(sites, null, 2));
}

export async function registerSiteRoutes(app: FastifyInstance): Promise<void> {
  app.get("/api/sites", async () => readSites());

  app.post<{ Body: { site_id?: string; name?: string; domain?: string } }>(
    "/api/sites/define",
    async (request, reply) => {
      const body = request.body ?? {};
      const siteId = body.site_id;
      const name = (body.name ?? "").trim();
      if (!siteId || !name || name.length > 40) {
        return reply.code(400).send({ error: "Invalid site_id or name (1-40 chars)" });
      }
      const sites = await readSites();
      const site = sites.find((s) => s.id === siteId);
      if (!site) return reply.code(404).send({ error: "site_not_found" });
      if (site.is_default) return reply.code(400).send({ error: "cannot_modify_default" });

      site.name = name;
      site.defined = true;
      site.domain = (body.domain ?? name.toLowerCase()).slice(0, 60);
      site.workflow_id = `${siteId}-workflow`;
      site.sprite = null;
      await writeSites(sites);
      manager.broadcast({ type: "sites", data: sites });
      return { ok: true, site };
    },
  );

  app.post<{ Body: { site_id?: string; name?: string } }>(
    "/api/sites/rename",
    async (request, reply) => {
      const body = request.body ?? {};
      const siteId = body.site_id;
      const name = (body.name ?? "").trim();
      if (!siteId || !name || name.length > 40) {
        return reply.code(400).send({ error: "Invalid site_id or name (1-40 chars)" });
      }
      const sites = await readSites();
      const site = sites.find((s) => s.id === siteId);
      if (!site) return reply.code(404).send({ error: "site_not_found" });
      site.name = name;
      await writeSites(sites);
      manager.broadcast({ type: "sites", data: sites });
      return { ok: true, site };
    },
  );

  app.post<{ Body: { site_id?: string } }>(
    "/api/sites/delete",
    async (request, reply) => {
      const siteId = request.body?.site_id;
      if (!siteId) return reply.code(400).send({ error: "site_id required" });
      const sites = await readSites();
      const site = sites.find((s) => s.id === siteId);
      if (!site) return reply.code(404).send({ error: "site_not_found" });
      if (site.is_default) return reply.code(400).send({ error: "cannot_delete_default" });
      site.name = null;
      site.defined = false;
      site.domain = null;
      site.workflow_id = null;
      site.sprite = null;
      await writeSites(sites);

      // Also remove matching workflow from knowledge-map.json if present
      if (existsSync(MAP_FILE)) {
        try {
          const raw = await readFile(MAP_FILE, "utf8");
          const map = JSON.parse(raw) as { workflows?: Array<{ id: string }> };
          const filtered = (map.workflows ?? []).filter(
            (w) => w.id !== `${siteId}-workflow`,
          );
          map.workflows = filtered;
          await writeFile(MAP_FILE, JSON.stringify(map, null, 2));
          manager.broadcast({ type: "map", data: map });
        } catch {
          /* ignore */
        }
      }
      manager.broadcast({ type: "sites", data: sites });
      return { ok: true };
    },
  );
}
