# GPT-5.6 Sol image-to-SVG Batch pilot

- Local batch: `openai-gpt-5.6-sol-dual-pilot-v1-20260723t012315852z`
- Remote batch: `batch_6a616d2e413481909e26e845193024c9`
- Model: `gpt-5.6-sol`, reasoning effort `high`
- Delivery: OpenAI Batch API (50% discount; completion within 24 hours)
- Batch wall time: 384.0 s (not per-request model latency)
- Estimated API cost: $1.5035
- Direct mean IoU: 0.5261
- Hybrid candidates passing every hard gate: 1/3
- Hybrid fallbacks to unchanged production trace: 2/3

The direct arm uses the exact three PNGs and exact prompt text used by the Gemini pilot, but this is a deliberate high-reasoning, 65,536-output-token sledgehammer rather than a compute-normalized model ranking. Batch wall time is not comparable with the earlier synchronous Gemini request latency. Automatic acceptance in the direct arm means technically valid/renderable, not visually good. Human ratings remain unreviewed.

| Case | Track | Outcome | Model accepted | IoU | Classical IoU | Delta | 2px F1 | Tokens | Est. cost |
| --- | --- | --- | --- | ---: | ---: | ---: | ---: | ---: | ---: |
| procedural-003-flying-bird | direct | accepted | yes | 0.9593 | 0.9789 | -0.0196 | 0.9992 | 4,977 | $0.0681 |
| procedural-003-flying-bird | hybrid | accepted | yes | 0.9792 | 0.9789 | 0.0003 | 1.0000 | 11,932 | $0.1503 |
| external-openclipart-rabbit-line-art | direct | accepted | yes | 0.4052 | 0.8010 | -0.3958 | 0.8293 | 11,794 | $0.1704 |
| external-openclipart-rabbit-line-art | hybrid | fallback | no | 0.8008 | 0.8010 | -0.0002 | 0.9985 | 27,200 | $0.2900 |
| existing-easter-bunny-gold | direct | accepted | yes | 0.2138 | 0.7603 | -0.5465 | 0.7222 | 19,181 | $0.2812 |
| existing-easter-bunny-gold | hybrid | fallback | no | 0.2042 | 0.7603 | -0.5561 | 0.7272 | 119,721 | $0.5436 |
