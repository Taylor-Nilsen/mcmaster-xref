/**
 * Tests for frontend/bookmarklet.js -- the McMaster-page DOM scraper run
 * from the "McMaster -> Xref" bookmarklet. The real McMaster DOM can't be
 * loaded from this sandbox, so this exercises the scraper two ways:
 *
 *   1. Its pure row-mapping function (`rowsToTableEntries`) directly on
 *      plain arrays -- no DOM at all.
 *   2. Its DOM-facing functions (`findSpecTable`, `extractRows`,
 *      `buildRecord`, ...) against a tiny hand-rolled fake DOM (below)
 *      that implements just enough of `Element`/`Document`
 *      (`querySelector(All)`, `textContent`, `className`) to run the exact
 *      selectors bookmarklet.js uses -- for both the current React spec
 *      table (`product-detail-spec-table`) and the legacy one
 *      (`table.spec-table--pd`), including grouped/indented rows
 *      (Thread -> Size, Head -> Diameter).
 *
 * The record `buildRecord` produces is then fed straight into
 * lib/product.js's own `parseProductRecord`/`classifyProduct`/
 * `buildQueries`, proving end to end that a bookmarklet-scraped page
 * produces the exact same result a server-fetched one would.
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const zlib = require("zlib");

const bookmarklet = require("../../frontend/bookmarklet");
const { parseProductRecord, classifyProduct, buildQueries } = require("../lib/product");

const {
  rowsToTableEntries,
  findSpecTable,
  extractRows,
  extractPartNumber,
  extractTitle,
  extractBreadcrumbs,
  buildRecord,
  toBase64Url,
  encodeRecord,
} = bookmarklet;

// ---------------------------------------------------------------------------
// Tiny fake DOM -- just enough to run the selectors bookmarklet.js uses
// (tag, .class, tag.class, comma lists, and a single two-token descendant
// combinator like "nav[aria-label='breadcrumb'] a").
// ---------------------------------------------------------------------------

class FakeElement {
  constructor(tagName, opts, children) {
    opts = opts || {};
    children = children || [];
    this.tagName = String(tagName).toLowerCase();
    this.className = opts.className || "";
    this.attrs = opts.attrs || {};
    this._text = opts.textContent;
    this.children = children;
    this.parent = null;
    for (const c of children) c.parent = this;
  }
  get textContent() {
    if (this._text != null) return this._text;
    return this.children.map((c) => c.textContent).join("");
  }
  querySelectorAll(selector) {
    return queryAll(this, selector);
  }
  querySelector(selector) {
    return queryAll(this, selector)[0] || null;
  }
}

function el(tag, opts, children) {
  return new FakeElement(tag, opts, children);
}

function hasClassToken(fakeEl, cls) {
  return String(fakeEl.className || "").toLowerCase().indexOf(cls.toLowerCase()) !== -1;
}

function parseToken(token) {
  const m = token.match(/^([a-zA-Z0-9]*)((?:\.[\w-]+)*)(?:\[([\w-]+)=(['"])(.*?)\4\])?$/);
  if (!m) throw new Error(`fake DOM: unsupported selector token "${token}"`);
  return {
    tag: m[1] || null,
    classes: m[2] ? m[2].split(".").filter(Boolean) : [],
    attr: m[3] ? { name: m[3], value: m[5] } : null,
  };
}

function elementMatchesToken(fakeEl, tok) {
  if (tok.tag && fakeEl.tagName !== tok.tag) return false;
  for (const cls of tok.classes) if (!hasClassToken(fakeEl, cls)) return false;
  if (tok.attr && fakeEl.attrs[tok.attr.name] !== tok.attr.value) return false;
  return true;
}

function allDescendants(root) {
  const out = [];
  (function walk(node) {
    for (const c of node.children) {
      out.push(c);
      walk(c);
    }
  })(root);
  return out;
}

function hasMatchingAncestor(fakeEl, tok) {
  let p = fakeEl.parent;
  while (p) {
    if (elementMatchesToken(p, tok)) return true;
    p = p.parent;
  }
  return false;
}

function queryAll(root, selector) {
  const compounds = selector.split(",").map((s) => s.trim());
  const seen = new Set();
  const out = [];
  for (const compound of compounds) {
    const tokens = compound.split(/\s+/).filter(Boolean).map(parseToken);
    if (tokens.length === 0) continue;
    const last = tokens[tokens.length - 1];
    let matches = allDescendants(root).filter((e) => elementMatchesToken(e, last));
    if (tokens.length === 2) matches = matches.filter((e) => hasMatchingAncestor(e, tokens[0]));
    else if (tokens.length > 2) throw new Error("fake DOM: selectors of more than 2 tokens are not supported");
    for (const m of matches) {
      if (!seen.has(m)) {
        seen.add(m);
        out.push(m);
      }
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Fixture builders
// ---------------------------------------------------------------------------

function cell(tag, className, text) {
  return el(tag, { className: className, textContent: text });
}

function row(cells) {
  return el("tr", {}, cells);
}

/**
 * A React-shaped spec table for a 1/4"-20 x 3/4" socket head cap screw:
 * Thread -> Size / Type (grouped), Head -> Diameter (grouped), then a
 * top-level Material row that ends the "Head" group.
 */
function reactSpecTable() {
  return el("table", { className: "styled__Table-abc product-detail-spec-table" }, [
    row([cell("td", "name-cell", "Thread"), cell("td", "value-cell", "")]),
    row([cell("td", "name-cell indent", "Size"), cell("td", "value-cell indent", '1/4"-20')]),
    row([cell("td", "name-cell indent", "Type"), cell("td", "value-cell indent", "Coarse")]),
    // Non-indented: ends the "Thread" group, same as a real McMaster page.
    row([cell("td", "name-cell", "Fastener Head Type"), cell("td", "value-cell", "Socket")]),
    row([cell("td", "name-cell", "Drive Style"), cell("td", "value-cell", "Hex")]),
    row([cell("td", "name-cell", "Head"), cell("td", "value-cell", "")]),
    row([cell("td", "name-cell indent", "Diameter"), cell("td", "value-cell indent", '3/8"')]),
    row([cell("td", "name-cell", "Material"), cell("td", "value-cell", "18-8 Stainless Steel")]),
  ]);
}

/** Same part, legacy markup shape. */
function legacySpecTable() {
  return el("table", { className: "spec-table--pd" }, [
    row([cell("td", "attr-cell--table", "Thread"), cell("td", "value-cell--table", "")]),
    row([cell("td", "attr-cell--table child-attr--table", "Size"), cell("td", "value-cell--table", '1/4"-20')]),
    row([cell("td", "attr-cell--table child-attr--table", "Type"), cell("td", "value-cell--table", "Coarse")]),
    row([cell("td", "attr-cell--table", "Fastener Head Type"), cell("td", "value-cell--table", "Socket")]),
    row([cell("td", "attr-cell--table", "Drive Style"), cell("td", "value-cell--table", "Hex")]),
    row([cell("td", "attr-cell--table", "Head"), cell("td", "value-cell--table", "")]),
    row([cell("td", "attr-cell--table child-attr--table", "Diameter"), cell("td", "value-cell--table", '3/8"')]),
    row([cell("td", "attr-cell--table", "Material"), cell("td", "value-cell--table", "18-8 Stainless Steel")]),
  ]);
}

function pageWithTable(specTable) {
  const h1 = el("h1", { textContent: "Socket Head Screw" });
  const breadcrumbNav = el("nav", { className: "breadcrumb" }, [
    el("a", { textContent: "Fastening and Joining" }),
    el("a", { textContent: "Screws and Bolts" }),
    el("a", { textContent: "Socket Head Screws" }),
  ]);
  return el("body", {}, [h1, breadcrumbNav, specTable]);
}

// ---------------------------------------------------------------------------
// Pure row-mapping logic
// ---------------------------------------------------------------------------

test("rowsToTableEntries: a header row (empty value, not indented) becomes Value=''", () => {
  const entries = rowsToTableEntries([{ name: "Thread", value: "", indented: false }]);
  assert.deepEqual(entries, [{ Name: "Thread", Value: "", IsIndented: false, Type: "TableEntrySpec" }]);
});

test("rowsToTableEntries: indented rows carry IsIndented and their real value", () => {
  const entries = rowsToTableEntries([
    { name: "Thread", value: "", indented: false },
    { name: "Size", value: '1/4"-20', indented: true },
    { name: "Type", value: "Coarse", indented: true },
    { name: "Head", value: "", indented: false },
    { name: "Diameter", value: '3/8"', indented: true },
  ]);
  assert.deepEqual(entries, [
    { Name: "Thread", Value: "", IsIndented: false, Type: "TableEntrySpec" },
    { Name: "Size", Value: '1/4"-20', IsIndented: true, Type: "TableEntrySpec" },
    { Name: "Type", Value: "Coarse", IsIndented: true, Type: "TableEntrySpec" },
    { Name: "Head", Value: "", IsIndented: false, Type: "TableEntrySpec" },
    { Name: "Diameter", Value: '3/8"', IsIndented: true, Type: "TableEntrySpec" },
  ]);
});

test("rowsToTableEntries: an indented row with no value stays a real (blank) spec, not a header", () => {
  const entries = rowsToTableEntries([{ name: "Note", value: "", indented: true }]);
  assert.equal(entries[0].Value, "");
  assert.equal(entries[0].IsIndented, true);
});

test("rowsToTableEntries: rows with no name are dropped", () => {
  const entries = rowsToTableEntries([{ name: "  ", value: "x", indented: false }, { name: "Material", value: "Steel", indented: false }]);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].Name, "Material");
});

// ---------------------------------------------------------------------------
// DOM-facing: current (React) table shape
// ---------------------------------------------------------------------------

test("findSpecTable + extractRows: React table, grouped Thread/Head rows read correctly", () => {
  const doc = pageWithTable(reactSpecTable());
  const info = findSpecTable(doc);
  assert.ok(info);
  assert.equal(info.kind, "react");

  const rows = extractRows(info);
  assert.deepEqual(
    rows.map((r) => [r.name, r.value, r.indented]),
    [
      ["Thread", "", false],
      ["Size", '1/4"-20', true],
      ["Type", "Coarse", true],
      ["Fastener Head Type", "Socket", false],
      ["Drive Style", "Hex", false],
      ["Head", "", false],
      ["Diameter", '3/8"', true],
      ["Material", "18-8 Stainless Steel", false],
    ]
  );
});

test("buildRecord: React table page produces a parseProductRecord-shaped record, part number from the URL path", () => {
  const doc = pageWithTable(reactSpecTable());
  const loc = { pathname: "/91251A540/" };
  const result = buildRecord(doc, loc);
  assert.ok(!result.error, result.error);

  const record = result.record;
  assert.equal(record.PartNbrTxt, "91251A540");
  assert.equal(record.TitleTxt, "Socket Head Screw");
  assert.equal(record.TargetPageMetadata.ProductFamily, "Socket Head Screws");
  assert.deepEqual(
    record.ReactData.Breadcrumbs.map((b) => b.Name),
    ["Fastening and Joining", "Screws and Bolts", "Socket Head Screws"]
  );
  assert.equal(record.ReactData.TableEntries.length, 8);

  // Feed it straight into the real parser/classifier/query builder -- the
  // whole point of matching parseProductRecord's shape.
  const product = parseProductRecord(record);
  assert.equal(product.partNumber, "91251A540");
  assert.equal(product.byName("Size", "Thread"), '1/4"-20');
  assert.equal(product.byName("Diameter", "Head"), '3/8"');

  const { noun, kind } = classifyProduct(product);
  assert.equal(kind, "fastener");
  assert.equal(noun, "socket head cap screw");

  const { primary } = buildQueries(product);
  assert.match(primary, /1\/4"-20 socket head cap screw/i);
  assert.doesNotMatch(primary, /3\/8"/, "the head's own diameter must not leak into the query");
});

// ---------------------------------------------------------------------------
// DOM-facing: legacy table shape
// ---------------------------------------------------------------------------

test("findSpecTable + extractRows: legacy spec-table--pd, child-attr--table marks indented rows", () => {
  const doc = pageWithTable(legacySpecTable());
  const info = findSpecTable(doc);
  assert.ok(info);
  assert.equal(info.kind, "legacy");

  const rows = extractRows(info);
  assert.deepEqual(
    rows.map((r) => [r.name, r.value, r.indented]),
    [
      ["Thread", "", false],
      ["Size", '1/4"-20', true],
      ["Type", "Coarse", true],
      ["Fastener Head Type", "Socket", false],
      ["Drive Style", "Hex", false],
      ["Head", "", false],
      ["Diameter", '3/8"', true],
      ["Material", "18-8 Stainless Steel", false],
    ]
  );
});

test("buildRecord: legacy table page parses identically to the React one through lib/product.js", () => {
  const doc = pageWithTable(legacySpecTable());
  const loc = { pathname: "/en/process/91251A540/" };
  const result = buildRecord(doc, loc);
  assert.ok(!result.error, result.error);

  const product = parseProductRecord(result.record);
  const { noun, kind } = classifyProduct(product);
  assert.equal(kind, "fastener");
  assert.equal(noun, "socket head cap screw");
  const { primary } = buildQueries(product);
  assert.match(primary, /1\/4"-20 socket head cap screw/i);
});

// ---------------------------------------------------------------------------
// Field extraction edge cases
// ---------------------------------------------------------------------------

test("extractPartNumber: reads the last URL path segment that looks like a part number", () => {
  const doc = el("body", {}, []);
  assert.equal(extractPartNumber(doc, { pathname: "/91251A540/" }), "91251A540");
  assert.equal(extractPartNumber(doc, { pathname: "/en-us/91251A540/" }), "91251A540");
  assert.equal(extractPartNumber(doc, { pathname: "/9528K13/" }), "9528K13");
});

test("extractPartNumber: falls back to the h1 when the URL has no part-shaped segment", () => {
  const doc = el("body", {}, [el("h1", { textContent: "Part 91251A540 -- Socket Head Screw" })]);
  assert.equal(extractPartNumber(doc, { pathname: "/product/detail/" }), "91251A540");
});

test("extractTitle: prefers h1, falls back to h3", () => {
  const withH1 = el("body", {}, [el("h1", { textContent: "Socket Head Screw" })]);
  assert.equal(extractTitle(withH1), "Socket Head Screw");

  const withH3Only = el("body", {}, [el("h3", { textContent: "Hex Nut" })]);
  assert.equal(extractTitle(withH3Only), "Hex Nut");
});

test("extractBreadcrumbs: reads names from a .breadcrumb container", () => {
  const doc = el("body", {}, [
    el("nav", { className: "breadcrumb" }, [el("a", { textContent: "Fasteners" }), el("a", { textContent: "Hex Nuts" })]),
  ]);
  assert.deepEqual(extractBreadcrumbs(doc), ["Fasteners", "Hex Nuts"]);
});

test("buildRecord: no spec table on the page -> one-line error, not a throw", () => {
  const doc = el("body", {}, [el("h1", { textContent: "Some Category Page" })]);
  const result = buildRecord(doc, { pathname: "/some-category/" });
  assert.ok(result.error);
  assert.equal(typeof result.error, "string");
  assert.ok(result.error.length < 200);
});

test("buildRecord: spec table present but empty -> one-line error", () => {
  const doc = pageWithTable(el("table", { className: "product-detail-spec-table" }, []));
  const result = buildRecord(doc, { pathname: "/91251A540/" });
  assert.ok(result.error);
});

// ---------------------------------------------------------------------------
// Fragment encoding: compressed and plain paths both decode back to the
// original JSON. Node has CompressionStream/DecompressionStream (18+) and
// btoa/atob globally, same as a modern browser, so this exercises the
// actual encodeRecord the bookmarklet runs, not a reimplementation.
// ---------------------------------------------------------------------------

function fromBase64Url(str) {
  const padded = str.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(str.length / 4) * 4, "=");
  return Buffer.from(padded, "base64");
}

test("encodeRecord: deflate-raw path ('dr.' prefix) decodes back to the original JSON", async () => {
  const record = { PartNbrTxt: "91251A540", TitleTxt: "Socket Head Screw" };
  const encoded = await encodeRecord(record);
  assert.match(encoded, /^dr\./, "CompressionStream is available in this Node runtime, so the compressed path should be used");
  const bytes = fromBase64Url(encoded.slice(3));
  const inflated = zlib.inflateRawSync(bytes);
  assert.deepEqual(JSON.parse(inflated.toString("utf8")), record);
});

test("encodeRecord: plain path ('raw.' prefix) is used when CompressionStream is unavailable, and decodes back", async () => {
  const original = global.CompressionStream;
  // @ts-ignore -- deliberately simulate an older browser for this one test
  global.CompressionStream = undefined;
  try {
    const record = { PartNbrTxt: "9528K13", TitleTxt: "Steel Ball" };
    const encoded = await encodeRecord(record);
    assert.match(encoded, /^raw\./);
    const bytes = fromBase64Url(encoded.slice(4));
    assert.deepEqual(JSON.parse(bytes.toString("utf8")), record);
  } finally {
    global.CompressionStream = original;
  }
});

test("toBase64Url: no padding, URL-safe alphabet", () => {
  const encoded = toBase64Url(new TextEncoder().encode("hi!!"));
  assert.ok(!/[+/=]/.test(encoded));
});

// ---------------------------------------------------------------------------
// run(): wires buildRecord -> encodeRecord -> open, or alert on error
// ---------------------------------------------------------------------------

test("run(): opens PAGES_URL with a #r= fragment on success", async () => {
  const doc = pageWithTable(reactSpecTable());
  const loc = { pathname: "/91251A540/" };
  let openedUrl = null;
  let alerted = null;
  await bookmarklet.run(doc, loc, {
    open: (url) => {
      openedUrl = url;
    },
    alert: (msg) => {
      alerted = msg;
    },
  });
  assert.equal(alerted, null);
  assert.ok(openedUrl);
  assert.ok(openedUrl.startsWith(bookmarklet.PAGES_URL + "#r="), openedUrl);
});

test("run(): alerts a one-line reason and does not open anything when the spec table is missing", async () => {
  const doc = el("body", {}, [el("h1", { textContent: "Category page" })]);
  let openedUrl = null;
  let alerted = null;
  await bookmarklet.run(doc, { pathname: "/some-category/" }, {
    open: (url) => {
      openedUrl = url;
    },
    alert: (msg) => {
      alerted = msg;
    },
  });
  assert.equal(openedUrl, null);
  assert.ok(alerted);
  assert.ok(alerted.startsWith("McMaster → Xref:"));
});

test("PAGES_URL points at this repo's GitHub Pages site", () => {
  assert.equal(bookmarklet.PAGES_URL, "https://taylor-nilsen.github.io/mcmaster-xref/");
});
