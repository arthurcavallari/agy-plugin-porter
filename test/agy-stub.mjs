// A stand-in for the agy CLI: `--version`, `plugin validate <dir> --json` (no findings)
// and `plugin install <dir>`. Every call is appended to $AGY_STUB_LOG as a JSON line.
import { appendFileSync } from 'node:fs';

const args = process.argv.slice(2);
if (process.env.AGY_STUB_LOG) appendFileSync(process.env.AGY_STUB_LOG, `${JSON.stringify(args)}\n`);
if (args[0] === '--version') console.log('0.0.0-stub');
else if (args[0] === 'plugin' && args[1] === 'validate') console.log(JSON.stringify({ components: {}, findings: [] }));
else if (args[0] === 'plugin' && args[1] === 'install') console.log(`Installed plugin from ${args[2]}`);
else process.exitCode = 1;
