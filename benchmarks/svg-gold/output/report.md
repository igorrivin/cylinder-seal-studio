# Semantic SVG gold benchmark

The semantic SVG is rendered at 1024 × 1024, passed through the documented neutral preprocessing profile, and the production tracer is measured against that exact opaque black/white input raster.

Preprocessing: threshold **170**, soften **0**, invert **false**, mirror **false**, seam band **false**.

| Visual metric | Result | Gate | Status |
| --- | ---: | ---: | --- |
| Foreground IoU | 0.848545 | ≥ 0.84 | pass |
| Precision | 0.919920 | ≥ 0.9 | pass |
| Recall | 0.916223 | ≥ 0.91 | pass |
| Pixel disagreement | 0.021771 | ≤ 0.03 | pass |
| Normalized grayscale MAE | 0.026425 | diagnostic | — |

## Topology

| Raster | Foreground components | Background holes |
| --- | ---: | ---: |
| Processed gold (tracer input) | 125 | 528 |
| Traced | 123 | 452 |

## SVG structure

| SVG | Bytes | Paths | Subpaths | Cubic curves | Commands | SHA-256 |
| --- | ---: | ---: | ---: | ---: | ---: | --- |
| Gold source | 15643 | 50 | 65 | 57 | 173 | `c1ff4a28d648e8e233202e58b5a457b9eaa7c49d3d134a07dc58040426bb6491` |
| Raw trace | 231958 | 125 | 548 | 6214 | 7310 | `cc5bfb9bbe4dd4d4660585ad8d63df54040c4fc10641da301873621461b2fc06` |
| Normalized trace | 218908 | 125 | 548 | 6214 | 7310 | `ec4784bd507a60bf031ebb22dbcaabd2a39a2872a7767eb80c3d2970d23d73de` |

The gold source remained self-contained semantic SVG: **yes**. The trace was deterministic: **yes**. Overall quality gate: **PASS**.
