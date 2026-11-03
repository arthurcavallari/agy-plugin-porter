// Appends the raw stdin payload and env to <tmp>/agy-porter-fixture.log so the
// Phase 0 live check can see exactly what the host sends.
import { appendFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

if (process.env.NODE_TEST_CONTEXT && !process.env.extensionPath && !process.env.CLAUDE_PLUGIN_ROOT) process.exit(0);
const tag = process.argv[2] || 'hook';
let stdin = '';
try { stdin = readFileSync(0, 'utf8'); } catch {}
appendFileSync(join(tmpdir(), 'agy-porter-fixture.log'), JSON.stringify({
  tag, at: new Date().toISOString(), cwd: process.cwd(),
  pluginRoot: process.env.CLAUDE_PLUGIN_ROOT ?? null, stdin,
}) + '\n');
