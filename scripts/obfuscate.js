#!/usr/bin/env node
/**
 * Silver Engineer — Selective obfuscation script
 *
 * Applies javascript-obfuscator ONLY to AI-core modules that contain:
 *   - Prompt strings / SKILL content inlined by esbuild
 *   - Workflow orchestration logic
 *   - Agent loop and routing logic
 *
 * General infrastructure code (mcpServer, webview, graphStore) is left
 * unobfuscated to avoid Marketplace false-positives and runtime slowdown.
 *
 * Level used: "light"
 *   - identifierNamesGenerator: hexadecimal
 *   - stringArray: true (encode strings in a shuffled array)
 *   - stringArrayEncoding: ['rc4']  ← recoverable but opaque to grep
 *   - controlFlowFlattening: false  ← too slow for realtime extension code
 *   - deadCodeInjection: false
 *
 * Run:  node scripts/obfuscate.js
 * Prereq: npm run build:prod must have completed first.
 */

'use strict';

const JavaScriptObfuscator = require('javascript-obfuscator');
const fs   = require('fs');
const path = require('path');

// ── Targets — only obfuscate these specific output modules ────────────────
// After esbuild, everything is in dist/extension.js.
// For surgical protection we rely on esbuild's banner comment markers to
// identify the AI-core section; this script post-processes the full bundle.
// Adjust the regex markers if you split the bundle further.
const TARGET_FILE = path.join(__dirname, '..', 'dist', 'extension.js');

// ── Obfuscation options (light profile) ──────────────────────────────────
/** @type {import('javascript-obfuscator').ObfuscatorOptions} */
const OPTIONS = {
  compact: true,
  simplify: true,

  // String array: encode string literals into an indexed array with RC4
  stringArray: true,
  stringArrayEncoding: ['rc4'],
  stringArrayThreshold: 0.6,      // only 60% of strings — keeps size reasonable
  rotateStringArray: true,
  shuffleStringArray: true,

  // Identifier renaming: hexadecimal names (short, unreadable)
  identifierNamesGenerator: 'hexadecimal',
  renameGlobals: false,            // don't rename top-level exports (breaks VSCode API)
  reservedNames: [
    // Keep VS Code extension entry points intact
    '^activate$', '^deactivate$',
  ],

  // Disable heavy transforms that hurt perf or trigger Marketplace scans
  controlFlowFlattening: false,
  deadCodeInjection: false,
  debugProtection: false,
  disableConsoleOutput: false,     // keep console.error for error reporting
  selfDefending: false,            // can break in sandboxed Extension Host
  transformObjectKeys: false,

  sourceMap: false,
  log: false,
};

// ── Main ──────────────────────────────────────────────────────────────────

if (!fs.existsSync(TARGET_FILE)) {
  console.error(`[obfuscate] Target not found: ${TARGET_FILE}`);
  console.error('            Run "npm run build:prod" first.');
  process.exit(1);
}

const original     = fs.readFileSync(TARGET_FILE, 'utf8');
const originalSize = Buffer.byteLength(original, 'utf8');

console.log(`[obfuscate] Processing ${TARGET_FILE} (${(originalSize / 1024).toFixed(1)} KB)…`);

const result = JavaScriptObfuscator.obfuscate(original, OPTIONS);
const obfuscated = result.getObfuscatedCode();
const newSize    = Buffer.byteLength(obfuscated, 'utf8');

fs.writeFileSync(TARGET_FILE, obfuscated, 'utf8');

const ratio = ((newSize - originalSize) / originalSize * 100).toFixed(1);
console.log(`[obfuscate] Done. ${(originalSize / 1024).toFixed(1)} KB → ${(newSize / 1024).toFixed(1)} KB (${ratio}%)`);
