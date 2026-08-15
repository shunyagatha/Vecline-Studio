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
function prepare(image: RasterImage, settings: ConvertSettings): {
  source: RasterImage;
  mode: Exclude<Mode, 'auto'>;
  notes: string[];
} {
  const notes: string[] = [];
  let source = image;
  if (settings.removeBackground) {
    const r = removeBackground(source as never, {}) as { image: RasterImage };
    source = r.image;
    notes.push('Removed the detected background colour.');
  }
  return { source, mode: resolveMode(source, settings.mode), notes };
}

function convert(image: RasterImage, settings: ConvertSettings): ConvertResult {
  const started = performance.now();
  const { source, mode, notes } = prepare(image, settings);
  let svg: string;
  let shapes = 0;
  let colors = 0;
  let lossless = false;

  if (mode === 'lossless') {
    const out = vectorizeExact(source as never) as { svg: string; shapes: number };
    svg = out.svg;
    shapes = out.shapes;
    lossless = true;
    notes.push('Pixel-exact geometry: this rasterises back to the source with zero differing pixels.');
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
function exportAs(image: RasterImage, settings: ConvertSettings, format: ExportFormat): string | Uint8Array {
  if (format === 'svg') return convert(image, settings).svg;

  // Framework components start from the SVG the user is looking at, so what you
  // paste into an app is the thing that was measured on screen.
  if (format === 'react' || format === 'vue' || format === 'svelte' || format === 'solid') {
    return toComponent(convert(image, settings).svg, {
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
  if (format === 'dxf') return toDxf(geometry);
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

self.onmessage = (e: MessageEvent<WorkerRequest>) => {
  const req = e.data;
  let res: WorkerResponse;
  try {
    if (req.kind === 'convert') {
      res = { id: req.id, ok: true, kind: 'convert', result: convert(req.image, req.settings) };
    } else if (req.kind === 'measure') {
      res = { id: req.id, ok: true, kind: 'measure', metrics: measure(req.a, req.b) };
    } else if (req.kind === 'export-many') {
      res = { id: req.id, ok: true, kind: 'export-many', files: exportMany(req.image, req.settings) };
    } else if (req.kind === 'diff') {
      const d = diffImages(req.source as never, req.rendered as never, {} as never) as
        { image: RasterImage; changedFraction: number; maxDeltaE: number };
      res = {
        id: req.id, ok: true, kind: 'diff',
        image: d.image, changedFraction: d.changedFraction, maxDeltaE: d.maxDeltaE,
      };
    } else {
      res = { id: req.id, ok: true, kind: 'export', data: exportAs(req.image, req.settings, req.format), format: req.format };
    }
  } catch (err) {
    res = { id: req.id, ok: false, error: (err as Error).message };
  }
  (self as unknown as Worker).postMessage(res);
};
