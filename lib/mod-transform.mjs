// Collects a UI mod's module graph and turns it into files a sidecar can import.
// TS/TSX/JSX go through esbuild, an optional dependency of the porter loaded only for
// them (plan §5.8, picked by the 2.5A scorecard). Plain .js/.mjs mods need nothing.
import { existsSync, readFileSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { extname, join, posix, relative } from 'node:path';

import { importsOf } from './mod-scan.mjs';

export const NEEDS_TRANSFORM = new Set(['.ts', '.tsx', '.jsx', '.mts']);
const TRY_EXT = ['', '.ts', '.tsx', '.js', '.mjs', '.jsx', '/index.ts', '/index.tsx', '/index.js', '/index.mjs'];

// esbuild, or null when it isn't installed.
export function loadEsbuild() {
  try { return createRequire(import.meta.url)('esbuild'); } catch { return null; }
}

const isFile = (p) => existsSync(p) && statSync(p).isFile();

// Resolves a relative specifier from `fromRel` (posix, relative to root). A `.js`
// specifier may name a `.ts` file (TypeScript's convention). Type declarations
// (.d.ts) resolve to null: imports of them are erased by the transform.
export function resolveSpec(root, fromRel, spec) {
  const base = posix.normalize(posix.join(posix.dirname(fromRel), spec));
  if (base.startsWith('../') || base === '..') throw new Error(`${fromRel} imports ${spec}, outside the plugin`);
  const stem = /\.(m?js|jsx)$/.test(base) ? base.replace(/\.(m?js|jsx)$/, '') : null;
  for (const cand of [...TRY_EXT.map((e) => base + e), ...(stem ? ['.ts', '.tsx', '.mts'].map((e) => stem + e) : [])]) {
    if (cand.endsWith('.d.ts')) continue;
    if (isFile(join(root, cand))) return cand;
  }
  for (const e of ['.d.ts', '/index.d.ts']) if (isFile(join(root, base + e))) return null;
  throw new Error(`${fromRel} imports ${spec}, which isn't in the plugin`);
}

// The module and every relative file it imports at runtime: [{rel, src}].
export function collectGraph(root, entryRel) {
  const files = new Map();
  const queue = [entryRel];
  while (queue.length) {
    const rel = queue.shift();
    if (files.has(rel)) continue;
    const src = readFileSync(join(root, rel), 'utf8').replace(/^\uFEFF/, '');
    files.set(rel, src);
    for (const spec of importsOf(src)) {
      if (!/^\.{1,2}\//.test(spec)) continue;
      const target = resolveSpec(root, rel, spec);
      if (target) queue.push(target);
    }
  }
  return [...files].map(([rel, src]) => ({ rel, src }));
}

// Output name inside the sidecar's mod/ folder: always .mjs, so Node loads every file
// as ESM whatever its version.
export const outName = (rel) => rel.replace(/\.(tsx?|mts|jsx|m?js)$/, '') + '.mjs';

export const needsTransform = (files) => files.some((f) => NEEDS_TRANSFORM.has(extname(f.rel)));

// Transforms one file and points its imports at the output names: relative files at
// their .mjs copies, 'claude-code' at the runtime's stand-in next to mod/.
export function transformFile(root, file, esbuild) {
  const ext = extname(file.rel);
  let code = file.src;
  if (NEEDS_TRANSFORM.has(ext)) {
    if (!esbuild) throw new Error('needs esbuild to transform TS/TSX: port it with `npx agy-plugin-porter`, which installs esbuild as an optional dependency');
    code = esbuild.transformSync(file.src, {
      loader: ext === '.mts' ? 'ts' : ext.slice(1), format: 'esm', jsx: 'transform', jsxFactory: 'h', jsxFragment: 'Fragment',
      target: 'node20', sourcefile: file.rel,
    }).code;
  }
  const outDir = posix.dirname(`mod/${outName(file.rel)}`);
  const stand = posix.relative(outDir, 'claude-code.mjs');
  const rewrite = (spec) => {
    if (spec === 'claude-code') return stand.startsWith('.') ? stand : `./${stand}`;
    if (!/^\.{1,2}\//.test(spec)) return spec;
    const target = resolveSpec(root, file.rel, spec);
    if (!target) return spec;
    const r = posix.relative(posix.dirname(file.rel), outName(target));
    return r.startsWith('.') ? r : `./${r}`;
  };
  return code.replace(/(\bfrom\s*|\bimport\s*\(\s*|\bimport\s+)(['"])([^'"\n]+)\2/g, (whole, lead, q, spec) => `${lead}${q}${rewrite(spec)}${q}`);
}

export const relPosix = (from, to) => relative(from, to).split('\\').join('/');
