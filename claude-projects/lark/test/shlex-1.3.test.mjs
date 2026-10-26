import assert from "node:assert/strict";
import test from "node:test";
import { decodeCanonicalShlex13, shlexJoin13, shlexSplit13 } from "../src/shlex-1.3.mjs";

test("Rust shlex 1.3 fixtures round trip exactly", () => {
  const words = ["C:\\Program Files\\PowerShell\\pwsh.exe", "-Command", "Get-Content -Raw .\\README.md"];
  const encoded = shlexJoin13(words);
  assert.deepEqual(shlexSplit13(encoded), words);
  assert.deepEqual(decodeCanonicalShlex13(encoded), words);
  assert.equal(shlexJoin13([""]), "''");
  assert.equal(shlexJoin13(["foo bar"]), "'foo bar'");
  assert.equal(shlexJoin13(["'foo bar'"]), "\"'foo bar'\"");
});

test("canonical decoder rejects alternate spellings and redaction", () => {
  assert.equal(decodeCanonicalShlex13('"foo"'), null);
  assert.equal(decodeCanonicalShlex13("foo  bar"), null);
  assert.equal(decodeCanonicalShlex13("foo # comment"), null);
  assert.equal(decodeCanonicalShlex13("'[REDACTED_SECRET]'"), null);
  assert.equal(decodeCanonicalShlex13("'unterminated"), null);
});
