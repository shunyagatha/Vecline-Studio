/**
 * The main-thread half of the engine.
 *
 * Three jobs the worker cannot do:
 *
 * 1. **Decode** — the browser already has excellent PNG/JPEG/WebP/GIF decoders,
 *    so we hand a `File` to `createImageBitmap` rather than shipping codecs.
 * 2. **Render the SVG back to pixels** — the measurement loop needs the *actual*
 *    rendered output, and only the browser can rasterise SVG. This is what makes
 *    the studio's metrics real rather than estimated.
 * 3. **Own the worker** and keep the UI responsive.
 *
 * Nothing here touches the network. Every byte stays in the tab.
 */

import type {
  ConvertResult, ConvertSettings, ExportFormat, Metrics, RasterImage,
  WorkerRequest, WorkerResponse,
} from './types.js';

/**
 * `Omit` collapses a union to its shared keys, so `Omit<WorkerRequest, 'id'>`
 * would forget every payload field. Distributing over the union first keeps each
 * variant intact, which is what makes `send()` type-check its own callers.
 */
type RequestBody = WorkerRequest extends infer T
  ? T extends WorkerRequest ? Omit<T, 'id'> : never
  : never;

export class Engine {
  private worker: Worker;
  private seq = 0;
  private pending = new Map<number, { resolve: (v: never) => void; reject: (e: Error) => void }>();

  constructor(workerUrl: string | URL) {
    this.worker = new Worker(workerUrl, { type: 'module' });
    this.worker.onmessage = (e: MessageEvent<WorkerResponse>) => {
      const res = e.data;
      const slot = this.pending.get(res.id);
      if (!slot) return;
      this.pending.delete(res.id);
      if (res.ok) slot.resolve(res as never);
      else slot.reject(new Error(res.error));
    };
  }

  private send<T>(req: RequestBody): Promise<T> {
    const id = ++this.seq;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as never, reject });
      this.worker.postMessage({ ...req, id } as WorkerRequest);
    });
  }

  /** Convert an image. Runs off-thread; the UI stays interactive. */
  async convert(image: RasterImage, settings: ConvertSettings): Promise<ConvertResult> {
    const r = await this.send<{ result: ConvertResult }>({ kind: 'convert', image, settings });
    return r.result;
  }

  /** Score two same-sized rasters. */
  async measure(a: RasterImage, b: RasterImage): Promise<Metrics> {
    const r = await this.send<{ metrics: Metrics }>({ kind: 'measure', a, b });
    return r.metrics;
  }

  /** Produce a non-SVG vector export (DXF/EPS/PDF/G-code), client-side. */
  async exportAs(image: RasterImage, settings: ConvertSettings, format: ExportFormat): Promise<string | Uint8Array> {
    const r = await this.send<{ data: string | Uint8Array }>({ kind: 'export', image, settings, format });
    return r.data;
  }

  /**
   * Convert, then render the result and score it — the full "measured" loop
   * that no competitor performs. Returns both halves so the UI can show the
   * output and the receipt together.
   */
  async convertAndMeasure(
    image: RasterImage,
    settings: ConvertSettings,
  ): Promise<{ result: ConvertResult; metrics: Metrics | null }> {
    const result = await this.convert(image, settings);
    try {
      const rendered = await rasterizeSvg(result.svg, image.width, image.height);
      const metrics = await this.measure(image, rendered);
      return { result, metrics };
    } catch {
      // A render failure must not lose the conversion; report it as unmeasured
      // rather than inventing a number.
      return { result, metrics: null };
    }
  }

  dispose(): void {
    this.worker.terminate();
    this.pending.clear();
  }
}

/** Decode any browser-supported image file into the engine's pixel contract. */
export async function decodeFile(file: Blob): Promise<RasterImage> {
  const bitmap = await createImageBitmap(file);
  try {
    return drawToImageData(bitmap, bitmap.width, bitmap.height);
  } finally {
    bitmap.close();
  }
}

/**
 * Rasterise an SVG string at a given size, via a blob URL and an `<img>`.
 *
 * The SVG is loaded as an image rather than injected into the document, so it
 * is rendered in an isolated, script-free context — safe even though the input
 * is machine-generated.
 */
export async function rasterizeSvg(svg: string, width: number, height: number): Promise<RasterImage> {
  const url = URL.createObjectURL(new Blob([svg], { type: 'image/svg+xml' }));
  try {
    const img = new Image();
    img.decoding = 'sync';
    await new Promise<void>((resolve, reject) => {
      img.onload = () => resolve();
      img.onerror = () => reject(new Error('The SVG could not be rendered for measurement.'));
      img.src = url;
    });
    return drawToImageData(img, width, height);
  } finally {
    URL.revokeObjectURL(url);
  }
}

function drawToImageData(
  source: CanvasImageSource,
  width: number,
  height: number,
): RasterImage {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) throw new Error('This browser did not provide a 2D canvas context.');
  ctx.clearRect(0, 0, width, height);
  ctx.drawImage(source, 0, 0, width, height);
  const { data } = ctx.getImageData(0, 0, width, height);
  return { width, height, data };
}

/** Hand a produced file to the user. Everything was generated locally. */
export function download(data: string | Uint8Array, filename: string, mime: string): void {
  const blob = new Blob([data as BlobPart], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  // Give the click a tick to start before revoking.
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export const MIME: Record<ExportFormat | 'png', string> = {
  svg: 'image/svg+xml',
  dxf: 'application/dxf',
  eps: 'application/postscript',
  pdf: 'application/pdf',
  gcode: 'text/plain',
  png: 'image/png',
};
