/**
 * Tests for lib/product.js -- the structured-record parser, classifier and
 * query builder that replace the innerText regex parsing in lib/specs.js
 * (that file's own tests, test/specs.test.js, are left in place and still
 * pass; this file does not touch them).
 *
 * The fixtures in test/fixtures/mcmaster/*.raw are real captured McMaster
 * product pages: `<10-digit byte length prefix><JSON><trailing HTML>`.
 * parseProductRecord is handed the raw file contents directly (a Buffer),
 * the same shape a fetch layer would hand it, and finds the JSON itself.
 *
 * The second half of this file builds synthetic records, by hand, in the
 * same shape McMaster's real ReactData.TableEntries/Breadcrumbs use, to
 * exercise product categories none of the five captured fixtures cover:
 * a metric screw, an o-ring, raw bar stock, a ball bearing, a pipe
 * fitting and a spring. This is what proves the classification and query
 * rules are generic rather than fixture-specific.
 */

const fs = require("fs");
const path = require("path");
const test = require("node:test");
const assert = require("node:assert/strict");

const {
  parseProductRecord,
  classifyProduct,
  buildQueries,
  buildSupplierLinks,
  cleanValue,
  normalizeThread,
  normalizeGauge,
} = require("../lib/product");

const FIXTURES_DIR = path.join(__dirname, "fixtures", "mcmaster");
const loadFixture = (name) => parseProductRecord(fs.readFileSync(path.join(FIXTURES_DIR, `${name}.raw`)));

// ---------------------------------------------------------------------------
// Real fixtures
// ---------------------------------------------------------------------------

test("91251A540: socket head screw -- thread and length parse, head diameter never leaks into the query", () => {
  const product = loadFixture("91251A540");
  assert.equal(product.partNumber, "91251A540");
  assert.equal(product.family, "Socket Head Screws");
  assert.equal(product.byName("Size", "Thread"), '1/4"-20');
  assert.equal(product.byName("Length"), '3/4"');
  // The *head* diameter lives under the "Head" group and is a different
  // field entirely from the thread size -- this is the exact bug the old
  // prose parser had (it read the head's 3/8" diameter as the screw size).
  assert.equal(product.byName("Diameter", "Head"), '3/8"');

  const { noun, kind } = classifyProduct(product);
  assert.equal(kind, "fastener");
  assert.equal(noun, "socket head cap screw");

  const { primary, terms } = buildQueries(product);
  assert.equal(terms.threadSize, '1/4"-20');
  assert.equal(terms.length, '3/4"');
  assert.match(primary, /1\/4"-20 x 3\/4" socket head cap screw/i);
  assert.doesNotMatch(primary, /3\/8"/, "the head's own diameter must not appear in the query");
});

test("90480A005: hex nut -- thread size and noun, not a screw", () => {
  const product = loadFixture("90480A005");
  const { noun, kind } = classifyProduct(product);
  assert.equal(kind, "nut");
  assert.equal(noun, "hex nut");

  const { primary, terms } = buildQueries(product);
  assert.equal(terms.threadSize, "4-40");
  assert.match(primary, /^4-40 hex nut\b/i);
  assert.doesNotMatch(primary, /screw/i);
});

test("91102A029: split lock washer -- classified as washer, carries the screw size it fits", () => {
  const product = loadFixture("91102A029");
  const { noun, kind } = classifyProduct(product);
  assert.equal(kind, "washer");
  assert.equal(noun, "split lock washer");

  const { primary, terms } = buildQueries(product);
  assert.equal(terms.screwSize, '1/4"');
  assert.match(primary, /1\/4"/);
  assert.match(primary, /split lock washer/i);
});

test("9528K13: 52100 steel ball -- rawstock, size + grade + noun, no 'alloy' filler, chrome steel offered as an alternate", () => {
  const product = loadFixture("9528K13");
  assert.equal(product.byName("Diameter"), '3/16"');

  const { noun, kind } = classifyProduct(product);
  assert.equal(noun, "steel ball");
  assert.ok(kind === "rawstock" || kind === "other", `expected rawstock or other, got ${kind}`);

  const { primary, alternates } = buildQueries(product);
  assert.equal(primary, '3/16" 52100 steel ball');
  assert.ok(
    alternates.some((a) => /chrome steel/i.test(a)),
    `expected an alternate mentioning "chrome steel", got ${JSON.stringify(alternates)}`
  );
});

test("92196A106: 4-40 x 1/4 stainless socket head cap screw", () => {
  const product = loadFixture("92196A106");
  const { noun, kind } = classifyProduct(product);
  assert.equal(kind, "fastener");
  assert.equal(noun, "socket head cap screw");

  const { primary } = buildQueries(product);
  assert.match(primary.toLowerCase(), /4-40 x 1\/4" socket head cap screw/);
  assert.match(primary.toLowerCase(), /18-8 stainless/);
});

test("attributes are preserved in full, including nested Material Composition rows", () => {
  const product = loadFixture("9528K13");
  const names = product.attributes.map((a) => a.name);
  assert.ok(names.includes("Yield Strength"));
  assert.ok(names.includes("Hardness Rating"));
  const carbon = product.attributes.find((a) => a.group === "Material Composition" && a.name === "Carbon");
  assert.ok(carbon, "expected an indented Material Composition row for Carbon");
  assert.equal(carbon.value, "0.93% to 1.10%");
});

test("buildSupplierLinks routes fasteners/nuts/washers to the fastener supplier set with Bolt Depot", () => {
  const product = loadFixture("91251A540");
  const links = buildSupplierLinks(product);
  const names = links.map((l) => l.supplier);
  assert.deepEqual(names, ["Fastenal", "Grainger", "MSC Direct", "Bolt Depot", "Amazon", "AliExpress", "Banggood"]);
  for (const link of links) assert.match(link.url, /^https:\/\//);
  const boltDepot = links.find((l) => l.supplier === "Bolt Depot");
  assert.match(boltDepot.url, /Category=Socket_screws/);
});

test("buildSupplierLinks routes raw stock to the metal suppliers, dropping dimensions for the dimensionless ones", () => {
  const product = loadFixture("9528K13");
  const links = buildSupplierLinks(product);
  const names = links.map((l) => l.supplier);
  assert.deepEqual(names, ["Speedy Metals", "Metal Supermarkets", "MSC Direct", "Grainger", "Online Metals"]);
  const speedy = links.find((l) => l.supplier === "Speedy Metals");
  assert.ok(!/3\/16/.test(speedy.query), "dimensionless supplier should have the size stripped");
  const msc = links.find((l) => l.supplier === "MSC Direct");
  assert.ok(/3\/16/.test(msc.query), "a distributor that indexes dimensions should keep them");
});

// ---------------------------------------------------------------------------
// Synthetic records: shapes not covered by the captured fixtures
// ---------------------------------------------------------------------------

// Small builders that produce the same JSON shape as a real McMaster
// product record's embedded webpart payload, so parseProductRecord is
// exercised the same way for these as for the fixtures above.
function specRow(name, value, isIndented = false) {
  return { AttrId: 1, AttrValId: 1, IsIndented: isIndented, Name: name, Type: "TableEntrySpec", Value: value };
}
function groupHeader(name) {
  return { AttrId: 0, AttrValId: 0, IsIndented: false, Name: name, Type: "TableEntrySpec", Value: "" };
}
function crumb(name, nodeType) {
  return { OutlineEntryId: 1, Name: name, Href: "/x/", NodeType: nodeType };
}
function record({ part, title, family, breadcrumbs, entries, copies }) {
  return {
    PartNbrTxt: part,
    TitleTxt: title,
    TargetPageMetadata: { ProductFamily: family },
    ReactData: {
      Breadcrumbs: [...breadcrumbs, crumb(part, "")],
      TableEntries: entries,
      Copies: copies || [],
    },
    CtlgPgNbrs: [],
  };
}

test("synthetic: metric socket head screw -- M6 x 1 mm normalizes to M6-1, mm length loses its space", () => {
  const product = parseProductRecord(
    record({
      part: "91290A123",
      title: 'Class 12.9 Alloy Steel Socket Head Screw, M6 x 1 mm Thread Size, 20 mm Long',
      family: "Socket Head Screws",
      breadcrumbs: [
        crumb("Fastening and Joining", "product-category"),
        crumb("Screws and Bolts", "product-line-2"),
        crumb("Socket Head Screws", "product-family"),
        crumb("Alloy Steel Socket Head Screws", "presentation"),
      ],
      entries: [
        groupHeader("Thread"),
        specRow("Size", "M6 x 1 mm", true),
        specRow("Length", "20 mm", false),
        groupHeader("Head"),
        specRow("Diameter", "10 mm", true),
        specRow("Fastener Head Type", "Socket", false),
        specRow("Drive Style", "Hex", false),
        specRow("Material", "Class 12.9 Alloy Steel", false),
      ],
    })
  );

  const { noun, kind } = classifyProduct(product);
  assert.equal(kind, "fastener");
  assert.equal(noun, "socket head cap screw");

  const { primary, terms } = buildQueries(product);
  assert.equal(terms.threadSize, "M6-1");
  assert.equal(terms.length, "20mm");
  assert.match(primary, /^M6-1 x 20mm socket head cap screw/);
  assert.doesNotMatch(primary, /10 ?mm/, "the head diameter must not leak into the query");
});

test("synthetic: o-ring -- sealing kind, ID and width lead the query", () => {
  const product = parseProductRecord(
    record({
      part: "9452K12",
      title: 'Buna-N O-Ring, 1/4" ID, 1/16" Width',
      family: "O-Rings",
      breadcrumbs: [crumb("Sealing Devices", "product-category"), crumb("O-Rings", "product-family")],
      entries: [
        specRow("Material", "Buna-N Rubber", false),
        specRow("Inside Diameter", '1/4"', false),
        specRow("Width", '1/16"', false),
        specRow("Durometer", "70A", false),
      ],
    })
  );

  const { noun, kind } = classifyProduct(product);
  assert.equal(kind, "sealing");
  assert.equal(noun, "o-ring");

  const { primary } = buildQueries(product);
  assert.match(primary, /1\/4" ID/);
  assert.match(primary, /1\/16" wide/);
  assert.match(primary, /o-ring/);
});

test("synthetic: 6061 aluminum round bar -- rawstock, grade prefixes the material+shape noun, no length", () => {
  const product = parseProductRecord(
    record({
      part: "8975K261",
      title: 'Multipurpose 6061 Aluminum Round Bar, 1/2" Diameter, 3 ft. Long',
      family: "Aluminum",
      breadcrumbs: [
        crumb("Raw Materials", "product-category"),
        crumb("Metals", "product-line-1"),
        crumb("Aluminum", "product-family"),
        crumb("Aluminum Round Bar", "presentation"),
      ],
      entries: [
        specRow("Material", "6061 Aluminum", false),
        specRow("Shape", "Round Bar", false),
        specRow("Diameter", '1/2"', false),
        specRow("Length", "3 ft.", false),
      ],
    })
  );

  const { noun, kind } = classifyProduct(product);
  assert.equal(kind, "rawstock");
  assert.equal(noun, "aluminum round bar");

  const { primary } = buildQueries(product);
  assert.equal(primary, '1/2" 6061 aluminum round bar');
  assert.doesNotMatch(primary, /3 ?ft/, "stock length should not narrow a cut-to-order search");
});

test("synthetic: ball bearing -- bearing kind, bore and OD lead the query", () => {
  const product = parseProductRecord(
    record({
      part: "60355K33",
      title: '440C Stainless Steel Ball Bearing, 1/2" Bore, 1-1/8" OD',
      family: "Ball Bearings",
      breadcrumbs: [crumb("Bearings", "product-category"), crumb("Ball Bearings", "product-family")],
      entries: [
        specRow("Bore", '1/2"', false),
        specRow("OD", "1-1/8\"", false),
        specRow("Width", '5/16"', false),
        specRow("Material", "440C Stainless Steel", false),
      ],
    })
  );

  const { noun, kind } = classifyProduct(product);
  assert.equal(kind, "bearing");
  assert.equal(noun, "ball bearing");

  const { primary } = buildQueries(product);
  assert.match(primary, /1\/2" bore/);
  assert.match(primary, /1-1\/8" OD/);
  assert.match(primary, /ball bearing/);
});

test("synthetic: pipe nipple -- fitting kind, routed to the MRO supplier set", () => {
  const product = parseProductRecord(
    record({
      part: "48605K111",
      title: 'Steel Pipe Nipple, 1/2" Pipe Size, 2" Long',
      family: "Pipe Nipples",
      breadcrumbs: [
        crumb("Plumbing", "product-category"),
        crumb("Pipe Fittings", "product-line-1"),
        crumb("Pipe Nipples", "product-family"),
      ],
      entries: [specRow("Pipe Size", '1/2"', false), specRow("Length", '2"', false), specRow("Material", "Steel", false)],
    })
  );

  const { noun, kind } = classifyProduct(product);
  assert.equal(kind, "fitting");
  assert.equal(noun, "pipe nipple");

  const links = buildSupplierLinks(product);
  assert.deepEqual(links.map((l) => l.supplier), ["Grainger", "MSC Direct", "Zoro", "Amazon"]);
});

test("synthetic: compression spring -- falls through to the generic 'other' kind with a sensible noun", () => {
  const product = parseProductRecord(
    record({
      part: "9657K21",
      title: 'Music Wire Steel Compression Spring, 1/2" OD, 2" Long',
      family: "Compression Springs",
      breadcrumbs: [crumb("Springs", "product-category"), crumb("Compression Springs", "product-family")],
      entries: [
        specRow("Wire Diameter", '0.035"', false),
        specRow("OD", '1/2"', false),
        specRow("Free Length", '2"', false),
        specRow("Material", "Music Wire Steel", false),
      ],
    })
  );

  const { noun, kind } = classifyProduct(product);
  assert.equal(kind, "other");
  assert.equal(noun, "compression spring");

  const { primary } = buildQueries(product);
  assert.match(primary, /compression spring/);
  assert.match(primary, /0\.035" wire/);
});

// ---------------------------------------------------------------------------
// Small unit checks on the standalone helpers
// ---------------------------------------------------------------------------

test("cleanValue strips McMaster's fraction spans and decodes entities", () => {
  assert.equal(cleanValue('<span class="af">1/4</span>"'), '1/4"');
  assert.equal(cleanValue("Class 12.9 &amp; up"), "Class 12.9 & up");
});

test("normalizeThread / normalizeGauge match the documented lessons", () => {
  assert.equal(normalizeThread("M6 x 1 mm"), "M6-1");
  assert.equal(normalizeThread('1/4"-20'), '1/4"-20');
  assert.equal(normalizeGauge("8"), "#8");
  assert.equal(normalizeGauge("1/4\""), '1/4"');
});

test("parseProductRecord accepts a Buffer, a string, or an already-parsed object", () => {
  const buf = fs.readFileSync(path.join(FIXTURES_DIR, "90480A005.raw"));
  const fromBuffer = parseProductRecord(buf);
  const fromString = parseProductRecord(buf.toString("utf8"));
  assert.equal(fromBuffer.partNumber, "90480A005");
  assert.equal(fromString.partNumber, "90480A005");

  const rec = record({
    part: "TEST1",
    title: "Test Part",
    family: "Test Family",
    breadcrumbs: [crumb("Test Category", "product-category")],
    entries: [specRow("Material", "Steel", false)],
  });
  const fromObject = parseProductRecord(rec);
  assert.equal(fromObject.partNumber, "TEST1");
  assert.equal(fromObject.byName("Material"), "Steel");
});
