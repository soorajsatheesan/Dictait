#!/usr/bin/env python3
"""Local stdio MCP server for Dictait notes, vocabulary, and snippets.

Exposes read-only tools over JSON-RPC 2.0 stdio so AI coding agents (Claude Code, Cursor,
Codex, T3 Code) can search your local voice notes without any network port or cloud sync.
"""
from __future__ import annotations

import json
import sqlite3
import sys
import time
from pathlib import Path

SUPPORT = Path.home() / "Library" / "Application Support" / "Dictait"
SERVER_INFO = {"name": "dictait", "version": "0.8.0"}
PROTOCOL_VERSION = "2024-11-05"

TOOLS = [
    {
        "name": "search_dictations",
        "description": "Full-text search across Dictait's local voice notes using SQLite FTS5.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "query": {"type": "string", "description": "Search keywords or phrase."},
                "limit": {"type": "integer", "minimum": 1, "maximum": 50, "default": 10},
            },
            "required": ["query"],
        },
    },
    {
        "name": "recent_dictations",
        "description": "Return the most recent local voice dictations in reverse chronological order.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "limit": {"type": "integer", "minimum": 1, "maximum": 50, "default": 10},
            },
        },
    },
    {
        "name": "get_dictation",
        "description": "Fetch a single dictation note by its id.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "id": {"type": "string", "description": "The note ID or 8-character prefix."},
            },
            "required": ["id"],
        },
    },
    {
        "name": "list_snippets",
        "description": "List the user's configured Dictait voice snippets and text macros.",
        "inputSchema": {"type": "object", "properties": {}},
    },
    {
        "name": "list_vocabulary",
        "description": "List the user's personal Dictait vocabulary terms and aliases.",
        "inputSchema": {"type": "object", "properties": {}},
    },
]


def _open_db(db_path: Path):
    if not db_path.exists():
        return None
    conn = sqlite3.connect(f"file:{db_path}?mode=ro", uri=True, timeout=2.0)
    conn.row_factory = sqlite3.Row
    return conn


def _fmt_time(ts: float) -> str:
    return time.strftime("%Y-%m-%d %H:%M:%S", time.localtime(ts))


def _load_personal(support: Path) -> dict:
    path = support / "personalization.json"
    if not path.exists():
        return {"vocabulary": [], "examples": [], "snippets": []}
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except Exception:
        return {"vocabulary": [], "examples": [], "snippets": []}


def call_tool(name: str, arguments: dict, support: Path = SUPPORT) -> dict:
    db_path = support / "memory.sqlite3"
    if name == "search_dictations":
        query = str(arguments.get("query", "")).strip()
        limit = max(1, min(50, int(arguments.get("limit", 10) or 10)))
        if not query:
            return {"results": []}
        conn = _open_db(db_path)
        if conn is None:
            return {"results": []}
        try:
            import re
            words = re.findall(r"\w+", query)[:20]
            if not words:
                return {"results": []}
            fts = " OR ".join('"' + w + '"' for w in words)
            rows = conn.execute(
                "SELECT n.id, n.body, n.created, n.language FROM note_search s "
                "JOIN notes n ON n.id = s.id WHERE note_search MATCH ? ORDER BY rank LIMIT ?",
                (fts, limit),
            ).fetchall()
            return {"results": [
                {"id": r["id"], "created": _fmt_time(r["created"]), "language": r["language"] or "", "body": r["body"]}
                for r in rows
            ]}
        finally:
            conn.close()

    if name == "recent_dictations":
        limit = max(1, min(50, int(arguments.get("limit", 10) or 10)))
        conn = _open_db(db_path)
        if conn is None:
            return {"results": []}
        try:
            rows = conn.execute(
                "SELECT id, body, created, language FROM notes ORDER BY created DESC LIMIT ?",
                (limit,),
            ).fetchall()
            return {"results": [
                {"id": r["id"], "created": _fmt_time(r["created"]), "language": r["language"] or "", "body": r["body"]}
                for r in rows
            ]}
        finally:
            conn.close()

    if name == "get_dictation":
        note_id = str(arguments.get("id", "")).strip()
        conn = _open_db(db_path)
        if conn is None or not note_id:
            return {"note": None}
        try:
            row = conn.execute(
                "SELECT id, body, created, language FROM notes WHERE id = ? OR id LIKE ? LIMIT 1",
                (note_id, note_id + "%"),
            ).fetchone()
            if row is None:
                return {"note": None}
            return {"note": {"id": row["id"], "created": _fmt_time(row["created"]), "language": row["language"] or "", "body": row["body"]}}
        finally:
            conn.close()

    if name == "list_snippets":
        data = _load_personal(support)
        return {"snippets": [{"trigger": s.get("trigger", ""), "content": s.get("content", "")} for s in data.get("snippets", []) if isinstance(s, dict)]}

    if name == "list_vocabulary":
        data = _load_personal(support)
        return {"vocabulary": [{"word": v.get("word", ""), "alias": v.get("alias", "")} for v in data.get("vocabulary", []) if isinstance(v, dict)]}

    raise KeyError(f"Unknown tool: {name}")


def handle_message(message: dict, support: Path = SUPPORT) -> dict | None:
    msg_id = message.get("id")
    method = message.get("method", "")
    params = message.get("params") or {}

    if method == "notifications/initialized":
        return None
    if method == "initialize":
        return {
            "jsonrpc": "2.0",
            "id": msg_id,
            "result": {
                "protocolVersion": PROTOCOL_VERSION,
                "capabilities": {"tools": {}},
                "serverInfo": SERVER_INFO,
            },
        }
    if method == "ping":
        return {"jsonrpc": "2.0", "id": msg_id, "result": {}}
    if method == "tools/list":
        return {"jsonrpc": "2.0", "id": msg_id, "result": {"tools": TOOLS}}
    if method == "tools/call":
        try:
            name = str(params.get("name", ""))
            args = params.get("arguments") or {}
            payload = call_tool(name, args, support=support)
            return {
                "jsonrpc": "2.0",
                "id": msg_id,
                "result": {
                    "content": [{"type": "text", "text": json.dumps(payload, ensure_ascii=False, indent=2)}],
                    "isError": False,
                },
            }
        except Exception as exc:
            return {
                "jsonrpc": "2.0",
                "id": msg_id,
                "result": {
                    "content": [{"type": "text", "text": str(exc)}],
                    "isError": True,
                },
            }
    if msg_id is None:
        return None
    return {"jsonrpc": "2.0", "id": msg_id, "error": {"code": -32601, "message": f"Method not found: {method}"}}


def main():
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            message = json.loads(line)
        except json.JSONDecodeError:
            continue
        reply = handle_message(message)
        if reply is not None:
            sys.stdout.write(json.dumps(reply, ensure_ascii=False) + "\n")
            sys.stdout.flush()


if __name__ == "__main__":
    main()
