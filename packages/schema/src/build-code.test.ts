import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import {
  BUILD_CODE_PREFIX,
  decodeBuildCode,
  encodeBuildCode,
  isBuildCode,
  parseBuild,
  readBuildText,
} from "./build-code.js";
import { emptyBuild } from "./build-doc.js";

const example = readFileSync(new URL("../../../examples/lagionaire.json", import.meta.url), "utf8");

test("a code round-trips to the same document", async () => {
  const { doc } = parseBuild(example);
  const code = await encodeBuildCode(doc);
  assert.ok(code.startsWith(BUILD_CODE_PREFIX));
  assert.match(code.slice(BUILD_CODE_PREFIX.length), /^[A-Za-z0-9_-]+$/);
  assert.deepEqual(await decodeBuildCode(code), doc);
});

test("a code is much smaller than the file it came from", async () => {
  const code = await encodeBuildCode(parseBuild(example).doc);
  assert.ok(code.length < example.length / 2, `${code.length} vs ${example.length}`);
});

test("a code survives the line breaks a chat window wraps it with", async () => {
  const doc = emptyBuild(42);
  const code = await encodeBuildCode(doc);
  const wrapped = `  ${code.slice(0, 10)}\n${code.slice(10, 20)}\r\n${code.slice(20)}  `;
  assert.deepEqual(await decodeBuildCode(wrapped), doc);
});

test("a code cut short says so", async () => {
  const code = await encodeBuildCode(parseBuild(example).doc);
  await assert.rejects(decodeBuildCode(code.slice(0, code.length / 2)), /cut off/);
});

test("text that is not a code is refused by the decoder", async () => {
  await assert.rejects(decodeBuildCode("{}"), /Not a build code/);
});

test("readBuildText takes a code, a document or a capture", async () => {
  const doc = emptyBuild(7);
  assert.deepEqual((await readBuildText(await encodeBuildCode(doc))).doc, doc);
  assert.deepEqual((await readBuildText(JSON.stringify(doc))).doc, doc);

  const capture = { name: "x", build: doc, observed: { source: "mod_dump", stats: [] } };
  assert.deepEqual((await readBuildText(JSON.stringify(capture))).doc, doc);
});

test("isBuildCode ignores surrounding whitespace and nothing else", () => {
  assert.equal(isBuildCode(`\n ${BUILD_CODE_PREFIX}abc`), true);
  assert.equal(isBuildCode('{"cob1:": 1}'), false);
});

test("a JSON object that is not a build is refused", () => {
  assert.throws(() => parseBuild('{"name": "an item"}'), /character/);
  assert.throws(() => parseBuild("[]"), /character/);
});
