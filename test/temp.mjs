// Temp folders for the tests. node --test runs each test file in its own process,
// and the folders are deleted when that process exits: after every after() hook,
// so the sidecars and servers a test file starts have stopped by then.
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { removeTree } from '../lib/source.mjs';

const made = [];
process.on('exit', () => {
  for (const path of made.reverse()) {
    try {
      removeTree(path);
    } catch (err) {
      console.error(`couldn't remove ${path}: ${err.message}`);
    }
  }
});

// Deletes path (a folder or a link) when the test file is done.
export function removeLater(path) {
  made.push(path);
  return path;
}

// A new folder in the OS temp dir, deleted when the test file is done.
export const tempDir = (prefix) => removeLater(mkdtempSync(join(tmpdir(), prefix)));
