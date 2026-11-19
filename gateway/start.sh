#!/usr/bin/env bash
# CatsApi gateway launcher — loads the standing egress proxy (Node fetch needs it on this VM).
set -a
source /home/hatch/workspace/camofox-browser/.env.proxy 2>/dev/null
set +a
export NODE_USE_ENV_PROXY=1
cd /home/hatch/workspace/catsapi-gateway
[ -f .env ] && { set -a; source .env; set +a; }
exec /usr/bin/node server.mjs
