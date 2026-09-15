/**
 * The category matrix: one real part per McMaster family, with the
 * label/value block the product page renders and the search phrase the
 * app should build from it.
 *
 * The expectations in categories.json are reviewed, not captured -- each
 * one was read against what a supplier's catalog actually calls that part
 * before being pinned here. Four were wrong when the matrix was first run
 * (a Phillips flat head sold as a socket cap screw, a bare gauge size, a
 * bearing missing its inside diameter, a gasket missing its thickness);
 * those are fixed, and this file is what stops them coming back.
 *
 * server.js runs the same file against a live deployment under
 * RUN_SWEEP=1, so the local suite and the deployed instance are held to
 * one set of answers.
 */

const test = require("node:test");
const assert = require("node:assert/strict");

const { parseSpecsFromText, parseKeyValueText, buildQuery, buildSupplierLinks } = require("../lib/specs");
const CASES = require("./categories.json");

const parsePage = (text) => ({ ...parseSpecsFromText(text), ...parseKeyValueText(text) });

test("the category matrix covers every routing family and is well formed", () => {
  assert.ok(CASES.length >= 110, `only ${CASES.length} cases`);
  for (const c of CASES) {
    assert.ok(c.part && c.label && c.pastedText && c.expect, `incomplete case: ${c.label}`);
  }

  // Every family the router can return needs real coverage, since each one
  // is a different query shape and a different supplier list. Five is the
  // floor; the families that were wrong when this was first swept -- nuts,
  // washers, seals, everything bored -- are the reason for the floor.
  const { partFamily, parseSpecsFromText: pf, parseKeyValueText: pk } = require("../lib/specs");
  const counts = {};
  for (const c of CASES) {
    const fam = partFamily({ ...pf(c.pastedText), ...pk(c.pastedText) });
    counts[fam] = (counts[fam] || 0) + 1;
  }
  for (const fam of ["fastener", "nut", "washer", "sealing", "rawstock", "fitting", "other"]) {
    assert.ok((counts[fam] || 0) >= 5, `${fam}: only ${counts[fam] || 0} cases`);
  }
});

for (const c of CASES) {
  test(`${c.label} (${c.part}) builds its catalog phrase`, () => {
    assert.equal(buildQuery(parsePage(c.pastedText)), c.expect);
  });

  test(`${c.label} (${c.part}) links are well formed`, () => {
    const links = buildSupplierLinks(parsePage(c.pastedText));
    assert.ok(links.length > 0, "no suppliers");
    for (const link of links) {
      const url = new URL(link.url);
      assert.equal(url.protocol, "https:");
      assert.ok(!/[{}]/.test(link.url), `unsubstituted placeholder: ${link.url}`);
      // The search parameter must decode back to exactly the query, which
      // is what catches an encoding bug rather than a formatting opinion.
      const param = ["query", "searchQuery", "searchterm", "k", "SearchText", "text", "searchTerm"]
        .find((p) => url.searchParams.has(p));
      if (param) assert.equal(url.searchParams.get(param), c.expect);
    }
  });
}
