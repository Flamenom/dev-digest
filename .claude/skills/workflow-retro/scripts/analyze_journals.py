#!/usr/bin/env python3
"""Deep-parse Claude Code agent journals for a workflow retrospective.

Reads subagent journal files (`agent-<id>.jsonl`) and/or a main-session
transcript (`<session>.jsonl`) and aggregates, per agent and in total:
  - token usage (input / output / cache-read / cache-creation)
  - cache hit ratio (cache_read / total input-side tokens)
  - tool-call count
  - wall-clock span (first → last timestamp)
  - model(s) used
  - an OPTIONAL cost estimate (only when a price map is supplied)

It is intentionally read-only and dependency-free (stdlib only). The
`workflow-retro` skill calls it in `deep` mode; in the default mode the skill
reads usage straight from the orchestrator's in-context Agent results instead.

Usage:
  python3 analyze_journals.py FILE_OR_GLOB [FILE_OR_GLOB ...] [--json] [--prices prices.json]

Each positional argument is a path or a shell-expanded list of paths. Example:
  python3 analyze_journals.py \
    ~/.claude/projects/<proj>/<session>/subagents/agent-*.jsonl --json

Cost: pricing is NOT hard-coded (it changes and would go stale). Pass
--prices with a JSON map of {model_substring: {"in": $/Mtok, "out": $/Mtok,
"cache_read": $/Mtok, "cache_write": $/Mtok}}; verify current numbers via the
`claude-api` skill. Without it, cost is reported as "n/a".
"""
import sys
import json
import glob
import argparse
from datetime import datetime, timezone


def parse_ts(s):
    if not s:
        return None
    try:
        return datetime.fromisoformat(s.replace("Z", "+00:00"))
    except Exception:
        return None


def agent_label(path):
    base = path.rsplit("/", 1)[-1]
    if base.startswith("agent-") and base.endswith(".jsonl"):
        return base[len("agent-"):-len(".jsonl")]
    return base[:-len(".jsonl")] if base.endswith(".jsonl") else base


def load_meta(path):
    """Read the sibling `<journal>.meta.json` if present.

    Gives agentType, description, and spawnDepth. spawnDepth > 1 means this is a
    NESTED sub-agent (spawned by another sub-agent, not by the main session) — it
    must still be counted in the totals. Journals are stored FLAT in `subagents/`,
    so a plain `agent-*.jsonl` glob already includes every nesting level.
    """
    meta_path = path[:-len(".jsonl")] + ".meta.json" if path.endswith(".jsonl") else path + ".meta.json"
    try:
        with open(meta_path, "r", encoding="utf-8") as fh:
            return json.load(fh)
    except (OSError, ValueError):
        return {}


def accumulate(path):
    """Return a per-file aggregate dict, or None if the file is unreadable."""
    meta = load_meta(path)
    agg = {
        "agent": agent_label(path),
        "type": meta.get("agentType"),
        "desc": meta.get("description"),
        "depth": meta.get("spawnDepth", 1),
        "input": 0,
        "output": 0,
        "cache_read": 0,
        "cache_write": 0,
        "tool_calls": 0,
        "assistant_turns": 0,
        "models": set(),
        "ts_first": None,
        "ts_last": None,
        "lines": 0,
    }
    try:
        with open(path, "r", encoding="utf-8") as fh:
            for line in fh:
                line = line.strip()
                if not line:
                    continue
                agg["lines"] += 1
                try:
                    o = json.loads(line)
                except Exception:
                    continue
                ts = parse_ts(o.get("timestamp"))
                if ts:
                    if agg["ts_first"] is None or ts < agg["ts_first"]:
                        agg["ts_first"] = ts
                    if agg["ts_last"] is None or ts > agg["ts_last"]:
                        agg["ts_last"] = ts
                msg = o.get("message") or {}
                if not isinstance(msg, dict):
                    continue
                if msg.get("model"):
                    agg["models"].add(msg["model"])
                usage = msg.get("usage") or {}
                if usage:
                    agg["assistant_turns"] += 1
                    agg["input"] += usage.get("input_tokens", 0) or 0
                    agg["output"] += usage.get("output_tokens", 0) or 0
                    agg["cache_read"] += usage.get("cache_read_input_tokens", 0) or 0
                    agg["cache_write"] += usage.get("cache_creation_input_tokens", 0) or 0
                content = msg.get("content")
                if isinstance(content, list):
                    for block in content:
                        if isinstance(block, dict) and block.get("type") == "tool_use":
                            agg["tool_calls"] += 1
    except OSError:
        return None
    return agg


def price_for(model, prices):
    if not prices or not model:
        return None
    for key, p in prices.items():
        if key in model:
            return p
    return None


def cost_of(agg, prices):
    model = sorted(agg["models"])[0] if agg["models"] else None
    p = price_for(model, prices)
    if not p:
        return None
    m = 1_000_000
    return (
        agg["input"] / m * p.get("in", 0)
        + agg["output"] / m * p.get("out", 0)
        + agg["cache_read"] / m * p.get("cache_read", 0)
        + agg["cache_write"] / m * p.get("cache_write", 0)
    )


def span_seconds(agg):
    if agg["ts_first"] and agg["ts_last"]:
        return (agg["ts_last"] - agg["ts_first"]).total_seconds()
    return None


def fmt_int(n):
    return f"{n:,}"


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("paths", nargs="+")
    ap.add_argument("--json", action="store_true", help="emit machine-readable JSON")
    ap.add_argument("--prices", help="JSON file: {model_substr: {in,out,cache_read,cache_write}}")
    args = ap.parse_args()

    prices = None
    if args.prices:
        with open(args.prices) as fh:
            prices = json.load(fh)

    files = []
    for pat in args.paths:
        hits = glob.glob(pat)
        files.extend(hits if hits else [pat])
    files = sorted(set(files))

    rows = []
    for f in files:
        agg = accumulate(f)
        if agg and agg["lines"] > 0:
            rows.append(agg)

    if not rows:
        print("no readable journal files matched", file=sys.stderr)
        return 1

    # order by first timestamp (launch order)
    rows.sort(key=lambda a: (a["ts_first"] or datetime.max.replace(tzinfo=timezone.utc)))

    total = {"input": 0, "output": 0, "cache_read": 0, "cache_write": 0,
             "tool_calls": 0, "cost": 0.0, "has_cost": False}
    sum_span = 0.0
    wall_first = None
    wall_last = None

    out_rows = []
    for a in rows:
        c = cost_of(a, prices)
        sp = span_seconds(a)
        if sp:
            sum_span += sp
        if a["ts_first"] and (wall_first is None or a["ts_first"] < wall_first):
            wall_first = a["ts_first"]
        if a["ts_last"] and (wall_last is None or a["ts_last"] > wall_last):
            wall_last = a["ts_last"]
        cache_in = a["input"] + a["cache_read"] + a["cache_write"]
        hit = (a["cache_read"] / cache_in) if cache_in else 0.0
        for k in ("input", "output", "cache_read", "cache_write", "tool_calls"):
            total[k] += a[k]
        if c is not None:
            total["cost"] += c
            total["has_cost"] = True
        out_rows.append({
            "agent": a["agent"],
            "type": a["type"],
            "desc": a["desc"],
            "depth": a["depth"],
            "model": sorted(a["models"])[0] if a["models"] else None,
            "input": a["input"], "output": a["output"],
            "cache_read": a["cache_read"], "cache_write": a["cache_write"],
            "cache_hit": round(hit, 3),
            "tool_calls": a["tool_calls"],
            "turns": a["assistant_turns"],
            "span_s": round(sp, 1) if sp else None,
            "started": a["ts_first"].isoformat() if a["ts_first"] else None,
            "cost_usd": round(c, 4) if c is not None else None,
        })

    wall = (wall_last - wall_first).total_seconds() if (wall_first and wall_last) else None
    parallelism = round(sum_span / wall, 2) if (wall and wall > 0) else None
    tot_cache_in = total["input"] + total["cache_read"] + total["cache_write"]
    tot_hit = round(total["cache_read"] / tot_cache_in, 3) if tot_cache_in else 0.0
    max_depth = max((r["depth"] or 1) for r in out_rows)
    nested = sum(1 for r in out_rows if (r["depth"] or 1) > 1)

    summary = {
        "agents": len(out_rows),
        "nested_agents": nested,            # spawnDepth > 1, INCLUDED in every total below
        "max_depth": max_depth,
        "input": total["input"], "output": total["output"],
        "cache_read": total["cache_read"], "cache_write": total["cache_write"],
        "cache_hit": tot_hit,
        "tool_calls": total["tool_calls"],
        "wall_s": round(wall, 1) if wall else None,
        "sum_agent_span_s": round(sum_span, 1),
        "parallelism": parallelism,
        "cost_usd": round(total["cost"], 4) if total["has_cost"] else None,
    }

    if args.json:
        print(json.dumps({"agents": out_rows, "summary": summary}, indent=2))
        return 0

    # human table — nested agents (spawnDepth > 1) are indented but counted in TOTAL
    print(f"{'agent (└ = nested)':<30} {'type':<14} {'in':>9} {'out':>8} {'c-read':>9} "
          f"{'hit':>5} {'tools':>5} {'span':>7} {'cost':>8}")
    print("-" * 105)
    for r in out_rows:
        depth = r["depth"] or 1
        indent = ("  " * (depth - 1)) + ("└ " if depth > 1 else "")
        name = (indent + r["agent"])[:30]
        print(f"{name:<30} {(r['type'] or '?')[:14]:<14} "
              f"{fmt_int(r['input']):>9} {fmt_int(r['output']):>8} "
              f"{fmt_int(r['cache_read']):>9} {r['cache_hit']*100:>4.0f}% "
              f"{r['tool_calls']:>5} "
              f"{(str(r['span_s'])+'s') if r['span_s'] else '-':>7} "
              f"{('$'+format(r['cost_usd'],'.4f')) if r['cost_usd'] is not None else 'n/a':>8}")
    print("-" * 105)
    print(f"TOTAL agents={summary['agents']} (nested={summary['nested_agents']}, "
          f"max_depth={summary['max_depth']})  in={fmt_int(summary['input'])}  "
          f"out={fmt_int(summary['output'])}  cache_read={fmt_int(summary['cache_read'])}  "
          f"cache_hit={summary['cache_hit']*100:.0f}%  tools={summary['tool_calls']}")
    print(f"      wall={summary['wall_s']}s  sum_agent_span={summary['sum_agent_span_s']}s  "
          f"parallelism={summary['parallelism']}x  "
          f"cost={'$'+format(summary['cost_usd'],'.4f') if summary['cost_usd'] is not None else 'n/a (pass --prices)'}")
    print("note: totals INCLUDE all nested sub-agents (spawnDepth > 1).")
    return 0


if __name__ == "__main__":
    sys.exit(main())