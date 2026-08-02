# Classical tracer corpus baseline

This diagnostic baseline applies a luminance threshold of 170 to each committed raster input, runs the production VTracer adapter, and compares its rendered output with the clean vector oracle. It is not an LLM score and deliberately has no aggregate quality gate; its purpose is to make future semantic-model improvements measurable against the current product.

Each oracle has only one raster profile in v1. Profile and split summaries are descriptive smoke diagnostics, not causal robustness comparisons, because source identity and difficulty are confounded with those groups.

## Overall summary

| Scope | Cases | Mean IoU | Minimum IoU | Mean precision | Mean recall | Mean disagreement |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| all cases | 40 | 0.8787 | 0.0250 | 0.9344 | 0.9317 | 0.0118 |

## Profile summary

| Input profile | Cases | Mean IoU | Minimum IoU | Mean precision | Mean recall | Mean disagreement |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| clean | 20 | 0.8619 | 0.0250 | 0.9437 | 0.9027 | 0.0140 |
| faint-scan | 5 | 0.9524 | 0.9170 | 0.9675 | 0.9837 | 0.0045 |
| pixelated | 5 | 0.7996 | 0.5618 | 0.8471 | 0.9233 | 0.0168 |
| softened | 5 | 0.9042 | 0.8010 | 0.9263 | 0.9732 | 0.0087 |
| speckled | 5 | 0.9260 | 0.8528 | 0.9597 | 0.9626 | 0.0085 |

## Split summary

| Split | Cases | Mean IoU | Minimum IoU | Mean precision | Mean recall | Mean disagreement |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| development | 24 | 0.8853 | 0.0250 | 0.9444 | 0.9311 | 0.0095 |
| test | 8 | 0.8329 | 0.4736 | 0.9011 | 0.9029 | 0.0206 |
| validation | 8 | 0.9048 | 0.8469 | 0.9378 | 0.9622 | 0.0099 |

## Per-case results

| Case | Split | Profile | IoU | Precision | Recall | Disagreement | Trace bytes |
| --- | --- | --- | ---: | ---: | ---: | ---: | ---: |
| existing-easter-bunny-gold | development | clean | 0.7603 | 0.8637 | 0.8640 | 0.0390 | 150,328 |
| external-lucide-castle | development | clean | 0.9721 | 0.9923 | 0.9795 | 0.0078 | 6,026 |
| external-lucide-circuit-board | development | speckled | 0.9769 | 0.9915 | 0.9852 | 0.0070 | 9,252 |
| external-lucide-flower-2 | development | clean | 0.9838 | 0.9905 | 0.9932 | 0.0044 | 4,124 |
| external-lucide-origami | development | pixelated | 0.9588 | 0.9733 | 0.9847 | 0.0113 | 19,429 |
| external-open-doodles-ballet | validation | speckled | 0.8528 | 0.9200 | 0.9212 | 0.0096 | 21,979 |
| external-open-doodles-coffee | validation | clean | 0.9366 | 0.9574 | 0.9774 | 0.0091 | 20,302 |
| external-open-doodles-ice-cream | validation | clean | 0.9270 | 0.9612 | 0.9631 | 0.0058 | 11,996 |
| external-open-doodles-selfie | validation | clean | 0.9039 | 0.9529 | 0.9462 | 0.0067 | 19,456 |
| external-openclipart-bicycle | test | softened | 0.9186 | 0.9283 | 0.9887 | 0.0082 | 8,831 |
| external-openclipart-butterfly-line-art | test | pixelated | 0.5618 | 0.6424 | 0.8175 | 0.0206 | 28,147 |
| external-openclipart-can-lineart | development | softened | 0.9320 | 0.9637 | 0.9659 | 0.0110 | 8,965 |
| external-openclipart-decorative-line-frame | development | clean | 0.0250 | 0.8711 | 0.0251 | 0.0291 | 2,211 |
| external-openclipart-flower-lineart | development | speckled | 0.9176 | 0.9684 | 0.9459 | 0.0122 | 35,813 |
| external-openclipart-geometric-lines | test | clean | 0.4736 | 0.8255 | 0.5262 | 0.0998 | 108,149 |
| external-openclipart-rabbit-line-art | development | softened | 0.8010 | 0.8453 | 0.9386 | 0.0124 | 14,255 |
| external-openclipart-tree-lineart | development | clean | 0.9255 | 0.9579 | 0.9648 | 0.0076 | 11,506 |
| procedural-001-crescent-star | development | faint-scan | 0.9755 | 0.9764 | 0.9991 | 0.0033 | 3,484 |
| procedural-002-amphora | development | clean | 0.9383 | 0.9683 | 0.9681 | 0.0046 | 7,377 |
| procedural-003-flying-bird | development | clean | 0.9789 | 0.9814 | 0.9974 | 0.0031 | 2,200 |
| procedural-004-mountain-sun | development | clean | 0.9355 | 0.9669 | 0.9664 | 0.0049 | 8,484 |
| procedural-005-fish | development | pixelated | 0.8102 | 0.8597 | 0.9337 | 0.0134 | 21,399 |
| procedural-006-ceremonial-key | development | softened | 0.9358 | 0.9479 | 0.9866 | 0.0039 | 5,694 |
| procedural-007-leaf-sprig | development | clean | 0.9745 | 0.9749 | 0.9995 | 0.0020 | 3,584 |
| procedural-008-scarab | test | clean | 0.9410 | 0.9542 | 0.9854 | 0.0053 | 10,485 |
| procedural-009-tea-table | development | faint-scan | 0.9170 | 0.9361 | 0.9782 | 0.0062 | 10,341 |
| procedural-010-river-boat | development | clean | 0.9245 | 0.9342 | 0.9889 | 0.0080 | 9,149 |
| procedural-011-night-camp | validation | softened | 0.9336 | 0.9461 | 0.9861 | 0.0079 | 13,902 |
| procedural-012-garden-tools | development | speckled | 0.9316 | 0.9554 | 0.9739 | 0.0064 | 13,365 |
| procedural-013-fox-and-moon | development | pixelated | 0.8203 | 0.8762 | 0.9278 | 0.0158 | 21,409 |
| procedural-014-workshop-tools | test | clean | 0.9415 | 0.9717 | 0.9681 | 0.0091 | 18,093 |
| procedural-015-meander-seam | development | faint-scan | 1.0000 | 1.0000 | 1.0000 | 0.0000 | 2,342 |
| procedural-016-wave-seam | validation | faint-scan | 0.9290 | 0.9422 | 0.9851 | 0.0061 | 5,899 |
| procedural-017-rosette-beads | test | faint-scan | 0.9404 | 0.9827 | 0.9562 | 0.0068 | 20,488 |
| procedural-018-palmette-band | validation | pixelated | 0.8469 | 0.8840 | 0.9528 | 0.0228 | 26,089 |
| procedural-019-braid-seam | test | speckled | 0.9513 | 0.9633 | 0.9870 | 0.0070 | 9,356 |
| procedural-020-gazelle-chase-seam | development | clean | 0.9312 | 0.9432 | 0.9866 | 0.0078 | 16,116 |
| procedural-021-procession-seam | test | clean | 0.9351 | 0.9406 | 0.9938 | 0.0078 | 17,409 |
| procedural-022-cuneiform-registers | development | clean | 0.9212 | 0.9269 | 0.9933 | 0.0065 | 16,578 |
| procedural-023-cuneiform-seal | validation | clean | 0.9087 | 0.9386 | 0.9662 | 0.0114 | 10,864 |
