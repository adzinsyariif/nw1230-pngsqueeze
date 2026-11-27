# png-squeeze — smallest lossless PNG for 1280×720 screenshots

[![Bounty](https://make.fun/badge/png-squeeze-01-run-20261127.svg)](https://make.fun/bounty/png-squeeze-01-run-20261127)
[![Rank](https://make.fun/badge/png-squeeze-01-run-20261127/adzinsyariif/nw1230-pngsqueeze/rank.svg)](https://make.fun/bounty/png-squeeze-01-run-20261127)
[![Reward](https://make.fun/badge/png-squeeze-01-run-20261127/adzinsyariif/nw1230-pngsqueeze/reward.svg)](https://make.fun/bounty/png-squeeze-01-run-20261127)

Entry for the make.fun bounty
[Squeeze screenshots into the smallest PNG, 27 November 2026](https://make.fun/bounty/png-squeeze-01-run-20261127):
one Node 22 program (`main.ts`) re-encodes each 1280×720 RGBA screenshot as
the smallest lossless PNG the contest decoder accepts (bit depth 8,
non-interlaced, colour types 0/2/3/4/6, chunks IHDR/PLTE/tRNS/IDAT/IEND
only), every pixel — including a fully transparent pixel's colour —
decoding exactly.

## How it works

1. **Decode** the stored input PNG to RGBA with a small built-in decoder.
2. **Screen every lossless form** of the same pixels: palette (≤256
   colours) in three orderings (by count, by luminance, by first
   appearance, transparent entries first so `tRNS` stays short), grey /
   grey+alpha, RGB / RGBA, and a `tRNS`-keyed form when a single fully
   transparent value is unused by opaque pixels.
3. **Screen filter strategies** per form at zlib level 6: fixed filters,
   minimum signed sum, fewest distinct byte pairs, lowest byte entropy,
   and a brute-force per-row search weighed by deflate against the bytes
   already written.
4. **Compress the winner** with the best of several zlib level-9 settings
   and an optimal-parsing DEFLATE compressor (`deflate-opt.ts`): hash-chain
   match search with Pareto-optimal (length, distance) pairs per position,
   a dynamic-programming parse minimising bit cost under the current
   Huffman lengths, Huffman refinement passes, and dynamic-Huffman block
   emission (single block or split, whichever is smaller). The optimal
   stream is verified by inflating it before use and falls back to zlib
   level 9 whenever it would not be smaller.

Everything is deterministic — every search budget is counted in work,
never in wall-clock time — so two executions write identical bytes.

## Practice results

On the kit's practice set (drand round 34285479), graded with the kit's
own `grade-local`: **713,744 / 1,000,000** (8/8 answered, all exact),
against the house baseline fixed-paeth 1.0.0 at 420,399 on the same set.

## Run locally

```sh
MAKEFUN_INPUT_DIR=<kit>/practice/input MAKEFUN_OUTPUT_DIR=out node main.ts
```

## Licence

MIT — see `LICENSE`.
