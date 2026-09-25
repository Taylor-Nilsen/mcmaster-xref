/**
 * Pure parsing tests for lib/mcmaster.js's parseFragment(). These never
 * touch the network or launch a browser - they replay captured
 * ItmPrsnttnWebPart response bodies from test/fixtures/mcmaster/*.raw.
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

const { parseFragment } = require("../lib/mcmaster");

const FIXTURES_DIR = path.join(__dirname, "fixtures", "mcmaster");

const fixtureFiles = fs
  .readdirSync(FIXTURES_DIR)
  .filter((f) => f.endsWith(".raw"))
  .sort();

test("fixtures directory has .raw fixtures to test against", () => {
  assert.ok(fixtureFiles.length > 0, "expected at least one .raw fixture");
});

for (const file of fixtureFiles) {
  test(`parseFragment parses ${file}`, () => {
    const raw = fs.readFileSync(path.join(FIXTURES_DIR, file));
    const json = parseFragment(raw);

    assert.ok(json && typeof json === "object", "parseFragment should return an object");
    assert.equal(typeof json.TitleTxt, "string");
    assert.ok(json.TitleTxt.length > 0, "TitleTxt should be non-empty");

    const tableEntries = json.ReactData && json.ReactData.TableEntries;
    assert.ok(Array.isArray(tableEntries), "ReactData.TableEntries should be an array");
    assert.ok(tableEntries.length > 0, "TableEntries should be non-empty");

    for (const entry of tableEntries) {
      assert.ok("Name" in entry);
      assert.ok("Value" in entry);
    }
  });
}

test("parseFragment throws a plain Error when given garbage", () => {
  assert.throws(() => parseFragment("not json at all, no braces here"));
});

test("parseFragment falls back to balanced-brace scan when the length prefix is wrong/missing", () => {
  const obj = { TitleTxt: "Test Part", ReactData: { TableEntries: [{ Name: "A", Value: "1" }] } };
  const body = "0000000001" + JSON.stringify(obj) + "<div>trailing html</div>";
  const parsed = parseFragment(body);
  assert.equal(parsed.TitleTxt, "Test Part");
});

test("parseFragment handles multi-byte characters in the length-prefixed JSON", () => {
  // The 10-digit prefix counts JS string characters (UTF-16 code units),
  // not UTF-8 bytes - a value containing a multi-byte char like the degree
  // sign must still slice correctly.
  const obj = { TitleTxt: "Steel Rod, 90° Angle", ReactData: { TableEntries: [] } };
  const jsonStr = JSON.stringify(obj);
  const prefix = String(jsonStr.length).padStart(10, "0");
  const body = Buffer.from(prefix + jsonStr + "<div id='trailer'></div>", "utf-8");
  const parsed = parseFragment(body);
  assert.equal(parsed.TitleTxt, "Steel Rod, 90° Angle");
});
