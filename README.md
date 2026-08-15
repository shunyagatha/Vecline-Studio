# Vecline Studio

**→ [vecline.xyz](https://vecline.xyz)**

The free, private, in-browser image → vector studio. It is the web platform for
[vecline](https://www.npmjs.com/package/vecline); the library lives in its own
repository and is consumed here as a dependency.

**Everything runs in the tab.** Images are decoded by the browser, converted by
`vecline/core` in a Web Worker, and rendered back to pixels for scoring — there
is no backend, no upload, and no account. Once cached it works fully offline,
which is the strongest available proof of that claim.

## What makes it different

Every rival either charges per image, uploads your artwork to a cloud, or both.
Vecline Studio is free and unlimited, keeps your work on your machine, and — the
part nobody else does — **measures its own output**: it renders the SVG it just
produced and reports the real SSIM, PSNR and CIEDE2000 against your source, plus
a bit-exact badge when the result is provably perfect.

## What it does, and what it does not

The studio is the image → vector surface. It is **not** the whole library, and
the gap is worth stating plainly rather than letting anyone discover it.

**In the app:** Bézier tracing and pixel-exact lossless conversion (with `auto`
routing between them), centerline tracing, background removal, presets, live
SSIM / PSNR / CIEDE2000 against the source, a bit-exact badge, a size-budget
readout, split and side-by-side comparison, and render-preserving minification
on every SVG it produces.

**Input formats.** Whatever the browser decodes — PNG, JPEG, WebP, AVIF, GIF,
usually BMP — plus **TGA, PNM (PBM/PGM/PPM) and ICO**, which no browser reads
and which vecline decodes itself. The browser is tried first, because for the
common formats its decoder is native and colour-managed.

**Exports, all generated in the tab:**

| | |
|---|---|
| Vector & machine | SVG, PNG, DXF, EPS, PDF, G-code — DXF can declare a physical cut size |
| Raster → raster | WebP, JPEG (browser encoders) and BMP, TGA, PPM (vecline's own, which no browser writes) |
| Web | React / Vue / Svelte / Solid component, favicon `.ico`, LQIP placeholder, BlurHash, palette as CSS custom properties |
| Makers & checking | Colour separations (one SVG per ink — screen print, vinyl, DTF), CIEDE2000 difference heatmap |
| Many images | `<symbol>` sprite sheet (rasters traced on the way in), animated GIF/WebP → one CSS-animated SVG |

**Content-aware crop** is in the control rail: pick an aspect and the frame is
chosen by edge energy and colour saturation, so a subject sitting off to one
side survives a crop that centring would cut away.

**PDFs work.** Drop one and page 1 renders at 150 DPI — the same default
`vecline doc` uses — then traces like any other image. The engine is mupdf
compiled to WebAssembly, imported *dynamically*, so it is downloaded the first
time you open a PDF and never by anyone who only converts images.

**Office documents work too, if you run the CLI.** A tab has no office engine,
and the two usual ways to give it one both cost something this product is built
on: a ~300 MB LibreOffice-in-WASM destroys instant load, and uploading the file
destroys the privacy claim. So neither. Run `vecline serve` and the studio hands
the document to **your** machine:

```bash
npm install -g vecline && vecline serve
```

Every link stays local — `.docx` → your LibreOffice → PDF → mupdf in this tab →
pixels → traced SVG. When the bridge is not running, the studio says what to
install rather than failing at the moment you try to convert.

**One browser caveat, stated rather than hidden:** extracting the frames of an
animated GIF or WebP needs WebCodecs' `ImageDecoder`, which Chrome, Edge and
Firefox have and **Safari does not**. There, the animated-SVG export reports
that plainly instead of silently handing back a one-frame file — the exact
failure mode the library's own APNG bug taught us to avoid.

Two honest caveats about what *is* here:

- **The size budget reports; it does not enforce.** The solver that relaxes,
  re-renders, re-measures and bisects back lives in the library's Node entry
  point, not in `vecline/core`, so the studio can only tell you whether the
  result fits the cap you set. The UI says exactly that, and should keep saying
  only that until the solver is ported.
- **The presets are the studio's own**, not the library's. The Studio's `poster`
  is 6 colours where the CLI's is 32. `vecline --preset poster` and the Poster
  button are deliberately different conversions, tuned for different contexts —
  interactive feedback here, best measured result there.

## Layout

```
src/engine/   the design-independent half: worker, client, types
src/app/      the UI shell
public/       index.html, manifest, service worker, icons
scripts/      build (esbuild) and a local dev server
```

`src/engine` deliberately knows nothing about the visual design: the UI talks to
it through the shapes in `engine/types.ts`, so the look can change without
touching the engine.

## Develop

```bash
npm install
npm start          # build + serve on http://localhost:5173
npm run dev        # rebuild on change
npm run typecheck
```

A real origin is required (a worker and a service worker will not run from
`file://`), which is all `npm run serve` provides.

## Licence

**Source-available, not open source.** The code is public so anyone can verify
the claim this product rests on — that your images are converted in your browser
and never uploaded. You may read it, and build and run it locally to audit it.
You may not redistribute it, host it for others, or use it commercially. See
[LICENSE](LICENSE).

The **engine is different**: [`vecline`](https://github.com/shunyagatha/Vecline)
is MIT and always will be. If you want to build your own tool on this
technology, use the library — that is precisely what it is for.
