import assert from 'node:assert/strict';
import { test } from 'node:test';

import { formatFrontmatter, parseYaml, splitFrontmatter } from '../lib/yaml-lite.mjs';

test('roomodes-style YAML: nested sequences, block scalars, flow lists', () => {
  const parsed = parseYaml(`customModes:
  - slug: docs-writer
    name: 📝 Docs Writer
    roleDefinition: >-
      You are a technical writer
      who keeps docs short.
    customInstructions: |-
      Keep sentences short.
      Use sentence case.
    groups:
      - read
      - - edit
        - fileRegex: \\.md$
          description: Markdown files only
      - command
  - slug: reviewer
    roleDefinition: "You review code: never edit."   # trailing comment
    groups: [read, browser, mcp]
`);
  assert.deepEqual(parsed.customModes[0], {
    slug: 'docs-writer',
    name: '📝 Docs Writer',
    roleDefinition: 'You are a technical writer who keeps docs short.',
    customInstructions: 'Keep sentences short.\nUse sentence case.',
    groups: ['read', ['edit', { fileRegex: '\\.md$', description: 'Markdown files only' }], 'command'],
  });
  assert.deepEqual(parsed.customModes[1], { slug: 'reviewer', roleDefinition: 'You review code: never edit.', groups: ['read', 'browser', 'mcp'] });
});

test('scalars and tolerant plain values', () => {
  const parsed = parseYaml(`a: true
b: 12
c: ~
d: 'it''s'
e: Runs checks: lint and test
f: Bash(git diff:*), Read
g:
h: [focus-area]
i: a plain value
  continued on the next line
j: |
  kept
`);
  assert.deepEqual(parsed, {
    a: true, b: 12, c: null, d: "it's", e: 'Runs checks: lint and test', f: 'Bash(git diff:*), Read',
    g: null, h: ['focus-area'], i: 'a plain value continued on the next line', j: 'kept\n',
  });
});

test('splitFrontmatter and formatFrontmatter', () => {
  const { data, body, hasFrontmatter } = splitFrontmatter('﻿---\r\nname: x\r\ntools: Read, Grep\r\n---\r\n\r\nBody --- text\r\n');
  assert.equal(hasFrontmatter, true);
  assert.deepEqual(data, { name: 'x', tools: 'Read, Grep' });
  assert.equal(body, '\nBody --- text\n');
  assert.equal(splitFrontmatter('no frontmatter').hasFrontmatter, false);
  assert.deepEqual(splitFrontmatter('---\n---\nbody').data, {});

  const out = formatFrontmatter({ name: 'a', description: 'Use when: x', tools: ['view_file'], empty: [], skip: null, on: true }, '\nbody\n');
  assert.equal(out, '---\nname: a\ndescription: "Use when: x"\ntools:\n  - view_file\nempty: []\non: true\n---\n\nbody\n');
  assert.deepEqual(splitFrontmatter(out).data, { name: 'a', description: 'Use when: x', tools: ['view_file'], empty: [], on: true });
  assert.equal(splitFrontmatter(formatFrontmatter({ v: 'true', n: '12' }, '')).data.v, 'true');
});

test('bad indentation throws', () => {
  assert.throws(() => parseYaml('a: 1\n  b: 2\nc'), /yaml:/);
});
