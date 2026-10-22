// Native-shape hook probe: logs what agy sends, then answers per argv[2].
// Log goes to $PROBE_LOG, else <tmp>/agy-porter-probe.log. Only the hooks under
// test should be enabled at once: several PreToolUse hooks run in sequence.
import { appendFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const mode = process.argv[2] || 'log';
let stdin = '';
try { stdin = readFileSync(0, 'utf8'); } catch {}
appendFileSync(process.env.PROBE_LOG || join(tmpdir(), 'agy-porter-probe.log'), JSON.stringify({
  mode, at: new Date().toISOString(), cwd: process.cwd(),
  pluginRoot: process.env.CLAUDE_PLUGIN_ROOT ?? null, stdin,
}) + '\n');
let cmd = '';
try { cmd = JSON.parse(stdin)?.toolCall?.args?.CommandLine ?? ''; } catch {}
const out = (o) => process.stdout.write(JSON.stringify(o));
const inject = (text) => out({ injectSteps: [{ systemMessage: { systemMessage: text } }] });

switch (mode) {
  case 'pre-json': // deny via JSON on the marker command; empty stdout otherwise
    if (cmd.includes('porter-fixture-deny')) out({ decision: 'deny', reason: 'probe: denied via JSON decision' });
    break;
  case 'pre-empty-object': // agy reads {} as a deny with an empty reason
    out({});
    break;
  case 'pre-allow':
    out({ decision: 'allow' });
    break;
  case 'pre-exit1':
    if (cmd.includes('porter-fixture-exit1')) { process.stderr.write('probe: exit 1 crash'); process.exit(1); }
    break;
  case 'pre-exit2':
    if (cmd.includes('porter-fixture-exit2')) { process.stderr.write('probe: exit 2 block'); process.exit(2); }
    break;
  case 'post-exit1':
    process.stderr.write('probe: post exit 1');
    process.exit(1);
  case 'session-text':
    process.stdout.write('PORTER_PROBE_PLAIN_TEXT_MARKER');
    break;
  case 'session-flat':
    inject('PORTER_PROBE_FLAT_MARKER');
    break;
  default: // log only: empty stdout, which agy treats as "no opinion"
    break;
}
