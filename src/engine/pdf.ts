/**
 * PDF rendering in the browser.
 *
 * This was written off as impossible here for longer than it should have been:
 * PDF support in the library goes through `mupdf`, and "needs mupdf" got filed
 * next to "needs LibreOffice". They are not the same kind of dependency at all.
 * LibreOffice is a native binary driven through a child process, which a tab
 * genuinely cannot do. **mupdf is pure WebAssembly** — 9.9 MB raw, 3.4 MB
 * brotli-compressed, shipping its own `.br` artefacts, which is what a package
 * built for browser delivery looks like. There was never a technical barrier,
 * only an unexamined assumption.
 *
 * The real cost is weight, and weight is a scheduling problem rather than a
 * capability one. The module is imported **dynamically, on first PDF**, so a
 * user who only ever converts PNGs never downloads a byte of it and the app's
 * instant-load and offline properties are untouched.
 *
 * Nothing here reaches the network: the WASM is served from our own origin
 * alongside the app, and the document is decoded in the tab like every other
 * format.
 */

import type { RasterImage } from './types.js';

/** The slice of mupdf's API this file uses, so the dynamic import stays typed. */
interface MupdfModule {
  Document: {
    openDocument(data: Uint8Array, magic: string): MupdfDocument;
  };
  Matrix: { scale(x: number, y: number): unknown };
  ColorSpace: { DeviceRGB: unknown };
}

interface MupdfDocument {
  countPages(): number;
  loadPage(n: number): MupdfPage;
  destroy?(): void;
}

interface MupdfPage {
  toPixmap(matrix: unknown, colorspace: unknown, alpha: boolean): MupdfPixmap;
  destroy?(): void;
}

interface MupdfPixmap {
  getWidth(): number;
  getHeight(): number;
  getPixels(): Uint8Array;
  getNumberOfComponents(): number;
  destroy?(): void;
}

let modulePromise: Promise<MupdfModule> | null = null;

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

/** Cheap signature check — `%PDF-`. Extensions lie; the first five bytes do not. */
export function isPdf(bytes: Uint8Array): boolean {
  return bytes.length > 4
    && bytes[0] === 0x25 && bytes[1] === 0x50
    && bytes[2] === 0x44 && bytes[3] === 0x46 && bytes[4] === 0x2d;
}

export interface PdfPages {
  count: number;
  /** Render one page (0-based) at the given DPI. */
  render(index: number, dpi?: number): RasterImage;
  close(): void;
}

/**
 * Open a PDF and expose its pages as renderable rasters.
 *
 * Pages are rendered lazily — a 400-page document costs one parse, not 400
 * rasterisations, and the studio only ever asks for the page on screen.
 */
export async function openPdf(bytes: Uint8Array): Promise<PdfPages> {
  const mupdf = await loadMupdf();
  const doc = mupdf.Document.openDocument(bytes, 'application/pdf');
  const count = doc.countPages();

  return {
    count,
    render(index: number, dpi = 150): RasterImage {
      // PDF user space is 72 units to the inch, so the scale is dpi/72 — the
      // same convention the CLI's `--dpi` uses, which keeps a page rendered
      // here identical to the same page rendered there.
      const scale = dpi / 72;
      const page = doc.loadPage(Math.max(0, Math.min(count - 1, index)));
      let pixmap: MupdfPixmap | null = null;
      try {
        pixmap = page.toPixmap(mupdf.Matrix.scale(scale, scale), mupdf.ColorSpace.DeviceRGB, true);
        return pixmapToRaster(pixmap);
      } finally {
        pixmap?.destroy?.();
        page.destroy?.();
      }
    },
    close(): void {
      doc.destroy?.();
    },
  };
}

/**
 * mupdf hands back tightly packed components; the engine's contract is RGBA8.
 *
 * With `alpha: true` on a DeviceRGB pixmap that is already 4 components, so the
 * common path is a straight copy. The 3-component branch exists because a
 * pixmap built without alpha is still perfectly valid input, and silently
 * misreading its stride would shear the image diagonally — a failure that looks
 * like a rendering bug rather than a wrong assumption.
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
    throw new Error(`This PDF page rendered with ${components} colour components, which is not supported.`);
  }
  return { width, height, data };
}
