"""LoRA post-training of gpt-oss-20b on engine-labelled preference pairs.

    python src/train/lora_dpo.py --data data/dpo.jsonl --out adapters/placebo-dpo

What makes this dataset unusual is not its size — it is small, and honestly
labelled as such — but where the preference came from. Each pair is two
implementations of the same requirement, started from the same world, driven by
the same interactions, and separated by a *measured difference in what they
caused* inside a live Roblox engine. No annotator, no judge model, and no
reference implementation to imitate.

Two details specific to gpt-oss:

  * It is a mixture of experts. Targeting only attention projections leaves most
    of the model untouched, so the expert projections are included in the LoRA
    target modules. This follows OpenAI's own fine-tuning guidance for gpt-oss.
  * It ships in MXFP4. Training loads bf16 and trains adapters only, which keeps
    the base weights untouched and lets the result be served by pointing vLLM at
    a LoRA rather than by writing out a second full-size model.
"""

from __future__ import annotations

import argparse
import json
import os
from pathlib import Path


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--model", default="openai/gpt-oss-20b")
    parser.add_argument("--data", default="data/dpo.jsonl")
    parser.add_argument("--out", default="adapters/placebo-dpo")
    parser.add_argument("--rank", type=int, default=16)
    parser.add_argument("--epochs", type=float, default=3.0)
    parser.add_argument("--lr", type=float, default=5e-5)
    parser.add_argument("--max-len", type=int, default=1536)
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="Load the data and report what would train, without touching a GPU.",
    )
    return parser.parse_args()


def load_pairs(path: Path) -> list[dict]:
    """Reads the exporter's output into TRL's expected prompt/chosen/rejected shape."""
    rows: list[dict] = []
    with path.open(encoding="utf-8") as handle:
        for line in handle:
            line = line.strip()
            if not line:
                continue
            row = json.loads(line)
            rows.append(
                {
                    "prompt": row["prompt"],
                    "chosen": [{"role": "assistant", "content": row["chosen"]}],
                    "rejected": [{"role": "assistant", "content": row["rejected"]}],
                }
            )
    return rows


def main() -> None:
    args = parse_args()
    data_path = Path(args.data)
    pairs = load_pairs(data_path)

    print(f"{len(pairs)} preference pairs from {data_path}")
    if not pairs:
        raise SystemExit("no pairs to train on")

    if args.dry_run:
        example = pairs[0]
        print("\nfirst pair:")
        print("  prompt roles :", [m["role"] for m in example["prompt"]])
        print("  chosen chars :", len(example["chosen"][0]["content"]))
        print("  rejected chars:", len(example["rejected"][0]["content"]))
        print("\ndry run: no GPU touched")
        return

    import torch
    from datasets import Dataset
    from peft import LoraConfig
    from transformers import AutoModelForCausalLM, AutoTokenizer
    from trl import DPOConfig, DPOTrainer

    print(f"loading {args.model} (bf16, adapters only)")
    tokenizer = AutoTokenizer.from_pretrained(args.model)
    model = AutoModelForCausalLM.from_pretrained(
        args.model,
        dtype=torch.bfloat16,
        device_map="auto",
        attn_implementation="eager",
    )
    model.config.use_cache = False

    # gpt-oss is a mixture of experts: attention-only LoRA would leave the
    # majority of the parameters, and most of the domain behaviour, untouched.
    target_modules = [
        "q_proj",
        "k_proj",
        "v_proj",
        "o_proj",
        "gate_proj",
        "up_proj",
        "down_proj",
    ]

    peft_config = LoraConfig(
        r=args.rank,
        lora_alpha=args.rank * 2,
        lora_dropout=0.05,
        bias="none",
        task_type="CAUSAL_LM",
        target_modules=target_modules,
    )

    config = DPOConfig(
        output_dir=args.out,
        num_train_epochs=args.epochs,
        per_device_train_batch_size=1,
        gradient_accumulation_steps=8,
        gradient_checkpointing=True,
        learning_rate=args.lr,
        logging_steps=1,
        save_strategy="epoch",
        bf16=True,
        max_length=args.max_len,
        max_prompt_length=args.max_len // 2,
        beta=0.1,
        report_to=[],
    )

    trainer = DPOTrainer(
        model=model,
        args=config,
        train_dataset=Dataset.from_list(pairs),
        processing_class=tokenizer,
        peft_config=peft_config,
    )

    trainer.train()
    trainer.save_model(args.out)
    print(f"\nadapter written to {args.out}")
    print("serve it with:  vllm serve openai/gpt-oss-20b --enable-lora --lora-modules placebo=" + args.out)


if __name__ == "__main__":
    os.environ.setdefault("TOKENIZERS_PARALLELISM", "false")
    main()
