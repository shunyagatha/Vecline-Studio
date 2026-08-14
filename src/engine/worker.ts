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
} from 'vecline/core';
import type {
  ConvertResult, ConvertSettings, Metrics, RasterImage,
  WorkerRequest, WorkerResponse, ExportFormat, Mode,
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

function convert(image: RasterImage, settings: ConvertSettings): ConvertResult {
  const started = performance.now();
  const notes: string[] = [];

  let source = image;
  if (settings.removeBackground) {
    const r = removeBackground(source as never, {}) as { image: RasterImage };
    source = r.image;
    notes.push('Removed the detected background colour.');
  }

  const mode = resolveMode(source, settings.mode);
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

/** Non-SVG vector exports, all produced client-side. */
function exportAs(image: RasterImage, settings: ConvertSettings, format: ExportFormat): string | Uint8Array {
  if (format === 'svg') return convert(image, settings).svg;
  if (format === 'gcode') {
    const polys = centerlinePolylines(image as never, {}) as never;
    return toGcode(polys, { mode: 'laser', height: image.height } as never);
  }
  const geometry = traceGeometry(image as never, traceOptions(settings) as never) as never;
  if (format === 'dxf') return toDxf(geometry);
  if (format === 'eps') return toEps(geometry, {} as never);
  return toPdf(geometry, {} as never);
}

self.onmessage = (e: MessageEvent<WorkerRequest>) => {
  const req = e.data;
  let res: WorkerResponse;
  try {
    if (req.kind === 'convert') {
      res = { id: req.id, ok: true, kind: 'convert', result: convert(req.image, req.settings) };
    } else if (req.kind === 'measure') {
      res = { id: req.id, ok: true, kind: 'measure', metrics: measure(req.a, req.b) };
    } else {
      res = { id: req.id, ok: true, kind: 'export', data: exportAs(req.image, req.settings, req.format), format: req.format };
    }
  } catch (err) {
    res = { id: req.id, ok: false, error: (err as Error).message };
  }
  (self as unknown as Worker).postMessage(res);
};
