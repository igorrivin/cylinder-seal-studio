# Image-to-SVG benchmark data

This directory defines the durable contract for the varied image-to-SVG evaluation corpus and its run history. The initial corpus is an evaluation suite, not a training set: retaining an artifact does not imply permission to train on it.

## Files

- `corpus-manifest.schema.json` describes a versioned, rights-audited corpus.
- `run-record.schema.json` describes one immutable pipeline run against one corpus case.
- `validate.ts` enforces the schemas' cross-field rules that JSON Schema cannot express cleanly.
- `validate.test.ts` exercises valid records and the principal safety checks.
- `sources/` and `fragments/` retain exact vector references and their ingestion metadata.
- `build-corpus.mjs` deterministically creates the frozen manifest, raster inputs, reference renders, split inventory, and attributions.
- `baseline/` retains the current production tracer's reproducible smoke-test results.
- `runs/` is the append-only archive for future model outputs and their exact usage/cost records.
- `evaluate-gemini.mjs` runs the direct one-shot comparison arm.
- `evaluate-openai-batch.mjs` manages the paired GPT-5.6 Sol direct and fail-closed hybrid Batch pilot.

All artifact paths are POSIX paths relative to the repository root. Hashes are lowercase SHA-256 digests of the exact stored bytes. For an external asset, `source.sha256` identifies the upstream download and `reference.sha256` identifies the sanitized local SVG; `source.transformation` records that adaptation. For project-authored assets, the source and reference hashes may be identical. Each input, reference render, and run artifact carries its own digest.

The v1 corpus has 40 cases: 23 deterministic project fixtures, 16 retained external vectors (Open Doodles, reviewed Openclipart entries, and Lucide), and the existing semantic gold case. Only the 16 independently licensed external cases are currently marked training-cleared. Agent-assisted fixtures remain evaluation-only pending provider-output terms review.

## Corpus manifest

The manifest must record corpus identity, version, creation time, `case_count`, the frozen split policy, and every case. A case requires:

- Stable `id` and human-readable `title`.
- Frozen `split`, categories, tags, and difficulty.
- Raster `input` and SVG `reference`, both with path, hash, media type, and dimensions. A named rasterization `profile` and version may be attached to the input. The reference records its provenance `kind` and may include a canonical PNG `render` artifact.
- Source kind/group, title, creator, acquisition date, upstream source hash, any transformation, and page/direct URLs. URLs may be `null` for project-authored, procedural, or existing model-assisted gold assets; an external source must retain at least one URL.
- Explicit license, license-evidence URL, attribution, redistribution, adaptation, and training-rights fields. The builder rejects licenses outside its reviewed allowlist rather than guessing their permissions.

The validator additionally requires unique case IDs and artifact paths, exact `case_count`, and exact agreement between declared and observed split counts.

## Frozen splits

Corpus v1 uses 24 development, 8 validation, and 8 policy-sealed test cases. Development cases may guide prompts and implementation. Validation cases select prompts, models, and thresholds. Do not inspect or tune against test results until a pipeline version is fixed.

Set `split_policy.strategy` to `frozen`, record `frozen_at`, and leave `test_is_sealed` and every case's `split_frozen` set to `true`. Changing a case's split requires a new corpus version; it is not an edit to the existing manifest.

“Sealed” is an honor-policy holdout, not a hidden or cryptographically sealed set: the inputs and references are committed for reproducibility. External style/creator groups do not cross splits, but project procedural fixtures do. A private hidden benchmark would be needed for adversarial or leaderboard claims.

Each oracle receives exactly one deterministic raster profile so v1 stays at 40 calls. The per-profile and per-split summaries are descriptive smoke diagnostics, not causal comparisons: source identity and difficulty remain confounded with profile and split. A later robustness suite should apply every profile to every oracle and add enough independent source groups to balance held-out difficulty.

## Training rights

`rights.training_allowed` concerns the source/reference pair. It may be `true` only after the asset license or owner permission has been reviewed, and never when adaptation is forbidden. Redistribution permission alone is not training permission. Keep uncertain cases as `false` and explain the uncertainty in `notes`.

Generated outputs have a separate `output_training_rights` decision in each run record because provider terms can be more restrictive than the source license. It records source clearance and provider-output clearance independently, including provider terms URL/version/effective date. `training_allowed` can be true only when both decisions are cleared. Provider-generated candidates may still be retained for evaluation while marked false; do not promote them into a distillation corpus earlier.

## Immutable run records

Write each execution as a new record, conventionally `runs/<run_id>.json`; never overwrite a prior record after publication. Corrections and reruns receive new IDs. A record preserves:

- Corpus version, manifest hash, case identity, input/reference hashes, pipeline commit, and renderer settings.
- Every generation, repair, fallback, or human-edit attempt, including exact model settings, exact prompt text, usage, cost, verbatim model output and provider response when available, candidate artifacts, rendered preview, validation report, and failures.
- Aggregate metrics, latency, token use, cost, fidelity/manufacturability ratings, final outcome, and output training rights.

Attempt indexes start at zero and remain contiguous. Aggregate usage and cost must equal their attempt totals. Prompt SHA-256 is computed over UTF-8 `system`, one NUL byte, then UTF-8 `user`; `hashPrompt` implements this canonical form.

Run the contract tests from `app/`:

```sh
npm run benchmark:corpus:build
npm run benchmark:corpus
npm run benchmark:corpus:check
```

## Model pilots

The Gemini pilot makes one synchronous model call per selected case. The OpenAI
pilot fixes the same three development cases, uses the exact Gemini direct
prompt for one arm, and pairs it with a trace-constrained refactor arm. The
hybrid arm automatically retains the exact classical trace unless the model
candidate passes every SVG safety, two-pixel fidelity, oracle, and complexity
gate. Neither pilot inspects the sealed test split.

The OpenAI workflow is deliberately split into resumable commands because a
Batch job can complete any time within its 24-hour window:

```sh
npm run benchmark:openai -- prepare
npm run benchmark:openai -- submit --batch <local-batch-id>
npm run benchmark:openai -- status --batch <local-batch-id>
npm run benchmark:openai -- collect --batch <local-batch-id>
npm run benchmark:openai -- rescore --batch <local-batch-id>
```

`submit` without `--batch` prepares and submits a new job. The API key is read
from `OPENAI_API_KEY`, or from `~/.config/secrets/llm.env` for this local
experiment; it is never written to the archive. Batch request/output JSONL,
status snapshots, exact source traces, raw provider responses, verbatim model
text, rendered candidates, validation reports, token usage, estimated cost,
and fallback decisions are retained under `runs/`. Batch wall time is recorded
as orchestration latency and must not be compared with synchronous per-request
model latency. `rescore` reuses the archived provider bytes and appends a new
pipeline version; it never repeats the paid model calls or overwrites the
earlier immutable records.
