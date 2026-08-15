/**
 * Build Vecline Studio into `dist/` — a static site with no backend.
 *
 * Two bundles, because the heavy half runs off-thread: the app shell and the
 * conversion worker. `vecline/core` is dependency-free and Node-built-in-free,
 * so it bundles for the browser with no shims and no externals.
 */

import { build, context } from 'esbuild';
import { cp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';

const watch = process.argv.includes('--watch');
const dev = watch || process.argv.includes('--dev');

const common = {
  bundle: true,
  format: 'esm',
  target: ['es2022', 'chrome111', 'firefox111', 'safari16'],
  minify: !dev,
  sourcemap: dev,
  logLevel: 'info',
  // mupdf's emscripten glue carries a Node branch that does
  // `await import("node:fs")` / `await import("module")` behind a
  // `typeof process === "object"` guard. In a browser that branch never runs,
  // but esbuild still tries to resolve the specifiers while bundling. Marking
  // them external leaves the `import()` expressions in place, unevaluated —
  // which is correct, rather than shimming a filesystem that is never touched.
  external: ['node:fs', 'module'],
};

async function run() {
  await mkdir('dist', { recursive: true });

  // `splitting` is load-bearing, not a nicety: without it esbuild inlines
  // dynamic imports straight into the bundle, so the 3.4 MB PDF engine would
  // ship to every visitor who only ever converts a PNG — exactly the cost the
  // dynamic import exists to avoid. With it, mupdf becomes its own chunk that
  // is fetched the first time someone actually drops a PDF.
  const entries = [
    { entryPoints: { app: 'src/app/main.ts' }, outdir: 'dist', splitting: true },
    { entryPoints: ['src/engine/worker.ts'], outfile: 'dist/worker.js' },
  ].filter((e) => {
    const first = Array.isArray(e.entryPoints) ? e.entryPoints[0] : Object.values(e.entryPoints)[0];
    return existsSync(first);
  });

  if (entries.length === 0) {
    console.warn('Nothing to bundle yet — src/app/main.ts is added with the UI.');
  }

  if (watch) {
    for (const e of entries) {
      const ctx = await context({ ...common, ...e });
      await ctx.watch();
    }
    console.log('watching…');
  } else {
    for (const e of entries) await build({ ...common, ...e });
  }

  // Static assets: index.html, manifest, service worker, icons.
  if (existsSync('public')) await cp('public', 'dist', { recursive: true });

  // mupdf locates its WebAssembly relative to the JS that loads it, so the
  // binary has to sit beside the bundle. Copied rather than bundled: a 9.9 MB
  // base64 string inside a JS file would be both larger on the wire and
  // ineligible for the streaming compilation the browser does with a real
  // `.wasm` response.
  const wasm = 'node_modules/mupdf/dist/mupdf-wasm.wasm';
  if (existsSync(wasm)) await cp(wasm, 'dist/mupdf-wasm.wasm');

  // Stamp the service worker with a build id so caches roll over on deploy.
  const swPath = 'dist/sw.js';
  if (existsSync(swPath)) {
    const stamp = process.env.BUILD_ID || String(Date.now());
    await writeFile(swPath, (await readFile(swPath, 'utf8')).replace('__BUILD_ID__', stamp));
  }

  console.log(`Vecline Studio → dist/${dev ? ' (dev)' : ''}`);
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
