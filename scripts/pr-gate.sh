#!/usr/bin/env bash
# PR self-review gate — PreToolUse(Bash) hook.
# Reads the hook JSON from stdin; if the command is a `git push` or
# `gh pr create`, requires a fresh passing verdict from /pr-self-review
# (.git/pr-self-review.json bound to HEAD sha + worktree hash).
# Exit 0 = allow, exit 2 = block (stderr goes back to the agent).
set -uo pipefail

INPUT="$(cat)"
CMD="$(printf '%s' "$INPUT" | python3 -c 'import json,sys
try: print(json.load(sys.stdin).get("tool_input",{}).get("command",""))
except Exception: print("")')"

# Only gate push / PR creation (tolerate rtk-rewritten and env-prefixed forms).
if ! printf '%s' "$CMD" | grep -qE '(^|[;&|]\s*|\s)(rtk\s+)?(git\s+push|gh\s+pr\s+create)(\s|$)'; then
  exit 0
fi

REPO_ROOT="$(git rev-parse --show-toplevel 2>/dev/null)" || exit 0
VERDICT_FILE="$REPO_ROOT/.git/pr-self-review.json"

# Escape hatch: PR_GATE_SKIP=1 with a mandatory reason; every skip is logged.
SKIP="${PR_GATE_SKIP:-}"; REASON="${PR_GATE_SKIP_REASON:-}"
if [[ -z "$SKIP" ]]; then
  SKIP="$(printf '%s' "$CMD" | sed -n 's/.*PR_GATE_SKIP=\([^ ]*\).*/\1/p')"
  REASON="$(printf '%s' "$CMD" | sed -n 's/.*PR_GATE_SKIP_REASON="\([^"]*\)".*/\1/p')"
fi
if [[ "$SKIP" == "1" ]]; then
  if [[ -z "$REASON" ]]; then
    echo "pr-gate: PR_GATE_SKIP=1 requires PR_GATE_SKIP_REASON=\"...\" — skip refused." >&2
    exit 2
  fi
  printf '{"skipped_at":"%s","head_sha":"%s","reason":%s}\n' \
    "$(date -u +%FT%TZ)" "$(git rev-parse HEAD)" \
    "$(printf '%s' "$REASON" | python3 -c 'import json,sys; print(json.dumps(sys.stdin.read()))')" \
    >> "$REPO_ROOT/.git/pr-self-review-skips.jsonl"
  echo "pr-gate: skipped by PR_GATE_SKIP=1 (logged): $REASON" >&2
  exit 0
fi

HEAD_SHA="$(git rev-parse HEAD)"
WT_HASH="$(git diff HEAD | git hash-object --stdin)"

RESULT="$(python3 - "$VERDICT_FILE" "$HEAD_SHA" "$WT_HASH" <<'PY'
import json, sys
path, head, wt = sys.argv[1:4]
try:
    v = json.load(open(path))
except Exception:
    print("missing"); sys.exit()
if v.get("verdict") != "pass": print("fail:%d critical finding(s)" % v.get("counts", {}).get("critical", 0))
elif v.get("partial"): print("partial")
elif v.get("head_sha") != head or v.get("worktree_hash") != wt: print("stale")
else: print("ok")
PY
)"

case "$RESULT" in
  ok) exit 0 ;;
  missing) MSG="no pr-self-review verdict found" ;;
  stale)   MSG="verdict is stale (new commits or uncommitted edits since last review)" ;;
  partial) MSG="last review was partial (--scope/--skill); a full run is required" ;;
  *)       MSG="last review failed: ${RESULT#fail:}" ;;
esac

echo "pr-gate: BLOCKED — $MSG. Run /pr-self-review and fix critical findings before pushing or opening a PR." >&2
exit 2
