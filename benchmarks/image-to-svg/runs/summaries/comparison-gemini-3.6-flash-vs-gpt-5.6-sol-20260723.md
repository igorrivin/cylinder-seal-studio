# Gemini 3.6 Flash versus GPT-5.6 Sol pilot comparison

This report compares the three fixed development cases only. It is a product
sanity check, not a statistically stable or compute-normalized model ranking.
The direct arms use the same PNG bytes and the same prompt hash
`78be5e78a6ab25a674b5b2cbdb07c01bdf813421008968f28575395691bf7a25`.

GPT-5.6 Sol used high reasoning, a 65,536-token output allowance, and the
50%-discounted Batch API. Gemini 3.6 Flash used medium thinking, a 32,768-token
allowance, and synchronous Interactions calls. Provider token counts and
latencies are therefore not directly comparable.

## Quality

| Case | Classical IoU | Gemini direct | GPT direct | GPT − Gemini | GPT hybrid candidate | Published hybrid result |
| --- | ---: | ---: | ---: | ---: | ---: | --- |
| Flying bird | 0.9789 | 0.6861 | 0.9593 | +0.2732 | 0.9792 | Accepted model refactor |
| Rabbit line art | 0.8010 | 0.1372 | 0.4052 | +0.2679 | 0.8008 | Classical fallback |
| Easter pattern | 0.7603 | 0.1994 | 0.2138 | +0.0145 | 0.2042 | Classical fallback |
| **Mean** | **0.8467** | **0.3409** | **0.5261** | **+0.1852** | **0.6614** | **0.8468 final** |

GPT's direct mean IoU is 54.3% higher than Gemini's on this trio, but it remains
0.3207 below the classical tracer. The improvement is concentrated in the
simple bird and, to a lesser degree, the single rabbit. Both models still
redraw rather than register the dense Easter layout.

The hybrid bird is a genuine small win: IoU improves from 0.9789 to 0.9792
while bytes fall 27.6%, path commands 21.4%, and geometry numeric tokens 34.2%.
The rabbit candidate preserves fidelity (0.8008 IoU and 0.9985 two-pixel F1)
but reduces coordinate tokens by only 5.6%, missing the preregistered 20%
complexity gate, so the exact classical trace is retained. The Easter hybrid
redraws objects and scores 0.2042; the fail-closed gate correctly rejects it.

Visual inspection agrees with the metrics. GPT's direct bird is close and
clean; its direct rabbit is recognizable but moves ears, body contours, and
feet; its Easter result preserves the motif vocabulary but not the exact
geometry or layout. The accepted hybrid bird is visually indistinguishable
from the trace. The rabbit hybrid is also visually close but not materially
simpler by the coordinate-count criterion. The Easter hybrid changes character
details and uses stroke geometry, so it is unsuitable for fabrication.

## Cost and execution

| Arm | Requests | Input tokens | Output tokens (reasoning included) | Reasoning tokens | Total tokens | Estimated cost |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Gemini direct | 3 | 3,906 | 52,500 | 27,224 | 56,406 | $0.3996 |
| GPT direct, Batch rates | 3 | 1,566 | 34,386 | 15,885 | 35,952 | $0.5197 |
| GPT hybrid, Batch rates | 3 | 111,921 | 46,932 | 24,784 | 158,853 | $0.9838 |
| GPT dual pilot, Batch rates | 6 | 113,487 | 81,318 | 40,669 | 194,805 | $1.5035 |

The OpenAI Batch wall time was 384 seconds. This is orchestration latency, not
per-request inference latency, and should not be compared with the 208-second
sum of the three synchronous Gemini calls. At standard rather than Batch rates,
the six OpenAI calls have an estimated list-price equivalent of $3.0070.

## Interpretation

The evidence says the failure is partly model-specific, but not mainly a
Gemini-only defect. A stronger, more expensive model substantially improves a
simple direct reconstruction and modestly improves the rabbit, yet still fails
the coordinate-preserving dense-layout task. The safer product direction is a
classical trace followed by a strictly gated refactor, not an unconstrained VLM
replacement. In this pilot that policy never worsens the published result and
produces one modest simplification win, but its $0.98 three-case cost and 1/3
acceptance rate do not justify a runtime feature yet.

Human fidelity and manufacturability ratings remain unreviewed. Two reference
assets have OpenAI coding-agent provenance, automatic IoU favors literal
registration, and three cases are too few for a general model claim.

## Provenance

- Classical baseline: `baseline/report.json`, SHA-256
  `631c9c5cc96dee7c0443995fd1b3106132b777eaf74f2ad5d475a427bdae74fa`
- Gemini summary: `gemini-3.6-flash-one-shot-v1-20260722t221137709z.json`,
  SHA-256 `86083a98fb3e87a4518b58824e6d088bb3055e4ab13b5d57668d6a1dce84b111`
- Corrected OpenAI summary:
  `openai-gpt-5.6-sol-dual-pilot-v1-20260723t012315852z-scorer-v1.0.1.json`,
  SHA-256 `d80af96011ff54e822f50c49c0fde39d0461cc14df7750385ae47413a4ec81fa`
- The scorer v1.0.1 erratum preserves and supersedes the first-pass OpenAI
  complexity metrics; pixel metrics, usage, and cost were unaffected.
