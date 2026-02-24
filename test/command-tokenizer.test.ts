import test from "node:test";
import assert from "node:assert/strict";
import { tokenizeArgs } from "../src/utils/command.js";

void test("tokenizeArgs preserves legacy whitespace splitting", () => {
  assert.deepEqual(tokenizeArgs("install npm:pi-extmgr --project"), [
    "install",
    "npm:pi-extmgr",
    "--project",
  ]);
});

void test("tokenizeArgs supports quoted values", () => {
  assert.deepEqual(tokenizeArgs('install "./extensions/My Cool Extension" --project'), [
    "install",
    "./extensions/My Cool Extension",
    "--project",
  ]);

  assert.deepEqual(tokenizeArgs("install 'git@github.com:user/my repo.git'"), [
    "install",
    "git@github.com:user/my repo.git",
  ]);
});

void test("tokenizeArgs keeps windows paths intact", () => {
  assert.deepEqual(tokenizeArgs('install "C:\\Users\\Aya\\Pi Extensions\\ext.ts" --global'), [
    "install",
    "C:\\Users\\Aya\\Pi Extensions\\ext.ts",
    "--global",
  ]);

  assert.deepEqual(tokenizeArgs('install "\\\\server\\share\\ext.ts" --global'), [
    "install",
    "\\\\server\\share\\ext.ts",
    "--global",
  ]);

  assert.deepEqual(tokenizeArgs("install \\\\server\\share\\ext.ts --global"), [
    "install",
    "\\\\server\\share\\ext.ts",
    "--global",
  ]);
});
