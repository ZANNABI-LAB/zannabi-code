#!/bin/sh
# packages/adapter-claude/tests/fixtures/fake-claude-exit1.sh
# 성공 stream-json을 출력하지만 exit 1로 종료한다 (exitCode 판정 테스트용)
echo "ARGS: $*" >&2
cat <<'EOF'
{"type":"system","subtype":"init","session_id":"fake-session"}
{"type":"result","subtype":"success","result":"done by fake","session_id":"fake-session"}
EOF
exit 1
