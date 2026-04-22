/** SQLite schema + CRUD — port of server/models.py.
 *
 * Uses bun:sqlite. The `events` table is dropped on startup to avoid
 * duplicate rows when the watcher replays events.jsonl (same behaviour as
 * the Python version). All other tables use CREATE IF NOT EXISTS so skills,
 * state, and quests persist across restarts. */

import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

import { DB_PATH } from "./config.ts";

const SCHEMA = `
CREATE TABLE events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ts TEXT NOT NULL,
    type TEXT NOT NULL,
    region TEXT,
    data TEXT
);

CREATE TABLE IF NOT EXISTS state (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    data TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS skills (
    name TEXT PRIMARY KEY,
    rarity TEXT DEFAULT 'common',
    category TEXT,
    description TEXT DEFAULT '',
    version INTEGER DEFAULT 1,
    created_at TEXT,
    updated_at TEXT,
    source TEXT
);

CREATE TABLE IF NOT EXISTS quests (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    description TEXT,
    rank TEXT DEFAULT 'C',
    status TEXT DEFAULT 'active',
    reward_gold INTEGER,
    reward_xp INTEGER,
    created_at TEXT,
    completed_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_events_type ON events(type);
CREATE INDEX IF NOT EXISTS idx_events_ts ON events(ts);
`;

let _db: Database | null = null;

function getDb(): Database {
  if (_db === null) {
    mkdirSync(dirname(DB_PATH), { recursive: true });
    const db = new Database(DB_PATH);
    db.exec("DROP TABLE IF EXISTS events");
    db.exec(SCHEMA);
    _db = db;
  }
  return _db;
}

export interface EventInput {
  ts?: string;
  timestamp?: string;
  type?: string;
  event?: string;
  region?: string | null;
  data?: Record<string, unknown>;
}

export interface EventRow {
  ts: string;
  type: string;
  region: string | null;
  data: Record<string, unknown>;
}

export interface SkillInput {
  name: string;
  rarity?: string;
  category?: string | null;
  version?: number;
  description?: string;
  created_at?: string | null;
  updated_at?: string | null;
  source?: string | null;
}

export interface SkillRow {
  name: string;
  rarity: string;
  category: string | null;
  version: number;
  description: string;
  created_at: string | null;
  updated_at: string | null;
  source: string | null;
}

export interface QuestInput {
  id: string;
  title?: string;
  description?: string | null;
  rank?: string;
  status?: string;
  reward_gold?: number | null;
  reward_xp?: number | null;
  created_at?: string | null;
  completed_at?: string | null;
}

export interface QuestRow {
  id: string;
  title: string;
  description: string | null;
  rank: string;
  status: string;
  reward_gold: number | null;
  reward_xp: number | null;
  created_at: string | null;
  completed_at: string | null;
}

export function initDb(): void {
  getDb();
}

export function insertEvent(event: EventInput): void {
  const db = getDb();
  const ts = event.ts ?? event.timestamp ?? "";
  const etype = event.type ?? event.event ?? "";
  db.prepare("INSERT INTO events (ts, type, region, data) VALUES (?, ?, ?, ?)").run(
    ts,
    etype,
    event.region ?? null,
    JSON.stringify(event.data ?? {}),
  );
}

export function upsertState(state: Record<string, unknown>): void {
  const db = getDb();
  db.prepare(
    "INSERT INTO state (id, data) VALUES (1, ?) ON CONFLICT(id) DO UPDATE SET data = excluded.data",
  ).run(JSON.stringify(state));
}

export function upsertSkill(skill: SkillInput): void {
  const name = (skill.name ?? "").trim();
  if (!name) return;
  const db = getDb();
  db.prepare(
    `INSERT INTO skills (name, rarity, category, version, description, created_at, updated_at, source)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(name) DO UPDATE SET
       rarity = excluded.rarity,
       category = excluded.category,
       version = excluded.version,
       description = CASE WHEN excluded.description != '' THEN excluded.description ELSE skills.description END,
       updated_at = excluded.updated_at,
       source = excluded.source`,
  ).run(
    name,
    skill.rarity ?? "common",
    skill.category ?? null,
    skill.version ?? 1,
    skill.description ?? "",
    skill.created_at ?? null,
    skill.updated_at ?? null,
    skill.source ?? null,
  );
}

export function upsertQuest(quest: QuestInput): void {
  const db = getDb();
  db.prepare(
    `INSERT INTO quests (id, title, description, rank, status, reward_gold, reward_xp, created_at, completed_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       status = excluded.status,
       completed_at = excluded.completed_at`,
  ).run(
    quest.id,
    quest.title ?? "",
    quest.description ?? null,
    quest.rank ?? "C",
    quest.status ?? "active",
    quest.reward_gold ?? null,
    quest.reward_xp ?? null,
    quest.created_at ?? null,
    quest.completed_at ?? null,
  );
}

export function getState(): Record<string, unknown> | null {
  const db = getDb();
  const row = db.prepare("SELECT data FROM state WHERE id = 1").get() as { data: string } | null;
  if (!row) return null;
  try {
    return JSON.parse(row.data) as Record<string, unknown>;
  } catch {
    return null;
  }
}

export function getEvents(limit = 50, offset = 0): EventRow[] {
  const db = getDb();
  const rows = db
    .prepare("SELECT ts, type, region, data FROM events ORDER BY id DESC LIMIT ? OFFSET ?")
    .all(limit, offset) as Array<{ ts: string; type: string; region: string | null; data: string | null }>;
  return rows.map((r) => ({
    ts: r.ts,
    type: r.type,
    region: r.region,
    data: r.data ? (safeParse(r.data) as Record<string, unknown>) : {},
  }));
}

export function hasFeedbackForEvent(eventId: string): boolean {
  if (!eventId) return false;
  const db = getDb();
  const pattern = `%\\"event_id\\": "${eventId}"%`;
  const row = db
    .prepare("SELECT 1 FROM events WHERE type = ? AND data LIKE ? LIMIT 1")
    .get("user_feedback", pattern);
  return row !== null && row !== undefined;
}

export function getSkills(): SkillRow[] {
  const db = getDb();
  return db
    .prepare(
      "SELECT name, rarity, category, version, description, created_at, updated_at, source FROM skills WHERE TRIM(name) != '' AND name IS NOT NULL ORDER BY name",
    )
    .all() as SkillRow[];
}

export function getQuests(status?: string | null): QuestRow[] {
  const db = getDb();
  if (status) {
    return db
      .prepare(
        "SELECT id, title, description, rank, status, reward_gold, reward_xp, created_at, completed_at FROM quests WHERE status = ? ORDER BY created_at DESC",
      )
      .all(status) as QuestRow[];
  }
  return db
    .prepare(
      "SELECT id, title, description, rank, status, reward_gold, reward_xp, created_at, completed_at FROM quests ORDER BY created_at DESC",
    )
    .all() as QuestRow[];
}

export function deleteSkill(name: string): boolean {
  const db = getDb();
  const result = db.prepare("DELETE FROM skills WHERE name = ?").run(name);
  return result.changes > 0;
}

function safeParse(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return {};
  }
}
