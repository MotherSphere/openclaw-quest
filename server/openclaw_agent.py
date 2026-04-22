"""Thin wrapper around the `openclaw agent` CLI for single-turn LLM calls.

Used by quest_cycle (REFLECT / REPORT narration) and npc_chat (tavern NPCs)
so both sides share the same subprocess / JSON-parsing plumbing instead of
duplicating it.

All calls return a plain string (the agent's visible reply) or None on
failure — callers MUST have a deterministic fallback and never crash on
None.
"""

from __future__ import annotations

import json
import logging
import os
import subprocess
from typing import Any

from config import AGENT_RUNTIME_BIN

logger = logging.getLogger(__name__)

DEFAULT_AGENT_ID = os.environ.get("QUEST_CYCLE_AGENT_ID", "main")
DEFAULT_THINKING = os.environ.get("QUEST_CYCLE_THINKING", "minimal")
DEFAULT_TIMEOUT = int(os.environ.get("QUEST_CYCLE_LLM_TIMEOUT", "90"))


def _dig(obj: Any, key: str) -> str | None:
    """Recursive best-effort lookup — the exact JSON shape of `openclaw agent
    --json` has shifted across versions, so we dig for the first matching key
    at any depth."""
    if isinstance(obj, dict):
        if key in obj and isinstance(obj[key], str):
            return obj[key]
        for v in obj.values():
            found = _dig(v, key)
            if found:
                return found
    return None


def call_agent(
    prompt: str,
    *,
    agent_id: str = DEFAULT_AGENT_ID,
    thinking: str = DEFAULT_THINKING,
    timeout: int = DEFAULT_TIMEOUT,
) -> str | None:
    """Run a single `openclaw agent` turn and return the assistant's visible text.

    Returns None on any failure (binary missing, timeout, non-zero exit,
    unparseable JSON, empty reply) so callers can fall back to a default.
    """
    if not AGENT_RUNTIME_BIN.exists():
        return None
    cmd = [
        str(AGENT_RUNTIME_BIN),
        "agent",
        "--agent", agent_id,
        "--thinking", thinking,
        "--json",
        "-m", prompt,
    ]
    try:
        result = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout)
    except (subprocess.TimeoutExpired, OSError) as exc:
        logger.warning("openclaw agent call failed: %s", exc)
        return None
    if result.returncode != 0:
        logger.warning(
            "openclaw agent returned %d: %s",
            result.returncode,
            (result.stderr or "")[:200],
        )
        return None
    try:
        payload = json.loads(result.stdout)
    except json.JSONDecodeError:
        logger.warning("openclaw agent produced non-JSON output")
        return None
    text = _dig(payload, "finalAssistantVisibleText") or _dig(payload, "finalAssistantRawText")
    if not text:
        return None
    return text.strip() or None
