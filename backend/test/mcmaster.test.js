/**
 * Pure parsing tests for lib/mcmaster.js's parseFragment(). These never
 * touch the network or launch a browser - they replay captured
 * ItmPrsnttnWebPart response bodies from test/fixtures/mcmaster/*.raw.
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

const { parseFragment, validateProductRecord, attemptFetch } = require("../lib/mcmaster");

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

// ---------------------------------------------------------------------------
// attemptFetch - context/page teardown, driven with a fake browser so no
// real Chromium process is ever launched by this suite.
// ---------------------------------------------------------------------------

test("attemptFetch closes the context even when page creation itself throws (no context leak)", async () => {
  let contextClosed = false;
  const fakeCtx = {
    newPage: async () => {
      throw new Error("boom: simulated newPage failure");
    },
    close: async () => {
      contextClosed = true;
    },
  };
  const fakeBrowser = {
    newContext: async () => fakeCtx,
  };

  await assert.rejects(() => attemptFetch("91251A540", 5000, fakeBrowser), /boom: simulated newPage failure/);
  assert.equal(contextClosed, true, "the context created before the throw must still be closed");
});

// ---------------------------------------------------------------------------
// validateProductRecord - guards against a fragment that parses as JSON but
// is not a product record (see server.js's file header / the file-level
// comment above validateProductRecord in lib/mcmaster.js for the live defect
// this covers).
// ---------------------------------------------------------------------------

test("validateProductRecord accepts a real fixture's parsed record", () => {
  const raw = fs.readFileSync(path.join(FIXTURES_DIR, fixtureFiles[0]));
  const json = parseFragment(raw);
  assert.doesNotThrow(() => validateProductRecord(json));
});

test("validateProductRecord rejects a family-listing-shaped record with NO_DATA, naming the page type", () => {
  const notAProduct = { NewStyleIndicator: true, TargetPageMetadata: { Type: "product_family" } };
  assert.throws(
    () => validateProductRecord(notAProduct),
    (err) => {
      assert.equal(err.code, "NO_DATA");
      assert.match(err.message, /product_family/);
      assert.equal(err.record, notAProduct);
      return true;
    },
  );
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
