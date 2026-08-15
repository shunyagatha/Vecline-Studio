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
readout, split and side-by-side comparison, and export to SVG, PNG, DXF, EPS,
PDF and G-code — all produced in the tab.

**Not in the app, because a browser tab genuinely cannot:** Office ⇄ PDF
conversion, which drives your local LibreOffice through a child process. That
is the only capability in the whole library with no browser path at all. Use
the CLI or the MCP server for it.

**Not in the app yet, though nothing stops it:** SVG minification, colour
separations, smart crop, the CIEDE2000 diff heatmap, palette extraction to CSS
variables, framework-component codegen, BlurHash/LQIP placeholders, favicon
sets, sprite sheets, and decoding for TGA / PNM / ICO — formats no browser
reads, where the library's from-scratch decoders would strictly beat the
platform. All are pure and portable; they are simply not wired up.

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
