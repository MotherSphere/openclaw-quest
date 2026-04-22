/** Read-only bridge to the running OpenClaw instance — port of
 * server/openclaw_bridge.py.
 *
 * Opens ~/.openclaw/tasks/runs.sqlite with `readonly: true` so the live
 * OpenClaw process can keep writing (WAL mode visible, no lock contention).
 * Also parses openclaw.json for the agents list.
 *
 * Every call is defensive: missing DB → empty list, query error → empty
 * list, malformed JSON → empty agents. The dashboard never sees an
 * exception from this module. */

import { Database } from "bun:sqlite";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { OPENCLAW_HOME } from "./config.ts";

const TASK_RUNS_DB = join(OPENCLAW_HOME, "tasks", "runs.sqlite");
const OPENCLAW_CONFIG_FILE = join(OPENCLAW_HOME, "openclaw.json");

const TASK_COLUMNS = [
  "task_id",
  "runtime",
  "task_kind",
  "agent_id",
  "label",
  "status",
  "created_at",
  "started_at",
  "ended_at",
  "last_event_at",
  "error",
  "progress_summary",
  "terminal_summary",
  "terminal_outcome",
] as const;

export interface TaskRun {
  task_id: string;
  runtime: string;
  task_kind: string | null;
  agent_id: string | null;
  label: string | null;
  status: string;
  created_at: number | null;
  started_at: number | null;
  ended_at: number | null;
  last_event_at: number | null;
  error: string | null;
  progress_summary: string | null;
  terminal_summary: string | null;
  terminal_outcome: string | null;
}

export interface StatusSummary {
  available: boolean;
  agents: Array<{ id: string; model: string }>;
  tasks: {
    by_status: Record<string, number>;
    by_runtime: Record<string, number>;
    total: number;
    last_event_at: number | null;
  };
  openclaw_home: string;
}

function roConnect(): Database | null {
  if (!existsSync(TASK_RUNS_DB)) return null;
  try {
    return new Database(TASK_RUNS_DB, { readonly: true });
  } catch (err) {
    console.warn("openclaw-bridge: failed to open tasks DB:", (err as Error).message);
    return null;
  }
}

export function readTaskRuns(limit = 100): TaskRun[] {
  const db = roConnect();
  if (!db) return [];
  try {
    const cap = Math.max(1, Math.min(Number.isFinite(limit) ? limit : 100, 500));
    const cols = TASK_COLUMNS.join(", ");
    const rows = db
      .prepare(`SELECT ${cols} FROM task_runs ORDER BY created_at DESC LIMIT ?`)
      .all(cap) as TaskRun[];
    return rows;
  } catch (err) {
    console.warn("openclaw-bridge: task_runs query failed:", (err as Error).message);
    return [];
  } finally {
    db.close();
  }
}

export function readStatusSummary(): StatusSummary {
  const summary: StatusSummary = {
    available: existsSync(TASK_RUNS_DB),
    agents: [],
    tasks: { by_status: {}, by_runtime: {}, total: 0, last_event_at: null },
    openclaw_home: OPENCLAW_HOME,
  };

  const db = roConnect();
  if (db) {
    try {
      const rows = db
        .prepare(
          "SELECT status, runtime, COUNT(*) AS n FROM task_runs GROUP BY status, runtime",
        )
        .all() as Array<{ status: string; runtime: string; n: number }>;
      for (const row of rows) {
        summary.tasks.by_status[row.status] = (summary.tasks.by_status[row.status] ?? 0) + row.n;
        summary.tasks.by_runtime[row.runtime] = (summary.tasks.by_runtime[row.runtime] ?? 0) + row.n;
        summary.tasks.total += row.n;
      }
      const latest = db.prepare("SELECT MAX(last_event_at) AS last FROM task_runs").get() as
        | { last: number | null }
        | undefined;
      summary.tasks.last_event_at = latest?.last ?? null;
    } catch (err) {
      console.warn("openclaw-bridge: summary query failed:", (err as Error).message);
    } finally {
      db.close();
    }
  }

  if (existsSync(OPENCLAW_CONFIG_FILE)) {
    try {
      const raw = readFileSync(OPENCLAW_CONFIG_FILE, "utf8");
      const cfg = JSON.parse(raw) as {
        agents?: { list?: Array<{ id?: string; model?: string }> };
      };
      const list = cfg.agents?.list ?? [];
      summary.agents = list
        .filter((a): a is { id: string; model?: string } => typeof a.id === "string" && a.id.length > 0)
        .map((a) => ({ id: a.id, model: a.model ?? "" }));
    } catch (err) {
      console.warn(
        "openclaw-bridge: failed to read openclaw.json:",
        (err as Error).message,
      );
    }
  }

  return summary;
}
