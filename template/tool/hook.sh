#!/usr/bin/env bash
# codemap hook — PostToolUse for Write|Edit|MultiEdit ("edit") and Bash ("bash").
# Part of the codemap kit by Rateb Seirawan. The lane roots for the fast path
# live in .codemap/tool/lane-roots (written by the installer); when that file is
# missing the hook FAILS OPEN to reindex.ts, which reads the config itself. A
# fast path that could fail closed would silently stop every flag.
#
# Fast path in pure shell: most tool calls have nothing to do with an indexed
# lane, so reject them on a substring match before starting bun at all.
# Always exits 0, except when an index YAML was just written badly (exit 2
# hands the validator's message back to the agent that wrote it).

set -u
kind="${1:-edit}"
payload=$(cat 2>/dev/null) || exit 0
[ -z "$payload" ] && exit 0

root="${CLAUDE_PROJECT_DIR:-$(cd "$(dirname "$0")/../.." && pwd)}"

if [ "$kind" = "edit" ]; then
	case "$payload" in
		*.codemap/*) ;;
		*)
			roots="$root/.codemap/tool/lane-roots"
			if [ -f "$roots" ]; then
				hit=0
				while IFS= read -r r; do
					[ -z "$r" ] && continue
					if [ "$r" = "." ]; then hit=1; break; fi
					case "$payload" in *"$r"/*) hit=1; break ;; esac
				done < "$roots"
				[ "$hit" -eq 1 ] || exit 0
			fi
			;;
	esac
else
	# Reads cannot change a file. A false positive costs ~100ms; a false
	# negative costs a stale index, so the list is generous.
	case "$payload" in
		*'>'*|*sed*|*perl*|*python*|*tee*|*' mv '*|*' cp '*|*' rm '*|*patch*|*truncate*|*codemod*|*prettier*|*eslint*|*gofmt*|*rustfmt*|*black*|*ruff*) ;;
		*'git checkout'*|*'git restore'*|*'git stash'*|*'git apply'*|*'git rebase'*|*'git merge'*|*'git revert'*|*'git pull'*|*'git reset'*) ;;
		*) exit 0 ;;
	esac
fi

command -v bun >/dev/null 2>&1 || exit 0
printf '%s' "$payload" | bun "$root/.codemap/tool/reindex.ts" hook "$kind"
status=$?
[ "$status" -eq 2 ] && exit 2
exit 0
