/**
 * Vecline Studio — the UI half.
 *
 * The rule this file lives by: **nothing is asserted, only measured**. Every
 * number on screen comes back from the engine for the image actually in the
 * tab; when a figure cannot be obtained it shows an em-dash rather than a
 * plausible guess. That is the product's entire differentiator, so the code
 * never interpolates, estimates or remembers a stale value.
 */

import { Engine, decodeFile, decodeFileDetailed, decodeFrames, download, rasterizeSvg, encodeRasterImage, MIME, RASTER_MIME, EXPORT_EXT, type RasterTarget } from '../engine/client.js';
import { isPdf, openPdf, type PdfPages } from '../engine/pdf.js';
import { isOfficeDocument, probeBridge, convertViaBridge } from '../engine/bridge.js';
import { VERSION as ENGINE_VERSION } from 'vecline/core';
import type {
  ConvertResult, ConvertSettings, ExportFormat, MultiExportFormat, Metrics, Mode, Preset, RasterImage,
} from '../engine/types.js';

/* ============================================================
   Small helpers
   ============================================================ */

function byId<T extends HTMLElement>(id: string): T {
  const node = document.getElementById(id);
  if (!node) throw new Error(`Vecline Studio: the shell is missing #${id}.`);
  return node as T;
}

function all<T extends HTMLElement>(selector: string): T[] {
  return Array.from(document.querySelectorAll<T>(selector));
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

function group(nodes: HTMLElement[], isOn: (n: HTMLElement) => boolean): void {
  for (const n of nodes) n.setAttribute('aria-pressed', isOn(n) ? 'true' : 'false');
}

const EM_DASH = '—';

/** Byte counts, in the unit a human would have chosen. */
function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(n < 10 * 1024 ? 1 : 0)} KB`;
  return `${(n / (1024 * 1024)).toFixed(2)} MB`;
}

/** "84.1 → 31.0" plus the shared unit, so the pair reads as one comparison. */
function sizePair(a: number, b: number): { text: string; unit: string } {
  const mb = Math.max(a, b) >= 1024 * 1024;
  const div = mb ? 1024 * 1024 : 1024;
  const one = (n: number): string => (n / div >= 100 ? Math.round(n / div).toString() : (n / div).toFixed(1));
  return { text: `${one(a)} → ${one(b)}`, unit: mb ? 'MB' : 'KB' };
}

function fmtInt(n: number): string {
  return n.toLocaleString('en-US');
}

/**
 * Write a metric cell without ever touching innerHTML. The values here are all
 * locally formatted numbers, but keeping one DOM-building path means a filename
 * or an engine note can never be mistaken for markup somewhere down the line.
 */
function setCell(
  node: HTMLElement,
  value: string,
  unit?: string,
  badge?: { text: string; up: boolean },
): void {
  node.textContent = value;
  if (unit) {
    const s = document.createElement('small');
    s.textContent = unit;
    node.appendChild(s);
  }
  if (badge) {
    const b = document.createElement('span');
    b.className = badge.up ? 'delta up' : 'delta';
    b.textContent = badge.text;
    node.appendChild(b);
  }
}

function setGauge(node: HTMLElement, pct: number | null): void {
  node.style.width = pct === null ? '0%' : `${clamp(pct, 2, 100).toFixed(1)}%`;
}

function canvasToBlob(canvas: HTMLCanvasElement, type: string): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (b) => (b ? resolve(b) : reject(new Error('The canvas could not be encoded.'))),
      type,
    );
  });
}

function rasterToCanvas(raster: RasterImage): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  canvas.width = raster.width;
  canvas.height = raster.height;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('This browser did not provide a 2D canvas context.');
  // Copy into a context-owned ImageData rather than constructing one around the
  // engine's buffer: the engine's array may be backed by a SharedArrayBuffer,
  // which `new ImageData()` will not accept.
  const buffer = ctx.createImageData(raster.width, raster.height);
  buffer.data.set(raster.data);
  ctx.putImageData(buffer, 0, 0);
  return canvas;
}

/* ============================================================
   Presets — expressed only through settings the engine reads
   ============================================================ */

interface PresetDef {
  name: string;
  mode: Mode;
  colors: number;
  /** The rail's 0–100 feel, not the engine's tolerance. */
  detail: number;
  gradients: boolean;
  primitives: boolean;
}

const PRESETS: Record<Preset, PresetDef> = {
  auto:     { name: 'Auto',      mode: 'auto',       colors: 16, detail: 62,  gradients: false, primitives: false },
  logo:     { name: 'Logo',      mode: 'trace',      colors: 8,  detail: 55,  gradients: false, primitives: true },
  lineart:  { name: 'Line-art',  mode: 'centerline', colors: 2,  detail: 70,  gradients: false, primitives: false },
  poster:   { name: 'Poster',    mode: 'trace',      colors: 6,  detail: 45,  gradients: false, primitives: true },
  photo:    { name: 'Photo',     mode: 'trace',      colors: 48, detail: 78,  gradients: true,  primitives: false },
  detailed: { name: 'Detailed',  mode: 'trace',      colors: 24, detail: 88,  gradients: true,  primitives: false },
  pixelart: { name: 'Pixel-art', mode: 'lossless',   colors: 8,  detail: 100, gradients: false, primitives: false },
};

/**
 * The rail's "detail" is a feel from 0–100; the engine wants a curve-fit
 * tolerance in pixels where *smaller* is more faithful. The map is geometric
 * rather than linear because tolerance behaves logarithmically — a linear map
 * would spend most of its travel between 3px and 1.5px, where nothing visibly
 * changes, and cram every useful value into the last few percent.
 */
const TOL_LOOSE = 3;
const TOL_TIGHT = 0.1;
function detailToTolerance(detail: number): number {
  const t = clamp(detail, 0, 100) / 100;
  return TOL_LOOSE * Math.pow(TOL_TIGHT / TOL_LOOSE, t);
}

/* ============================================================
   State
   ============================================================ */

type CanvasView = 'split' | 'side' | 'out' | 'src';

interface UiState {
  preset: Preset;
  mode: Mode;
  colors: number;
  detail: number;
  gradients: boolean;
  primitives: boolean;
  removeBackground: boolean;
  /** `"1:1"`, `"16:9"`, … or empty for the whole frame. */
  cropAspect: string;
  /** Finished DXF width; 0 means 'no physical size declared'. */
  physicalWidth: number;
  dxfUnits: 'mm' | 'cm' | 'in';
  budgetOn: boolean;
  budgetKB: number;
  canvasView: CanvasView;
  split: number;
  zoomIdx: number;
  outline: boolean;
}

const state: UiState = {
  preset: 'auto',
  mode: 'auto',
  colors: 16,
  detail: 62,
  gradients: false,
  primitives: false,
  removeBackground: false,
  cropAspect: '',
  physicalWidth: 0,
  dxfUnits: 'mm',
  budgetOn: false,
  budgetKB: 24,
  canvasView: 'split',
  split: 46,
  zoomIdx: 2,
  outline: false,
};

const ZOOM = [50, 75, 100, 150, 200, 300, 400, 600, 800];

interface Source {
  name: string;
  bytes: number;
  image: RasterImage;
  /** Object URL for the original file, shown in the source pane. */
  url: string;
  /**
   * The original bytes. Kept because `createImageBitmap` only ever yields frame
   * zero — turning an animated GIF into an animated SVG means decoding the file
   * again, per frame, through a different API.
   */
  file: Blob;
}

let source: Source | null = null;
let lastResult: ConvertResult | null = null;
let lastMetrics: Metrics | null = null;
let outUrl: string | null = null;
let outlineUrl: string | null = null;
let busy = false;
/**
 * Whether the busy work in flight is an export.
 *
 * `busy` alone cannot answer the only question that matters before cancelling:
 * is this work the user asked for, or work we started on their behalf? A
 * preview conversion is speculative — a newer one supersedes it and nothing is
 * lost. An export is a file the user clicked a button to get, and the controls
 * stay live while it runs, so without this distinction a nudge of the colour
 * slider mid-export would terminate the worker and lose the download.
 */
let exporting = false;
let sweepPending = false;

/* ============================================================
   Elements
   ============================================================ */

const app = byId('app');
const viewport = byId('viewport');
const frame = document.querySelector<HTMLElement>('.frame');
const handle = byId('handle');
const srcImg = byId<HTMLImageElement>('srcImg');
const outImg = byId<HTMLImageElement>('outImg');
const outlineImg = byId<HTMLImageElement>('outlineImg');
const pxgrid = byId('pxgrid');
const dropZone = byId('drop');
const fileInput = byId<HTMLInputElement>('fileInput');
const errBar = byId('errBar');
const errText = byId('errText');
const toastEl = byId('toast');

const coloursRange = byId<HTMLInputElement>('colours');
const detailRange = byId<HTMLInputElement>('detail');
const budgetRange = byId<HTMLInputElement>('budget');
const budgetText = byId<HTMLInputElement>('budVal');

const dlSvgBtn = byId<HTMLButtonElement>('dlSvg');
const copySvgBtn = byId<HTMLButtonElement>('copySvg');
const moreBtn = byId<HTMLButtonElement>('moreBtn');
const moreMenu = byId('moreMenu');

const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
const darkQuery = window.matchMedia('(prefers-color-scheme: dark)');

/* ============================================================
   Engine
   ============================================================ */

// app.js and worker.js are siblings in dist/, so the worker resolves relative to
// this module rather than to the page — the studio keeps working if it is ever
// served from a subdirectory.
const engine = new Engine(new URL('./worker.js', import.meta.url));

function settingsFromState(): ConvertSettings {
  const s: ConvertSettings = {
    mode: state.mode,
    preset: state.preset,
    colors: state.colors,
    detail: detailToTolerance(state.detail),
    gradients: state.gradients,
    primitives: state.primitives,
    removeBackground: state.removeBackground,
    ...(parseAspect(state.cropAspect) ? { cropAspect: parseAspect(state.cropAspect) as [number, number] } : {}),
    ...(state.physicalWidth > 0 ? { physicalWidth: state.physicalWidth, dxfUnits: state.dxfUnits } : {}),
  };
  // Carried for the readout, which compares the finished size against this cap
  // and reports whether it fits. It is deliberately *not* an instruction to the
  // worker: the library's budget solver — relax, re-render, re-measure, bisect
  // back — lives in the Node entry point, not in `vecline/core`, so the studio
  // cannot yet enforce a budget, only report against one. The UI says exactly
  // that ("Fits" / "Over budget"), and must keep saying only that until the
  // solver is ported.
  if (state.budgetOn) s.maxBytes = state.budgetKB * 1024;
  return s;
}

/* ------------------------------------------------------------
   The conversion loop
   ------------------------------------------------------------ */

let runSeq = 0;
let debounceTimer = 0;

/** Controls fire continuously; converting on every tick would thrash the worker. */
function scheduleRun(): void {
  window.clearTimeout(debounceTimer);
  debounceTimer = window.setTimeout(() => void runNow(), 250);
}

async function runNow(): Promise<void> {
  window.clearTimeout(debounceTimer);
  const src = source;
  if (!src) return;

  // Every run takes a ticket. Conversions are not uniform in cost — dropping the
  // colour count can make a run finish in 40ms while the 3000ms photo run before
  // it is still going — so a late arrival must check that it is still the newest
  // before it paints. Without this the UI can settle on numbers that belong to
  // settings the user has already moved away from.
  const token = ++runSeq;

  // Free the thread before asking for more work. Without this the previous run
  // holds the worker to completion and this one queues behind it, so the bar
  // sits at 2% for as long as a conversion the user has already moved past.
  //
  // An export is exempt: it is a file the user asked for, and terminating the
  // worker under it would lose the download and report "That export failed" for
  // something we did on purpose. It queues instead, which is the correct
  // trade — the user's file wins over the preview's latency.
  if (busy && !exporting) engine.cancelAll();

  setBusy(true);
  setProgress('Decoding', 2);
  // Late arrivals must not repaint the bar for a run the user has moved past.
  engine.onProgress = (stage, pct) => { if (token === runSeq) setProgress(stage, pct); };

  try {
    const { result, metrics } = await engine.convertAndMeasure(
      src.image,
      settingsFromState(),
      // Scoring happens *inside* convertAndMeasure — rasterise the SVG back,
      // then compare. The label used to be set on the line after the await,
      // which is to say after the scoring had already finished: the bar sat on
      // the previous stage through the actual work and then flashed
      // "Scoring the result" for a single frame on its way out.
      () => { if (token === runSeq) setProgress('Scoring the result', 92); },
    );
    if (token !== runSeq) return;
    // Reaching 100 matters: a bar that stops short reads as an operation that
    // gave up rather than one that finished, and `aria-valuenow` is the only
    // completion signal a screen reader gets before the region is hidden.
    //
    // Nothing is awaited to make this paint. An earlier version yielded a
    // `requestAnimationFrame` here so the 100% state survived the `setBusy`
    // below — and that hung the app outright: rAF does not fire in a
    // backgrounded tab, so switching away mid-conversion left the promise
    // unsettled, the `finally` unreached and `busy` stuck at 1 forever, with no
    // result and no error. Measured: `data-busy` went to 1 and never came back.
    // The bar is `display:none` the instant busy clears, so the frame it bought
    // was never visible anyway. Resetting on entry instead of on exit is what
    // actually keeps the finished state coherent — see `setBusy`.
    setProgress('Done', 100);
    applyResult(result, metrics);
    clearError();
  } catch (err) {
    if (token !== runSeq) return;
    // A run we cancelled on purpose is not a failure to report to the user.
    if ((err as Error).message === 'Superseded.') return;
    clearResult();
    showError(`That image could not be converted. ${(err as Error).message}`);
  } finally {
    if (token === runSeq) setBusy(false);
  }
}

function applyResult(result: ConvertResult, metrics: Metrics | null): void {
  lastResult = result;
  lastMetrics = metrics;

  // The SVG goes into an <img> through a blob URL instead of being injected as
  // markup. An <img> renders SVG in an isolated, script-free context, so even a
  // pathological document can neither reach into this page nor run anything —
  // and the browser re-rasterises it crisply as the element is resized.
  const nextOut = URL.createObjectURL(new Blob([result.svg], { type: 'image/svg+xml' }));
  const outlineSvg = toOutlineSvg(result.svg);
  const nextOutline = outlineSvg
    ? URL.createObjectURL(new Blob([outlineSvg], { type: 'image/svg+xml' }))
    : null;

  if (outUrl) URL.revokeObjectURL(outUrl);
  if (outlineUrl) URL.revokeObjectURL(outlineUrl);
  outUrl = nextOut;
  outlineUrl = nextOutline;

  outImg.src = outUrl;
  outImg.hidden = false;
  if (outlineUrl) {
    outlineImg.src = outlineUrl;
    outlineImg.hidden = false;
  } else {
    outlineImg.hidden = true;
  }

  // Embedded-bitmap output has no geometry, so the overlay has nothing to draw.
  // Say that on the control rather than letting it toggle to an empty pane.
  const outlineable = outlineUrl !== null;
  const btn = byId<HTMLButtonElement>('outlineBtn');
  btn.disabled = !outlineable;
  btn.title = outlineable
    ? 'Show the vector geometry'
    : 'This result is an embedded bitmap — there is no geometry to outline';
  if (!outlineable && state.outline) {
    state.outline = false;
    btn.setAttribute('aria-pressed', 'false');
    viewport.dataset['outline'] = 'off';
  }

  paintMetrics();
  paintSwatches();
  paintBudget();
  paintReport();
  paintExports();

  if (sweepPending) {
    sweepPending = false;
    runSweep();
  }
}

function clearResult(): void {
  lastResult = null;
  lastMetrics = null;
  if (outUrl) URL.revokeObjectURL(outUrl);
  if (outlineUrl) URL.revokeObjectURL(outlineUrl);
  outUrl = null;
  outlineUrl = null;
  outImg.hidden = true;
  outImg.removeAttribute('src');
  outlineImg.hidden = true;
  outlineImg.removeAttribute('src');
  paintMetrics();
  paintSwatches();
  paintBudget();
  paintReport();
  paintExports();
}

/**
 * The "Outlines" overlay shows the engine's own geometry restroked — it is not a
 * redrawing. One injected <style> is enough because CSS beats presentation
 * attributes, which avoids parsing path data; a real parser would have to cope
 * with relative commands, arcs and gradient fills to gain nothing here.
 */
function toOutlineSvg(svg: string): string | null {
  const start = svg.indexOf('<svg');
  if (start < 0) return null;
  // An embedded bitmap has no geometry to stroke, so an outline overlay would be
  // a blank pane with no explanation — which reads as a broken toggle rather
  // than as "there is nothing here to outline". Refusing lets the caller disable
  // the control instead.
  if (!/<(path|rect|circle|ellipse|polygon|polyline|line)\b/.test(svg)) return null;
  const open = svg.indexOf('>', start);
  if (open < 0) return null;
  const css =
    '<style>*{fill:none!important;stroke:#D1006F!important;stroke-width:1!important;'
    + 'vector-effect:non-scaling-stroke!important}</style>';
  return `${svg.slice(0, open + 1)}${css}${svg.slice(open + 1)}`;
}

/* ============================================================
   Loading images
   ============================================================ */

/**
 * Return to the empty state — for when the wrong image went in. Releases the
 * object URLs so a long session of dropping images does not leak blobs, drops
 * any open PDF, and clears the result so no stale metrics linger under a blank
 * canvas.
 */
function removeImage(): void {
  if (source) URL.revokeObjectURL(source.url);
  source = null;
  closePdf();
  clearResult();
  clearError();
  srcImg.hidden = true;
  srcImg.removeAttribute('src');
  byId('fileName').textContent = '—';
  byId('fileDim').textContent = '—';
  app.dataset['state'] = 'empty';
  fileInput.value = '';
}

async function loadFile(file: File): Promise<void> {
  clearError();
  setBusy(true);

  let image: RasterImage;
  let pdfNote = '';
  // Whether the *original file* can go straight into an `<img>`. When it cannot
  // — PDF, TGA, PNM, ICO — the source pane is fed a canvas-rendered PNG of the
  // decoded pixels instead, so the before/after comparison actually has a
  // before. Without this the pane renders blank and nothing reports an error.
  let browserDisplayable = true;
  try {
    // An Office document has to become a PDF before anything here can read it,
    // and only the user's own machine can do that. If a bridge is listening the
    // whole chain stays local: .docx → their LibreOffice → PDF → mupdf in this
    // tab → pixels → traced SVG.
    if (isOfficeDocument(file.name)) {
      const bridge = await probeBridge();
      if (!bridge.available) {
        setBusy(false);
        showError(
          'Office documents need the Vecline CLI running on your machine — a browser tab has no ' +
          'office engine, and we will not upload your file to get one. Install it with ' +
          '`npm i -g vecline`, run `vecline serve`, then drop this file again.',
        );
        return;
      }
      if (!bridge.office) {
        setBusy(false);
        showError(
          'The local bridge is running but could not find LibreOffice, which does the actual ' +
          'conversion. Install it from libreoffice.org, or restart with `vecline serve --soffice <path>`.',
        );
        return;
      }
      toast('Converting through your local LibreOffice…');
      const asPdf = await convertViaBridge(file, file.name, 'pdf', bridge.port);
      closePdf();
      pdf = await openPdf(asPdf);
      pdfPage = 0;
      image = await pdf.render(0, PDF_DPI);
      browserDisplayable = false;
      pdfNote = pdf.count > 1 ? ` · page 1 of ${pdf.count}` : ' · 1 page';
    } else {
      const head = new Uint8Array(await file.slice(0, 8).arrayBuffer());
      if (isPdf(head)) {
        // The PDF engine is a separate chunk fetched on demand, so this is the
        // one load path that can be slow for a reason the user should be told
        // about rather than left guessing at.
        toast('Loading the PDF engine…');
        closePdf();
        pdf = await openPdf(new Uint8Array(await file.arrayBuffer()));
        pdfPage = 0;
        image = await pdf.render(0, PDF_DPI);
        browserDisplayable = false;
        pdfNote = pdf.count > 1 ? ` · page 1 of ${pdf.count}` : ' · 1 page';
      } else {
        const decoded = await decodeFileDetailed(file);
        image = decoded.image;
        browserDisplayable = decoded.browserDisplayable;
      }
    }
  } catch (err) {
    setBusy(false);
    closePdf();
    showError(
      /pdf/i.test((err as Error).message)
        ? `That PDF could not be rendered. ${(err as Error).message}`
        : 'That file could not be read as an image.',
    );
    return;
  }

  if (source) URL.revokeObjectURL(source.url);
  source = {
    name: file.name || 'image',
    bytes: file.size,
    image,
    // A PDF, TGA or PNM cannot be the `src` of an `<img>`, so the pane gets a
    // PNG of the decoded pixels instead. For everything the browser can render
    // natively the original file is used directly — no re-encode, and no
    // needless round-trip through a canvas for a large photograph.
    url: browserDisplayable
      ? URL.createObjectURL(file)
      : URL.createObjectURL(await canvasToBlob(rasterToCanvas(image), 'image/png')),
    file,
  };

  srcImg.src = source.url;
  srcImg.hidden = false;
  byId('fileName').textContent = source.name;
  byId('fileDim').textContent = `${image.width} × ${image.height}`;

  app.dataset['state'] = 'loaded';
  clearResult();
  sweepPending = true;
  paintCanvas();

  await runNow();
}

function baseName(): string {
  const name = source?.name ?? 'image';
  const dot = name.lastIndexOf('.');
  return dot > 0 ? name.slice(0, dot) : name;
}

/* ============================================================
   Samples — drawn here, never fetched
   ============================================================ */

interface SampleDef {
  id: string;
  label: string;
  preset: Preset;
  width: number;
  height: number;
  svg: string;
}

const MARK: Array<{ fill: string; d: string }> = [
  { fill: '#F2B02A', d: 'M 132 118 C 164 128 196 148 226 176 C 194 176 160 168 136 152 C 122 143 120 126 132 118 Z' },
  { fill: '#E4552B', d: 'M 74 42 C 68 24 74 12 88 4 C 82 18 82 30 86 44 Z' },
  { fill: '#E4552B', d: 'M 90 34 C 90 16 100 4 116 2 C 104 12 100 24 102 38 Z' },
  { fill: '#E4552B', d: 'M 104 38 C 110 22 122 12 138 12 C 124 20 118 30 116 44 Z' },
  { fill: '#12897B', d: 'M 90 96 C 130 96 152 122 152 150 C 152 167 140 176 120 176 L 74 176 C 56 176 44 165 44 148 C 44 119 62 96 90 96 Z' },
  { fill: '#0A6156', d: 'M 94 110 C 120 110 138 130 138 152 C 138 166 128 173 115 168 C 93 160 78 138 82 122 C 84 114 88 110 94 110 Z' },
  { fill: '#12897B', d: 'M 88 30 C 112 30 132 50 132 74 C 132 98 112 118 88 118 C 64 118 44 98 44 74 C 44 50 64 30 88 30 Z' },
  { fill: '#F2B02A', d: 'M 62 56 C 46 56 30 66 22 80 C 16 90 22 101 32 99 C 26 93 30 85 38 81 C 48 76 58 75 66 75 C 74 75 78 67 74 61 C 71 57 67 56 62 56 Z' },
  { fill: '#FFFFFF', d: 'M 78 56 C 86 56 92 62 92 70 C 92 78 86 84 78 84 C 70 84 64 78 64 70 C 64 62 70 56 78 56 Z' },
  { fill: '#231A2B', d: 'M 76 61 C 81 61 85 65 85 70 C 85 75 81 79 76 79 C 71 79 67 75 67 70 C 67 65 71 61 76 61 Z' },
];

function svgDoc(width: number, height: number, viewBox: string, body: string, extra = ''): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" `
    + `viewBox="${viewBox}"${extra}>${body}</svg>`;
}

function buildSamples(): SampleDef[] {
  const mark = MARK.map((p) => `<path fill="${p.fill}" d="${p.d}"/>`).join('');

  const line = [
    '<rect width="320" height="240" fill="#FFFFFF"/>',
    '<g fill="none" stroke="#1B1220" stroke-width="5" stroke-linecap="round">',
    '<path d="M56 192C80 96 136 56 192 56"/>',
    '<path d="M80 200c40-32 88-40 136-24"/>',
    '<path d="M192 56c32 8 52 32 56 64"/>',
    '<path d="M120 120c24-16 52-16 72 0"/>',
    '<path d="M104 152c28 20 64 24 96 12"/>',
    '</g>',
  ].join('');

  const icon = [
    '<rect x="18" y="18" width="220" height="220" rx="52" fill="#D1006F"/>',
    '<path d="M84 128h88M128 84v88" stroke="#FFFFFF" stroke-width="24" stroke-linecap="round"/>',
  ].join('');

  const sprite = [
    '<g fill="#12897B">',
    '<rect x="12" y="4" width="16" height="4"/><rect x="8" y="8" width="24" height="4"/>',
    '<rect x="8" y="12" width="24" height="4"/>',
    '</g>',
    '<g fill="#231A2B">',
    '<rect x="12" y="8" width="4" height="4"/><rect x="24" y="8" width="4" height="4"/>',
    '</g>',
    '<g fill="#E4552B">',
    '<rect x="12" y="16" width="16" height="4"/><rect x="16" y="20" width="8" height="4"/>',
    '<rect x="12" y="24" width="4" height="4"/><rect x="24" y="24" width="4" height="4"/>',
    '</g>',
  ].join('');

  const photo = [
    '<defs>',
    '<linearGradient id="sky" x1="0" y1="0" x2="0" y2="1">',
    '<stop offset="0" stop-color="#F7C65A"/><stop offset="0.55" stop-color="#F2882A"/>',
    '<stop offset="1" stop-color="#E4552B"/>',
    '</linearGradient>',
    '<radialGradient id="sun" cx="0.5" cy="0.5" r="0.5">',
    '<stop offset="0" stop-color="#FFF6D8"/><stop offset="1" stop-color="#FFD98A" stop-opacity="0"/>',
    '</radialGradient>',
    '</defs>',
    '<rect width="320" height="240" fill="url(#sky)"/>',
    '<circle cx="222" cy="80" r="66" fill="url(#sun)"/>',
    '<circle cx="222" cy="80" r="26" fill="#FFF0C9"/>',
    '<path d="M0 176 L88 104 L152 176 L208 132 L320 208 L320 240 L0 240 Z" fill="#5B2C4A"/>',
    '<path d="M0 208 L72 160 L136 208 L320 240 L0 240 Z" fill="#2E1430"/>',
  ].join('');

  return [
    { id: 'logo',   label: 'Flat logo',   preset: 'logo',     width: 320, height: 240, svg: svgDoc(320, 240, '-12 -9 264 198', mark) },
    { id: 'line',   label: 'Ink drawing', preset: 'lineart',  width: 320, height: 240, svg: svgDoc(320, 240, '0 0 320 240', line) },
    { id: 'icon',   label: 'App icon',    preset: 'logo',     width: 256, height: 256, svg: svgDoc(256, 256, '0 0 256 256', icon) },
    { id: 'pixel',  label: 'Sprite',      preset: 'pixelart', width: 40,  height: 32,  svg: svgDoc(40, 32, '0 0 40 32', sprite, ' shape-rendering="crispEdges"') },
    { id: 'photo',  label: 'Sunset',      preset: 'photo',    width: 320, height: 240, svg: svgDoc(320, 240, '0 0 320 240', photo) },
  ];
}

/** A sample becomes a genuine PNG file, so it travels the exact path a drop does. */
async function sampleToFile(sample: SampleDef): Promise<File> {
  const raster = await rasterizeSvg(sample.svg, sample.width, sample.height);
  const blob = await canvasToBlob(rasterToCanvas(raster), 'image/png');
  return new File([blob], `${sample.id}-sample.png`, { type: 'image/png' });
}

function mountSamples(): void {
  const row = byId('samplerow');
  for (const sample of buildSamples()) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'sample';
    btn.setAttribute('aria-label', `Load the ${sample.label} sample`);

    const thumb = document.createElement('span');
    thumb.className = 'thumb';
    const img = document.createElement('img');
    // A data URL, not a file: the samples are drawn in this bundle, so the
    // "no network requests" promise holds even for the gallery.
    img.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(sample.svg)}`;
    img.alt = '';
    thumb.appendChild(img);

    const cap = document.createElement('span');
    cap.className = 'cap';
    cap.textContent = sample.label;

    btn.append(thumb, cap);
    btn.addEventListener('click', () => {
      void (async () => {
        setBusy(true);
        try {
          const file = await sampleToFile(sample);
          applyPreset(sample.preset, false);
          await loadFile(file);
        } catch {
          setBusy(false);
          showError('That sample could not be drawn in this browser.');
        }
      })();
    });
    row.appendChild(btn);
  }
}

/* ============================================================
   Painting
   ============================================================ */

function paintMetrics(): void {
  const pill = byId('statePill');
  const pillText = byId('statePillText');
  const note = byId('readNote');
  const r = lastResult;
  const m = lastMetrics;
  const lossless = Boolean(r?.lossless || m?.lossless);

  pill.classList.toggle('is-lossless', lossless && !busy);
  pill.classList.toggle('is-ready', !source);
  pill.classList.toggle('is-busy', busy);

  if (busy) {
    pillText.textContent = 'Measuring';
    note.textContent = 'converting on this device';
  } else if (!source) {
    pillText.textContent = 'Ready';
    note.textContent = 'waiting for an image';
  } else if (!r) {
    pillText.textContent = 'No result';
    note.textContent = 'nothing measured';
  } else if (lossless) {
    pillText.textContent = 'Lossless ✓ bit-exact';
    note.textContent = `verified pixel-for-pixel · ${source.image.width} × ${source.image.height}`;
  } else if (!m) {
    pillText.textContent = 'Unmeasured';
    note.textContent = 'the output could not be re-rendered for scoring';
  } else {
    pillText.textContent = 'Measured';
    note.textContent = `rendered at 1× · ${source.image.width} × ${source.image.height}`;
  }

  const mSsim = byId('mSsim');
  const mPsnr = byId('mPsnr');
  const mDe = byId('mDe');
  const mNodes = byId('mNodes');
  const mSize = byId('mSize');
  const mTime = byId('mTime');

  // Metrics and result are separately available: a render failure loses the
  // scores but not the conversion, and each half shows only what it really has.
  if (m) {
    setCell(mSsim, m.ssim >= 1 ? '1.0000' : m.ssim.toFixed(4));
    setCell(mPsnr, Number.isFinite(m.psnr) ? m.psnr.toFixed(1) : '∞', 'dB');
    setCell(mDe, m.deltaE.toFixed(2));
    setGauge(byId('gSsim'), ((m.ssim - 0.9) / 0.1) * 100);
    setGauge(byId('gPsnr'), (((Number.isFinite(m.psnr) ? m.psnr : 48) - 20) / 28) * 100);
    setGauge(byId('gDe'), 100 - (m.deltaE / 6) * 100);
  } else {
    setCell(mSsim, EM_DASH);
    setCell(mPsnr, EM_DASH);
    setCell(mDe, EM_DASH);
    setGauge(byId('gSsim'), null);
    setGauge(byId('gPsnr'), null);
    setGauge(byId('gDe'), null);
  }

  if (r && source) {
    setCell(mNodes, fmtInt(r.nodes));
    setGauge(byId('gNodes'), (r.nodes / 6000) * 100);

    const pair = sizePair(source.bytes, r.bytes);
    const pct = source.bytes > 0 ? Math.round(((r.bytes - source.bytes) / source.bytes) * 100) : 0;
    setCell(mSize, pair.text, pair.unit, {
      text: `${pct > 0 ? '+' : '−'}${Math.abs(pct)}%`,
      up: pct > 0,
    });
    setGauge(byId('gSize'), 100 - (r.bytes / Math.max(1, source.bytes)) * 100);

    setCell(mTime, fmtInt(r.elapsedMs), 'ms');
    setGauge(byId('gTime'), (r.elapsedMs / 1600) * 100);

    byId('outInfo').textContent =
      `${baseName()}.svg · ${fmtBytes(r.bytes)} · ${fmtInt(r.nodes)} nodes`;
  } else {
    setCell(mNodes, EM_DASH);
    setCell(mSize, EM_DASH);
    setCell(mTime, EM_DASH);
    setGauge(byId('gNodes'), null);
    setGauge(byId('gSize'), null);
    setGauge(byId('gTime'), null);
    byId('outInfo').textContent = 'no output yet';
  }
}

/** Colour chips read out of the produced SVG — the palette that actually shipped. */
const FILL_RE = /(?:fill|stop-color)\s*[:=]\s*"?\s*(#[0-9a-fA-F]{3,8}|rgba?\([^)]{0,64}\))/g;

function paletteOf(svg: string, cap: number): string[] {
  const seen = new Set<string>();
  for (const m of svg.matchAll(FILL_RE)) {
    seen.add(m[1].toLowerCase());
    if (seen.size >= cap) break;
  }
  return Array.from(seen);
}

function paintSwatches(): void {
  const box = byId('swatches');
  box.replaceChildren();
  if (!lastResult) {
    const none = document.createElement('span');
    none.className = 'none';
    none.textContent = EM_DASH;
    box.appendChild(none);
    return;
  }
  const palette = paletteOf(lastResult.svg, 64);
  for (const colour of palette.slice(0, 12)) {
    const chip = document.createElement('i');
    chip.style.background = colour;
    box.appendChild(chip);
  }
  if (palette.length > 12) {
    const more = document.createElement('span');
    more.className = 'more';
    more.textContent = `+${palette.length - 12}`;
    box.appendChild(more);
  }
}

function paintBudget(): void {
  const cost = byId('cost');
  const budgetGrp = byId('budgetGrp');
  const isLossless = state.mode === 'lossless';
  budgetGrp.classList.toggle('dim', isLossless);

  if (isLossless) {
    cost.textContent = 'Not applicable. Lossless output is already the smallest exact form.';
    return;
  }
  if (!state.budgetOn) {
    cost.textContent = 'No cap. Vecline emits whatever the image actually needs.';
    return;
  }
  const cap = state.budgetKB * 1024;
  if (!lastResult) {
    cost.textContent = `Cap set to ${state.budgetKB} KB. Convert an image to check it against the budget.`;
    return;
  }
  // Measured, not promised: the studio reports the result against the cap rather
  // than claiming a trim it cannot verify.
  if (lastResult.bytes <= cap) {
    cost.textContent =
      `Fits: ${fmtBytes(lastResult.bytes)} under a ${state.budgetKB} KB cap.`;
  } else {
    cost.textContent =
      `Over budget: ${fmtBytes(lastResult.bytes)} against a ${state.budgetKB} KB cap. `
      + 'Fewer colours or less detail will bring it down.';
  }
}

function paintReport(): void {
  const box = byId('report');
  box.replaceChildren();
  const r = lastResult;
  if (!r) {
    box.textContent = 'Nothing converted yet.';
    return;
  }

  const dl = document.createElement('dl');
  const rows: Array<[string, string]> = [
    ['Strategy', r.mode],
    ['Shapes', fmtInt(r.shapes)],
    ['Colours', r.colors > 0 ? fmtInt(r.colors) : EM_DASH],
    ['Nodes', fmtInt(r.nodes)],
    ['Bytes', fmtBytes(r.bytes)],
  ];
  for (const [k, v] of rows) {
    const dt = document.createElement('dt');
    dt.textContent = k;
    const dd = document.createElement('dd');
    dd.textContent = v;
    dl.append(dt, dd);
  }
  box.appendChild(dl);

  if (r.notes.length > 0) {
    const ul = document.createElement('ul');
    for (const note of r.notes) {
      const li = document.createElement('li');
      li.textContent = note;
      ul.appendChild(li);
    }
    box.appendChild(ul);
  }
}

function paintExports(): void {
  const ready = Boolean(lastResult) && !busy;
  dlSvgBtn.disabled = !ready;
  copySvgBtn.disabled = !ready;
  moreBtn.disabled = !ready;
  if (!ready) closeMenu();
}

function paintControls(): void {
  byId('presetVal').textContent = PRESETS[state.preset].name;
  byId('colVal').textContent = String(state.colors);
  byId('detVal').textContent = String(state.detail);

  coloursRange.value = String(state.colors);
  detailRange.value = String(state.detail);
  budgetRange.value = String(clamp(state.budgetKB, 6, 140));
  if (document.activeElement !== budgetText) budgetText.value = `${state.budgetKB} KB`;

  for (const input of [coloursRange, detailRange, budgetRange]) setRangeFill(input);

  for (const sw of all('.sw[data-tog]')) {
    const key = sw.dataset['tog'] ?? '';
    const on = key === 'budget'
      ? state.budgetOn
      : Boolean(state[key as 'gradients' | 'primitives' | 'removeBackground']);
    sw.setAttribute('aria-checked', on ? 'true' : 'false');
  }

  group(all('.chip[data-preset]'), (n) => n.dataset['preset'] === state.preset);
  group(all('.mode[data-mode]'), (n) => n.dataset['mode'] === state.mode);
  // Exposed for the stylesheet: centerline output is monochrome strokes, so the
  // dark theme flips them to white for viewing (see the invert rule in the CSS).
  app.dataset['mode'] = state.mode;

  // Colour quantisation and the trace passes only exist on the tracing path;
  // leaving them live in lossless or centerline mode would imply an effect the
  // engine will not produce.
  const tracing = state.mode === 'auto' || state.mode === 'trace';
  byId('colourGrp').classList.toggle('dim', !tracing);
  coloursRange.disabled = !tracing;
  detailRange.disabled = !tracing;
  for (const sw of all<HTMLButtonElement>('.sw[data-tog="gradients"], .sw[data-tog="primitives"]')) {
    sw.disabled = !tracing;
  }

  const budgetUsable = state.mode !== 'lossless';
  budgetRange.disabled = !state.budgetOn || !budgetUsable;
  budgetText.disabled = !state.budgetOn || !budgetUsable;
}

function setRangeFill(input: HTMLInputElement): void {
  const min = Number(input.min);
  const max = Number(input.max);
  const v = Number(input.value);
  const pct = max > min ? ((v - min) / (max - min)) * 100 : 0;
  input.style.setProperty('--fill', `${pct.toFixed(2)}%`);
}

function paintSplit(): void {
  document.documentElement.style.setProperty('--split', state.split.toFixed(1));
  byId('ruleRead').textContent = `SPLIT ${state.split.toFixed(1)}%`;
  const rounded = Math.round(state.split);
  handle.setAttribute('aria-valuenow', String(rounded));
  handle.setAttribute('aria-valuetext', `${rounded} percent`);
}

function paintCanvas(): void {
  viewport.dataset['view'] = state.canvasView;
  viewport.dataset['outline'] = state.outline ? 'on' : 'off';
  app.dataset['cview'] = state.canvasView;

  const zoom = ZOOM[state.zoomIdx];
  viewport.style.setProperty('--zoom', String(zoom / 100));
  const zoomVal = byId('zoomVal');
  zoomVal.textContent = `${zoom}%`;
  zoomVal.setAttribute('aria-label', `Reset zoom to 100 percent, currently ${zoom} percent`);

  paintSplit();
  layoutPixelGrid();
}

/**
 * The pixel grid has to sit exactly on the source pixels or it is a lie. The
 * <img> is object-fit:contain inside a box scaled by the zoom, so the drawn
 * artwork is the largest zoom-scaled rectangle with the image's aspect ratio —
 * that rectangle, not the pane, is what the overlay is positioned against.
 */
function layoutPixelGrid(): void {
  const src = source;
  const pane = pxgrid.parentElement;
  if (!src || !pane) {
    pxgrid.hidden = true;
    return;
  }
  const pw = pane.clientWidth;
  const ph = pane.clientHeight;
  if (!pw || !ph) {
    pxgrid.hidden = true;
    return;
  }
  const zoom = ZOOM[state.zoomIdx] / 100;
  const scale = Math.min((pw * zoom) / src.image.width, (ph * zoom) / src.image.height);
  const drawnW = src.image.width * scale;
  const drawnH = src.image.height * scale;

  // Below roughly six CSS pixels per source pixel the grid is moiré, not
  // information — and it would swamp the artwork it is meant to explain.
  srcImg.classList.toggle('px', scale >= 3);
  if (scale < 6) {
    pxgrid.hidden = true;
    return;
  }
  pxgrid.hidden = false;
  pxgrid.style.left = `${(pw - drawnW) / 2}px`;
  pxgrid.style.top = `${(ph - drawnH) / 2}px`;
  pxgrid.style.width = `${drawnW}px`;
  pxgrid.style.height = `${drawnH}px`;
  pxgrid.style.setProperty('--px', `${scale}px`);
}

function setBusy(on: boolean): void {
  busy = on;
  app.dataset['busy'] = on ? '1' : '0';
  // Reset when work *starts*, not when it ends.
  //
  // Clearing on the way out contradicted the run that had just finished: the
  // last state the bar was left in — and the last `aria-valuenow` a screen
  // reader saw — was 0%, immediately after reaching 100%. Since the bar is
  // hidden while idle, nobody benefits from that zero; the only thing it can do
  // is make a completed conversion look abandoned.
  //
  // Callers that know their first step override this straight away in the same
  // tick, so the neutral label shows only for work whose progress we genuinely
  // cannot name yet, such as decoding a file.
  if (on) setProgress('Working', 0);
  paintMetrics();
  paintExports();
}

/**
 * Paint the staged progress readout. Called from real milestones only — the
 * worker announces a stage as it begins it, and nothing here interpolates
 * between them, so the bar never claims progress that has not happened.
 */
function setProgress(stage: string, pct: number): void {
  const clamped = Math.max(0, Math.min(100, pct));
  if (stage) byId('progStage').textContent = stage + '…';
  byId<HTMLElement>('progFill').style.width = `${clamped}%`;
  byId('progPct').textContent = `${Math.round(pct)}%`;
  // Keep the assistive value in step with the painted one, or a screen reader
  // reports a bar frozen at zero while the visible one advances.
  byId('progTrack').setAttribute('aria-valuenow', String(Math.round(clamped)));
}

/* ============================================================
   Messages
   ============================================================ */

function showError(message: string): void {
  errText.textContent = message;
  errBar.hidden = false;
}

function clearError(): void {
  errBar.hidden = true;
  errText.textContent = '';
}

let toastTimer = 0;
function toast(message: string): void {
  toastEl.textContent = message;
  toastEl.classList.add('show');
  window.clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => toastEl.classList.remove('show'), 2600);
}

/* ============================================================
   Wiring — controls
   ============================================================ */

function applyPreset(key: Preset, convert = true): void {
  const p = PRESETS[key];
  state.preset = key;
  state.mode = p.mode;
  state.colors = p.colors;
  state.detail = p.detail;
  state.gradients = p.gradients;
  state.primitives = p.primitives;
  paintControls();
  paintBudget();
  if (convert) scheduleRun();
}

for (const chip of all('.chip[data-preset]')) {
  chip.addEventListener('click', () => applyPreset((chip.dataset['preset'] ?? 'auto') as Preset));
}

for (const mode of all('.mode[data-mode]')) {
  mode.addEventListener('click', () => {
    state.mode = (mode.dataset['mode'] ?? 'auto') as Mode;
    paintControls();
    paintBudget();
    scheduleRun();
  });
}

coloursRange.addEventListener('input', () => {
  state.colors = Number(coloursRange.value);
  byId('colVal').textContent = String(state.colors);
  setRangeFill(coloursRange);
  scheduleRun();
});

detailRange.addEventListener('input', () => {
  state.detail = Number(detailRange.value);
  byId('detVal').textContent = String(state.detail);
  setRangeFill(detailRange);
  scheduleRun();
});

const cutWidth = byId<HTMLInputElement>('physicalWidth');
const cutUnits = byId<HTMLSelectElement>('dxfUnits');
// Physical size changes only the DXF header and coordinate scale, never the
// traced geometry — so it does not re-run the conversion, unlike every other
// control in this rail.
cutWidth.addEventListener('input', () => { state.physicalWidth = Number(cutWidth.value) || 0; });
cutUnits.addEventListener('change', () => { state.dxfUnits = cutUnits.value as 'mm' | 'cm' | 'in'; });

const cropSelect = byId<HTMLSelectElement>('cropAspect');
cropSelect.addEventListener('change', () => {
  state.cropAspect = cropSelect.value;
  // A crop changes the pixels being converted, so it re-runs like any other
  // setting — the metrics must describe the cropped region, not the old frame.
  scheduleRun();
});

budgetRange.addEventListener('input', () => {
  state.budgetKB = Number(budgetRange.value);
  budgetText.value = `${state.budgetKB} KB`;
  setRangeFill(budgetRange);
  paintBudget();
  scheduleRun();
});

/** Accepts "40KB", "40 kb", "0.5 MB", "4096 B" — a bare number means kilobytes. */
function parseBudget(text: string): number | null {
  const m = /^\s*([0-9]*\.?[0-9]+)\s*(b|k|kb|m|mb)?\s*$/i.exec(text);
  if (!m) return null;
  const n = Number(m[1]);
  if (!Number.isFinite(n) || n <= 0) return null;
  const unit = (m[2] ?? 'kb').toLowerCase();
  const kb = unit === 'b' ? n / 1024 : unit === 'm' || unit === 'mb' ? n * 1024 : n;
  return clamp(Math.round(kb), 6, 4096);
}

function commitBudgetText(): void {
  const parsed = parseBudget(budgetText.value);
  if (parsed === null) {
    budgetText.value = `${state.budgetKB} KB`;
    return;
  }
  state.budgetKB = parsed;
  budgetText.value = `${parsed} KB`;
  budgetRange.value = String(clamp(parsed, 6, 140));
  setRangeFill(budgetRange);
  paintBudget();
  scheduleRun();
}

budgetText.addEventListener('change', commitBudgetText);
budgetText.addEventListener('blur', commitBudgetText);
budgetText.addEventListener('keydown', (e: KeyboardEvent) => {
  if (e.key === 'Enter') {
    e.preventDefault();
    commitBudgetText();
  }
});

for (const sw of all<HTMLButtonElement>('.sw[data-tog]')) {
  sw.addEventListener('click', () => {
    if (sw.disabled) return;
    const key = sw.dataset['tog'] ?? '';
    if (key === 'budget') {
      state.budgetOn = !state.budgetOn;
    } else if (key === 'gradients' || key === 'primitives' || key === 'removeBackground') {
      state[key] = !state[key];
    } else {
      return;
    }
    paintControls();
    paintBudget();
    scheduleRun();
  });
}

/* ============================================================
   Wiring — canvas
   ============================================================ */

for (const tab of all('.tabs button[data-view]')) {
  tab.addEventListener('click', () => {
    state.canvasView = (tab.dataset['view'] ?? 'split') as CanvasView;
    group(all('.tabs button[data-view]'), (n) => n === tab);
    paintCanvas();
  });
}

const outlineBtn = byId('outlineBtn');
outlineBtn.addEventListener('click', () => {
  state.outline = !state.outline;
  outlineBtn.setAttribute('aria-pressed', state.outline ? 'true' : 'false');
  paintCanvas();
});

byId('zoomIn').addEventListener('click', () => {
  state.zoomIdx = Math.min(ZOOM.length - 1, state.zoomIdx + 1);
  paintCanvas();
});
byId('zoomOut').addEventListener('click', () => {
  state.zoomIdx = Math.max(0, state.zoomIdx - 1);
  paintCanvas();
});
byId('zoomVal').addEventListener('click', () => {
  state.zoomIdx = ZOOM.indexOf(100);
  paintCanvas();
});

/**
 * The split is stored as a percentage of the viewport width rather than a pixel
 * offset, because the handle, the caliper cursor and the output pane's clip-path
 * all read the same `--split` custom property: one number means they cannot
 * drift apart when the window resizes mid-drag.
 */
let dragging = false;

function setSplitFromClientX(clientX: number): void {
  const rect = viewport.getBoundingClientRect();
  if (!rect.width) return;
  state.split = clamp(((clientX - rect.left) / rect.width) * 100, 0, 100);
  paintSplit();
}

// Pointer events cover mouse, pen and touch in one path; `touch-action:none` on
// the viewport stops the browser stealing the drag to scroll the page.
viewport.addEventListener('pointerdown', (e: PointerEvent) => {
  if (state.canvasView !== 'split' || !source) return;
  dragging = true;
  viewport.setPointerCapture(e.pointerId);
  setSplitFromClientX(e.clientX);
  e.preventDefault();
});
viewport.addEventListener('pointermove', (e: PointerEvent) => {
  if (dragging) setSplitFromClientX(e.clientX);
});
for (const ev of ['pointerup', 'pointercancel', 'pointerleave'] as const) {
  viewport.addEventListener(ev, () => { dragging = false; });
}

handle.addEventListener('keydown', (e: KeyboardEvent) => {
  const step = e.shiftKey ? 10 : 2;
  let used = true;
  if (e.key === 'ArrowLeft' || e.key === 'ArrowDown') state.split = clamp(state.split - step, 0, 100);
  else if (e.key === 'ArrowRight' || e.key === 'ArrowUp') state.split = clamp(state.split + step, 0, 100);
  else if (e.key === 'Home') state.split = 0;
  else if (e.key === 'End') state.split = 100;
  else used = false;
  if (used) {
    e.preventDefault();
    paintSplit();
  }
});

function runSweep(): void {
  if (reducedMotion.matches) {
    state.split = 46;
    paintSplit();
    return;
  }
  const from = 100;
  const to = 46;
  const dur = 900;
  const t0 = performance.now();
  const step = (now: number): void => {
    const k = clamp((now - t0) / dur, 0, 1);
    state.split = from + (to - from) * (1 - Math.pow(1 - k, 3));
    paintSplit();
    if (k < 1) requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}

if ('ResizeObserver' in window) {
  new ResizeObserver(() => layoutPixelGrid()).observe(viewport);
}
window.addEventListener('resize', () => layoutPixelGrid());

/* ============================================================
   Wiring — input
   ============================================================ */

// Show which engine build is running, linked to its release notes.
byId('engineVer').textContent = `v${ENGINE_VERSION}`;

byId('removeImg').addEventListener('click', removeImage);

byId('browse').addEventListener('click', () => fileInput.click());

fileInput.addEventListener('change', () => {
  const file = fileInput.files?.[0];
  if (file) void loadFile(file);
  // Reset so choosing the same file twice still fires a change event.
  fileInput.value = '';
});

// Without these the browser navigates away from the app when a file is dropped
// anywhere outside the target.
document.addEventListener('dragover', (e: DragEvent) => e.preventDefault());
document.addEventListener('drop', (e: DragEvent) => e.preventDefault());

if (frame) {
  for (const ev of ['dragenter', 'dragover'] as const) {
    frame.addEventListener(ev, (e: DragEvent) => {
      e.preventDefault();
      dropZone.classList.add('over');
    });
  }
  for (const ev of ['dragleave', 'dragend'] as const) {
    frame.addEventListener(ev, () => dropZone.classList.remove('over'));
  }
  frame.addEventListener('drop', (e: DragEvent) => {
    e.preventDefault();
    dropZone.classList.remove('over');
    const file = e.dataTransfer?.files?.[0];
    if (file) void loadFile(file);
    else showError('That drop did not contain a file.');
  });
}

document.addEventListener('paste', (e: ClipboardEvent) => {
  // A paste into the size-budget field is a paste into that field, not an image.
  const target = e.target;
  if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement) return;
  const file = e.clipboardData?.files?.[0];
  if (!file) return;
  e.preventDefault();
  void loadFile(file);
});

byId('errClose').addEventListener('click', clearError);

/* ============================================================
   Wiring — export
   ============================================================ */

dlSvgBtn.addEventListener('click', () => {
  if (!lastResult) return;
  download(lastResult.svg, `${baseName()}.svg`, MIME.svg);
});

copySvgBtn.addEventListener('click', () => {
  const r = lastResult;
  if (!r) return;
  if (!navigator.clipboard?.writeText) {
    showError('This browser did not allow clipboard access. Use Download SVG instead.');
    return;
  }
  navigator.clipboard.writeText(r.svg).then(
    () => toast('SVG copied to the clipboard'),
    () => showError('The clipboard was blocked. Use Download SVG instead.'),
  );
});

function closeMenu(): void {
  moreMenu.hidden = true;
  moreBtn.setAttribute('aria-expanded', 'false');
}

moreBtn.addEventListener('click', (e: MouseEvent) => {
  e.stopPropagation();
  const opening = moreMenu.hidden;
  moreMenu.hidden = !opening;
  moreBtn.setAttribute('aria-expanded', opening ? 'true' : 'false');
});

moreMenu.addEventListener('click', (e: MouseEvent) => {
  const target = e.target instanceof Element ? e.target.closest<HTMLElement>('button[data-fmt]') : null;
  if (!target) return;
  closeMenu();
  void exportAs((target.dataset['fmt'] ?? 'svg') as ExportFormat | MultiExportFormat | ExtraExport);
});

document.addEventListener('click', (e: MouseEvent) => {
  if (!moreMenu.hidden && e.target instanceof Node && !moreMenu.contains(e.target)) closeMenu();
});

document.addEventListener('keydown', (e: KeyboardEvent) => {
  if (e.key === 'Escape' && !moreMenu.hidden) {
    closeMenu();
    moreBtn.focus();
  }
});

/** `"16:9"` → `[16, 9]`; anything unparseable means "no crop". */
function parseAspect(value: string): [number, number] | null {
  const m = /^(\d+(?:\.\d+)?):(\d+(?:\.\d+)?)$/.exec(value.trim());
  if (!m) return null;
  const w = Number(m[1]);
  const h = Number(m[2]);
  return w > 0 && h > 0 ? [w, h] : null;
}

/**
 * 150 DPI: the same default the CLI's `vecline doc --dpi` uses, so a page
 * rendered here and a page rendered there are the same pixels. High enough that
 * body text traces cleanly, low enough that an A4 page stays around 1240×1754
 * rather than becoming a 20-megapixel buffer the tracer then has to chew.
 */
const PDF_DPI = 150;

let pdf: PdfPages | null = null;
let pdfPage = 0;

function closePdf(): void {
  pdf?.close();
  pdf = null;
  pdfPage = 0;
}

const PNG_SCALE = 2;

/**
 * A sprite sheet is the one export that needs *more* input than the studio
 * holds, so it asks for it: pick several icons, each gets traced with the
 * current settings, and they come back as one `<symbol>` sheet you reference
 * with `<use href="#name">`. Every other sprite tool starts from SVGs you
 * already have; tracing on the way in is the point.
 */
const spriteInput = byId<HTMLInputElement>('spriteInput');

async function exportSprite(): Promise<void> {
  const files = await new Promise<File[]>((resolve) => {
    const onChange = (): void => {
      spriteInput.removeEventListener('change', onChange);
      resolve(Array.from(spriteInput.files ?? []));
      spriteInput.value = '';
    };
    spriteInput.addEventListener('change', onChange);
    spriteInput.click();
  });
  if (files.length === 0) return;

  const items: { id: string; image: RasterImage }[] = [];
  const skipped: string[] = [];
  for (const file of files) {
    try {
      items.push({
        // The filename becomes the symbol id, because that is what the author
        // will type into `<use href="#…">`.
        id: (file.name.replace(/\.[^.]+$/, '') || 'icon').replace(/[^a-z0-9_-]+/gi, '-').toLowerCase(),
        image: await decodeFile(file),
      });
    } catch {
      skipped.push(file.name);
    }
  }
  if (items.length === 0) throw new Error('None of those files could be read as images.');

  const out = await engine.sprite(items, settingsFromState());
  download(out.svg, 'sprite.svg', MIME.svg);
  toast(
    `Sprite sheet saved — ${out.count} symbols` +
    (skipped.length ? `, ${skipped.length} skipped` : ''),
  );
}

/** Friendly names for the toast, where  reads badly. */
const EXPORT_LABEL: Partial<Record<ExportFormat | MultiExportFormat | ExtraExport, string>> = {
  react: 'React component', vue: 'Vue component',
  svelte: 'Svelte component', solid: 'Solid component',
  ico: 'Favicon', lqip: 'LQIP placeholder', blurhash: 'BlurHash',
  'palette-css': 'Palette CSS',
};

/** Raster re-encodes of the source, as menu ids. */
const RASTER_EXPORTS = ['raster-webp', 'raster-jpeg', 'raster-bmp', 'raster-tga', 'raster-pnm'] as const;
type RasterExport = typeof RASTER_EXPORTS[number];
// A real type guard:  reads fine but narrows nothing, so the union
// stayed wide and every later branch saw a format it could not handle.
const isRasterExport = (f: string): f is RasterExport =>
  (RASTER_EXPORTS as readonly string[]).includes(f);

type ExtraExport = 'png' | 'sprite' | 'animated' | RasterExport;

async function exportAs(format: ExportFormat | MultiExportFormat | ExtraExport): Promise<void> {
  const src = source;
  const r = lastResult;
  if (!src || !r) return;
  exporting = true;
  setBusy(true);
  // Name the step. Without this an export inherits the neutral "Working… 0%"
  // that `setBusy` starts every job with, which for the longest operations in
  // the app — sprite and animate trace every frame — is the least informative
  // thing the bar could say. The duration genuinely is unknown, so it names
  // itself and sits there rather than pretending to advance.
  setProgress(`Exporting ${String(format).replace(/^raster-/, '').toUpperCase()}`, 50);
  try {
    if (format === 'png') {
      // Rasterised from the SVG the user is looking at, through the same helper
      // the measurement loop uses — so the PNG is the measured output, not a
      // second rendering that might differ from it.
      const raster = await rasterizeSvg(r.svg, src.image.width * PNG_SCALE, src.image.height * PNG_SCALE);
      const blob = await canvasToBlob(rasterToCanvas(raster), 'image/png');
      download(new Uint8Array(await blob.arrayBuffer()), `${baseName()}@${PNG_SCALE}x.png`, MIME.png);
    } else if (isRasterExport(format)) {
      // Raster → raster: the source's own pixels, re-encoded. No tracing, no
      // vector step — this is the format matrix the library advertises, which
      // the studio previously could not express at all.
      const target = format.slice('raster-'.length) as RasterTarget;
      const bytes = await encodeRasterImage(src.image, target);
      const ext = target === 'pnm' ? 'ppm' : target;
      download(bytes, `${baseName()}.${ext}`, RASTER_MIME[target]);
      const delta = Math.round(((bytes.length - src.bytes) / src.bytes) * 100);
      toast(`${ext.toUpperCase()} saved — ${fmtBytes(bytes.length)} (${delta >= 0 ? '+' : ''}${delta}%)`);
      return;
    } else if (format === 'sprite') {
      await exportSprite();
      return;
    } else if (format === 'animated') {
      // Re-decode the original bytes: `createImageBitmap` gave us frame zero and
      // nothing else, so the frames have to come from `ImageDecoder`.
      const frames = await decodeFrames(src.file);
      if (!frames) {
        throw new Error(
          'That file is not an animation, or this browser cannot read its frames. ' +
          'Animated GIF and WebP work in Chrome, Edge and Firefox; Safari lacks the API.',
        );
      }
      const out = await engine.animate(frames, settingsFromState(), 10);
      download(out.svg, `${baseName()}.animated.svg`, MIME.svg);
      toast(`Animated SVG saved — ${out.frames} frames, one shared palette`);
      return;
    } else if (format === 'separations') {
      // One file per ink. Browsers rate-limit rapid programmatic downloads, so
      // they are spaced out — otherwise only the first two or three arrive and
      // the user silently gets an incomplete set of plates.
      const files = await engine.exportMany(src.image, settingsFromState(), 'separations');
      if (files.length === 0) throw new Error('This image produced no separable colour layers.');
      for (const [i, file] of files.entries()) {
        download(file.data, `${baseName()}-${file.name}`, file.mime);
        if (i < files.length - 1) await new Promise((r) => setTimeout(r, 350));
      }
      toast(`${files.length} colour separations saved`);
      return;
    } else if (format === 'diff') {
      // Compare the source against what the SVG *actually renders*, not against
      // the source again — the heatmap has to be able to disagree with us.
      const rendered = await rasterizeSvg(r.svg, src.image.width, src.image.height);
      const d = await engine.diff(src.image, rendered);
      const blob = await canvasToBlob(rasterToCanvas(d.image), 'image/png');
      download(new Uint8Array(await blob.arrayBuffer()), `${baseName()}.diff.png`, MIME.diff);
      toast(`Heatmap saved — ${(d.changedFraction * 100).toFixed(2)}% of pixels differ`);
      return;
    } else {
      const data = await engine.exportAs(src.image, settingsFromState(), format);
      download(data, `${baseName()}.${EXPORT_EXT[format]}`, MIME[format]);
    }
    toast(`${EXPORT_LABEL[format] ?? format.toUpperCase()} saved`);
  } catch (err) {
    // `exporting` is meant to keep a cancellation from ever reaching an export,
    // so this branch should be unreachable. It is here because the cost of
    // being wrong is a bare "That export failed. Superseded." — an error
    // message for something we did deliberately, which is worse than silence.
    if ((err as Error).message === 'Superseded.') return;
    showError(`That export failed. ${(err as Error).message}`);
  } finally {
    exporting = false;
    setBusy(false);
  }
}

/* ============================================================
   Theme
   ============================================================ */

const THEME_KEY = 'vecline-theme';
const themeBtn = byId('theme');
const SVGNS = 'http://www.w3.org/2000/svg';

function effectiveDark(): boolean {
  const attr = document.documentElement.getAttribute('data-theme');
  if (attr === 'dark') return true;
  if (attr === 'light') return false;
  return darkQuery.matches;
}

function paintThemeBtn(): void {
  const dark = effectiveDark();
  themeBtn.setAttribute('aria-label', dark ? 'Switch to light theme' : 'Switch to dark theme');

  const svg = document.createElementNS(SVGNS, 'svg');
  svg.setAttribute('width', '17');
  svg.setAttribute('height', '17');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '1.8');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  svg.setAttribute('aria-hidden', 'true');

  if (dark) {
    const moon = document.createElementNS(SVGNS, 'path');
    moon.setAttribute('d', 'M20.4 14.6A8.6 8.6 0 0 1 9.4 3.6a8.6 8.6 0 1 0 11 11z');
    svg.appendChild(moon);
  } else {
    const disc = document.createElementNS(SVGNS, 'circle');
    disc.setAttribute('cx', '12');
    disc.setAttribute('cy', '12');
    disc.setAttribute('r', '4.2');
    const rays = document.createElementNS(SVGNS, 'path');
    rays.setAttribute(
      'd',
      'M12 2.6v2.2M12 19.2v2.2M2.6 12h2.2M19.2 12h2.2M5.3 5.3l1.6 1.6'
      + 'M17.1 17.1l1.6 1.6M18.7 5.3l-1.6 1.6M6.9 17.1l-1.6 1.6',
    );
    svg.append(disc, rays);
  }
  themeBtn.replaceChildren(svg);
}

themeBtn.addEventListener('click', () => {
  const next = effectiveDark() ? 'light' : 'dark';
  document.documentElement.setAttribute('data-theme', next);
  try {
    localStorage.setItem(THEME_KEY, next);
  } catch {
    // Private-mode storage can refuse writes; the choice still holds this session.
  }
  paintThemeBtn();
});

// Only meaningful while no explicit choice is stored — then the button icon has
// to follow the system as it changes.
darkQuery.addEventListener('change', paintThemeBtn);

/* ============================================================
   Boot
   ============================================================ */

mountSamples();
paintThemeBtn();
paintControls();
paintCanvas();
paintMetrics();
paintSwatches();
paintBudget();
paintReport();
paintExports();

// Offline support is a bonus on top of a working app, never a precondition for
// one — every failure path here is silent by design.
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    try {
      void navigator.serviceWorker.register('./sw.js').catch(() => undefined);
    } catch {
      /* registration is unavailable in some embedded contexts */
    }
  });
}
