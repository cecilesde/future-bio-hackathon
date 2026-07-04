#!/usr/bin/env bash
# Wait for the background pull to finish, then run the full pipeline end-to-end
# and load final results to Supabase. Launched in the background after the pull.
set -euo pipefail
cd "$(dirname "$0")/.."
PY=.venv/bin/python

echo "[finalize] waiting for pull to complete..."
while ! grep -q "^DONE\." data/cache/pull.log 2>/dev/null; do
  sleep 30
done
echo "[finalize] pull done: $(ls data/cache/trials/ | wc -l) trial files"

echo "[finalize] build_dataset"; $PY -m pipeline.build_dataset
echo "[finalize] train";        $PY -m pipeline.train
echo "[finalize] score";        $PY -m pipeline.score
echo "[finalize] load_supabase"; $PY -m pipeline.load_supabase
echo "[finalize] COMPLETE"
