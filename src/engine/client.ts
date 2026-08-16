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

import { decodeFallback, decodeTgaFallback, encodeBmp, encodePnm, encodeTga } from 'vecline/core';
import type {
  ConvertResult, ConvertSettings, ExportFormat, MultiExportFormat, ExportedFile, Metrics, RasterImage,
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
  /** Called as the worker passes each real stage of a conversion. */
  onProgress: ((stage: string, pct: number) => void) | null = null;

  private readonly workerUrl: string | URL;

  constructor(workerUrl: string | URL) {
    this.workerUrl = workerUrl;
    this.worker = this.spawn();
  }

  private spawn(): Worker {
    const worker = new Worker(this.workerUrl, { type: 'module' });
    worker.onmessage = (e: MessageEvent<WorkerResponse>) => {
      const res = e.data;
      // Progress is a running commentary on a request that has not finished, so
      // it must not settle or clear the pending slot. Checked before the pending
      // lookup for that reason.
      if (res.ok && res.kind === 'progress') {
        this.onProgress?.(res.stage, res.pct);
        return;
      }
      const slot = this.pending.get(res.id);
      if (!slot) return;
      this.pending.delete(res.id);
      if (res.ok) slot.resolve(res as never);
      else slot.reject(new Error(res.error));
    };
    return worker;
  }

  /**
   * Abandon whatever the worker is doing, immediately.
   *
   * A Worker handles `onmessage` serially and the conversion inside it is one
   * synchronous call, so a superseded run cannot be asked to stop — it holds the
   * thread until it finishes, and the next request queues behind it. Dragging
   * the colour slider during a three-second photo trace therefore waited out
   * that whole trace before starting the one the user actually wanted, with the
   * bar sitting on "Decoding… 2%" the entire time.
   *
   * The run token already stops a stale result from painting, which is
   * correctness. This is latency, and terminating is the only thing that frees
   * the thread. The worker keeps no state between requests — every call carries
   * its own image and settings — so a replacement costs one module
   * instantiation and nothing else.
   */
  cancelAll(): void {
    for (const slot of this.pending.values()) slot.reject(new Error('Superseded.'));
    this.pending.clear();
    this.worker.terminate();
    this.worker = this.spawn();
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

  /** Produce a single-file export, client-side. */
  async exportAs(image: RasterImage, settings: ConvertSettings, format: ExportFormat): Promise<string | Uint8Array> {
    const r = await this.send<{ data: string | Uint8Array }>({ kind: 'export', image, settings, format });
    return r.data;
  }

  /** Produce an export that is a set of files — currently colour separations. */
  async exportMany(
    image: RasterImage,
    settings: ConvertSettings,
    format: MultiExportFormat,
  ): Promise<ExportedFile[]> {
    const r = await this.send<{ files: ExportedFile[] }>({ kind: 'export-many', image, settings, format });
    return r.files;
  }

  /**
   * A perceptual difference heatmap between the source and what the output
   * actually renders. The metrics say *how far off*; this says *where*.
   */
  async diff(source: RasterImage, rendered: RasterImage): Promise<{
    image: RasterImage; changedFraction: number; maxDeltaE: number;
  }> {
    return this.send<{ image: RasterImage; changedFraction: number; maxDeltaE: number }>({
      kind: 'diff', source, rendered,
    });
  }

  /** Trace many icons into one `<symbol>` sheet. */
  async sprite(
    items: { id: string; image: RasterImage }[],
    settings: ConvertSettings,
  ): Promise<{ svg: string; count: number }> {
    return this.send<{ svg: string; count: number }>({ kind: 'sprite', items, settings });
  }

  /** Trace many frames into one CSS-animated SVG. */
  async animate(
    frames: RasterImage[],
    settings: ConvertSettings,
    fps: number,
  ): Promise<{ svg: string; frames: number }> {
    return this.send<{ svg: string; frames: number }>({ kind: 'animate', frames, settings, fps });
  }

  /**
   * Convert, then render the result and score it — the full "measured" loop
   * that no competitor performs. Returns both halves so the UI can show the
   * output and the receipt together.
   */
  async convertAndMeasure(
    image: RasterImage,
    settings: ConvertSettings,
    /**
     * Called once the conversion is done and scoring is about to begin.
     *
     * Scoring is not free — it rasterises the SVG back and compares every pixel
     * — and it happens inside this method, so a caller cannot label it from
     * outside without labelling it too late.
     */
    onScoring?: () => void,
  ): Promise<{ result: ConvertResult; metrics: Metrics | null }> {
    const result = await this.convert(image, settings);
    onScoring?.();
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

/**
 * Decode an image file into the engine's pixel contract.
 *
 * The browser handles what it can — PNG, JPEG, WebP, AVIF, GIF and, on most
 * platforms, BMP. For the rest, vecline's own from-scratch decoders take over:
 * **TGA, PNM (PBM/PGM/PPM) and ICO**, none of which any browser will decode as
 * an ordinary image. This is the one category where the library strictly beats
 * the platform, so the studio would be worse than the CLI without it — those
 * files used to reach the generic "could not be read as an image".
 *
 * The browser is tried first rather than sniffing up front, because for the
 * common formats its decoder is native, hardware-accelerated, and colour-managed
 * in ways a pure-TypeScript path is not trying to match.
 */
export async function decodeFile(file: Blob): Promise<RasterImage> {
  return (await decodeFileDetailed(file)).image;
}

/**
 * As {@link decodeFile}, but also reports whether the *browser* could read the
 * file.
 *
 * That distinction matters for more than bookkeeping. The source pane shows the
 * original file in an `<img>`, which works only for formats the browser itself
 * decodes — so for a TGA, a PNM, or a PDF the "before" half of the comparison
 * silently rendered blank while the "after" half was fine. Nothing errored; the
 * image simply had `naturalWidth === 0`. Knowing which path produced the pixels
 * is what lets the caller substitute a preview it can actually draw.
 */
export async function decodeFileDetailed(
  file: Blob,
): Promise<{ image: RasterImage; browserDisplayable: boolean }> {
  try {
    const bitmap = await createImageBitmap(file);
    try {
      return { image: drawToImageData(bitmap, bitmap.width, bitmap.height), browserDisplayable: true };
    } finally {
      bitmap.close();
    }
  } catch (browserFailure) {
    const bytes = new Uint8Array(await file.arrayBuffer());
    // TGA carries no signature, so it is sniffed by structure separately.
    const decoded = decodeFallback(bytes) ?? decodeTgaFallback(bytes);
    if (!decoded) throw browserFailure;

    // An ICO may wrap a PNG rather than a DIB. The decoder hands those bytes
    // back instead of reimplementing PNG, so they go to the browser after all.
    if (decoded.delegate) {
      const bitmap = await createImageBitmap(
        new Blob([decoded.delegate.bytes as BlobPart], { type: `image/${decoded.delegate.format}` }),
      );
      try {
        // The payload is displayable, but the *container* the user handed us is
        // not — an `<img src="…ico">` is not reliably rendered — so this still
        // counts as needing a substituted preview.
        return { image: drawToImageData(bitmap, bitmap.width, bitmap.height), browserDisplayable: false };
      } finally {
        bitmap.close();
      }
    }
    if (!decoded.image) throw browserFailure;
    const { width, height, data } = decoded.image;
    return { image: { width, height, data }, browserDisplayable: false };
  }
}

/**
 * Pull every frame out of an animated image.
 *
 * `createImageBitmap` only ever yields frame 0, so this goes through WebCodecs'
 * `ImageDecoder`, which exposes the frame count and lets each be selected. That
 * is a real portability cost — Chromium and Firefox have it, **Safari does
 * not** — so the caller is told plainly rather than being handed a silent
 * one-frame result, which is exactly the failure the library's own APNG bug
 * taught us to avoid.
 *
 * Returns `null` when the format is not animated or the API is unavailable.
 */
export async function decodeFrames(file: Blob): Promise<RasterImage[] | null> {
  const Decoder = (globalThis as { ImageDecoder?: unknown }).ImageDecoder as
    | (new (init: { data: ArrayBuffer; type: string }) => {
        completed: Promise<void>;
        tracks: { selectedTrack?: { frameCount: number } };
        decode: (o: { frameIndex: number }) => Promise<{ image: VideoFrame }>;
        close: () => void;
      })
    | undefined;
  if (!Decoder) return null;

  const buffer = await file.arrayBuffer();
  const decoder = new Decoder({ data: buffer, type: file.type || 'image/gif' });
  try {
    await decoder.completed;
    const count = decoder.tracks.selectedTrack?.frameCount ?? 1;
    if (count < 2) return null;

    const frames: RasterImage[] = [];
    for (let i = 0; i < count; i++) {
      const { image } = await decoder.decode({ frameIndex: i });
      try {
        frames.push(drawToImageData(image as unknown as CanvasImageSource, image.displayWidth, image.displayHeight));
      } finally {
        image.close();
      }
    }
    return frames;
  } catch {
    return null;
  } finally {
    decoder.close();
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

/**
 * Raster → raster, in the tab.
 *
 * The library advertises a square 11×11 format matrix, and the studio could
 * previously express none of it — it converted *into* vector and out to PNG,
 * and that was all. So "121 conversions" was a claim about the CLI being made
 * on behalf of the whole product.
 *
 * Two engines, chosen per format and for a reason:
 *
 * - **The browser** encodes PNG, JPEG and WebP. Its encoders are native and
 *   hardware-accelerated; reimplementing them in TypeScript would be slower and
 *   worse.
 * - **`vecline/core`** encodes BMP, PNM and TGA, which no browser will write at
 *   all. These are the from-scratch codecs, and this is the case they exist for.
 *
 * AVIF, TIFF and GIF are deliberately absent rather than faked: browsers decode
 * all three and encode none of them, and there is no `ImageEncoder` to reach
 * for. Offering a button that silently produced a PNG with the wrong extension
 * would be worse than not offering it.
 */
export type RasterTarget = 'png' | 'jpeg' | 'webp' | 'bmp' | 'pnm' | 'tga';

const BROWSER_ENCODED: Record<string, string> = {
  png: 'image/png',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
};

export const RASTER_MIME: Record<RasterTarget, string> = {
  png: 'image/png',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  bmp: 'image/bmp',
  pnm: 'image/x-portable-pixmap',
  tga: 'image/x-targa',
};

export async function encodeRasterImage(
  image: RasterImage,
  target: RasterTarget,
  quality = 0.92,
): Promise<Uint8Array> {
  const mime = BROWSER_ENCODED[target];
  if (mime) {
    const canvas = document.createElement('canvas');
    canvas.width = image.width;
    canvas.height = image.height;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('This browser did not provide a 2D canvas context.');
    const buffer = ctx.createImageData(image.width, image.height);
    buffer.data.set(image.data);
    ctx.putImageData(buffer, 0, 0);

    const blob = await new Promise<Blob | null>((resolve) =>
      canvas.toBlob(resolve, mime, quality));
    // `toBlob` falls back to PNG for a type it cannot encode rather than
    // failing, so the result is checked instead of trusted — a "WebP" that is
    // actually a PNG is exactly the silent wrongness this app exists to avoid.
    if (!blob) throw new Error(`This browser could not encode ${target.toUpperCase()}.`);
    if (blob.type !== mime) {
      throw new Error(`This browser does not support encoding ${target.toUpperCase()}.`);
    }
    return new Uint8Array(await blob.arrayBuffer());
  }

  const source = image as unknown as Parameters<typeof encodeBmp>[0];
  if (target === 'bmp') return encodeBmp(source);
  if (target === 'pnm') return encodePnm(source, { variant: 'P6' });
  return encodeTga(source, { rle: true });
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
  // Components and placeholders are source text; served as plain text so a
  // browser shows them rather than trying to run anything.
  react: 'text/plain',
  vue: 'text/plain',
  svelte: 'text/plain',
  solid: 'text/plain',
  ico: 'image/x-icon',
  lqip: 'image/svg+xml',
  blurhash: 'text/plain',
  'palette-css': 'text/css',
  diff: 'image/png',
};

/** File extension for each export. Not always the format name. */
export const EXPORT_EXT: Record<ExportFormat, string> = {
  svg: 'svg', dxf: 'dxf', eps: 'eps', pdf: 'pdf', gcode: 'gcode',
  react: 'tsx', solid: 'tsx', vue: 'vue', svelte: 'svelte',
  ico: 'ico', lqip: 'lqip.svg', blurhash: 'blurhash.txt',
  'palette-css': 'palette.css', diff: 'diff.png',
};
