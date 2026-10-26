// detect -> stage -> compile -> audit -> write. For Claude Code and Gemini CLI
// sources, staging is `agy plugin install` run against a throwaway home, and
// the porter post-processes what agy staged (docs/agy-baseline.md). Cursor,
// Roo/Kilo and Codex sources, which agy doesn't detect, start from an empty
// plugin dir. agy only ever runs with HOME/USERPROFILE pointed at a temp dir,
// so the user's real profile is never read or written.
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';

import { detect } from './detector.mjs';
import { compileHooks, writeHookPort } from './hook-compiler.mjs';
import { sanitizeManifest, sourceManifest } from './manifest-sanitizer.mjs';
import { compileMods, userConfigDefaults } from './mod-compiler.mjs';
import { compileModes } from './mode-compiler.mjs';
import { compileRules } from './rules-compiler.mjs';
import { compileSkills, slugifyName } from './skill-compiler.mjs';
import { auditPlugin } from './static-auditor.mjs';

const AGY_STAGED = ['claude', 'gemini'];

export function throwawayEnv(home) {
  return { ...process.env, HOME: home, USERPROFILE: home, NO_COLOR: '1' };
}

export function runAgy(args, { agy = 'agy', home }) {
  const run = spawnSync(agy, args, { encoding: 'utf8', env: throwawayEnv(home), timeout: 120_000 });
  if (run.error) throw new Error(`can't run ${agy}: ${run.error.message}`);
  return run;
}

// Runs `agy plugin install <srcDir>` in a throwaway home and returns the staged dir.
export function stageWithAgy(srcDir, { agy, workDir }) {
  const home = join(workDir, 'home');
  mkdirSync(home, { recursive: true });
  const run = runAgy(['plugin', 'install', srcDir], { agy, home });
  const pluginsDir = join(home, '.gemini', 'config', 'plugins');
  const staged = existsSync(pluginsDir) ? readdirSync(pluginsDir).filter((d) => statSync(join(pluginsDir, d)).isDirectory()) : [];
  if (run.status !== 0 || staged.length !== 1) {
    throw new Error(`agy plugin install failed (exit ${run.status}): ${(run.stdout + run.stderr).trim()}`);
  }
  return join(pluginsDir, staged[0]);
}

const removeEmptyDirs = (dir) => {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      removeEmptyDirs(full);
      if (readdirSync(full).length === 0) rmSync(full, { recursive: true });
    }
  }
};

const merge = (into, part) => {
  into.ported.push(...part.ported);
  into.unported.push(...part.unported);
  into.warnings.push(...part.warnings);
};

export function defaultSlug(srcDir, ecosystems) {
  const name = sourceManifest(srcDir, ecosystems).name;
  return slugifyName(typeof name === 'string' && name ? name : basename(resolve(srcDir)));
}

// Ports srcDir into outDir. Returns the port report. `esbuild` overrides the optional
// esbuild the mod compiler loads for TS/TSX mods (null: act as if it's missing).
export function transpile({ srcDir, outDir, slug, agy = 'agy', force = false, validate = false, esbuild }) {
  srcDir = resolve(srcDir);
  const detection = detect(srcDir);
  const { ecosystems } = detection;
  if (ecosystems.length === 0) throw new Error(`no plugin found in ${srcDir} (looked for Claude Code, Gemini CLI, Cursor, Roo/Kilo, Codex and Antigravity layouts)`);
  slug = slug ?? defaultSlug(srcDir, ecosystems);
  if (!/^[a-z0-9][a-z0-9._-]*$/.test(slug)) throw new Error(`invalid slug "${slug}": use lowercase letters, digits, ".", "_" and "-"`);
  outDir = resolve(outDir);
  if (existsSync(outDir) && readdirSync(outDir).length && !force) throw new Error(`${outDir} isn't empty (pass force to replace it)`);

  const report = { slug, ecosystems, ported: [], unported: [], warnings: [], flags: [], tier: null, tierReasons: [] };
  const workDir = mkdtempSync(join(tmpdir(), 'agy-porter-'));
  try {
    const pluginDir = join(workDir, 'plugin');
    const stagedPaths = [];
    if (ecosystems.includes('antigravity')) {
      cpSync(srcDir, pluginDir, { recursive: true, filter: (p) => !/[\\/](\.git|node_modules)$/.test(p) });
      report.ported.push('native plugin (copied as is)');
    } else if (ecosystems.some((e) => AGY_STAGED.includes(e))) {
      let stageFrom = srcDir;
      if (detection.manifestless) {
        // agy only detects Claude plugins by their manifest, so stage a copy with one.
        stageFrom = join(workDir, 'src');
        cpSync(srcDir, stageFrom, { recursive: true, filter: (p) => !/[\\/](\.git|node_modules)$/.test(p) });
        mkdirSync(join(stageFrom, '.claude-plugin'));
        writeFileSync(join(stageFrom, '.claude-plugin', 'plugin.json'), JSON.stringify({ name: slug }));
        report.warnings.push('no .claude-plugin/plugin.json: ported as a Claude Code plugin from its default folders');
      }
      const staged = stageWithAgy(stageFrom, { agy, workDir });
      // agy may write the resolved path (macOS /var -> /private/var, Windows 8.3 names).
      stagedPaths.push(...new Set([staged, realpathSync.native(staged)]));
      cpSync(staged, pluginDir, { recursive: true, filter: (p) => !/[\\/]\.git$/.test(p) });
    } else {
      mkdirSync(pluginDir);
    }

    if (!ecosystems.includes('antigravity')) {
      merge(report, sanitizeManifest(pluginDir, { srcDir, ecosystems, slug, stagedPaths }));
      const hooks = compileHooks(detection.hookSources, { slug });
      writeHookPort(pluginDir, hooks);
      merge(report, hooks.report);
      // UI mods become sidecars (it merges its hooks into hooks.json, so it runs after
      // writeHookPort). The raw module files agy staged are dropped either way.
      if (detection.uiMods.length) {
        const manifest = sourceManifest(srcDir, ecosystems);
        merge(report, compileMods(detection.uiMods, {
          srcDir, pluginDir, slug, esbuild,
          sourceName: typeof manifest.name === 'string' ? manifest.name : slug,
          title: typeof manifest.displayName === 'string' ? manifest.displayName : undefined,
          version: typeof manifest.version === 'string' ? manifest.version : undefined,
          options: userConfigDefaults(manifest.userConfig),
        }));
        if (typeof manifest.types === 'string') rmSync(join(pluginDir, manifest.types), { force: true });
      }
      merge(report, compileSkills(pluginDir, { srcDir, ecosystems }));
      merge(report, compileRules(pluginDir, { srcDir, ecosystems }));
      merge(report, compileModes(pluginDir, { srcDir, ecosystems, slug }));
      removeEmptyDirs(pluginDir);
    }

    const audit = auditPlugin(pluginDir);
    report.flags = audit.flags;
    report.warnings.push(...audit.warnings);
    report.tier = audit.tier;
    report.tierReasons = audit.reasons;

    rmSync(outDir, { recursive: true, force: true });
    mkdirSync(outDir, { recursive: true });
    cpSync(pluginDir, outDir, { recursive: true });
    if (validate) report.validation = validateWithAgy(outDir, { agy, workDir });
    return report;
  } finally {
    rmSync(workDir, { recursive: true, force: true });
  }
}

// `agy plugin validate --json` in a throwaway home.
export function validateWithAgy(pluginDir, { agy = 'agy', workDir } = {}) {
  const ownDir = !workDir;
  const dir = workDir ?? mkdtempSync(join(tmpdir(), 'agy-porter-validate-'));
  const home = join(dir, 'validate-home');
  mkdirSync(home, { recursive: true });
  try {
    const run = runAgy(['plugin', 'validate', pluginDir, '--json'], { agy, home });
    let result = null;
    try { result = JSON.parse(run.stdout); } catch {}
    if (!result) return { ok: false, errors: [], warnings: [], output: (run.stdout + run.stderr).trim() };
    const findings = result.findings ?? [];
    return {
      ok: run.status === 0,
      components: result.components,
      errors: findings.filter((f) => f.severity === 'error'),
      warnings: findings.filter((f) => f.severity !== 'error'),
    };
  } finally {
    if (ownDir) rmSync(dir, { recursive: true, force: true });
  }
}
