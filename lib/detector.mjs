// Works out which plugin ecosystem(s) a source directory contains, where its
// hook configs live, and which of those are Claude Code UI mods.
import { existsSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const MARKERS = {
  claude: ['.claude-plugin/plugin.json'],
  gemini: ['gemini-extension.json'],
  cursor: ['.cursor/rules', '.cursorrules'],
  roo: ['.roomodes', '.kilocodemodes'],
  codex: ['.agents/skills'],
};

export function readJson(file) {
  const text = readFileSync(file, 'utf8').replace(/^\uFEFF/, '');
  return JSON.parse(text);
}

const toPosix = (p) => p.split('\\').join('/');

// A Claude Code UI mod uses the classic hooks file name with a `modules` key.
export function isUiMod(config) {
  return Boolean(config) && typeof config === 'object' && Array.isArray(config.modules);
}

// Hook configs a Claude plugin can declare: hooks/hooks.json, plus the
// manifest's `hooks` field (a path, a list of paths, or an inline object).
function claudeHookSources(srcDir, manifest) {
  const sources = [];
  const seen = new Set();
  const addFile = (rel) => {
    const file = join(srcDir, rel);
    const key = toPosix(relative(srcDir, file));
    if (seen.has(key) || !existsSync(file)) return;
    seen.add(key);
    let config = null;
    let error = null;
    try { config = readJson(file); } catch (err) { error = err.message; }
    sources.push({ path: key, config, error });
  };
  addFile('hooks/hooks.json');
  const declared = manifest?.hooks;
  if (typeof declared === 'string') addFile(declared);
  else if (Array.isArray(declared)) declared.filter((p) => typeof p === 'string').forEach(addFile);
  else if (declared && typeof declared === 'object') {
    sources.push({ path: '.claude-plugin/plugin.json#hooks', config: declared, error: null });
  }
  return sources;
}

export function detect(srcDir) {
  if (!existsSync(srcDir) || !statSync(srcDir).isDirectory()) {
    throw new Error(`not a directory: ${srcDir}`);
  }
  const ecosystems = Object.keys(MARKERS)
    .filter((eco) => MARKERS[eco].some((m) => existsSync(join(srcDir, m))));
  if (ecosystems.length === 0 && existsSync(join(srcDir, 'plugin.json'))) ecosystems.push('antigravity');

  const hookSources = [];
  if (ecosystems.includes('claude')) {
    let manifest = null;
    try { manifest = readJson(join(srcDir, '.claude-plugin/plugin.json')); } catch {}
    hookSources.push(...claudeHookSources(srcDir, manifest).map((s) => ({ ...s, dialect: 'claude' })));
  }
  if (ecosystems.includes('gemini') && existsSync(join(srcDir, 'hooks/hooks.json'))
      && !hookSources.some((s) => s.path === 'hooks/hooks.json')) {
    let config = null;
    let error = null;
    try { config = readJson(join(srcDir, 'hooks/hooks.json')); } catch (err) { error = err.message; }
    hookSources.push({ path: 'hooks/hooks.json', config, error, dialect: 'gemini' });
  }

  const uiMods = hookSources
    .filter((s) => isUiMod(s.config))
    .map((s) => ({ path: s.path, modules: s.config.modules, hasHooks: Boolean(s.config.hooks) }));

  return { ecosystems, hookSources, uiMods };
}
