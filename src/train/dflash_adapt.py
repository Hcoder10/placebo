"""Domain-adapt the released DFlash draft model to this system's own traces.

z-lab publish the drafter but not the code that trained it, so the objective
here is reconstructed from the checkpoint's own `spec_generate` loop. That loop
is the specification, and getting the reconstruction wrong in a way that still
runs is the easiest way to produce a number that means nothing. What it does,
per drafting step:

    context     target hidden states for positions 0 .. S-1, concatenated over
                layers [1,6,11,16,21] (14400 wide), pushed through `fc` and
                `hidden_norm` once, then read as K/V by every draft layer
    queries     embed([tok[S], MASK, MASK, ... ]) -- 8 positions, S .. S+7,
                attending to the whole context and *bidirectionally* to their
                own block (`is_causal = False`; this is the block-diffusion part)
    prediction  the last 7 query outputs, through the TARGET's lm_head, are the
                tokens at S+1 .. S+7

So the training loss is cross-entropy of those 7 logits against the tokens the
target actually emitted. Only the drafter trains: `lm_head` and `embed_tokens`
belong to the target and stay frozen, because at serving time the drafter does
not own them.

The one liberty taken over the inference loop is packing. Inference does one
block per forward; here every block of a sequence goes through in a single
forward, separated by an attention mask that gives block b the context
`0 .. S_b - 1` and no other block's queries. That is the same computation, ~60x
fewer forwards. Block starts are strided by 8 from a per-epoch random offset,
because at serving time a block starts wherever the previous one was accepted to.

Reported before and after training on a held-out split:

  per-position top-1 match  does the drafter's argmax equal the token the target
                            actually produced, at each of the 7 offsets
  expected accepted length  1 + sum of the cumulative products of those, which is
                            what acceptance means -- a block is accepted up to
                            its first mistake

That last number is an offline predictor of the quantity `speculation.ts`
measures against a live server. It is a predictor and not the measurement: it
scores against tokens the target *sampled* at temperature 0.7, while the
benchmark decodes greedily. The live number is the one that counts; this one is
here so a failed adaptation is visible in minutes rather than after a redeploy.

    python src/train/dflash_adapt.py --data ~/dflash-data --out ~/dflash-adapted
"""

from __future__ import annotations

import argparse
import json
import math
import os
import random
import time
from pathlib import Path

import numpy as np
import torch
import torch.nn.functional as F
from safetensors import safe_open
from safetensors.torch import save_file
from transformers import AutoModel

DRAFT = "z-lab/gpt-oss-20b-DFlash"
TARGET = "openai/gpt-oss-20b"


# --------------------------------------------------------------------------
# the target's embedding table and output head, without loading the target
# --------------------------------------------------------------------------

def load_target_heads(device: torch.device) -> tuple[torch.Tensor, torch.Tensor]:
    """Pull `embed_tokens` and `lm_head` out of the target's safetensors.

    These two are bf16 in the checkpoint (only the MoE experts are MXFP4), so
    they can be read directly and we never pay for a 20B model just to embed a
    mask token and project 7 hidden states.
    """
    from huggingface_hub import snapshot_download

    root = Path(snapshot_download(TARGET, allow_patterns=["*.safetensors", "*.json"]))
    index = json.loads((root / "model.safetensors.index.json").read_text())["weight_map"]

    def find(*candidates: str) -> str:
        for name in candidates:
            if name in index:
                return name
        raise KeyError(f"none of {candidates} in target checkpoint")

    embed_key = find("model.embed_tokens.weight")
    head_key = find("lm_head.weight", "model.embed_tokens.weight")

    out = {}
    for key in {embed_key, head_key}:
        with safe_open(root / index[key], framework="pt", device="cpu") as f:
            out[key] = f.get_tensor(key)
    embed = out[embed_key].to(device=device, dtype=torch.bfloat16)
    head = out[head_key].to(device=device, dtype=torch.bfloat16)
    print(f"target heads: embed {tuple(embed.shape)} lm_head {tuple(head.shape)}"
          f"{' (tied)' if embed_key == head_key else ''}", flush=True)
    return embed, head


# --------------------------------------------------------------------------
# data
# --------------------------------------------------------------------------

class Traces:
    def __init__(self, root: Path):
        self.root = root
        self.index = json.loads((root / "index.json").read_text())

    def __len__(self) -> int:
        return len(self.index)

    def get(self, i: int, device: torch.device) -> tuple[torch.Tensor, torch.Tensor, int]:
        entry = self.index[i]
        raw = np.load(self.root / "feat" / entry["file"])          # uint16 view of bf16
        feat = torch.from_numpy(raw).to(device).view(torch.bfloat16)
        ids = torch.tensor(entry["token_ids"], dtype=torch.long, device=device)
        return feat, ids, entry["gen_start"]


def build_blocks(
    ids: torch.Tensor,
    gen_start: int,
    block_size: int,
    mask_token_id: int,
    offset: int,
) -> tuple[torch.Tensor, torch.Tensor, torch.Tensor] | None:
    """Block starts, the masked query token ids, and the labels."""
    length = ids.shape[0]
    first = gen_start + offset
    last = length - block_size          # need S + block_size - 1 <= length - 1
    if last < first:
        return None
    starts = torch.arange(first, last + 1, block_size, device=ids.device)
    step = torch.arange(block_size, device=ids.device)
    positions = starts[:, None] + step[None, :]                    # [B, 8]
    query_ids = ids[positions].clone()
    query_ids[:, 1:] = mask_token_id     # only the block's first token is known
    labels = ids[positions[:, 1:]]                                 # [B, 7]
    return starts, query_ids, labels


def build_attention_mask(
    starts: torch.Tensor,
    context_len: int,
    block_size: int,
    dtype: torch.dtype,
) -> torch.Tensor:
    """Additive mask over keys `[context (context_len) | queries (B*block_size)]`.

    Block b sees context positions `< S_b` -- exactly what the inference loop
    has in its KV cache when it drafts that block, no more -- and every query of
    its own block, in both directions. It sees nothing of any other block.
    """
    num_blocks = starts.shape[0]
    num_queries = num_blocks * block_size
    device = starts.device
    query_block = torch.arange(num_queries, device=device) // block_size
    query_start = starts[query_block]                                        # [Q]

    context_ok = torch.arange(context_len, device=device)[None, :] < query_start[:, None]
    block_ok = query_block[None, :] == query_block[:, None]
    allow = torch.cat([context_ok, block_ok], dim=1)                         # [Q, K]
    return torch.where(allow, 0.0, torch.finfo(dtype).min).to(dtype)[None, None]


# --------------------------------------------------------------------------
# forward
# --------------------------------------------------------------------------

def draft_logits(
    draft: torch.nn.Module,
    embed: torch.Tensor,
    head: torch.Tensor,
    feat: torch.Tensor,
    starts: torch.Tensor,
    query_ids: torch.Tensor,
    block_size: int,
) -> torch.Tensor:
    context_len = feat.shape[0]
    num_blocks = starts.shape[0]
    step = torch.arange(block_size, device=feat.device)
    positions = starts[:, None] + step[None, :]

    noise = F.embedding(query_ids.reshape(-1), embed)[None]                  # [1, Q, H]
    position_ids = torch.cat([
        torch.arange(context_len, device=feat.device),
        positions.reshape(-1),
    ])[None]
    mask = build_attention_mask(starts, context_len, block_size, noise.dtype)

    hidden = draft(
        position_ids=position_ids,
        attention_mask=mask,
        noise_embedding=noise,
        target_hidden=feat[None],
        past_key_values=None,
        use_cache=False,
    )
    # Per block, the last block_size-1 outputs predict tokens S+1 .. S+7 --
    # the same slice the inference loop takes with [:, -block_size+1:, :].
    hidden = hidden.view(1, num_blocks, block_size, -1)[:, :, 1:, :]
    return F.linear(hidden.reshape(-1, hidden.shape[-1]), head)              # [B*7, V]


@torch.no_grad()
def evaluate(draft, embed, head, traces, ids_range, device, block_size, mask_token_id):
    """Per-position top-1 match and the accepted length it implies."""
    draft.eval()
    match = torch.zeros(block_size - 1, dtype=torch.float64)
    total = 0
    loss_sum, loss_n = 0.0, 0
    for i in ids_range:
        feat, ids, gen_start = traces.get(i, device)
        built = build_blocks(ids, gen_start, block_size, mask_token_id, 0)
        if built is None:
            continue
        starts, query_ids, labels = built
        with torch.autocast("cuda", dtype=torch.bfloat16):
            logits = draft_logits(draft, embed, head, feat, starts, query_ids, block_size)
        flat = labels.reshape(-1)
        loss_sum += F.cross_entropy(logits.float(), flat).item() * flat.numel()
        loss_n += flat.numel()
        hit = (logits.argmax(-1) == flat).view(-1, block_size - 1)
        match += hit.sum(0).double().cpu()
        total += hit.shape[0]
    rates = (match / max(total, 1)).tolist()
    # A block is accepted up to its first mistake, plus the token the target
    # always contributes itself -- so this is the accepted length it predicts.
    accepted, running = 1.0, 1.0
    for r in rates:
        running *= r
        accepted += running
    draft.train()
    return {
        "loss": loss_sum / max(loss_n, 1),
        "per_position": [round(r, 4) for r in rates],
        "expected_accepted_length": round(accepted, 3),
        "blocks": total,
    }


def save_draft(draft: torch.nn.Module, out: Path, report: dict) -> None:
    """Write the adapted draft in the released checkpoint's own layout.

    Same parameter names, same config, same remote code, so vLLM's `dflash`
    speculator loads it exactly as it loads z-lab's.
    """
    from huggingface_hub import snapshot_download

    out.mkdir(parents=True, exist_ok=True)
    state = {k: v.detach().to(torch.bfloat16).contiguous() for k, v in draft.state_dict().items()}
    save_file(state, str(out / "model.safetensors"), metadata={"format": "pt"})
    src = Path(snapshot_download(DRAFT, allow_patterns=["*.json", "*.py"]))
    for name in ("config.json", "dflash.py", "utils.py"):
        if (src / name).exists():
            (out / name).write_bytes((src / name).read_bytes())
    (out / "adapt_report.json").write_text(json.dumps(report, indent=2))


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--data", default=os.path.expanduser("~/dflash-data"))
    ap.add_argument("--out", default=os.path.expanduser("~/dflash-adapted"))
    ap.add_argument("--device", default="cuda:1")
    ap.add_argument("--epochs", type=int, default=2)
    ap.add_argument("--lr", type=float, default=1e-5)
    ap.add_argument("--accum", type=int, default=4)
    ap.add_argument("--holdout", type=int, default=40)
    ap.add_argument("--seed", type=int, default=0)
    args = ap.parse_args()

    torch.manual_seed(args.seed)
    random.seed(args.seed)
    device = torch.device(args.device)

    traces = Traces(Path(os.path.expanduser(args.data)))
    order = list(range(len(traces)))
    random.Random(args.seed).shuffle(order)
    holdout, train_ids = order[: args.holdout], order[args.holdout :]
    print(f"{len(train_ids)} train / {len(holdout)} held-out traces", flush=True)

    draft = AutoModel.from_pretrained(DRAFT, trust_remote_code=True).to(device).float()
    draft.config._attn_implementation = "sdpa"
    block_size = draft.block_size
    mask_token_id = draft.mask_token_id
    n_params = sum(p.numel() for p in draft.parameters())
    print(f"draft loaded: {n_params / 1e6:.0f}M params, block_size={block_size}, "
          f"mask_token_id={mask_token_id}, target_layer_ids={draft.target_layer_ids}", flush=True)

    embed, head = load_target_heads(device)
    for tensor in (embed, head):
        tensor.requires_grad_(False)

    before = evaluate(draft, embed, head, traces, holdout, device, block_size, mask_token_id)
    print(f"BEFORE  {json.dumps(before)}", flush=True)
    out = Path(os.path.expanduser(args.out))
    best, best_epoch = before, -1

    optim = torch.optim.AdamW(draft.parameters(), lr=args.lr, weight_decay=0.0, betas=(0.9, 0.95))
    steps_total = math.ceil(len(train_ids) / args.accum) * args.epochs
    sched = torch.optim.lr_scheduler.OneCycleLR(
        optim, max_lr=args.lr, total_steps=max(steps_total, 1), pct_start=0.05, anneal_strategy="cos",
    )

    t0 = time.time()
    step = 0
    for epoch in range(args.epochs):
        epoch_order = list(train_ids)
        random.Random(args.seed + epoch).shuffle(epoch_order)
        # Serving starts a block wherever the last one was accepted to, so the
        # stride-8 grid is shifted each epoch rather than always landing on the
        # same positions.
        offset = random.Random(args.seed + 100 + epoch).randrange(block_size)
        running = 0.0
        for n, i in enumerate(epoch_order):
            feat, ids, gen_start = traces.get(i, device)
            built = build_blocks(ids, gen_start, block_size, mask_token_id, offset)
            if built is None:
                continue
            starts, query_ids, labels = built
            with torch.autocast("cuda", dtype=torch.bfloat16):
                logits = draft_logits(draft, embed, head, feat, starts, query_ids, block_size)
            loss = F.cross_entropy(logits.float(), labels.reshape(-1))
            (loss / args.accum).backward()
            running += loss.item()

            if (n + 1) % args.accum == 0:
                torch.nn.utils.clip_grad_norm_(draft.parameters(), 1.0)
                optim.step()
                sched.step()
                optim.zero_grad(set_to_none=True)
                step += 1
                if step % 20 == 0:
                    mem = torch.cuda.max_memory_allocated(device) / 1e9
                    print(f"  epoch {epoch} step {step}/{steps_total} "
                          f"loss {running / (args.accum * 20):.4f} "
                          f"lr {sched.get_last_lr()[0]:.2e} {mem:.1f}GB "
                          f"{time.time() - t0:.0f}s", flush=True)
                    running = 0.0

        mid = evaluate(draft, embed, head, traces, holdout, device, block_size, mask_token_id)
        print(f"EPOCH {epoch}  {json.dumps(mid)}", flush=True)
        # Keep the best epoch rather than the last. On a dataset this small the
        # held-out curve can turn over, and shipping a checkpoint from after
        # that point would be shipping a worse drafter on purpose.
        if mid["expected_accepted_length"] > best["expected_accepted_length"]:
            best, best_epoch = mid, epoch
            save_draft(draft, out, {
                "before": before, "after": mid, "best_epoch": epoch,
                "train_traces": len(train_ids), "holdout_traces": len(holdout),
                "epochs": args.epochs, "lr": args.lr, "accum": args.accum,
            })
            print(f"  saved (best so far) to {out}", flush=True)

    print(f"BEST    epoch {best_epoch}  {json.dumps(best)}", flush=True)
    print(f"expected accepted length {before['expected_accepted_length']} -> "
          f"{best['expected_accepted_length']}", flush=True)
    if best_epoch < 0:
        print("no epoch beat the released checkpoint; nothing saved", flush=True)


if __name__ == "__main__":
    main()
