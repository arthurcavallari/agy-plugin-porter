// Claude-style PreToolUse guard: blocks any command containing "porter-fixture-deny"
// via exit code 2 + stderr, the Claude Code blocking contract.
import { appendFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const raw = readFileSync(0, 'utf8');
appendFileSync(join(tmpdir(), 'agy-porter-fixture.log'), JSON.stringify({
  tag: 'bash-guard', at: new Date().toISOString(), cwd: process.cwd(),
  pluginRoot: process.env.CLAUDE_PLUGIN_ROOT ?? null, stdin: raw,
}) + '\n');
let input = {};
try { input = JSON.parse(raw); } catch {}
const command = input?.tool_input?.command ?? '';
if (command.includes('porter-fixture-deny')) {
  process.stderr.write('bash-guard: blocked by fixture policy');
  process.exit(2);
}
process.exit(0);
