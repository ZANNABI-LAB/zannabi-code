#!/bin/sh
cat "$(dirname "$0")/exec-failed.jsonl"
echo "codex: turn failed" >&2
exit 1
