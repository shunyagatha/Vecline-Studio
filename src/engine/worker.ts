/**
 * The conversion worker.
 *
 * Tracing a large image is hundreds of milliseconds of tight numeric work, so
 * it runs here rather than on the UI thread — the split slider stays draggable
 * while a photo converts. Everything imported below comes from `vecline/core`,
 * which is dependency-free and Node-built-in-free, so it loads in a worker
 * unchanged: no bundler shims, no polyfills, and *no network* — the image never
 * leaves the tab, which is the privacy claim the whole product rests on.
 */

import {
  trace,
  vectorizeExact,
  centerlineTrace,
  compareImages,
  measureSvgComplexity,
  removeBackground,
  traceGeometry,
  toDxf,
  toEps,
  toPdf,
  toGcode,
  centerlinePolylines,
  countDistinctColors,
  optimizeSvg,
  toComponent,
  traceSeparations,
  extractPalette,
  paletteToCssVars,
  blurHash,
  lqipSvg,
  encodeIco,
  encodeIcoDib,
  diffImages,
  smartCrop,
  cropImage,
  svgSprite,
  framesToAnimatedSvg,
} from 'vecline/core';
import type {
  ConvertResult, ConvertSettings, Metrics, RasterImage,
  WorkerRequest, WorkerResponse, ExportFormat, ExportedFile, Mode,
} from './types.js';

/** Trace options derived from the UI's settings. */
function traceOptions(s: ConvertSettings): Record<string, unknown> {
  return {
    colors: s.colors,
    tolerance: s.detail,
    fitError: s.detail,
    gradients: s.gradients,
    primitives: s.primitives,
    // Without this, Trace on photos emits zero curves: crack-following only
    // produces axis-aligned unit steps, which can't deviate from a chord by
    // less than 1/sqrt(5) ≈ 0.447px — below the Detail slider's whole range.
    // mosaic smooths each shared region boundary first (junctions pinned, so
    // neighbours still agree exactly), which is what lets the fitter engage.
    mosaic: true,
    // Degree-reduces cubics to quadratics wherever the fit error budget still
    // holds — same curve, fewer numbers. Free: -25% bytes, no quality cost.
    quadratics: true,
    // The tracer announces its own stages as it passes them. Forwarding them is
    // strictly better than the two hand-written milestones this file used to
    // post, which were guesses about someone else's internals and went stale the
    // moment the engine changed.
    //
    // Safe to attach here even though the export and separation paths share this
    // builder: `report` is inert unless a conversion is in flight, so those
    // paths pay nothing and say nothing.
    onProgress: (stage: string, pct: number): void =>
      report(stage, TRACE_LO + (Math.max(0, Math.min(100, pct)) * (TRACE_HI - TRACE_LO)) / 100),
  };
}

/**
 * Resolve `auto` the way the CLI does: flat artwork (few distinct colours) is
 * better served by the bit-exact pixel path than by approximating it with
 * curves — that is the one regime where "perfect vectorization" is honestly
 * true, and it is a large share of what people actually convert.
 */
function resolveMode(image: RasterImage, mode: Mode): Exclude<Mode, 'auto'> {
  if (mode !== 'auto') return mode;
  const distinct = countDistinctColors(image as never, 4096) as { count: number; capped: boolean };
  return distinct.count <= 24 ? 'lossless' : 'trace';
}

/**
 * Background removal and mode resolution, in one place.
 *
 * Both the preview and the downloads must start from *the same* pixels. When
 * this logic lived only in `convert()`, every non-SVG export re-derived its
 * geometry from the raw image — so turning on Remove Background changed what
 * you saw and not what you downloaded. That divergence is invisible by
 * construction: the export path never renders, so nothing on screen contradicts
 * it. Sharing the preparation is what keeps the file honest.
 */
/**
 * Longest edge, in pixels, a traced image is worked at. A traced SVG is
 * resolution-independent — it scales back to any size crisply — so feeding the
 * tracer a 12-megapixel phone photo spends seconds fitting curves to detail the
 * colour quantiser discards anyway. Measured on a 2.6 MP photo: capping to ~1 MP
 * was 3x faster and cost 0.0013 SSIM (rendered back at full size and scored),
 * which is invisible. Lossless mode is never capped — it must stay bit-exact.
 */
const MAX_TRACE_DIM = 1000;

function prepare(image: RasterImage, settings: ConvertSettings): {
  source: RasterImage;
  mode: Exclude<Mode, 'auto'>;
  notes: string[];
} {
  const notes: string[] = [];
  let source = image;

  // Crop first, so everything downstream — background detection, the palette,
  // the metrics — describes the region actually being converted rather than the
  // whole frame it was cut from.
  if (settings.cropAspect) {
    const [w, h] = settings.cropAspect;
    const rect = smartCrop(source as never, { aspect: [w, h] } as never) as
      { x: number; y: number; width: number; height: number };
    source = cropImage(source as never, rect) as RasterImage;
    notes.push(
      `Cropped to ${w}:${h} — ${rect.width}×${rect.height} at (${rect.x}, ${rect.y}), ` +
      'chosen by edge energy and colour saturation rather than by centring.',
    );
  }

  if (settings.removeBackground) {
    const r = removeBackground(source as never, {}) as { image: RasterImage };
    source = r.image;
    notes.push('Removed the detected background colour.');
  }

  const mode = resolveMode(source, settings.mode);

  // Cap the working resolution for the vector modes. The output scales back to
  // full size with no visible loss, so this is pure speed. Never for lossless.
  if (mode === 'trace' || mode === 'centerline') {
    const longest = Math.max(source.width, source.height);
    if (longest > MAX_TRACE_DIM) {
      const scale = MAX_TRACE_DIM / longest;
      const w = Math.max(1, Math.round(source.width * scale));
      const h = Math.max(1, Math.round(source.height * scale));
      source = downscaleBox(source, w, h);
      notes.push(
        `Traced at ${w}×${h} for speed — the SVG is resolution-independent, so it ` +
        `scales back to the original with no visible loss (measured against the full image).`,
      );
    }
  }

  return { source, mode, notes };
}

/**
 * Area-average (box filter) downscale. Unlike the nearest-neighbour resize used
 * for tiny favicons, this averages every source pixel that falls under a target
 * pixel, so a photo shrinks without the aliasing that would otherwise give the
 * tracer false edges to chase. Alpha-weighted so transparent pixels do not drag
 * colour toward black.
 */
function downscaleBox(image: RasterImage, width: number, height: number): RasterImage {
  const { width: sw, height: sh, data } = image;
  const out = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++) {
    const y0 = Math.floor((y * sh) / height);
    const y1 = Math.max(y0 + 1, Math.floor(((y + 1) * sh) / height));
    for (let x = 0; x < width; x++) {
      const x0 = Math.floor((x * sw) / width);
      const x1 = Math.max(x0 + 1, Math.floor(((x + 1) * sw) / width));
      let r = 0, g = 0, b = 0, a = 0, aw = 0, n = 0;
      for (let sy = y0; sy < y1; sy++) {
        for (let sx = x0; sx < x1; sx++) {
          const si = (sy * sw + sx) * 4;
          const al = data[si + 3] as number;
          r += (data[si] as number) * al;
          g += (data[si + 1] as number) * al;
          b += (data[si + 2] as number) * al;
          a += al;
          aw += al;
          n++;
        }
      }
      const di = (y * width + x) * 4;
      if (aw > 0) {
        out[di] = Math.round(r / aw);
        out[di + 1] = Math.round(g / aw);
        out[di + 2] = Math.round(b / aw);
      }
      out[di + 3] = Math.round(a / Math.max(1, n));
    }
  }
  return { width, height, data: out };
}

/**
 * Progress reporting.
 *
 * Every stage below is one the conversion really passes through, announced when
 * it actually starts — no interpolated percentage and no timer pretending to
 * advance. The percentages say how far through the *stage list* we are, not how
 * far through the work. A bar that lies about the remaining time is worse than
 * one that names the step.
 *
 * This file used to add that the tracer "cannot be subdivided from out here",
 * which was true and is now not: vecline's `trace()` reports its own stages —
 * quantising, region finding, contour tracing — and this file forwards them,
 * scaled into the band below. Two guesses posted from outside became four facts
 * reported from inside, and they cannot drift from what the engine does, because
 * they *are* what it does.
 *
 * The claim still holds for the other two modes. `vectorizeExact` and
 * `centerlineTrace` take no progress callback, so they are bracketed from out
 * here and say nothing while they run. That silence is deliberate: inventing a
 * crawl for them would be exactly the lie the paragraph above rules out.
 *
 * The band exists because tracing is one part of a longer job: preparation
 * happens before it and minification and scoring after, so the engine's own
 * 0–100 has to be compressed into the slice of the bar that tracing owns. The
 * upper end stops short of the minify step deliberately — the engine reports
 * nothing during curve fitting, and a bar that sat at 75 would be honest about
 * that silence in a way that one creeping to 79 would not.
 */
const TRACE_LO = 25;
const TRACE_HI = 75;

let progressFor: number | null = null;
function report(stage: string, pct: number): void {
  if (progressFor === null) return;
  const msg: WorkerResponse = { id: progressFor, ok: true, kind: 'progress', stage, pct };
  (self as unknown as { postMessage(m: WorkerResponse): void }).postMessage(msg);
}

/**
 * Wrap a raster's exact pixels in an `<svg><image>` container, as a genuinely
 * lossless SVG when geometry cannot be.
 *
 * THIS IS THE FALLBACK `convert()` HAD, AND IT WAS WRONG. The first version of
 * this file caught a refused `vectorizeExact` and fell back to `trace` — which
 * stopped the crash but silently broke the promise the MODE label makes
 * ("Pixel-lossless — Rasterises back bit-exact"): a photograph traced with
 * curves is an approximation, never lossless, whatever the mode selector says.
 * A user who explicitly asked for lossless and received an approximation with
 * no visible difference from clicking Trace directly got nothing for the
 * choice they made.
 *
 * The engine's own `vectorizeExact`/`runLossless` already has the right
 * fallback chain for exactly this situation — pixel geometry, then an embedded
 * bit-exact copy — but that second step (`vectorizeEmbed`) imports `sharp` and
 * `node:crypto` and is Node-only; it is not part of `vecline/core` and cannot
 * run in this worker. So this rebuilds the same idea with what a browser
 * already has: `OffscreenCanvas` encodes PNG natively, and PNG is lossless by
 * construction — round-tripping 8-bit RGBA through it changes nothing, which is
 * exactly the property `RasterImage.data` already has (a `Uint8ClampedArray`,
 * the same representation `ImageData` wants, so no conversion is needed).
 *
 * `FileReaderSync` is deliberately used over a hand-rolled base64 chunker: it
 * exists only in dedicated workers, is synchronous there, and is one call
 * instead of a loop that has to get large-buffer chunking right by hand.
 */
async function embedAsPng(image: RasterImage): Promise<{ svg: string; bytes: number }> {
  const canvas = new OffscreenCanvas(image.width, image.height);
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('This browser has no 2D canvas context in a worker.');
  // `RasterImage.data` is typed as the general `Uint8ClampedArray<ArrayBufferLike>`,
  // which admits a SharedArrayBuffer backing that `ImageData`'s constructor
  // narrowly refuses. It is never actually one here — decoded pixels are always
  // a plain heap buffer — so this is a type assertion, not a runtime coercion.
  ctx.putImageData(new ImageData(image.data as Uint8ClampedArray<ArrayBuffer>, image.width, image.height), 0, 0);
  const blob = await canvas.convertToBlob({ type: 'image/png' });
  const dataUri = new FileReaderSync().readAsDataURL(blob);
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="${image.width}" height="${image.height}" ` +
    `viewBox="0 0 ${image.width} ${image.height}">` +
    `<image width="${image.width}" height="${image.height}" href="${dataUri}"/></svg>`;
  return { svg, bytes: blob.size };
}

/**
 * Wrap the ORIGINAL uploaded bytes in an `<image>`, instead of re-encoding the
 * decoded pixels as a fresh PNG.
 *
 * Same reason to exist as {@link embedAsPng}, same bit-exactness (`compareImages`
 * scores the same decoded pixels either way) — but PNG is lossless, and a lossy
 * source format's whole point is throwing away information a lossless re-encode
 * cannot get back. Measured: a 4.8MB JPEG went to 58.1MB re-encoded as PNG and
 * base64'd; reusing its own bytes keeps it close to 4.8MB. Caller (see
 * `ConvertSettings.originalFile`) is responsible for only offering bytes that
 * are known to decode to exactly `image`'s pixels.
 */
function embedOriginal(
  file: { bytes: Uint8Array; type: string },
  image: RasterImage,
): { svg: string; bytes: number } {
  // Same narrow assertion `embedAsPng` makes for `ImageData`: `bytes` admits the
  // general `ArrayBufferLike` (which includes `SharedArrayBuffer`), but it is
  // never actually one here — `main.ts` builds it fresh from `Blob.arrayBuffer()`.
  const dataUri = new FileReaderSync().readAsDataURL(
    new Blob([file.bytes as Uint8Array<ArrayBuffer>], { type: file.type }),
  );
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="${image.width}" height="${image.height}" ` +
    `viewBox="0 0 ${image.width} ${image.height}">` +
    `<image width="${image.width}" height="${image.height}" href="${dataUri}"/></svg>`;
  return { svg, bytes: file.bytes.length };
}

async function convert(image: RasterImage, settings: ConvertSettings): Promise<ConvertResult> {
  const started = performance.now();
  report('Preparing', 5);
  const prepared = prepare(image, settings);
  const { source, notes } = prepared;
  // Mutable: LOSSLESS CAN FALL BACK, below, and the field this becomes is
  // documented as "which strategy actually ran" — so when it falls back, this is
  // the variable that has to change, or the result would claim a mode it did not
  // use and the SVG mode badge would lie.
  let mode: Exclude<Mode, 'auto'> = prepared.mode;
  // Only the paths that stay silent get a label announced from out here. The
  // trace path reports its own stages through `traceOptions`, and announcing
  // "Tracing contours" before calling it would be this file guessing at a step
  // the engine is about to name properly a millisecond later.
  if (mode === 'lossless') report('Building exact geometry', TRACE_LO);
  else if (mode === 'centerline') report('Finding centerlines', TRACE_LO);
  let svg: string;
  let shapes = 0;
  let colors = 0;
  let lossless = false;

  if (mode === 'lossless') {
    // Pixel-exact geometry is one shape per axis-aligned run of identical
    // pixels, so it degrades the same way for every caller: a photograph has
    // thousands of runs and the encoder refuses rather than emit a multi-
    // megabyte SVG with one <path> per colour. The engine's own `auto` mode
    // never lets a user hit that wall — it measures the image first and only
    // offers lossless when it will actually compress. This UI's MODE selector
    // bypasses that measurement on purpose, so a person can force lossless on
    // an image `auto` would have declined — which is a reasonable thing to
    // want to try, and a raw thrown error is not a reasonable way to answer it.
    try {
      const out = vectorizeExact(source as never) as { svg: string; shapes: number };
      svg = out.svg;
      shapes = out.shapes;
      lossless = true;
      notes.push('Pixel-exact geometry: this rasterises back to the source with zero differing pixels.');
    } catch (err) {
      // `vectorizeExact` throws two different shapes depending on which budget
      // is exceeded — src/vectorize/pixel.ts's hard cap ("would need more than
      // N rectangles.", no colon, lowercase "use") and its soft compression
      // budget ("has stopped compressing...: N rectangles for M pixels (X%,
      // over the Y% budget). Finishing would...", colon, capital "Use"). The
      // first version of this extraction only matched the second shape, so the
      // hard-cap message — reached on the very largest images, not the common
      // case — passed through with `--mode embed`/`--max-rects-per-pixel`
      // intact. Matched case-insensitively and independent of punctuation now,
      // so neither shape can leak a CLI flag into this browser tab.
      const reason = (err as Error).message
        .replace(/^Pixel-exact vectorisation (?:would need|has stopped compressing)[^:]*:\s*/, '')
        .replace(/^Pixel-exact vectorisation would need more than ([\d,]+) rectangles\.\s*/, 'more than $1 rectangles ')
        .replace(/This input is photographic;\s*/, '')
        .replace(/\s*[Uu]se --mode[\s\S]*$/, '')
        .replace(/\s*Finishing would emit[\s\S]*$/, '')
        .replace(/\.$/, '')
        .trim();
      try {
        // STILL LOSSLESS. A grid of rectangles is not the only bit-exact
        // representation — the pixels themselves, wrapped in an `<image>`, are
        // equally exact and never refuse regardless of how much detail the
        // source has. This is what "Pixel-lossless" actually promises;
        // rectangle geometry was one way to keep that promise, not the promise.
        //
        // Reuse the ORIGINAL bytes when they are known to decode to exactly
        // these pixels (see `ConvertSettings.originalFile`) rather than
        // re-encoding as PNG: PNG is lossless, so a photo a lossy format made
        // small can balloon on re-encode — measured, 4.8MB to 58.1MB.
        const out = settings.originalFile
          ? embedOriginal(settings.originalFile, source)
          : await embedAsPng(source);
        svg = out.svg;
        shapes = 1;
        lossless = true;
        const embedNote = settings.originalFile
          ? 'Embedded the original file instead: still bit-exact, and it keeps the size the ' +
            "source format already earned, at the cost of a raster wrapped in SVG rather than " +
            'shapes you can edit.'
          : 'Embedded the exact pixels instead: still bit-exact, and it always works, at the ' +
            'cost of a raster wrapped in SVG rather than shapes you can edit.';
        notes.push(`Pixel-exact rectangles would need ${reason} — too many for editable geometry. ${embedNote}`);
      } catch (embedErr) {
        // Only reached if this browser lacks `FileReaderSync` (both embed paths
        // need it) or, for the PNG path specifically, OffscreenCanvas encoding —
        // everything Baseline-widely-available supports both. Trace is the last
        // resort, not the first, and says plainly that it is not what was asked
        // for.
        mode = 'trace';
        const out = trace(source as never, traceOptions(settings) as never) as
          { svg: string; shapes: number; colors: number };
        svg = out.svg;
        shapes = out.shapes;
        colors = out.colors;
        notes.push(
          `Pixel-exact rectangles would need ${reason}, and this browser could not encode a ` +
          `lossless embed either (${(embedErr as Error).message}). Converted with Trace instead ` +
          '— this result is an approximation, not the exact copy Pixel-lossless promises.',
        );
      }
    }
  } else if (mode === 'centerline') {
    const out = centerlineTrace(source as never, {}) as { svg: string; paths: number };
    svg = out.svg;
    shapes = out.paths;
    notes.push('Single-stroke medial-axis paths, for pen plotters, lasers and CNC.');
  } else {
    const out = trace(source as never, traceOptions(settings) as never) as
      { svg: string; shapes: number; colors: number };
    svg = out.svg;
    shapes = out.shapes;
    colors = out.colors;
  }

  // Render-preserving minification: round coordinates, drop default attributes,
  // strip the prolog. It cannot change what the SVG draws, so it runs by default
  // rather than hiding behind a toggle — and because the metrics below are taken
  // *after* it, the reported size and the downloaded size are the same number.
  // Skipped for lossless output, where the whole promise is bit-exactness and
  // coordinate rounding is exactly the thing that would break it.
  if (settings.minify !== false && !lossless) {
    report('Minifying', 80);
    const before = svg.length;
    svg = optimizeSvg(svg);
    const saved = before - svg.length;
    if (saved > 0) notes.push(`Minified: ${Math.round((saved / before) * 100)}% smaller, same rendering.`);
  }

  const complexity = measureSvgComplexity(svg);
  return {
    svg,
    mode,
    shapes,
    colors,
    lossless,
    bytes: complexity.bytes,
    nodes: complexity.nodes,
    elapsedMs: Math.round(performance.now() - started),
    notes,
  };
}

/** Score a rendered result against its source. Measured, never asserted. */
function measure(a: RasterImage, b: RasterImage): Metrics {
  const q = compareImages(a as never, b as never) as
    { ssim: number; psnr: number; deltaE: { mean: number }; lossless: boolean };
  return {
    ssim: q.ssim,
    psnr: q.psnr,
    // `deltaE` is a distribution in the library (mean/p95/max); the studio's
    // headline figure is the mean CIEDE2000.
    deltaE: q.deltaE.mean,
    lossless: q.lossless,
  };
}

/**
 * Non-SVG vector exports, all produced client-side.
 *
 * These run through `prepare()` for the same reason `convert()` does, so a
 * download reflects the settings actually on screen.
 *
 * One honest asymmetry remains, and it is a property of the formats rather than
 * a bug: DXF, EPS and PDF carry *outline geometry*, so they are always traced,
 * even when the preview is in pixel-exact `lossless` mode. Lossless output is a
 * grid of axis-aligned rectangles, which these formats could in principle carry
 * exactly — but `traceGeometry` is the only geometry source available here, so a
 * lossless preview and a DXF of the same image are not the same construction.
 * G-code is likewise always centerline, because a toolpath *is* a medial axis;
 * there is no other meaningful reading of "cut this".
 */
async function exportAs(
  image: RasterImage, settings: ConvertSettings, format: ExportFormat,
): Promise<string | Uint8Array> {
  if (format === 'svg') return (await convert(image, settings)).svg;

  // Framework components start from the SVG the user is looking at, so what you
  // paste into an app is the thing that was measured on screen.
  if (format === 'react' || format === 'vue' || format === 'svelte' || format === 'solid') {
    return toComponent((await convert(image, settings)).svg, {
      framework: format,
      name: 'Icon',
      // `currentColor` is what makes an icon component actually reusable: the
      // caller's CSS `color` drives it. Gradients and `none` are left alone.
      currentColor: true,
    });
  }

  const { source } = prepare(image, settings);

  // These read the *source* pixels, not the vector output: a placeholder or a
  // palette describes the original image, and deriving them from a traced
  // approximation would quietly answer a different question.
  if (format === 'blurhash') return blurHash(source as never);
  if (format === 'lqip') return lqipSvg(source as never, {} as never);
  if (format === 'palette-css') {
    const palette = extractPalette(source as never, 8) as never;
    return paletteToCssVars(palette, '--brand');
  }
  if (format === 'ico') return faviconIco(source);

  if (format === 'gcode') {
    const polys = centerlinePolylines(source as never, {}) as never;
    return toGcode(polys, { mode: 'laser', height: source.height } as never);
  }
  const geometry = traceGeometry(source as never, traceOptions(settings) as never) as never;
  if (format === 'dxf') {
    // A DXF that declares no units is a drawing; one that does is a part.
    // Without `$INSUNITS`, LightBurn, LibreCAD and Fusion each apply a different
    // default, so the same file cuts at three different sizes depending on what
    // opened it — discovered after the cut, in material. The studio offered
    // exactly that silent file until now, while the CLI could do better.
    return toDxf(geometry, settings.physicalWidth
      ? { units: settings.dxfUnits ?? 'mm', pixelsPerUnit: source.width / settings.physicalWidth }
      : {});
  }
  if (format === 'eps') return toEps(geometry, {} as never);
  return toPdf(geometry, {} as never);
}

/**
 * A multi-size .ico from one source image.
 *
 * The classic four sizes, each nearest-neighbour sampled from the source. A DIB
 * payload rather than PNG, because 16×16 and 32×32 entries are the ones oldest
 * software reads, and every ICO reader understands a DIB.
 */
function faviconIco(source: RasterImage): Uint8Array {
  const sizes = [16, 32, 48, 64];
  const entries = sizes.map((size) => {
    const scaled = resizeNearest(source, size, size);
    return {
      width: size,
      height: size,
      payload: encodeIcoDib(scaled as never) as Uint8Array,
      bitCount: 32,
    };
  });
  return encodeIco(entries as never) as Uint8Array;
}

/**
 * Nearest-neighbour resize.
 *
 * Deliberately not smoothed: favicons are tiny, and at 16×16 a box filter turns
 * crisp edges into grey mush. There is no canvas in a worker without OffscreenCanvas
 * anyway, and this keeps the path pure.
 */
function resizeNearest(image: RasterImage, width: number, height: number): RasterImage {
  const out = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++) {
    const sy = Math.min(image.height - 1, Math.floor((y * image.height) / height));
    for (let x = 0; x < width; x++) {
      const sx = Math.min(image.width - 1, Math.floor((x * image.width) / width));
      const si = (sy * image.width + sx) * 4;
      const di = (y * width + x) * 4;
      out[di] = image.data[si] as number;
      out[di + 1] = image.data[si + 1] as number;
      out[di + 2] = image.data[si + 2] as number;
      out[di + 3] = image.data[si + 3] as number;
    }
  }
  return { width, height, data: out };
}

/**
 * Colour separations: one standalone SVG per colour.
 *
 * This is what screen-print, vinyl and DTF workflows need — a physical screen or
 * cutter pass per colour — and it is the single capability whose absence locked
 * an entire commercial audience out of the studio.
 */
function exportMany(image: RasterImage, settings: ConvertSettings): ExportedFile[] {
  const { source } = prepare(image, settings);
  const separations = traceSeparations(source as never, traceOptions(settings) as never) as
    { color: string; svg: string }[];
  return separations.map((sep, i) => ({
    // The colour is in the filename because a plate is identified by its ink,
    // and a folder of `layer-1.svg` tells a printer nothing.
    name: `${String(i + 1).padStart(2, '0')}-${sep.color.replace(/[^a-z0-9]+/gi, '') || 'layer'}.svg`,
    data: settings.minify !== false ? optimizeSvg(sep.svg) : sep.svg,
    mime: 'image/svg+xml',
  }));
}

/**
 * Many icons into one `<symbol>` sheet, referenced with `<use href="#id">`.
 *
 * The on-trend replacement for icon fonts, and the reason to build it *here* is
 * that rasters get traced on the way in — every other sprite tool starts from
 * SVGs you already have.
 */
async function sprite(items: { id: string; image: RasterImage }[], settings: ConvertSettings): Promise<string> {
  const traced = await Promise.all(
    items.map(async ({ id, image }) => ({ id, svg: (await convert(image, settings)).svg })),
  );
  return svgSprite(traced as never, {} as never) as string;
}

/**
 * Many frames into one CSS-animated SVG — a negative-`animation-delay`
 * flipbook, no JavaScript.
 *
 * Every frame is traced against a shared palette so colours cannot flicker
 * between frames, and frame 0 doubles as the still poster a non-animating
 * renderer or `prefers-reduced-motion` falls back to.
 */
async function animate(frames: RasterImage[], settings: ConvertSettings, fps: number): Promise<string> {
  const svgs = await Promise.all(frames.map(async (frame) => (await convert(frame, settings)).svg));
  return framesToAnimatedSvg(svgs, { fps } as never) as string;
}

// `convert()` became async the moment it grew a genuinely-lossless embed
// fallback (OffscreenCanvas PNG encoding, awaited) — see embedAsPng above — so
// this dispatcher and everything that calls convert() (exportAs, sprite,
// animate) had to follow. The dispatch itself stays a single try/catch around
// one big awaited expression per branch, so a rejection from deep inside
// still lands in the same `catch` a thrown error always did; nothing about the
// error-reporting contract changes for the callers on the other side of
// `postMessage`.
self.onmessage = async (e: MessageEvent<WorkerRequest>) => {
  const req = e.data;
  let res: WorkerResponse;
  try {
    if (req.kind === 'convert') {
      progressFor = req.id;
      try { res = { id: req.id, ok: true, kind: 'convert', result: await convert(req.image, req.settings) }; }
      finally { progressFor = null; }
    } else if (req.kind === 'measure') {
      res = { id: req.id, ok: true, kind: 'measure', metrics: measure(req.a, req.b) };
    } else if (req.kind === 'export-many') {
      res = { id: req.id, ok: true, kind: 'export-many', files: exportMany(req.image, req.settings) };
    } else if (req.kind === 'sprite') {
      const svg = await sprite(req.items, req.settings);
      res = { id: req.id, ok: true, kind: 'sprite', svg, count: req.items.length };
    } else if (req.kind === 'animate') {
      const svg = await animate(req.frames, req.settings, req.fps);
      res = { id: req.id, ok: true, kind: 'animate', svg, frames: req.frames.length };
    } else if (req.kind === 'diff') {
      const d = diffImages(req.source as never, req.rendered as never, {} as never) as
        { image: RasterImage; changedFraction: number; maxDeltaE: number };
      res = {
        id: req.id, ok: true, kind: 'diff',
        image: d.image, changedFraction: d.changedFraction, maxDeltaE: d.maxDeltaE,
      };
    } else {
      const data = await exportAs(req.image, req.settings, req.format);
      res = { id: req.id, ok: true, kind: 'export', data, format: req.format };
    }
  } catch (err) {
    res = { id: req.id, ok: false, error: (err as Error).message };
  }
  (self as unknown as Worker).postMessage(res);
};
