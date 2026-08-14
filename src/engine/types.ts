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
  | { id: number; kind: 'export'; image: RasterImage; settings: ConvertSettings; format: ExportFormat };

export type ExportFormat = 'svg' | 'dxf' | 'eps' | 'pdf' | 'gcode';

export type WorkerResponse =
  | { id: number; ok: true; kind: 'convert'; result: ConvertResult }
  | { id: number; ok: true; kind: 'measure'; metrics: Metrics }
  | { id: number; ok: true; kind: 'export'; data: string | Uint8Array; format: ExportFormat }
  | { id: number; ok: false; error: string };
