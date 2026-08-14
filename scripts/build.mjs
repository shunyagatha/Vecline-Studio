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
};

async function run() {
  await mkdir('dist', { recursive: true });

  const entries = [
    { entryPoints: ['src/app/main.ts'], outfile: 'dist/app.js' },
    { entryPoints: ['src/engine/worker.ts'], outfile: 'dist/worker.js' },
  ].filter((e) => existsSync(e.entryPoints[0]));

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
