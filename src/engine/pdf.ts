/**
 * PDF rendering in the browser, off the main thread.
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
 * The *second* cost was time, and this file used to pay it in the worst
 * possible place. Parsing a document and rasterising a page are long
 * synchronous calls into WebAssembly, and on the main thread that is not slow,
 * it is stopped: no repaint, no scroll, and the progress bar the rest of this
 * app works to keep honest frozen at whatever it last said. Both now happen in
 * `pdf-worker.ts`, so this file is a client and `render` is asynchronous —
 * the one shape change, and the reason it is worth it.
 *
 * Nothing here reaches the network: the WASM is served from our own origin
 * alongside the app, and the document is decoded in the tab like every other
 * format.
 */

import type { RasterImage } from './types.js';

/** Cheap signature check — `%PDF-`. Extensions lie; the first five bytes do not. */
export function isPdf(bytes: Uint8Array): boolean {
  return bytes.length > 4
    && bytes[0] === 0x25 && bytes[1] === 0x50
    && bytes[2] === 0x44 && bytes[3] === 0x46 && bytes[4] === 0x2d;
}

export interface PdfPages {
  count: number;
  /**
   * Render one page (0-based) at the given DPI.
   *
   * Asynchronous because the work happens on another thread. That is the whole
   * point: a caller that awaits keeps the tab alive while a page rasterises.
   */
  render(index: number, dpi?: number): Promise<RasterImage>;
  close(): void;
}

interface WorkerReply {
  id: number;
  ok: boolean;
  error?: string;
  count?: number;
  image?: RasterImage;
}

/**
 * Open a PDF and expose its pages as renderable rasters.
 *
 * Pages are rendered lazily — a 400-page document costs one parse, not 400
 * rasterisations, and the studio only ever asks for the page on screen.
 *
 * One worker per open document, terminated by `close()`. A PDF is opened when
 * a file is dropped and closed when the next one replaces it, so the lifetime
 * is short and explicit; pooling would add state to save a spawn that happens
 * once per document.
 */
export async function openPdf(bytes: Uint8Array): Promise<PdfPages> {
  const worker = new Worker(new URL('./pdf-worker.js', import.meta.url), { type: 'module' });
  let seq = 0;
  const pending = new Map<number, { resolve: (v: WorkerReply) => void; reject: (e: Error) => void }>();

  worker.onmessage = (e: MessageEvent<WorkerReply>): void => {
    const slot = pending.get(e.data.id);
    if (!slot) return;
    pending.delete(e.data.id);
    if (e.data.ok) slot.resolve(e.data);
    else slot.reject(new Error(e.data.error ?? 'The PDF engine failed.'));
  };
  // A worker that dies mid-parse must not leave the caller awaiting forever.
  worker.onerror = (): void => {
    for (const slot of pending.values()) slot.reject(new Error('The PDF engine stopped unexpectedly.'));
    pending.clear();
  };

  const send = (body: Record<string, unknown>): Promise<WorkerReply> => {
    const id = ++seq;
    return new Promise<WorkerReply>((resolve, reject) => {
      pending.set(id, { resolve, reject });
      worker.postMessage({ ...body, id });
    });
  };

  let opened: WorkerReply;
  try {
    opened = await send({ kind: 'open', bytes });
  } catch (err) {
    worker.terminate();
    throw err;
  }

  return {
    count: opened.count ?? 0,
    async render(index: number, dpi = 150): Promise<RasterImage> {
      const reply = await send({ kind: 'render', index, dpi });
      if (!reply.image) throw new Error('The PDF engine returned no image.');
      return reply.image;
    },
    close(): void {
      // Terminating is enough — the document lives in the worker and goes with
      // it. The message is sent first so mupdf can free its own handles rather
      // than being cut off mid-destructor.
      void send({ kind: 'close' }).catch(() => undefined);
      worker.terminate();
      pending.clear();
    },
  };
}
