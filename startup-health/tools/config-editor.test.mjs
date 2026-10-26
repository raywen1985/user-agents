import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { editHookFile, editHookText, MATCHER } from './config-editor.mjs';

const command = 'powershell.exe -NoProfile -File "startup-health\\Invoke-StartupHealthHook.ps1" -Owner AIStartupHealthV1';

test('installs exactly one owned hook while retaining comments and unrelated hooks', () => {
  const source = `{
  // retained comment
  "hooks": {
    "SessionStart": [
      {
        "matcher": "startup",
        "hooks": [{ "type": "command", "command": "existing.ps1", "timeout": 5 }]
      },
      {
        "matcher": "old",
        "hooks": [{ "type": "command", "command": "old.ps1 -Owner AIStartupHealthV1", "timeout": 1, "async": false }]
      }
    ]
  },
  "retained": true
}
`;
  const edited = editHookText(source, { action: 'install', command });
  assert.match(edited, /retained comment/);
  assert.match(edited, /existing\.ps1/);
  assert.equal((edited.match(/AIStartupHealthV1/g) ?? []).length, 1);
  assert.match(edited, new RegExp(MATCHER.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.match(edited, /"timeout": 75/);
  assert.match(edited, /"async": true/);
  assert.equal(edited.endsWith('\n'), true);
});

test('removes only owned hooks from a mixed hook entry', () => {
  const source = `{"hooks":{"SessionStart":[{"matcher":"x","hooks":[{"type":"command","command":"keep.ps1"},{"type":"command","command":"owned.ps1 -Owner AIStartupHealthV1"}]}]},"keep":1}`;
  const edited = editHookText(source, { action: 'remove' });
  assert.match(edited, /keep\.ps1/);
  assert.doesNotMatch(edited, /AIStartupHealthV1/);
  assert.match(edited, /"keep":1/);
});

test('rejects duplicate properties at any depth', () => {
  assert.throws(
    () => editHookText('{"hooks":{"SessionStart":[],"SessionStart":[]}}', { action: 'install', command }),
    /Duplicate JSON property/,
  );
});

test('preserves CRLF, indentation, and lack of final newline', () => {
  const source = '{\r\n\t"hooks": {\r\n\t\t"Other": []\r\n\t}\r\n}';
  const edited = editHookText(source, { action: 'install', command });
  assert.equal(edited.includes('\n') && !edited.replaceAll('\r\n', '').includes('\n'), true);
  assert.match(edited, /\r\n\t"hooks"/);
  assert.equal(edited.endsWith('\n'), false);
});

for (const fixture of [
  { name: 'utf8-bom', prefix: Buffer.from([0xef, 0xbb, 0xbf]), bodyEncoding: 'utf8' },
  { name: 'utf16le', prefix: Buffer.from([0xff, 0xfe]), bodyEncoding: 'utf16le' },
]) {
  test(`preserves ${fixture.name} encoding`, () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'config-editor-'));
    const input = path.join(root, 'input.json');
    const output = path.join(root, 'output.json');
    const body = Buffer.from('{\r\n  "hooks": {}\r\n}\r\n', fixture.bodyEncoding);
    fs.writeFileSync(input, Buffer.concat([fixture.prefix, body]));
    const summary = editHookFile({ inputPath: input, outputPath: output, action: 'install', command });
    const bytes = fs.readFileSync(output);
    assert.deepEqual(bytes.subarray(0, fixture.prefix.length), fixture.prefix);
    assert.equal(summary.bom, true);
    fs.rmSync(root, { recursive: true, force: true });
  });
}

test('refuses to overwrite an existing candidate output', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'config-editor-'));
  const input = path.join(root, 'input.json');
  const output = path.join(root, 'output.json');
  fs.writeFileSync(input, '{}');
  fs.writeFileSync(output, 'sentinel');
  assert.throws(() => editHookFile({ inputPath: input, outputPath: output, action: 'install', command }), /EEXIST/);
  assert.equal(fs.readFileSync(output, 'utf8'), 'sentinel');
  fs.rmSync(root, { recursive: true, force: true });
});
