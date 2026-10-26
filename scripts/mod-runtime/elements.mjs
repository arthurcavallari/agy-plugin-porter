// Element trees for a ported Claude Code mod. Mods compile against bare `h` and
// `Fragment` (esbuild's classic JSX runtime), and get components from $.ui.resolve(e).
// The view (ui-draw.js) decides how each element name is drawn.
const normalize = (c) => (c == null || typeof c === 'boolean' ? [] : Array.isArray(c) ? c.flatMap(normalize)
  : typeof c === 'number' ? [String(c)] : [c]);

export const element = (type, props) => {
  const { children, ...rest } = props ?? {};
  return { type, props: rest, children: normalize(children) };
};

export function installJsxGlobals() {
  globalThis.h = (tag, props, ...children) => {
    const all = { ...(props ?? {}) };
    if (children.length) all.children = children;
    return typeof tag === 'function' ? tag(all) : element(String(tag), all);
  };
  globalThis.Fragment = (props) => element('Box', { flexDirection: 'column', ...props });
}

// $.ui.resolve(e): every element name is a constructor.
export const ELEMENTS = new Proxy({}, {
  get: (_, name) => (typeof name === 'string' && name !== 'then' ? (props) => element(name, props) : undefined),
});

// A tree as JSON for the view. Functions (onPress, onSubmit, ...) become {$cb: id}.
export function serialize(node, cb) {
  if (node == null || typeof node === 'boolean') return null;
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  const kids = (list) => list.map((c) => serialize(c, cb)).filter((c) => c !== null);
  if (Array.isArray(node)) return { type: 'Box', props: { flexDirection: 'column' }, children: kids(node) };
  const props = {};
  for (const [k, v] of Object.entries(node.props ?? {})) props[k] = typeof v === 'function' ? { $cb: cb(v) } : v;
  return { type: node.type, props, children: kids(node.children ?? []) };
}
