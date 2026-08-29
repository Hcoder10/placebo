#!/usr/bin/env bash
# Domain-adapt the DFlash draft model on squaredcube1.
#
# Long jobs cannot be launched over SSH here: when the SSH session ends WSL
# shuts down and takes every child with it. So this script is driven by a
# Windows Scheduled Task via rig-dflash-train.cmd, and everything it does is
# logged to a file we tail from outside.
#
#   stage 1  extract  replay traces through gpt-oss-20b, dump layer [1,6,11,16,21]
#                     hidden states (~18 MB/trace) into ~/dflash-data
#   stage 2  train    fine-tune the released draft on those features
#
# CUDA_HOME/bin must be on PATH. A missing nvcc does not fail loudly here -- it
# silently breaks Triton JIT, which is how the MXFP4 expert matmul gets compiled.

set -u
export CUDA_HOME=/usr/local/cuda-13.0
export PATH="$CUDA_HOME/bin:$PATH"
export TOKENIZERS_PARALLELISM=false

STAGE="${1:-all}"
DEVICE="${DFLASH_DEVICE:-cuda:1}"
REPO="$HOME/robloxagent/placebo"
DATA="$HOME/dflash-data"
OUT="$HOME/dflash-adapted"
LOG="$HOME/robloxagent/dflash-train.log"

exec >>"$LOG" 2>&1
echo "=============================================================="
echo "stage=$STAGE device=$DEVICE started $(date -Is)"
nvcc --version | tail -1
source "$HOME/robloxagent/.venv/bin/activate"
cd "$REPO" || exit 1

if [ "$STAGE" = "extract" ] || [ "$STAGE" = "all" ]; then
  echo "--- stage 1: hidden state extraction ---"
  python src/train/collect_hidden.py \
    --traces data/draft-traces.jsonl \
    --out "$DATA" \
    --device "$DEVICE" \
    --batch 8
  echo "extract exit=$?"
  df -h / | tail -1
fi

if [ "$STAGE" = "train" ] || [ "$STAGE" = "all" ]; then
  echo "--- stage 2: draft adaptation ---"
  python src/train/dflash_adapt.py \
    --data "$DATA" \
    --out "$OUT" \
    --device "$DEVICE" \
    --epochs "${DFLASH_EPOCHS:-6}" \
    --lr "${DFLASH_LR:-5e-5}" \
    --accum "${DFLASH_ACCUM:-8}" \
    --holdout 60
  echo "train exit=$?"
fi

echo "finished $(date -Is)"
