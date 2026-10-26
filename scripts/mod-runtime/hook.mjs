// agy hook -> sidecar: `agy-node sidecars/<id>/hook.mjs <Event>`, cwd = plugin root
// (live, Phase 2.5A). Prints what the sidecar answers. Fails open: if the sidecar is
// down, slow or broken, it prints "no opinion" (nothing for PreToolUse, `{}`
// otherwise) and exits 0, since agy fails a tool call on any nonzero PreToolUse exit
// and reads `{}` from PreToolUse as a deny (live, agy-baseline.md).
import { callSidecar } from './locate.mjs';

const event = process.argv[2] || 'PreToolUse';
const noOpinion = event === 'PreToolUse' ? '' : '{}';
const finish = (out) => process.stdout.write(out, () => process.exit(0));
process.on('uncaughtException', () => finish(noOpinion));
setTimeout(() => finish(noOpinion), 4000).unref();

let raw = '';
for await (const chunk of process.stdin) raw += chunk;
let payload = {};
try { payload = JSON.parse(raw.replace(/^﻿/, '') || '{}'); } catch {}
try {
  const r = await callSidecar('/api/hook', { event, payload });
  finish(typeof r.stdout === 'string' ? r.stdout : noOpinion);
} catch (err) {
  process.stderr.write(`agy-porter mod hook: ${err.message}; not blocking\n`);
  finish(noOpinion);
}
