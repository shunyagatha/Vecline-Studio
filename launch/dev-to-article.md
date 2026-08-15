---
title: I built an image vectorizer that grades its own homework — and it kept catching me lying
published: false
description: Most SVG tracers claim "100% accuracy." Mine renders its own output back to pixels and scores it — which means it caught my own README overclaiming, three times, in public.
tags: opensource, javascript, webdev, showdev
cover_image: https://vecline.xyz/og.png
canonical_url: https://vecline.xyz
---

Every image-to-SVG converter I've ever used makes the same promise on its landing page: **100% accuracy**. None of them can define what that means, let alone measure it.

So I built one that does. It's called [Vecline](https://vecline.xyz), it's free, MIT, and runs entirely in your browser. But the interesting part isn't the tracer. It's what happens when a tool measures its own output instead of asserting it's good — because the measurements kept disagreeing with the things I'd written in my own README, and I had to fix them in public.

## The one idea: render it back and score it

A tracer turns pixels into paths. The obvious question — *how good is the result?* — almost nobody answers, because answering it is more work than the tracing.

Vecline answers it. Every conversion is rendered back to pixels with the same renderer a browser uses, and compared against the source with three real metrics: **SSIM**, **PSNR**, and **CIEDE2000** (perceptual colour difference). Not estimated from the settings. Measured, from the actual output.

```bash
vecline vectorize logo.png --verify
```

```
✓ logo.svg  400×300  pixel mode  4 shapes  2.1 KB → 7.5 KB  228 ms
  · Auto-selected pixel mode: 4 distinct colours. Output is bit-exact.

Accuracy  bit-exact (lossless)
  PSNR        ∞
  SSIM        1.000000
  RMSE        0.0000
```

On **flat artwork** — logos, icons, UI, screenshots, pixel art, which is most of what people actually vectorize — that `SSIM 1.000000` is not marketing. The SVG rasterizes back to the source with **zero differing pixels**, in a file that's *smaller and faster* than potrace, imagetracerjs, or vtracer. Bit-exact, provably, and you can check the claim yourself in one command.

On **photographs**, tracing is approximation by definition — you cannot fit a continuous-tone image into a compact set of Bézier curves. So Vecline says so, and reports exactly how close it landed. Measured against the Kodak set, it leads every open-source tracer on SSIM by 0.05–0.18. But it will also tell you, to its own detriment, that a traced photograph is usually a worse idea than just keeping the raster.

## The part nobody writes about: the measurements caught me lying

Here's the thing about a tool that measures itself. It measures *you* too.

**Lie #1: "smaller file every time."** My README had a benchmark table claiming Vecline produced a smaller SVG than vtracer on every image. It was true — against the vtracer *npm binding* I'd tested. When I finally ran vtracer's own released binary, it wrote **substantially smaller files** at the same quality: 987 KB where the binding wrote 1661 KB. My claim was false against the tool vtracer actually ships. I rewrote the table with the real numbers and added a paragraph saying plainly where vtracer wins. The quality lead held; the size claim didn't.

**Lie #2: "render-preserving."** Vecline can recognize when a traced region is *really* a circle, or a rectangle, or — as of last week — a pie slice, and emit the true shape instead of a Bézier approximation. I'd documented this as "render-preserving." It isn't, quite: an ideal arc cannot follow a pixel staircase exactly, so a `<circle>` trades about 0.02 SSIM for geometry a fraction of the size. The `<rect>` is genuinely render-identical; the curved ones are a *measured trade*. The docs now say which is which — including for the circle, which had been making that trade silently since day one.

**Lie #3: a feature that didn't work at all.** An audit that *executed* every documented command, instead of reading the docs, found that `vecline convert photo.png thumb.webp` — an ordinary raster-to-raster conversion — failed with "does not look like an SVG." The library could do it; the CLI command named `convert` couldn't express it. 100 of the 121 conversions my README advertised were unreachable from the command that was supposed to do them. Reading the code would never have found it. Running it did, immediately.

None of these were caught by a user filing a bug. They were caught by making the tool adversarial toward its own claims — which, for a project whose entire pitch is *measured, not asserted*, is the actual product.

## What else it does, briefly

The measurement is the spine, but the toolkit is broad because "I have the pixels and I can score any transform" turns out to unlock a lot:

- **Bit-exact lossless mode** — returns a byte-verifiable SVG or fails; never a silent near-miss.
- **Cut-ready DXF** with a real physical size (`--units mm --physical-width 80`), plus EPS, PDF, and G-code — the maker/CAD lane no other JS tracer serves.
- **PDF and Office → images**, entirely local.
- **A local bridge** (`vecline serve`) so the browser app can drive *your* LibreOffice for Office conversion without uploading a thing — because a tab has no office engine, and the two usual fixes (300 MB of WASM, or an upload) each break something the product is built on.
- **An MCP server**, so an AI agent can vectorize, measure, and diff images and verify its own output rather than asserting it worked.
- A **zero-dependency portable core** that's CI-proven to bundle for a browser at 85 KB.

All of it in [the Studio](https://vecline.xyz): free, unlimited, no signup, works offline, nothing uploaded.

## Try to break the claim

The whole thing is designed so you don't have to trust me:

```bash
npm install -g vecline
git clone https://github.com/shunyagatha/Vecline && cd Vecline
npm install && npm run compare
```

`npm run compare` runs the head-to-head yourself — same renderer, same metrics, same fixtures, against potrace and imagetracerjs (and vtracer if you point it at the binary). Every number in the README comes out of that command. If it disagrees with what I wrote, that's a bug, and I'd rather hear about it than not — it's happened three times already and each one made the project better.

- **Try it:** [vecline.xyz](https://vecline.xyz)
- **Code:** [github.com/shunyagatha/Vecline](https://github.com/shunyagatha/Vecline)
- **npm:** `npm install vecline`

If you've ever squinted at a "100% accurate" vectorizer and wondered *accurate by what measure* — this is the one that answers.
