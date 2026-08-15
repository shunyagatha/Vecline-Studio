/**
 * The contract between the UI and the engine.
 *
 * Deliberately free of any DOM or visual-design assumptions: whichever visual
 * direction the studio ships, it talks to the engine through exactly these
 * shapes. That keeps the heavy, testable half stable while the surface changes.
 */

/** Straight (non-premultiplied) RGBA8 — byte-identical to `ImageData`. */
export interface RasterImage {
  width: number;
  height: number;
  data: Uint8ClampedArray;
}

export type Mode = 'auto' | 'lossless' | 'trace' | 'centerline';

export type Preset =
  | 'auto' | 'logo' | 'lineart' | 'poster' | 'photo' | 'detailed' | 'pixelart';

/** Everything the control rail can set. */
export interface ConvertSettings {
  mode: Mode;
  preset: Preset;
  colors: number;
  /** Curve-fit tolerance in pixels; lower is more faithful and heavier. */
  detail: number;
  gradients: boolean;
  primitives: boolean;
  removeBackground: boolean;
  /** Optional size budget, in bytes. */
  maxBytes?: number;
  /** Optional complexity budget, in anchor points. */
  maxNodes?: number;
  /**
   * Render-preserving minification of the SVG. Default on; ignored for lossless
   * output, where rounding coordinates would forfeit the bit-exactness that is
   * the entire point of that mode.
   */
  minify?: boolean;
  /**
   * Content-aware crop to this aspect ratio as [width, height], or absent for
   * the whole frame. The subject is kept by scoring edge energy and colour
   * saturation — a naive centre crop drops a subject that sits off to one side.
   */
  cropAspect?: [number, number];
  /**
   * Finished width of the part in {@link dxfUnits}. Given this, DXF export
   * declares its own scale instead of emitting bare pixels — the difference
   * between a drawing and something a laser can cut at a known size.
   */
  physicalWidth?: number;
  /** Unit for {@link physicalWidth}. Default mm. */
  dxfUnits?: 'mm' | 'cm' | 'in' | 'm';
}

export const DEFAULT_SETTINGS: ConvertSettings = {
  mode: 'auto',
  preset: 'auto',
  colors: 16,
  detail: 0.4,
  gradients: false,
  primitives: false,
  removeBackground: false,
};

/** What the engine produces for one conversion. */
export interface ConvertResult {
  svg: string;
  /** Which strategy actually ran (auto resolves to one of these). */
  mode: Exclude<Mode, 'auto'>;
  shapes: number;
  colors: number;
  /** True when the output is provably a bit-exact representation. */
  lossless: boolean;
  bytes: number;
  nodes: number;
  elapsedMs: number;
  notes: string[];
}

/** Measured fidelity of a result against its source — the differentiator. */
export interface Metrics {
  ssim: number;
  psnr: number;
  /** Mean CIEDE2000. */
  deltaE: number;
  /** True when every pixel matched exactly. */
  lossless: boolean;
}

/** Messages the worker understands. */
export type WorkerRequest =
  | { id: number; kind: 'convert'; image: RasterImage; settings: ConvertSettings }
  | { id: number; kind: 'measure'; a: RasterImage; b: RasterImage }
  | { id: number; kind: 'export'; image: RasterImage; settings: ConvertSettings; format: ExportFormat }
  | { id: number; kind: 'export-many'; image: RasterImage; settings: ConvertSettings; format: MultiExportFormat }
  // `rendered` is the SVG rasterised back to pixels — the diff heatmap compares
  // the source against what the output actually draws, not against itself.
  | { id: number; kind: 'diff'; source: RasterImage; rendered: RasterImage }
  // Many images in, one file out. Kept separate from 'export' because the whole
  // studio is otherwise built around a single source image.
  | { id: number; kind: 'sprite'; items: { id: string; image: RasterImage }[]; settings: ConvertSettings }
  | { id: number; kind: 'animate'; frames: RasterImage[]; settings: ConvertSettings; fps: number };

/**
 * Everything the studio can hand back as a file.
 *
 * The first five are the original vector/machine targets. The rest were already
 * sitting in `vecline/core`, fully portable, and simply never wired up — an
 * audit comparing the library surface against this app found them missing, not
 * impossible. Each produces exactly one file except `separations`, which is a
 * set by definition.
 */
export type ExportFormat =
  | 'svg' | 'dxf' | 'eps' | 'pdf' | 'gcode'
  /** A typed, prop-forwarding component for the named framework. */
  | 'react' | 'vue' | 'svelte' | 'solid'
  /** A multi-size .ico — the favicon a browser actually wants. */
  | 'ico'
  /** A tiny blur-up placeholder SVG (a zero-binary SQIP successor). */
  | 'lqip'
  /** A BlurHash string, for lazy-loading pipelines. */
  | 'blurhash'
  /** The source's perceptual palette as CSS custom properties. */
  | 'palette-css'
  /** A CIEDE2000 heatmap PNG showing *where* the conversion differs. */
  | 'diff';

/** Exports that return a set of files rather than one. */
export type MultiExportFormat = 'separations';

/** One file in a multi-file export. */
export interface ExportedFile {
  name: string;
  data: string | Uint8Array;
  mime: string;
}

export type WorkerResponse =
  | { id: number; ok: true; kind: 'convert'; result: ConvertResult }
  | { id: number; ok: true; kind: 'measure'; metrics: Metrics }
  | { id: number; ok: true; kind: 'export'; data: string | Uint8Array; format: ExportFormat }
  | { id: number; ok: true; kind: 'export-many'; files: ExportedFile[] }
  | { id: number; ok: true; kind: 'diff'; image: RasterImage; changedFraction: number; maxDeltaE: number }
  | { id: number; ok: true; kind: 'sprite'; svg: string; count: number }
  | { id: number; ok: true; kind: 'animate'; svg: string; frames: number }
  | { id: number; ok: false; error: string };
