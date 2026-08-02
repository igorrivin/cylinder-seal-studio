# Immutable run archive

Store each evaluated case as `runs/<run_id>/record.json`, with the verbatim model output, provider response, candidate SVG, rendered preview, and validation report beside it. Never overwrite a published run directory; a retry or correction receives a new `run_id`.

Every record must satisfy `../run-record.schema.json` and `validateRunRecordAgainstManifest` in `../validate.ts`. The latter binds the record to the exact manifest bytes, corpus version, case, split, input, and reference hashes. `output_training_rights` must independently clear both source rights and provider-output rights before a result can enter a distillation corpus.

The first retained model result is a three-case Gemini 3.6 Flash pilot run on 2026-07-22. It made one stateless call per case and did not touch the test split. The result is informative but negative for pixel-faithful reconstruction: mean IoU was 0.3409 versus 0.8467 for the same three classical-tracer cases, at an estimated paid-tier list cost of $0.3996 and 208 seconds of API latency. See [`summaries/gemini-3.6-flash-one-shot-v1-20260722t221137709z.md`](summaries/gemini-3.6-flash-one-shot-v1-20260722t221137709z.md).

The candidates are visually coherent, compact redrawings, but they alter geometry, object identity, and layout enough that this prompt should not be scaled to the rest of the corpus. Every raw response and verbatim model output remains archived for evaluation. Current Gemini provider terms do not clear these outputs for distillation, so each record sets `output_training_rights.training_allowed` to `false`.

Run the fixed three-case Gemini pilot from the repository root with:

```sh
npm run benchmark:vlm -- --pilot
```

The runner makes exactly one stateless model call per selected case, never runs a repair loop, and refuses the test split unless `--allow-test` is supplied. It preserves the verbatim response, validates a restricted self-contained SVG subset, renders with Resvg, computes pixel metrics against the vector oracle, compares IoU with the classical tracer, and writes an immutable record plus a batch summary. `GEMINI_API_KEY` is read only from the environment and is never written to an artifact.

The second retained result is a six-request GPT-5.6 Sol Batch pilot run on
2026-07-23: three direct comparisons and three trace-constrained refactors at
high reasoning effort. Direct mean IoU was 0.5261. The fail-closed hybrid arm
accepted the bird refactor and retained the exact classical trace for the
rabbit and Easter cases. The complete job cost an estimated $1.5035 at Batch
rates. See the [cross-provider comparison](summaries/comparison-gemini-3.6-flash-vs-gpt-5.6-sol-20260723.md).

Scorer v1.0.1 is authoritative for the OpenAI run. It corrected multiline SVG
attribute parsing and inherited paint accounting without repeating any model
call. The initial records remain preserved, and
`batches/openai-gpt-5.6-sol-dual-pilot-v1-20260723t012315852z/scorer-erratum-v1.0.1.json`
links them to the corrected records and summary. OpenAI provider outputs are
also marked evaluation-only rather than distillation-ready under the reviewed
provider terms.
