/**
 * Parts from across McMaster's catalog, laid out the way a product page
 * reads: nav links above the product name (some are themselves product
 * names, like "Socket Head Screws"), the spec table under it, related
 * products after. Each case pins the name the parser picked as the title,
 * the search phrase, and which supplier group it goes to.
 *
 * The expectations were reviewed by hand: a low-profile screw has to stay
 * low-profile, a gear has to say which gear, a glove or a switch has to go
 * to suppliers that sell gloves or switches.
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const X = require("../lib/specs");
const cases = require("./catalog.json");

for (const c of cases) {
  test(`catalog: ${c.label}`, () => {
    const specs = { ...X.parseSpecsFromText(c.text), ...X.parseKeyValueText(c.text) };
    assert.equal(specs.title || null, c.title, "title");
    assert.equal(X.buildQuery(specs), c.query, "query");
    assert.equal(X.partFamily(X.normalizeSpecs(specs)), c.family, "family");
  });
}
