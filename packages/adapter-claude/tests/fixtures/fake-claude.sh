#!/bin/sh
# packages/adapter-claude/tests/fixtures/fake-claude.sh
# 받은 인자를 stderr에 기록하고(어댑터가 올바른 플래그를 넘기는지 검증용),
# 정해진 stream-json을 출력한다
echo "ARGS: $*" >&2
cat <<'EOF'
{"type":"system","subtype":"init","session_id":"fake-session"}
{"type":"result","subtype":"success","result":"done by fake","session_id":"fake-session"}
EOF
