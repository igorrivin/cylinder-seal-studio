# VTracer settings study

This bounded sweep selected the production spline defaults against the stable semantic gold source (`c1ff4a28…`) and then checked the direction of change against `public/sample.png`. Both inputs used the benchmark's neutral preprocessing profile: threshold 170, zero softness, no inversion, no mirroring, and no seam band.

The values below are exact 1024 × 1024 binary-raster comparisons. SVG size is the normalized fabrication SVG. Runtime is a diagnostic median of ten warmed trace, normalize, and render runs on the development machine; it is not a CI gate.

## Controlled gold source

| Profile | Mode | Segment | Corner | Splice | IoU | Precision | Recall | Disagreement | SVG bytes | Components / holes | Median |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| Previous default | spline | 4 | 60° | 45° | 0.840160 | 0.916147 | 0.910148 | 0.023052 | 246,990 | 119 / 446 | 83.99 ms |
| **Selected default** | **spline** | **5** | **45°** | **45°** | **0.848545** | **0.919920** | **0.916223** | **0.021771** | **218,908** | **123 / 452** | **81.89 ms** |
| Metric maximum | spline | 10 | 15° | 20° | 0.868685 | 0.936328 | 0.923222 | 0.018579 | 229,885 | 122 / 457 | 82.91 ms |
| Polygon comparison | polygon | — | — | — | 0.868344 | 0.933194 | 0.925901 | 0.018689 | 73,694 | 123 / 446 | 63.93 ms |

The processed gold contains 125 foreground components and 528 enclosed background holes. Topology is reported as a diagnostic rather than gated because antialiasing, thin closed strokes, and the tracer's compound-fill representation make single-pixel connectivity changes common.

## Original sample sanity check

| Profile | IoU | Disagreement | SVG bytes |
| --- | ---: | ---: | ---: |
| Previous default | 0.810431 | 0.025208 | 259,402 |
| **Selected default** | **0.820107** | **0.023811** | **233,170** |
| Metric maximum | 0.838821 | 0.021014 | 245,021 |
| Polygon comparison | 0.837713 | 0.021262 | 80,584 |

## Decision

The selected `5 / 45° / 45°` spline profile improves every gated visual metric, preserves more connected components, reduces the gold SVG by 11.4%, and reduces the sample SVG by 10.1%. At normal size it retains the rounded character of the prior default.

The more aggressive spline and polygon profiles score higher numerically, but 150% visual inspection reveals facets in eyes, circular decorations, and flower petals. Pixel overlap alone therefore does not select the production default; the conservative profile is the best quality/size compromise for this line-art use case.

The sweep also found that speckle values 0, 4, 8, and 16 and iteration limits 5, 10, and 20 were bit-identical for these fixtures. Tested polygon segment and angle combinations were likewise identical.
