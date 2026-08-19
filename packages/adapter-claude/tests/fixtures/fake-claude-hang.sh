#!/bin/sh
# 한 줄 내보낸 뒤 출력 없이 멈춘다 — 에이전트 행(hang) 재현
echo '{"type":"system","session_id":"hung-session"}'
sleep 30
