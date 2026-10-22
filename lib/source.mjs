// Resolves a --source: a local path, or `owner/repo[@ref]` fetched from GitHub
// at that ref (tag, branch or commit SHA) into a temp dir.
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const GITHUB = /^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?(?:@([^\s]+))?$/;

function git(args, cwd) {
  const run = spawnSync('git', args, { cwd, encoding: 'utf8', timeout: 300_000 });
  if (run.error) throw new Error(`can't run git: ${run.error.message}`);
  if (run.status !== 0) throw new Error(`git ${args[0]} failed: ${run.stderr.trim()}`);
  return run.stdout.trim();
}

export function parseSourceSpec(spec) {
  if (existsSync(spec)) return { kind: 'path', path: resolve(spec) };
  const m = GITHUB.exec(spec);
  if (!m) throw new Error(`source "${spec}" is neither an existing path nor owner/repo[@ref]`);
  return { kind: 'github', owner: m[1], repo: m[2], ref: m[3] ?? null };
}

// Returns {dir, commit, cleanup}. `subPath` picks a folder inside the source.
export function resolveSource(spec, { subPath } = {}) {
  const parsed = parseSourceSpec(spec);
  let root;
  let commit = null;
  let cleanup = () => {};
  if (parsed.kind === 'path') {
    root = parsed.path;
  } else {
    root = mkdtempSync(join(tmpdir(), 'agy-porter-src-'));
    cleanup = () => rmSync(root, { recursive: true, force: true });
    try {
      git(['init', '-q'], root);
      git(['fetch', '-q', '--depth', '1', `https://github.com/${parsed.owner}/${parsed.repo}.git`, parsed.ref ?? 'HEAD'], root);
      git(['checkout', '-q', 'FETCH_HEAD'], root);
      commit = git(['rev-parse', 'HEAD'], root);
    } catch (err) {
      cleanup();
      throw err;
    }
  }
  const dir = subPath ? resolve(root, subPath) : root;
  if (!dir.startsWith(root) || !existsSync(dir) || !statSync(dir).isDirectory()) {
    cleanup();
    throw new Error(`no folder "${subPath}" in ${spec}`);
  }
  return { dir, commit, unpinned: parsed.kind === 'github' && !parsed.ref, cleanup };
}
