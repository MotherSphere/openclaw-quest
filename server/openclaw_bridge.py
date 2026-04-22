"""Read-only bridge to the running OpenClaw instance.

Surfaces data from ~/.openclaw/ (tasks SQLite, openclaw.json) in shapes the
Quest dashboard can render. All access is strictly read-only — the bridge
never writes to EVE's live data directory, and it opens SQLite with
`mode=ro` so WAL writes from a running OpenClaw process remain visible
without risk of interference.
"""
import json
import logging
import sqlite3
from pathlib import Path
from typing import Any

from config import OPENCLAW_HOME

logger = logging.getLogger(__name__)

OPENCLAW_CONFIG_FILE = OPENCLAW_HOME / "openclaw.json"
TASK_RUNS_DB = OPENCLAW_HOME / "tasks" / "runs.sqlite"

TASK_COLUMNS = (
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
)


def _ro_connect() -> sqlite3.Connection | None:
    if not TASK_RUNS_DB.exists():
        return None
    uri = f"file:{TASK_RUNS_DB}?mode=ro"
    try:
        conn = sqlite3.connect(uri, uri=True, timeout=2.0)
        conn.row_factory = sqlite3.Row
        return conn
    except sqlite3.Error as exc:
        logger.warning("openclaw_bridge: failed to open tasks DB (%s)", exc)
        return None


def read_task_runs(limit: int = 100) -> list[dict[str, Any]]:
    """Return the N most recent OpenClaw task runs, newest first."""
    conn = _ro_connect()
    if conn is None:
        return []
    try:
        cols = ", ".join(TASK_COLUMNS)
        cur = conn.execute(
            f"SELECT {cols} FROM task_runs ORDER BY created_at DESC LIMIT ?",
            (max(1, min(limit, 500)),),
        )
        return [dict(row) for row in cur.fetchall()]
    except sqlite3.Error as exc:
        logger.warning("openclaw_bridge: task_runs query failed (%s)", exc)
        return []
    finally:
        conn.close()


def read_status_summary() -> dict[str, Any]:
    """Aggregate view: agents (from openclaw.json) + task counts by status."""
    summary: dict[str, Any] = {
        "available": TASK_RUNS_DB.exists(),
        "agents": [],
        "tasks": {"by_status": {}, "by_runtime": {}, "total": 0, "last_event_at": None},
        "openclaw_home": str(OPENCLAW_HOME),
    }

    conn = _ro_connect()
    if conn is not None:
        try:
            cur = conn.execute(
                "SELECT status, runtime, COUNT(*) AS n FROM task_runs GROUP BY status, runtime"
            )
            for row in cur.fetchall():
                status = row["status"]
                runtime = row["runtime"]
                n = row["n"]
                summary["tasks"]["by_status"][status] = (
                    summary["tasks"]["by_status"].get(status, 0) + n
                )
                summary["tasks"]["by_runtime"][runtime] = (
                    summary["tasks"]["by_runtime"].get(runtime, 0) + n
                )
                summary["tasks"]["total"] += n
            cur = conn.execute("SELECT MAX(last_event_at) AS last FROM task_runs")
            row = cur.fetchone()
            summary["tasks"]["last_event_at"] = row["last"] if row else None
        except sqlite3.Error as exc:
            logger.warning("openclaw_bridge: summary query failed (%s)", exc)
        finally:
            conn.close()

    if OPENCLAW_CONFIG_FILE.exists():
        try:
            cfg = json.loads(OPENCLAW_CONFIG_FILE.read_text())
            agents = (cfg.get("agents") or {}).get("list") or []
            summary["agents"] = [
                {"id": a.get("id"), "model": a.get("model")}
                for a in agents
                if a.get("id")
            ]
        except (json.JSONDecodeError, OSError) as exc:
            logger.warning("openclaw_bridge: failed to read openclaw.json (%s)", exc)

    return summary
