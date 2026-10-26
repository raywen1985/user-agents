import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const roots = ["src", "scripts", "config"];
const files = ["README.md", ".claude/settings.json"];

function* walk(relative) {
  const full = path.join(root, relative);
  for (const entry of fs.readdirSync(full, { withFileTypes: true })) {
    const child = path.join(relative, entry.name);
    if (entry.isDirectory()) yield* walk(child);
    else if (!entry.name.endsWith(".local.json")) files.push(child);
  }
}

for (const directory of roots) {
  for (const file of walk(directory)) files.push(file);
}

test("reusable runtime files do not contain machine-specific absolute paths", () => {
  const violations = [];
  for (const relative of [...new Set(files)]) {
    const text = fs.readFileSync(path.join(root, relative), "utf8");
    if (/Administrator/i.test(text) || /\/\/c\/Users\//i.test(text) || /(?<![A-Za-z])[A-Za-z]:[\\/]/.test(text)) violations.push(relative);
  }
  assert.deepEqual(violations, []);
});
