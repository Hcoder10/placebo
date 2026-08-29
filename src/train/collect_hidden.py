"""Extract the target hidden states a DFlash drafter is conditioned on.

DFlash's drafter is not a small independent language model. It is a model that
reads the *target's own internal representations*: the released checkpoint's
`dflash_config.target_layer_ids` is `[1, 6, 11, 16, 21]`, and the drafter's `fc`
maps `5 * 2880 -> 2880`. So before any training can happen, every trace has to be
replayed through gpt-oss-20b with `output_hidden_states=True` and those five
layers concatenated.

Two details decide whether the features are correct rather than merely plausible:

**The offset.** The reference implementation (`utils.extract_context_feature`)
indexes `hidden_states[layer_id + 1]`, because HF puts the embedding output at
index 0, so index `k` is the output of layer `k - 1`. vLLM's own DFlash path
agrees -- `gpu_model_runner.py` builds its aux layer list as
`[i + 1 for i in dflash_config["target_layer_ids"]]`. Off by one here and the
drafter trains against features it will never see at serving time.

**The tokens.** We replay the exact `prompt_token_ids + token_ids` that vLLM
returned when it generated the trace, not a re-tokenisation of the text. The
chat template, the harmony channel markers and the reasoning block all survive
verbatim, so the sequence the drafter learns on is byte-identical to the one the
server produces.

    python src/train/collect_hidden.py --out ~/dflash-data --device cuda:1

Writes one `.npy` per trace (bf16 viewed as uint16, shape [L, 14400]) plus an
`index.json` recording each sequence's token ids and where the generated region
starts. Roughly 18 MB per trace, so this goes inside WSL, never onto C:.
"""

from __future__ import annotations

import argparse
import json
import os
import time
from pathlib import Path

import numpy as np
import torch
from transformers import AutoModelForCausalLM

TARGET = "openai/gpt-oss-20b"
# From the released z-lab/gpt-oss-20b-DFlash config.json.
TARGET_LAYER_IDS = [1, 6, 11, 16, 21]
# HF hidden_states[0] is the embedding output, so layer L lands at index L + 1.
HIDDEN_INDICES = [layer_id + 1 for layer_id in TARGET_LAYER_IDS]


def load_traces(path: Path, limit: int | None) -> list[dict]:
    rows = []
    for line in path.read_text(encoding="utf-8").splitlines():
        if not line.strip():
            continue
        row = json.loads(line)
        # Older flywheel rows predate return_token_ids and carry text only. We
        # cannot replay those faithfully, so they are skipped rather than
        # re-tokenised into something the server never actually emitted.
        if not row.get("token_ids") or not row.get("prompt_token_ids"):
            continue
        rows.append(row)
    if limit:
        rows = rows[:limit]
    return rows


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--traces", default="data/draft-traces.jsonl")
    ap.add_argument("--out", default=os.path.expanduser("~/dflash-data"))
    ap.add_argument("--device", default="cuda:1")
    ap.add_argument("--batch", type=int, default=4)
    ap.add_argument("--limit", type=int, default=None)
    args = ap.parse_args()

    out = Path(os.path.expanduser(args.out))
    (out / "feat").mkdir(parents=True, exist_ok=True)

    rows = load_traces(Path(args.traces), args.limit)
    print(f"{len(rows)} replayable traces", flush=True)

    torch.set_grad_enabled(False)
    # device_map, not .to(): the MXFP4 path keeps packed weights and scale
    # tensors as plain buffers, and a post-hoc .to() leaves some of them on the
    # CPU, which surfaces much later as "Pointer argument cannot be accessed
    # from Triton (cpu tensor?)" from inside the expert matmul.
    model = AutoModelForCausalLM.from_pretrained(TARGET, dtype="auto", device_map=args.device)
    model.eval()
    footprint = sum(p.numel() * p.element_size() for p in model.parameters()) / 1e9
    print(f"target loaded, {footprint:.1f} GB of parameters on {args.device}", flush=True)

    pad_id = model.config.pad_token_id or 199999
    index: list[dict] = []
    t0 = time.time()
    done_tokens = 0

    for start in range(0, len(rows), args.batch):
        batch = rows[start : start + args.batch]
        seqs = [r["prompt_token_ids"] + r["token_ids"] for r in batch]
        lengths = [len(s) for s in seqs]
        width = max(lengths)
        # Right padding is safe here: the target is causal, so a real position
        # never attends to a pad that follows it.
        ids = torch.full((len(seqs), width), pad_id, dtype=torch.long)
        mask = torch.zeros((len(seqs), width), dtype=torch.long)
        for i, s in enumerate(seqs):
            ids[i, : len(s)] = torch.tensor(s, dtype=torch.long)
            mask[i, : len(s)] = 1
        ids = ids.to(args.device)
        mask = mask.to(args.device)

        out_hs = model(input_ids=ids, attention_mask=mask, output_hidden_states=True,
                       use_cache=False).hidden_states

        if start == 0:
            print(f"hidden_states: {len(out_hs)} tensors of {tuple(out_hs[0].shape)}, "
                  f"taking indices {HIDDEN_INDICES}", flush=True)
            assert len(out_hs) == model.config.num_hidden_layers + 1, "unexpected layer count"

        feat = torch.cat([out_hs[i] for i in HIDDEN_INDICES], dim=-1)  # [B, W, 14400]

        for i, row in enumerate(batch):
            length = lengths[i]
            arr = feat[i, :length].to(torch.bfloat16).contiguous()
            # bf16 has no numpy dtype; store the raw 16 bits and reinterpret on load.
            raw = arr.view(torch.uint16).cpu().numpy()
            name = f"{start + i:05d}.npy"
            np.save(out / "feat" / name, raw)
            index.append({
                "file": name,
                "length": length,
                "gen_start": len(row["prompt_token_ids"]),
                "token_ids": row["prompt_token_ids"] + row["token_ids"],
                "prompt": row["prompt"],
            })
            done_tokens += length

        if (start // args.batch) % 20 == 0:
            elapsed = time.time() - t0
            rate = done_tokens / max(elapsed, 1e-6)
            print(f"  {start + len(batch)}/{len(rows)} traces  {done_tokens} tokens  "
                  f"{rate:.0f} tok/s  {elapsed:.0f}s", flush=True)

    (out / "index.json").write_text(json.dumps(index), encoding="utf-8")
    gb = sum((out / "feat" / e["file"]).stat().st_size for e in index) / 1e9
    print(f"DONE {len(index)} traces, {done_tokens} tokens, {gb:.1f} GB in {time.time() - t0:.0f}s",
          flush=True)


if __name__ == "__main__":
    main()
