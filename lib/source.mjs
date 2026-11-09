// Resolves a --source: a local path, or `owner/repo[@ref]` fetched from GitHub
// at that ref (tag, branch or commit SHA) into a temp dir.
import { spawnSync } from 'node:child_process';
import { chmodSync, copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmdirSync, statSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';

// Owner, repo and ref can't start with "-", so none of them can reach git as an
// option (e.g. a ref of `--upload-pack=<cmd>`). Refs are limited to the
// characters tag, branch and SHA names use.
const GITHUB = /^([A-Za-z0-9][A-Za-z0-9-]*)\/([A-Za-z0-9_.][A-Za-z0-9_.-]*?)(?:\.git)?(?:@([A-Za-z0-9_][A-Za-z0-9_./-]*))?$/;

function git(args, cwd) {
  const run = spawnSync('git', args, { cwd, encoding: 'utf8', timeout: 300_000 });
  if (run.error) throw new Error(`can't run git: ${run.error.message}`);
  if (run.status !== 0) throw new Error(`git ${args[0]} failed: ${run.stderr.trim()}`);
  return run.stdout.trim();
}

// Deletes a tree without rmSync. On Windows, the Node 24 that Antigravity runs on
// (agy-node) has two rmSync bugs: it follows directory junctions inside the tree
// and deletes the files behind them, and it can't delete read-only files, which a
// git clone's pack files are. So this walks the tree itself, unlinks links
// without entering them, and makes a read-only file writable before deleting it.
export function removeTree(target) {
  let stat;
  try {
    stat = lstatSync(target);
  } catch (err) {
    if (err.code === 'ENOENT') return;
    throw err;
  }
  if (stat.isDirectory()) {
    for (const name of readdirSync(target)) removeTree(join(target, name));
    rmdirSync(target);
    return;
  }
  try {
    unlinkSync(target);
  } catch (err) {
    if (err.code !== 'EPERM' || stat.isSymbolicLink()) throw err;
    chmodSync(target, 0o666);
    unlinkSync(target);
  }
}

// Copies the tree at src to dest so that dest holds no links. A link whose target
// is inside one of `roots` (default: src) is replaced by a copy of what it points
// to. Any other link is left out: one pointing elsewhere, a dangling one, and one
// to a folder it sits in (which would copy forever). So is anything that's neither
// a file nor a folder. `skip(path)` leaves out a path and what's under it. Returns
// what was left out, as [{path, reason}] with path relative to src ("" for src).
//
// cpSync isn't enough: it keeps a symlink as a link to an absolute path (into a
// temp folder the porter deletes, or the user's checkout), and on Windows Node 20
// keeps a junction as a link while later versions copy what it points to.
// Whether path, with its links and ".." resolved, is root or inside it. False when
// path doesn't exist.
export function isInside(root, path) {
  try {
    const realRoot = realpathSync.native(root);
    const real = realpathSync.native(path);
    return real === realRoot || real.startsWith(realRoot.endsWith(sep) ? realRoot : realRoot + sep);
  } catch {
    return false;
  }
}

export function copyTree(src, dest, { roots = [src], skip = () => false } = {}) {
  const realRoots = roots.map((r) => realpathSync.native(r));
  const inRoots = (real) => realRoots.some((r) => real === r || real.startsWith(r.endsWith(sep) ? r : r + sep));
  const left = [];
  const walk = (from, to, open) => {
    if (skip(from)) return;
    const path = relative(src, from).replace(/\\/g, '/');
    const leave = (reason) => left.push({ path, reason });
    let stat = lstatSync(from);
    let real = null;
    if (stat.isSymbolicLink()) {
      try {
        real = realpathSync.native(from);
        stat = statSync(from);
      } catch {
        return leave('it links to nothing');
      }
      if (!inRoots(real)) return leave('it links outside the source');
      if (stat.isDirectory() && open.has(real)) return leave('it links to a folder it sits in');
    }
    if (stat.isDirectory()) {
      mkdirSync(to, { recursive: true });
      const inside = new Set(open).add(real ?? realpathSync.native(from));
      for (const name of readdirSync(from)) walk(join(from, name), join(to, name), inside);
    } else if (stat.isFile()) {
      copyFileSync(from, to);
    } else {
      leave("it's neither a file nor a folder");
    }
  };
  walk(src, dest, new Set());
  return left;
}

// A license file's name: LICENSE, LICENSE.md, LICENSE.txt or COPYING, any case.
const LICENSE_NAME = /^(license(\.md|\.txt)?|copying)$/i;

// The name of the license file at dir's top level, or null. A link counts only
// when it leads to a file inside `root` (default: dir), so nothing outside the
// source is ever read.
export function findLicense(dir, { root = dir } = {}) {
  let names;
  try {
    names = readdirSync(dir).filter((n) => LICENSE_NAME.test(n)).sort();
  } catch {
    return null;
  }
  return names.find((n) => isInside(root, join(dir, n)) && statSync(join(dir, n)).isFile()) ?? null;
}

export function parseSourceSpec(spec) {
  if (existsSync(spec)) return { kind: 'path', path: resolve(spec) };
  const m = GITHUB.exec(spec);
  if (!m || m[3]?.includes('..')) throw new Error(`source "${spec}" is neither an existing path nor owner/repo[@ref]`);
  return { kind: 'github', owner: m[1], repo: m[2], ref: m[3] ?? null };
}

// Returns {dir, root, commit, cleanup}. `subPath` picks a folder (dir) inside the
// source; root is the source's own folder (the repository root for owner/repo).
export function resolveSource(spec, { subPath } = {}) {
  const parsed = parseSourceSpec(spec);
  let root;
  let commit = null;
  let cleanup = () => {};
  if (parsed.kind === 'path') {
    root = parsed.path;
  } else {
    root = mkdtempSync(join(tmpdir(), 'agy-porter-src-'));
    cleanup = () => removeTree(root);
    try {
      const ref = parsed.ref ?? 'HEAD';
      if (ref.startsWith('-')) throw new Error(`invalid ref "${ref}"`);
      git(['init', '-q'], root);
      // Keep the upstream's line endings: on Windows, autocrlf would rewrite every file.
      git(['config', 'core.autocrlf', 'false'], root);
      // "--": git reads everything after it as a repository or refspec, never an option.
      git(['fetch', '-q', '--depth', '1', '--', `https://github.com/${parsed.owner}/${parsed.repo}.git`, ref], root);
      git(['checkout', '-q', 'FETCH_HEAD'], root);
      commit = git(['rev-parse', 'HEAD'], root);
    } catch (err) {
      cleanup();
      throw err;
    }
  }
  const dir = subPath ? resolve(root, subPath) : root;
  const rel = relative(root, dir);
  if (rel.startsWith('..') || isAbsolute(rel) || !existsSync(dir) || !statSync(dir).isDirectory()) {
    cleanup();
    throw new Error(`no folder "${subPath}" in ${spec}`);
  }
  return { dir, root, commit, unpinned: parsed.kind === 'github' && !parsed.ref, cleanup };
}
