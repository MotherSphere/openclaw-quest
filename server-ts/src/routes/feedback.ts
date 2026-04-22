/** /api/feedback + /api/feedback/digest — thumbs up/down from the UI.
 *
 * Port of the ~120-line Python user_feedback + update_feedback_digest.
 * Owns the RLHF-at-prompt-level loop: each thumb updates MP in state,
 * appends to feedback-digest.json (skill_sentiment / workflow_sentiment /
 * recent_feedback / user_corrections), and broadcasts via WS so the
 * Chronicle card updates instantly. */

import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import type { FastifyInstance } from "fastify";

import {
  EVENTS_FILE,
  FEEDBACK_DIGEST_FILE,
  GAME_BALANCE,
  STATE_FILE,
} from "../config.ts";
import { hasFeedbackForEvent, insertEvent, upsertState } from "../models.ts";
import { manager } from "../ws-manager.ts";

const seenEventIds = new Set<string>();

interface FeedbackDigest {
  generated_at: string | null;
  summary: { total_positive: number; total_negative: number; net_sentiment: number };
  recent_feedback: Array<{
    ts: string;
    event_type: string;
    event_summary: string;
    feedback: "up" | "down";
    quest_context: string;
    skill: string;
  }>;
  skill_sentiment: Record<string, { up: number; down: number }>;
  workflow_sentiment: Record<string, { up: number; down: number; suggestion: string }>;
  user_corrections: string[];
}

function emptyDigest(): FeedbackDigest {
  return {
    generated_at: null,
    summary: { total_positive: 0, total_negative: 0, net_sentiment: 0 },
    recent_feedback: [],
    skill_sentiment: {},
    workflow_sentiment: {},
    user_corrections: [],
  };
}

async function readDigest(): Promise<FeedbackDigest> {
  if (!existsSync(FEEDBACK_DIGEST_FILE)) return emptyDigest();
  try {
    const raw = await readFile(FEEDBACK_DIGEST_FILE, "utf8");
    const parsed = JSON.parse(raw) as Partial<FeedbackDigest>;
    const base = emptyDigest();
    return { ...base, ...parsed, summary: { ...base.summary, ...(parsed.summary ?? {}) } };
  } catch {
    return emptyDigest();
  }
}

async function updateDigest(opts: {
  eventId: string;
  feedbackType: "up" | "down" | "positive" | "negative";
  eventType: string;
  detail: string;
  eventData: Record<string, unknown> | null;
}): Promise<void> {
  const digest = await readDigest();
  const now = new Date().toISOString();
  const isPositive = opts.feedbackType === "up" || opts.feedbackType === "positive";

  if (isPositive) digest.summary.total_positive += 1;
  else digest.summary.total_negative += 1;
  const total = digest.summary.total_positive + digest.summary.total_negative;
  digest.summary.net_sentiment = total > 0
    ? Math.round(((digest.summary.total_positive - digest.summary.total_negative) / total) * 100) / 100
    : 0;

  const ctx = opts.eventData ?? {};
  const skillName =
    (ctx["skill"] as string | undefined) ??
    (ctx["skill_name"] as string | undefined) ??
    (ctx["target"] as string | undefined) ??
    "";
  const questId =
    (ctx["quest_id"] as string | undefined) ?? (ctx["id"] as string | undefined) ?? "";
  const questContext = questId ? `Quest: ${(ctx["title"] as string) ?? questId}` : "";

  digest.recent_feedback.unshift({
    ts: now,
    event_type: opts.eventType,
    event_summary: opts.detail.slice(0, 200),
    feedback: isPositive ? "up" : "down",
    quest_context: questContext,
    skill: skillName,
  });
  digest.recent_feedback = digest.recent_feedback.slice(0, 20);

  if (skillName) {
    const s = digest.skill_sentiment[skillName] ?? { up: 0, down: 0 };
    if (isPositive) s.up += 1;
    else s.down += 1;
    digest.skill_sentiment[skillName] = s;
  }

  const workflowName =
    (ctx["workflow"] as string | undefined) ??
    (ctx["workflow_name"] as string | undefined) ??
    (ctx["target_workflow"] as string | undefined) ??
    "";
  if (workflowName) {
    const w = digest.workflow_sentiment[workflowName] ?? { up: 0, down: 0, suggestion: "" };
    if (isPositive) w.up += 1;
    else w.down += 1;
    if (w.down > w.up * 2 && w.down >= 3) {
      w.suggestion = `User is dissatisfied with training in '${workflowName}' — avoid or change approach`;
    } else if (w.up > 3 && w.down === 0) {
      w.suggestion = `User approves of '${workflowName}' direction — deepen exploration`;
    } else {
      w.suggestion = "";
    }
    digest.workflow_sentiment[workflowName] = w;
  }

  const corrections: string[] = [];
  for (const [name, w] of Object.entries(digest.workflow_sentiment)) {
    if (w.down > w.up * 2 && w.down >= 3) {
      corrections.push(
        `User repeatedly gave negative feedback on '${name}' domain — pivot away or change approach`,
      );
    } else if (w.up > 3 && w.down === 0) {
      corrections.push(`User consistently approves '${name}' direction — prioritize this domain`);
    }
  }
  const recentNeg = digest.recent_feedback.slice(0, 5).filter((r) => r.feedback === "down");
  if (recentNeg.length >= 3) {
    const domains = new Set(recentNeg.map((r) => r.quest_context).filter(Boolean));
    if (domains.size > 0) {
      corrections.push(
        `Last ${recentNeg.length} feedback entries are negative, related to: ${[...domains].join(", ")}`,
      );
    }
  }
  digest.user_corrections = corrections;
  digest.generated_at = now;

  await writeFile(FEEDBACK_DIGEST_FILE, JSON.stringify(digest, null, 2));
}

export async function registerFeedbackRoutes(app: FastifyInstance): Promise<void> {
  app.get("/api/feedback/digest", async () => readDigest());

  app.post<{
    Body: {
      event_id?: string;
      type?: string;
      detail?: string;
      event_type?: string;
      event_data?: Record<string, unknown>;
    };
  }>("/api/feedback", async (request, reply) => {
    const body = request.body ?? {};
    const eventId = body.event_id ?? "";
    const feedbackType = body.type ?? "";
    const detail = body.detail ?? "";
    const eventType = body.event_type ?? "";
    const eventData = (body.event_data ?? null) as Record<string, unknown> | null;

    if (eventId && (seenEventIds.has(eventId) || hasFeedbackForEvent(eventId))) {
      return reply.code(409).send({ error: "already_feedbacked" });
    }
    if (!["up", "down", "positive", "negative"].includes(feedbackType)) {
      return reply.code(400).send({ error: "type must be positive or negative" });
    }

    // Update MP in state.json
    let state: Record<string, unknown> = {};
    try {
      const raw = await readFile(STATE_FILE, "utf8");
      state = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      return reply.code(500).send({ error: "no state" });
    }

    const isPositive = feedbackType === "up" || feedbackType === "positive";
    const delta = GAME_BALANCE.feedback_mp_delta;
    const mp = Number(state["mp"] ?? 0);
    const mpMax = Number(state["mp_max"] ?? GAME_BALANCE.mp_max);
    state["mp"] = isPositive ? Math.min(mp + delta, mpMax) : Math.max(mp - delta, 0);

    if (eventId) seenEventIds.add(eventId);

    if ((state["hp"] as number | undefined) === 0) {
      state["reflection_letter_pending"] = true;
    }
    await writeFile(STATE_FILE, JSON.stringify(state, null, 2));

    // Log event to events.jsonl + DB
    const event = {
      ts: new Date().toISOString(),
      type: "user_feedback",
      region: null,
      data: {
        event_id: eventId,
        feedback_type: feedbackType,
        reason: detail,
        event_type: eventType,
        event_data: eventData,
      },
    };
    await writeFile(EVENTS_FILE, JSON.stringify(event) + "\n", { flag: "a" });
    insertEvent(event);
    upsertState(state);

    await updateDigest({
      eventId,
      feedbackType: feedbackType as "up" | "down" | "positive" | "negative",
      eventType,
      detail,
      eventData,
    });

    manager.broadcast({ type: "state", data: state });
    manager.broadcast({ type: "event", data: event });

    return {
      status: "ok",
      hp: (state["hp"] as number) ?? 0,
      mp: (state["mp"] as number) ?? 0,
      digest_updated: true,
    };
  });
}
