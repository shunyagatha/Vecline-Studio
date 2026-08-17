/**
 * mupdf, off the main thread.
 *
 * Parsing a PDF and rasterising a page are both long synchronous calls into a
 * WebAssembly module. On the main thread that is not slow, it is *stopped*: no
 * repaint, no scroll, and the progress bar the rest of this app works hard to
 * keep honest sits frozen at whatever it last said. A large or complex page can
 * hold the tab for seconds.
 *
 * This worker owns the document. The page raster crosses back as a transferable
 * ArrayBuffer, so a multi-megabyte page costs a pointer hand-off rather than a
 * copy.
 *
 * It is deliberately a *second* worker rather than a new message kind on the
 * conversion one. The engine worker is lean and is busy tracing; loading a
 * 10 MB wasm blob into it would make every visitor who converts a PNG pay for a
 * PDF engine they never touch, which is the exact cost the dynamic import was
 * added to avoid.
 */
import type { RasterImage } from './types.js';

interface MupdfPixmap {
  getWidth(): number;
  getHeight(): number;
  getNumberOfComponents(): number;
  getPixels(): Uint8Array | Uint8ClampedArray;
  destroy?(): void;
}

interface MupdfPage {
  toPixmap(matrix: unknown, colorspace: unknown, alpha: boolean): MupdfPixmap;
  destroy?(): void;
}

interface MupdfDocument {
  countPages(): number;
  loadPage(index: number): MupdfPage;
  destroy?(): void;
}

interface MupdfModule {
  Document: { openDocument(data: Uint8Array, mime: string): MupdfDocument };
  Matrix: { scale(x: number, y: number): unknown };
  ColorSpace: { DeviceRGB: unknown };
}

type Request =
  | { id: number; kind: 'open'; bytes: Uint8Array }
  | { id: number; kind: 'render'; index: number; dpi: number }
  | { id: number; kind: 'close' };

let modulePromise: Promise<MupdfModule> | null = null;
let doc: MupdfDocument | null = null;

/**
 * Load mupdf once, on demand.
 *
 * The promise is cached rather than the module, so two PDFs dropped in quick
 * succession share a single download instead of racing two.
 */
function loadMupdf(): Promise<MupdfModule> {
  modulePromise ??= import('mupdf').then((m) => m as unknown as MupdfModule);
  return modulePromise;
}

/**
 * mupdf hands back tightly packed components; the engine's contract is RGBA8.
 *
 * Kept identical to the version this replaces, including the alpha default, so
 * a page rendered here is the same pixels it was before the move.
 */
function pixmapToRaster(pixmap: MupdfPixmap): RasterImage {
  const width = pixmap.getWidth();
  const height = pixmap.getHeight();
  const src = pixmap.getPixels();
  const components = pixmap.getNumberOfComponents();
  const data = new Uint8ClampedArray(width * height * 4);

  if (components === 4) {
    data.set(src.subarray(0, data.length));
  } else if (components === 3) {
    for (let i = 0, s = 0; i < data.length; i += 4, s += 3) {
      data[i] = src[s] as number;
      data[i + 1] = src[s + 1] as number;
      data[i + 2] = src[s + 2] as number;
      data[i + 3] = 255;
    }
  } else {
    // Refusing beats guessing: misreading the stride would shear the image
    // diagonally, which looks like a rendering bug rather than a wrong
    // assumption. Carried over verbatim from the main-thread version.
    throw new Error(`This PDF page rendered with ${components} colour components, which is not supported.`);
  }
  return { width, height, data };
}

self.onmessage = async (e: MessageEvent<Request>): Promise<void> => {
  const req = e.data;
  const post = (msg: unknown, transfer?: Transferable[]): void =>
    (self as unknown as { postMessage(m: unknown, t?: Transferable[]): void }).postMessage(msg, transfer);

  try {
    if (req.kind === 'open') {
      const mupdf = await loadMupdf();
      doc?.destroy?.();
      doc = mupdf.Document.openDocument(req.bytes, 'application/pdf');
      post({ id: req.id, ok: true, count: doc.countPages() });
      return;
    }

    if (req.kind === 'render') {
      if (!doc) throw new Error('No PDF is open.');
      const mupdf = await loadMupdf();
      // PDF user space is 72 units to the inch, so the scale is dpi/72 — the
      // same convention the CLI's `--dpi` uses, which keeps a page rendered
      // here identical to the same page rendered there.
      const scale = req.dpi / 72;
      const count = doc.countPages();
      const page = doc.loadPage(Math.max(0, Math.min(count - 1, req.index)));
      let pixmap: MupdfPixmap | null = null;
      try {
        pixmap = page.toPixmap(mupdf.Matrix.scale(scale, scale), mupdf.ColorSpace.DeviceRGB, true);
        const image = pixmapToRaster(pixmap);
        // Transferred, not copied: a 300 dpi A4 page is ~35 MB.
        post({ id: req.id, ok: true, image }, [image.data.buffer]);
      } finally {
        pixmap?.destroy?.();
        page.destroy?.();
      }
      return;
    }

    doc?.destroy?.();
    doc = null;
    post({ id: req.id, ok: true });
  } catch (err) {
    post({ id: req.id, ok: false, error: err instanceof Error ? err.message : String(err) });
  }
};
