# Related work, and what is actually different here

Written after checking the literature rather than before. Several things this
project might have claimed as novel are not, and it is cheaper to say so than to
be corrected on stage.

## What is not novel

**Execution feedback as a training signal.** Well established. Coding models
have been trained against test execution for years.

**Verifier-gated self-distillation for game code.** *The Verifier is the
Curriculum: Execution-Gated Self-Distillation for Cross-Family Game Generation*
([arXiv:2607.09709](https://arxiv.org/abs/2607.09709)) filters generated projects
through a strict launch gate under a headless engine and distils on what passes.
It also runs a **matched control** — swapping only the verifier for a lenient
BUILD check erases the gain — and a gold-duplication control. So "use controls
to show the verifier is what is doing the work" is already in the literature,
done carefully.

**Game-specialised post-training.** *OpenGame: Open Agentic Coding for Games*
([arXiv:2604.18394](https://arxiv.org/abs/2604.18394)) trains GameCoder-27B with
continual pre-training, SFT, and execution-grounded RL, and ships OpenGame-Bench.
Its RL stage evaluates individual gameplay modules against predefined unit tests.

**Speculative decoding via block diffusion.** *DFlash*
([arXiv:2602.06036](https://arxiv.org/abs/2602.06036)) — we use the released
`z-lab/gpt-oss-20b-DFlash` checkpoint. We did not invent it and did not train a
draft model.

## Where the control actually sits, and why that matters

The important difference is not *whether* there is a control, but **what it is a
control over**.

| | 2607.09709 | Placebo |
| --- | --- | --- |
| Control varies | the **verifier** in the training loop (strict gate vs lenient BUILD check) | the **interaction** inside a single evaluation (collect vs do-not-collect) |
| Question answered | "is the gain caused by verifier precision, or by more data?" | "is this state change caused by the interaction, or was it always going to happen?" |
| Granularity | one run of the pipeline | one requirement, one patch |
| Catches | a weak filter masquerading as a good one | a patch whose end state is right and whose causality is absent |

Their control is an **ablation of the method**. Ours is a **control condition
inside each measurement**. Both are legitimate uses of the word; they do
different jobs, and a project can want both.

Concretely: a launch gate accepts the reward hack in `src/verifier/patches.ts`.
That patch launches cleanly, produces a world where the score reads 1 and the
coin is gone, and satisfies any final-state assertion — while doing nothing when
the player collects. Only comparing against a no-collect control rejects it.

OpenGame's own paper names the gap this sits in: it identifies silent state
management desynchronisation — logic that is wrong without a crash or an
explicit trace — as an unresolved problem. A build-health or launch gate cannot
see that class by construction, because nothing fails.

## The honest statement of contribution

Not "the first to use controls". Rather:

> A per-requirement control condition over full game-engine state — treatment
> versus a matched non-interaction in a live engine — used to reject patches
> whose final state is correct but whose causal effect is absent, with isolation
> and quiescence measured rather than assumed.

And two things we explicitly do **not** claim:

- The realizations vary repetition, not scheduling. Nothing here is evidence
  about robustness to event ordering or replication timing.
- The prediction-accuracy numbers in the rehearsal come from a hardcoded
  prediction. They show the metric discriminates. They say nothing about any
  model's calibration until real branches produce the predictions.

## Adjacent work worth reading

- *When LLMs Lag Behind: Knowledge Conflicts from Evolving APIs in Code
  Generation* ([arXiv:2604.09515](https://arxiv.org/abs/2604.09515)) — models
  produce temporally wrong API code and can keep following stale parametric
  knowledge even when given fresh documentation.
- *LibEvoBench: Probing Temporal Knowledge Stratification in Code Generation
  Models* ([arXiv:2606.25402](https://arxiv.org/abs/2606.25402)).
