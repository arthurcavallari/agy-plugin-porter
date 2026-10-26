// Stand-in for the 'claude-code' module a TSX mod imports. Atoms live in the
// conversation's $.state (engine.mjs), so they are per conversation, like Claude
// Code's per-session state. derive and memberOf aren't used by the spike's mods.
const key = (ref) => `${ref.plugin}/${ref.key}${ref.id === undefined ? '' : `#${ref.id}`}`;

export const atom = (ref, initial, options) => Object.freeze({ ref: Object.freeze({ ...ref }), initial, shape: options?.shape });

export async function read($, a) {
  const value = await $.state.get(key(a.ref));
  return value === undefined ? a.initial : value;
}

export async function update($, a, fn) {
  const next = fn(await read($, a));
  await $.state.set(key(a.ref), next);
  return next;
}

export function derive() { throw new Error('derive is not available in the Antigravity port yet'); }
export function memberOf() { throw new Error('memberOf is not available in the Antigravity port yet'); }
