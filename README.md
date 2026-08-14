# Vecline Studio

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

MIT, matching the library.
