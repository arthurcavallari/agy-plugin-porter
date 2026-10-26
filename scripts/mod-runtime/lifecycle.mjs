// The sidecar's server_info.json and its exit. On Windows, quitting the app
// hard-kills the language server and orphans every sidecar (live,
// ui-mods-baseline.md), so the sidecar exits once ANTIGRAVITY_LS_ADDRESS stops
// answering. An orphan can notice that after its replacement started, so it
// removes server_info.json only while the file still holds its own pid (live fix).
import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { connect } from 'node:net';
import { join } from 'node:path';

export function writeServerInfo(dataDir, info) {
  writeFileSync(join(dataDir, 'server_info.json'), JSON.stringify({ ...info, pid: process.pid }, null, 2));
}

export function removeServerInfoIfOurs(dataDir, pid = process.pid) {
  const file = join(dataDir, 'server_info.json');
  try {
    if (JSON.parse(readFileSync(file, 'utf8')).pid !== pid) return false;
    rmSync(file, { force: true });
    return true;
  } catch {
    return false;
  }
}

// Calls onGone after two failed connects in a row, 5 s apart.
export function watchLanguageServer(address, onGone, { everyMs = 5000 } = {}) {
  const m = /([^/:]+|\[[^\]]+\]):(\d+)/.exec(address ?? '');
  if (!m) return null;
  let failures = 0;
  return setInterval(() => {
    const socket = connect({ host: m[1].replace(/^\[|\]$/g, ''), port: Number(m[2]) });
    const done = (alive) => {
      socket.destroy();
      failures = alive ? 0 : failures + 1;
      if (failures >= 2) onGone('language server gone');
    };
    socket.setTimeout(2000, () => done(false));
    socket.once('connect', () => done(true));
    socket.once('error', () => done(false));
  }, everyMs).unref();
}

export function stopOnSignals(stop) {
  for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP', 'SIGBREAK']) process.on(sig, () => stop(sig));
}
