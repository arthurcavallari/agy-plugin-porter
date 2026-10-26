#!/usr/bin/env node
// Offline smoke test for the spike plugins: starts each built sidecar on an ephemeral
// port with a temp data dir, then plays agy's side (hook payloads, MCP calls, the view's
// SSE and clicks). Prints one line per check, and writes each mod's final pane trees to
// <out>/smoke-<plugin>.json so the esbuild and node transforms can be compared.
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const OUT = join(import.meta.dirname, 'out');
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
let failed = 0;
const check = (name, ok, detail = '') => { if (!ok) failed++; console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? ` (${detail})` : ''}`); };

async function start(plugin) {
  const data = mkdtempSync(join(tmpdir(), 'porter-spike-'));
  const child = spawn(process.execPath, [join(OUT, plugin, 'sidecars', 'pane', 'server.mjs')], {
    env: { ...process.env, ANTIGRAVITY_EXECUTABLE_DATA_DIR: data, ANTIGRAVITY_LS_ADDRESS: '' }, stdio: 'ignore',
  });
  for (let i = 0; i < 50; i++) {
    try {
      const info = JSON.parse(readFileSync(join(data, 'server_info.json'), 'utf8'));
      const call = async (path, body) => {
        const res = await fetch(`http://127.0.0.1:${info.port}${path}`, {
          method: body === undefined ? 'GET' : 'POST', headers: { 'Content-Type': 'application/json', 'X-Sidecar-Token': info.token },
          body: body === undefined ? undefined : JSON.stringify(body),
        });
        return res.json();
      };
      return { child, data, info, call };
    } catch { await wait(100); }
  }
  throw new Error(`${plugin} did not start`);
}

// The view's SSE stream: collects messages; `latest(type)` is the newest of a type.
async function view(s, conv) {
  const msgs = [];
  const ac = new AbortController();
  const res = await fetch(`http://127.0.0.1:${s.info.port}/api/events?conv=${conv}&token=${s.info.token}`, { signal: ac.signal });
  (async () => {
    const dec = new TextDecoder();
    let buf = '';
    try {
      for await (const chunk of res.body) {
        buf += dec.decode(chunk);
        let i;
        while ((i = buf.indexOf('\n\n')) >= 0) { msgs.push(JSON.parse(buf.slice(6, i))); buf = buf.slice(i + 2); }
      }
    } catch {}
  })();
  await wait(200);
  return { msgs, close: () => ac.abort(), latest: (type) => msgs.filter((m) => m.type === type).at(-1) };
}

const walk = (node, fn) => { if (!node || typeof node === 'string') return; fn(node); for (const c of node.children ?? []) walk(c, fn); };
const text = (node) => (typeof node === 'string' ? node : (node?.children ?? []).map(text).join(''));
const find = (tree, pred) => { let hit; walk(tree, (n) => { if (!hit && pred(n)) hit = n; }); return hit; };
const hook = (s, event, payload) => s.call('/api/hook', { event, payload: { conversationId: 'c1', workspacePaths: ['C:\\work'], ...payload } });

const scenarios = {
  async 'porter-spike-task-board'(s) {
    const v = await view(s, 'c1');
    await s.call('/api/view', { conv: 'c1', cwd: 'C:/work' });
    const list = await s.call('/api/mcp', { op: 'list' });
    check('lists slash_task-board', list.tools.some((t) => t.name === 'slash_task-board'));
    const r = await s.call('/api/mcp', { op: 'call', conv: 'c1', name: 'slash_task-board', args: { args: 'Buy milk' } });
    check('command returns the pill', r.text.includes('sidecar://porter-spike-task-board/pane/ui.html'), r.text);
    await wait(100);
    const tree = v.latest('state')?.panes[0]?.tree;
    const toggle = find(tree, (n) => n.type === 'Button' && n.props.label === '[ ] Buy milk');
    check('pane shows the new task', Boolean(toggle));
    await s.call('/api/action', { conv: 'c1', cb: toggle.props.onPress.$cb, args: [] });
    await wait(100);
    check('toggle marks it done', Boolean(find(v.latest('state').panes[0].tree, (n) => n.props?.label === '[x] Buy milk')));
    const input = find(v.latest('state').panes[0].tree, (n) => n.type === 'Input');
    await s.call('/api/action', { conv: 'c1', cb: input.props.onSubmit.$cb, args: ['Second task'] });
    await wait(100);
    check('Input onSubmit saves', Boolean(find(v.latest('state').panes[0].tree, (n) => n.props?.label === '[ ] Second task')));
    const store = JSON.parse(readFileSync(join(s.data, 'store.json'), 'utf8'));
    check('$.store persisted per workspace', Object.keys(store).length === 2 && Object.keys(store)[0].startsWith(`workspace:${encodeURIComponent('C:\\work')}`), Object.keys(store)[0]);
    v.close();
    return v.latest('state');
  },

  async 'porter-spike-replay-theater'(s) {
    const v = await view(s, 'c1');
    await hook(s, 'SessionStart', {});
    await hook(s, 'PreInvocation', {});
    const pre1 = await hook(s, 'PreToolUse', { stepIdx: 4, toolCall: { name: 'write_to_file', args: { TargetFile: join(s.data, 'new.txt'), CodeContent: 'a\nb\n' } } });
    check('PreToolUse Write: no opinion', pre1.stdout === '' && pre1.path === 'next', JSON.stringify(pre1));
    const post1 = await hook(s, 'PostToolUse', { stepIdx: 4, toolCall: { name: 'write_to_file', args: {} }, error: '' });
    check('PostToolUse resumes by stepIdx', post1.path === 'resumed (stepIdx)', post1.path);
    await hook(s, 'PreInvocation', {});
    await hook(s, 'PreToolUse', { stepIdx: 7, toolCall: { name: 'replace_file_content', args: { TargetFile: 'C:\\work\\x.js', ReplacementChunks: [{ TargetContent: 'old line', ReplacementContent: 'new line' }] } } });
    await hook(s, 'PostToolUse', { stepIdx: 7, toolCall: { name: 'replace_file_content', args: {} }, error: '' });
    await hook(s, 'PreToolUse', { stepIdx: 9, toolCall: { name: 'edit_file', args: { Path: 'C:\\work\\y.js', Target: 'q', Replacement: 'r' } } });
    await hook(s, 'PostToolUse', { stepIdx: 9, toolCall: { name: 'edit_file', args: {} }, error: 'permission denied' });
    await hook(s, 'Stop', {});
    await wait(100);
    check('turn.complete toasts the count', v.latest('toast')?.text === 'replay-theater: 2 edits last turn. Run /replay', v.latest('toast')?.text);
    const r = await s.call('/api/mcp', { op: 'call', conv: 'c1', name: 'slash_replay', args: { args: '' } });
    check('/replay opens the pane', r.text.startsWith('Replaying the last turn') && r.text.includes('sidecar://'), r.text);
    await wait(100);
    let tree = v.latest('state').panes[0].tree;
    check('step 1 is the write', text(tree).includes('Step 1/2') && text(tree).includes('+ a'));
    const next = find(tree, (n) => n.type === 'Button' && n.props.label === 'Next');
    await s.call('/api/action', { conv: 'c1', cb: next.props.onPress.$cb, args: [] });
    await wait(100);
    tree = v.latest('state').panes[0].tree;
    check('Next (an atom update) redraws step 2', text(tree).includes('Step 2/2') && text(tree).includes('- old line') && text(tree).includes('+ new line'));
    // Second turn, a Pre with no Post: dropped at Stop, no replay.
    await hook(s, 'PreInvocation', {});
    await hook(s, 'PreToolUse', { stepIdx: 12, toolCall: { name: 'write_to_file', args: { TargetFile: 'C:\\work\\z', CodeContent: 'z' } } });
    await hook(s, 'Stop', {});
    const dbg = await s.call('/api/debug');
    check('a Pre with no Post is dropped at Stop', dbg.instances.find((i) => i.conv === 'c1').pending === 0);
    v.close();
    return v.latest('state');
  },

  async 'porter-spike-side-pane'(s) {
    const v = await view(s, 'c1');
    await s.call('/api/view', { conv: 'c1', cwd: 'C:/work' });
    const list = await s.call('/api/mcp', { op: 'list' });
    const upd = list.tools.find((t) => t.name === 'update');
    check('$.tool.register: update, clear and slash_side-pane listed', upd && list.tools.some((t) => t.name === 'clear') && list.tools.some((t) => t.name === 'slash_side-pane'));
    check('update carries the mod\'s instructions', upd?.description.includes('Fill the side pane') && upd.inputSchema.required?.[0] === 'markdown');
    const pre = await hook(s, 'PreInvocation', {});
    check('prompt.context -> systemMessage step', pre.stdout.includes('"systemMessage":{"systemMessage"') && pre.stdout.includes('mcp__side-pane__update'), pre.stdout.slice(0, 80));
    const r = await s.call('/api/mcp', { op: 'call', conv: 'c1', name: 'update', args: { markdown: '## Plan\n1. Option one\n2. Option two' } });
    check('update handler answers', r.text === 'Side pane updated.', r.text);
    await wait(100);
    const tree = v.latest('state')?.panes[0]?.tree;
    check('pane auto-opened with the items', Boolean(find(tree, (n) => n.type === 'Markdown' && n.props.text === '2. Option two')));
    const quote = find(tree, (n) => n.type === 'Button' && text(n) === 'quote');
    await s.call('/api/action', { conv: 'c1', cb: quote.props.onPress.$cb, args: [] });
    await wait(100);
    check('$.prompt.fill -> copy fallback', v.latest('fill')?.text === '> 1. Option one\n', JSON.stringify(v.latest('fill')));
    const bad = await s.call('/api/mcp', { op: 'call', conv: 'c1', name: 'update', args: { markdown: 5 } });
    check('a { deny } is an MCP error', bad.isError && bad.text === 'markdown must be a string.');
    await s.call('/api/close', { conv: 'c1', id: 'side-pane' });
    await s.call('/api/mcp', { op: 'call', conv: 'c1', name: 'update', args: { markdown: '1. again' } });
    await wait(100);
    check('ui.close by the person stops auto-open', v.latest('state').panes.length === 0);
    const toggled = await s.call('/api/mcp', { op: 'call', conv: 'c1', name: 'slash_side-pane', args: { args: '' } });
    check('/side-pane reopens', toggled.text.startsWith('Side pane opened.'), toggled.text);
    v.close();
    return v.latest('state');
  },
};

for (const [plugin, run] of Object.entries(scenarios)) {
  console.log(`# ${plugin}`);
  const s = await start(plugin);
  try {
    const final = await run(s);
    const port = JSON.parse(readFileSync(join(OUT, plugin, 'sidecars', 'pane', 'port.json'), 'utf8'));
    writeFileSync(join(OUT, `smoke-${plugin}.${port.transform}.json`), JSON.stringify(final?.panes ?? [], null, 2));
  } catch (err) {
    check('scenario ran', false, err.stack);
  } finally {
    s.child.kill();
  }
}
console.log(failed ? `${failed} failed` : 'all ok');
process.exit(failed ? 1 : 0);
