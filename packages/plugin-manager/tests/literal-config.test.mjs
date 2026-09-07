import test from 'node:test';
import assert from 'node:assert/strict';
import { parseLiteralConfig } from '../src/literal-config.mjs';

test('literal values preserve quoted paths, JSON and shell-looking text without expansion', () => {
  const allowed = new Set(['PATH_VALUE', 'ARRAY', 'TOKEN', 'EMPTY']);
  assert.deepEqual(parseLiteralConfig('# 中文说明\nPATH_VALUE="C:\\\\中文 路径"\nARRAY=["auth","example"]\nTOKEN=$(do-not-run)\nEMPTY=\n', allowed), {
    PATH_VALUE: 'C:\\中文 路径', ARRAY: '["auth","example"]', TOKEN: '$(do-not-run)', EMPTY: '',
  });
});

test('invalid and repeated input fails without disclosing values', () => {
  const allowed = new Set(['TOKEN']);
  for (const source of ['UNKNOWN=private-sentinel', 'TOKEN=private-sentinel\nTOKEN=next', 'TOKEN="private-sentinel', 'TOKEN="private-sentinel\\n"']) {
    assert.throws(() => parseLiteralConfig(source, allowed), error => !error.message.includes('private-sentinel'));
  }
});
