# Gemini one-shot image-to-SVG evaluation

- Batch: `gemini-3.6-flash-one-shot-v1-20260722t221137709z`
- Model: `gemini-3.6-flash`
- Policy: one model call per case; no repair loop; test split excluded
- Accepted: 3/3
- Estimated paid-tier cost: $0.3996
- Mean IoU: 0.3409
- Mean delta versus classical tracer: -0.5059

| Case | Difficulty | Profile | Accepted | IoU | Classical IoU | Delta | Tokens | Est. cost | Latency |
| --- | --- | --- | --- | ---: | ---: | ---: | ---: | ---: | ---: |
| procedural-003-flying-bird | easy | clean | yes | 0.6861 | 0.9789 | -0.2928 | 9,166 | $0.0609 | 35.6 s |
| external-openclipart-rabbit-line-art | medium | softened | yes | 0.1372 | 0.8010 | -0.6638 | 14,705 | $0.1025 | 59.9 s |
| existing-easter-bunny-gold | hard | clean | yes | 0.1994 | 0.7603 | -0.5610 | 32,535 | $0.2362 | 112.6 s |
