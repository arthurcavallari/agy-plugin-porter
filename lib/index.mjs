// Public API of agy-plugin-porter.
import { resolveSource } from './source.mjs';
import { transpile } from './transpiler-engine.mjs';

export { detect } from './detector.mjs';
export { compileHooks, remapMatcher, writeHookPort } from './hook-compiler.mjs';
export { sanitizeManifest } from './manifest-sanitizer.mjs';
export { compileMods } from './mod-compiler.mjs';
export { assess as assessMod, scanMod } from './mod-scan.mjs';
export { compileModes } from './mode-compiler.mjs';
export { compileRules } from './rules-compiler.mjs';
export { compileSkills } from './skill-compiler.mjs';
export { auditPlugin, inferTier, TIERS } from './static-auditor.mjs';
export { resolveSource } from './source.mjs';
export { transpile, validateWithAgy } from './transpiler-engine.mjs';

// portPackage({srcDir, outDir, slug}) -> {report, tier}. `srcDir` is a local path
// (or, with `source`, a path or owner/repo@ref to fetch first; `path` picks a
// subfolder). Pass `validate: true` to run `agy plugin validate` on the output.
export async function portPackage({ srcDir, source, path, outDir, slug, agy, force = false, validate = false }) {
  if (!outDir) throw new Error('outDir is required');
  const resolved = resolveSource(source ?? srcDir, { subPath: path });
  try {
    const report = transpile({ srcDir: resolved.dir, outDir, slug, agy, force, validate });
    if (resolved.commit) report.sourceCommit = resolved.commit;
    if (resolved.unpinned) report.warnings.push('source: no @ref given, so the port used the default branch; pin a tag or SHA for reproducible ports');
    return { report, tier: report.tier };
  } finally {
    resolved.cleanup();
  }
}
