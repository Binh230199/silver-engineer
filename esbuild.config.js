// @ts-check
'use strict';

const esbuild = require('esbuild');
const path = require('path');
const fs = require('fs');

const isProd = process.argv.includes('--production');
const isWatch = process.argv.includes('--watch');
const isWebview = process.argv.includes('--webview');

/** @type {esbuild.BuildOptions} */
const extensionConfig = {
  entryPoints: ['src/extension.ts'],
  bundle: true,
  outfile: 'dist/extension.js',
  external: ['vscode'],
  format: 'cjs',
  platform: 'node',
  target: 'node20',
  sourcemap: !isProd,
  minify: isProd,
  treeShaking: true,
  loader: {
    '.wasm': 'file',   // WASM assets copied to dist/ with content-hash name
    '.md': 'text',     // Inline SKILL.md templates as strings (non-sensitive ones)
  },
  // Ensures WASM files land in dist/ alongside extension.js
  assetNames: 'assets/[name]-[hash]',
  define: {
    'process.env.NODE_ENV': isProd ? '"production"' : '"development"',
  },
  logLevel: 'info',
};

/** @type {esbuild.BuildOptions} */
const webviewConfig = {
  entryPoints: ['src/webview/entry.ts'],
  bundle: true,
  outfile: 'dist/webview.js',
  format: 'iife',
  platform: 'browser',
  target: 'es2020',
  sourcemap: !isProd,
  minify: isProd,
  treeShaking: true,
  logLevel: 'info',
};

/**
 * Copy runtime data assets that cannot be bundled (loaded via __dirname at runtime).
 *
 * gpt-3-encoder (used by vectra) calls:
 *   fs.readFileSync(path.join(__dirname, './encoder.json'))
 *   fs.readFileSync(path.join(__dirname, './vocab.bpe'))
 * When bundled, __dirname === dist/, so both files must live there.
 */
function copyRuntimeAssets() {
  const distDir = path.join(__dirname, 'dist');
  if (!fs.existsSync(distDir)) fs.mkdirSync(distDir, { recursive: true });

  const runtimeFiles = [
    path.join(__dirname, 'node_modules', 'gpt-3-encoder', 'encoder.json'),
    path.join(__dirname, 'node_modules', 'gpt-3-encoder', 'vocab.bpe'),
  ];
  for (const src of runtimeFiles) {
    if (fs.existsSync(src)) {
      const dest = path.join(distDir, path.basename(src));
      fs.copyFileSync(src, dest);
      console.log(`[assets] Copied ${path.basename(src)} → dist/`);
    } else {
      console.warn(`[assets] WARNING: ${src} not found — vectra tokenizer will fail at runtime`);
    }
  }
  // Built-in skill templates → dist/skills/templates/
  const skillsSrc = path.join(__dirname, 'src', 'skills', 'templates');
  const skillsDst = path.join(distDir, 'skills', 'templates');
  if (fs.existsSync(skillsSrc)) {
    if (!fs.existsSync(skillsDst)) fs.mkdirSync(skillsDst, { recursive: true });
    for (const f of fs.readdirSync(skillsSrc)) {
      if (!f.endsWith('.md')) continue;
      fs.copyFileSync(path.join(skillsSrc, f), path.join(skillsDst, f));
    }
    console.log(`[assets] Copied skill templates \u2192 dist/skills/templates/`);
  }
  // WASM assets (add ruvector path here when available):
  const wasmSources = [
    // path.join(__dirname, 'node_modules', 'ruvector', 'dist', 'ruvector_bg.wasm'),
  ];
  const outAssetsDir = path.join(distDir, 'assets');
  if (!fs.existsSync(outAssetsDir)) fs.mkdirSync(outAssetsDir, { recursive: true });
  for (const src of wasmSources) {
    if (fs.existsSync(src)) {
      fs.copyFileSync(src, path.join(outAssetsDir, path.basename(src)));
      console.log(`[wasm] Copied ${path.basename(src)} → dist/assets/`);
    }
  }
}

async function build() {
  const configs = isWebview
    ? [webviewConfig]
    : [extensionConfig, webviewConfig];

  if (isWatch) {
    copyRuntimeAssets();
    const contexts = await Promise.all(configs.map(c => esbuild.context(c)));
    await Promise.all(contexts.map(ctx => ctx.watch()));
    console.log('[esbuild] Watching for changes…');
  } else {
    await Promise.all(configs.map(c => esbuild.build(c)));
    copyRuntimeAssets();
    console.log(`[esbuild] Build complete (${isProd ? 'production' : 'development'})`);
  }
}

build().catch(err => {
  console.error(err);
  process.exit(1);
});
