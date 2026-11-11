#!/usr/bin/env python3
"""Condense a Claude Code transcript into a handoff file for a fresh session.

Keeps: user prompts, assistant prose, one line per tool call, tool errors,
compaction summaries. Drops: tool results, thinking, attachments, metadata.

usage: condense.py SESSION_ID OUT_PATH
prints one JSON line: {"out", "transcript", "chars", "tokens", "turns"}
"""
import glob
import json
import os
import re
import sys

USER_CAP = 6000
ASSISTANT_CAP = 4000
TOOL_CAP = 160
ERROR_CAP = 300

NOISE = re.compile(
    r"<(system-reminder|local-command-caveat|local-command-stdout|local-command-stderr)>.*?</\1>",
    re.S,
)
COMMAND = re.compile(r"<command-name>(.*?)</command-name>.*?(?:<command-args>(.*?)</command-args>)?", re.S)
BASH_IN = re.compile(r"<bash-input>(.*?)</bash-input>", re.S)
BASH_OUT = re.compile(r"<bash-(?:stdout|stderr)>(.*?)</bash-(?:stdout|stderr)>", re.S)
KEY_ARGS = ("description", "command", "file_path", "path", "pattern", "query", "url", "skill", "prompt", "code")
EDIT_TOOLS = {"Edit", "Write", "NotebookEdit", "MultiEdit"}


def clip(text, cap):
    text = text.strip()
    if len(text) <= cap:
        return text
    half = cap // 2
    return f"{text[:half]}\n[… {len(text) - cap} chars cut …]\n{text[-half:]}"


def one_line(text, cap):
    text = " ".join(str(text).split())
    return text if len(text) <= cap else text[: cap - 1] + "…"


def clean_user_text(text):
    cmd = COMMAND.search(text)
    if cmd:
        return f"/{cmd.group(1).lstrip('/')} {(cmd.group(2) or '').strip()}".strip()
    text = BASH_IN.sub(lambda m: f"! {m.group(1).strip()}", text)
    text = BASH_OUT.sub(lambda m: clip(m.group(1), 1500), text)
    return NOISE.sub("", text).strip()


def tool_line(block):
    name = block.get("name", "?")
    short = name.split("__")[-1] if name.startswith("mcp__") else name
    args = block.get("input") or {}
    key = next((args[k] for k in KEY_ARGS if isinstance(args, dict) and args.get(k)), None)
    detail = key if key is not None else json.dumps(args, ensure_ascii=False)
    return f"  → {short}: {one_line(detail, TOOL_CAP)}"


def find_transcript(session_id):
    hits = glob.glob(os.path.expanduser(f"~/.claude/projects/*/{session_id}.jsonl"))
    if not hits:
        sys.exit(f"no transcript for session {session_id}")
    return max(hits, key=os.path.getmtime)


def main():
    session_id, out = sys.argv[1], sys.argv[2]
    path = find_transcript(session_id)
    lines, edited = [], []
    meta = {"title": None, "cwd": None, "branch": None, "first": None, "last": None}
    turns = 0

    with open(path, encoding="utf-8", errors="replace") as fh:
        for raw in fh:
            try:
                rec = json.loads(raw)
            except ValueError:
                continue
            kind = rec.get("type")
            if kind == "ai-title":
                meta["title"] = rec.get("aiTitle") or rec.get("title") or meta["title"]
                continue
            if kind not in ("user", "assistant") or rec.get("isSidechain"):
                continue
            meta["cwd"] = rec.get("cwd") or meta["cwd"]
            meta["branch"] = rec.get("gitBranch") or meta["branch"]
            meta["first"] = meta["first"] or rec.get("timestamp")
            meta["last"] = rec.get("timestamp") or meta["last"]
            content = (rec.get("message") or {}).get("content")
            blocks = [{"type": "text", "text": content}] if isinstance(content, str) else content or []

            for block in blocks:
                btype = block.get("type")
                if kind == "user" and rec.get("isCompactSummary") and btype == "text":
                    lines.append(f"\n### Earlier compaction summary\n\n{clip(block['text'], 20000)}\n")
                elif kind == "user" and btype == "text" and not rec.get("isMeta"):
                    text = clean_user_text(block.get("text", ""))
                    if text:
                        turns += 1
                        lines.append(f"\n### User ({rec.get('timestamp', '')[:16]})\n\n{clip(text, USER_CAP)}\n")
                elif kind == "user" and btype == "tool_result" and block.get("is_error"):
                    body = block.get("content")
                    if isinstance(body, list):
                        body = " ".join(b.get("text", "") for b in body if isinstance(b, dict))
                    lines.append(f"  ✗ error: {one_line(body or '', ERROR_CAP)}")
                elif kind == "assistant" and btype == "text" and block.get("text", "").strip():
                    lines.append(f"\n**Claude:** {clip(block['text'], ASSISTANT_CAP)}\n")
                elif kind == "assistant" and btype == "tool_use":
                    lines.append(tool_line(block))
                    fp = (block.get("input") or {}).get("file_path")
                    if block.get("name") in EDIT_TOOLS and fp and fp not in edited:
                        edited.append(fp)

    body = "\n".join(lines)
    head = [
        f"# Handoff from session {session_id}",
        "",
        f"- Title: {meta['title'] or '(none)'}",
        f"- Working directory: {meta['cwd']}",
        f"- Git branch at the end: {meta['branch']}",
        f"- Time span: {meta['first']} → {meta['last']}",
        f"- Full raw transcript (JSONL, grep it for tool output): {path}",
        f"- User turns: {turns}",
        "",
        "## Files edited or written",
        "",
        *([f"- {p}" for p in edited] or ["- (none)"]),
        "",
        "## Conversation (tool results and thinking left out)",
    ]
    text = "\n".join(head) + "\n" + body + "\n"
    os.makedirs(os.path.dirname(out), exist_ok=True)
    with open(out, "w", encoding="utf-8") as fh:
        fh.write(text)
    print(json.dumps({"out": out, "transcript": path, "chars": len(text), "tokens": len(text) // 4, "turns": turns}))


if __name__ == "__main__":
    main()
