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
  extractJsonObject,
  stripDimensions,
  toSlug,
  aliExpressWholesaleUrl,
  speedyMetalsQuery,
} = require("../lib/product");

// Rebuilds a McMaster-shaped record from a POST /api/xref response's
// `product` field -- reused rather than duplicated by hand, since
// backend/scripts/evaluate-records.js already has to solve exactly this
// problem to run the remote-sweep captures through this same module.
const { recordFromApiProduct } = require("../scripts/evaluate-records");

const FIXTURES_DIR = path.join(__dirname, "fixtures", "mcmaster");
const REMOTE_FIXTURES_DIR = path.join(FIXTURES_DIR, "remote");

// Loads a POST /api/xref response captured under test/fixtures/mcmaster/
// remote/<part>.json (see backend/scripts/remote-sweep.js) and returns the
// parsed Product, the same way evaluate-records.js does for the report.
function loadRemoteFixture(part) {
  const raw = JSON.parse(fs.readFileSync(path.join(REMOTE_FIXTURES_DIR, `${part}.json`), "utf8"));
  return parseProductRecord(recordFromApiProduct(raw.product));
}
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
  assert.deepEqual(names, ["Fastenal", "Grainger", "MSC Direct", "Bolt Depot", "Amazon", "AliExpress"]);
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

test("buildSupplierLinks: every link carries a verified field, and Metal Supermarkets carries a note", () => {
  const fastenerLinks = buildSupplierLinks(loadFixture("91251A540"));
  for (const link of fastenerLinks) assert.ok(link.verified, `${link.supplier} link is missing a verified field`);
  const fastenal = fastenerLinks.find((l) => l.supplier === "Fastenal");
  assert.equal(fastenal.verified, "browser-only");
  const aliExpress = fastenerLinks.find((l) => l.supplier === "AliExpress");
  assert.equal(aliExpress.verified, "renders");

  const rawLinks = buildSupplierLinks(loadFixture("9528K13"));
  const speedy = rawLinks.find((l) => l.supplier === "Speedy Metals");
  assert.equal(speedy.verified, "renders");
  assert.equal(speedy.note, undefined);
  const metalSupermarkets = rawLinks.find((l) => l.supplier === "Metal Supermarkets");
  assert.equal(metalSupermarkets.verified, "renders");
  assert.equal(metalSupermarkets.note, "category page; pick a store for prices");
});

// ---------------------------------------------------------------------------
// AliExpress: canonical slug URL (avoids the broken /wholesale?SearchText=
// redirect for a query with an inch fraction -- a literal "/" gets
// double-encoded by AliExpress's own 301 into a path its edge rejects).
// See backend/test/fixtures/suppliers/results.json (AliExpress-91251A540
// vs. AliExpress-91251A540-wording-decimal) for the real-browser evidence,
// and the report for a live check of the built URL below.
// ---------------------------------------------------------------------------

test("toSlug: lowercases, drops inch marks and other punctuation, turns '/' and whitespace into '-', collapses repeats", () => {
  assert.equal(
    toSlug('1/4"-20 x 3/4" socket head cap screw Alloy Steel black oxide'),
    "1-4-20-x-3-4-socket-head-cap-screw-alloy-steel-black-oxide"
  );
  assert.equal(toSlug("4-40 hex nut Steel Zinc-Plated"), "4-40-hex-nut-steel-zinc-plated");
  assert.equal(toSlug('O-Ring, 1/4" ID!'), "o-ring-1-4-id");
  assert.equal(toSlug("  extra   spaces  "), "extra-spaces");
});

test("aliExpressWholesaleUrl: builds the canonical /w/wholesale-<slug>.html form directly, no SearchText param and no literal '/'", () => {
  const product = loadFixture("91251A540");
  const { primary } = buildQueries(product);
  const url = aliExpressWholesaleUrl(primary);
  assert.equal(url, "https://www.aliexpress.com/w/wholesale-1-4-20-x-3-4-socket-head-cap-screw-alloy-steel-black-oxide.html");
  assert.ok(!url.includes("/wholesale?SearchText="), "must not use the broken SearchText redirect path");
  assert.equal((url.match(/\//g) || []).length, 4, "no stray '/' from the inch fraction -- only https:// and the /w/ path segment");
});

test("buildSupplierLinks: AliExpress link for a fastener with an inch fraction uses the canonical slug URL", () => {
  const links = buildSupplierLinks(loadFixture("91251A540"));
  const aliExpress = links.find((l) => l.supplier === "AliExpress");
  assert.match(aliExpress.url, /^https:\/\/www\.aliexpress\.com\/w\/wholesale-[a-z0-9-]+\.html$/);
  assert.doesNotMatch(aliExpress.url, /SearchText/);
});

// ---------------------------------------------------------------------------
// stripDimensions: dangling unit words left behind once the numbers
// they're attached to are stripped out.
// ---------------------------------------------------------------------------

test("stripDimensions drops dangling unit words (OD/ID/wall/bore/dia/wide/thick/long), not just the numbers", () => {
  assert.equal(
    stripDimensions('1" OD x 0.065" wall 304 stainless steel round tube'),
    "304 stainless steel round tube"
  );
  assert.equal(stripDimensions('1/2" bore 1-1/8" OD 5/16" wide ball bearing 440C Stainless Steel'), "ball bearing 440C Stainless Steel");
  assert.equal(stripDimensions('3/16" dia steel rod'), "steel rod");
  assert.equal(stripDimensions('2" long dowel pin'), "dowel pin");
  assert.equal(stripDimensions('1/8" thick gasket material'), "gasket material");
});

// ---------------------------------------------------------------------------
// Speedy Metals: dropping "bar" from the wording (its own catalog never
// spells it out -- see the report for the real-browser check across an
// aluminum round bar, a steel flat bar and a stainless round bar).
// ---------------------------------------------------------------------------

test("speedyMetalsQuery drops 'bar' but leaves everything else (including 'tube') alone", () => {
  assert.equal(speedyMetalsQuery("6061 aluminum round bar"), "6061 aluminum round");
  assert.equal(speedyMetalsQuery("1018 steel flat bar"), "1018 steel flat");
  assert.equal(speedyMetalsQuery("304 stainless round bar"), "304 stainless round");
  assert.equal(speedyMetalsQuery("304 stainless steel round tube"), "304 stainless steel round tube");
  assert.equal(speedyMetalsQuery("52100 steel ball"), "52100 steel ball");
});

test("buildSupplierLinks: Speedy Metals link for '... round bar' rawstock drops 'bar', query field shows what was actually sent", () => {
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
  const links = buildSupplierLinks(product);
  const speedy = links.find((l) => l.supplier === "Speedy Metals");
  assert.equal(speedy.query, "6061 aluminum round");
  assert.match(speedy.url, /SearchTerm=6061\+aluminum\+round$/);
  // A supplier that isn't Speedy Metals keeps the ordinary dimensionless
  // (but un-rewritten) query -- the "bar" rewrite is Speedy Metals-only.
  const msc = links.find((l) => l.supplier === "MSC Direct");
  assert.match(msc.query, /round bar/i);
});

// ---------------------------------------------------------------------------
// 92620A624: three real defects found on a live sweep capture (a Grade 8
// hex head cap screw). Read directly from
// test/fixtures/mcmaster/sweep/92620A624.raw -- the sweep that captured it
// is still running and this file is a real McMaster response, not a
// synthetic one.
// ---------------------------------------------------------------------------

const SWEEP_DIR = path.join(FIXTURES_DIR, "sweep");
const load92620A624 = () => parseProductRecord(fs.readFileSync(path.join(SWEEP_DIR, "92620A624.raw")));

test("92620A624: Fastener Strength Grade/Class 'SAE Grade 8' normalizes to 'Grade 8' and reaches the query", () => {
  const product = load92620A624();
  assert.equal(product.byName("Fastener Strength Grade/Class"), "SAE Grade 8");
  // The thread-fit class lives under a different attribute entirely and
  // must never be mistaken for a strength grade.
  assert.equal(product.byName("Thread Fit"), "Unified Standard Class 2A");

  const { primary, terms } = buildQueries(product);
  assert.equal(terms.grade, "Grade 8");
  assert.match(primary, /\bGrade 8\b/);
  assert.doesNotMatch(primary, /2A/, "the thread-fit class must never leak into the query as a grade");
});

test("92620A624: fully-hyphenated Material ('Zinc-Yellow-Chromate-Plated Steel') still splits into finish + material, rendered in plain words", () => {
  const product = load92620A624();
  assert.equal(product.byName("Material"), "Zinc-Yellow-Chromate-Plated Steel");

  const { terms } = buildQueries(product);
  assert.equal(terms.finish, "zinc yellow chromate");
  assert.equal(terms.material, "Steel");
});

test("92620A624: empty Breadcrumbs ([]) still classifies correctly via the attribute fallback, and the primary query is complete", () => {
  const product = load92620A624();
  assert.deepEqual(product.categoryPath, [], "this record's own ReactData.Breadcrumbs is []");

  const { noun, kind } = classifyProduct(product);
  assert.equal(kind, "fastener");
  assert.equal(noun, "hex head cap screw");

  const { primary } = buildQueries(product);
  // Size, "Grade 8", the noun, and the material must all be present and
  // human-readable; finish wording may vary but must be present too.
  assert.match(primary, /3\/8"-16/);
  assert.match(primary, /x 1"/);
  assert.match(primary, /Grade 8/);
  assert.match(primary, /hex head cap screw/i);
  assert.match(primary, /steel/i);
});

test("classifyKindFromAttributes: stripping Breadcrumbs from each of the five original fixtures leaves kind and noun unchanged", () => {
  const names = ["91251A540", "90480A005", "91102A029", "9528K13", "92196A106"];
  for (const name of names) {
    const withCrumbs = loadFixture(name);
    const expected = classifyProduct(withCrumbs);

    const text = fs.readFileSync(path.join(FIXTURES_DIR, `${name}.raw`)).toString("utf8");
    const jsonText = extractJsonObject(text, text.indexOf("{"));
    const rec = JSON.parse(jsonText);
    rec.ReactData = { ...rec.ReactData, Breadcrumbs: [] };
    const stripped = parseProductRecord(rec);
    assert.deepEqual(stripped.categoryPath, []);
    const actual = classifyProduct(stripped);

    assert.equal(actual.kind, expected.kind, `${name}: kind changed when Breadcrumbs was stripped`);
    assert.equal(actual.noun, expected.noun, `${name}: noun changed when Breadcrumbs was stripped`);
  }
});

// ---------------------------------------------------------------------------
// classifyKindFromAttributes: additional structural signals for records
// with a thin or empty breadcrumb trail (pins, rings, rivets, springs,
// inserts, standoffs, seals, fittings, raw stock, and the title/family
// text fallback used when nothing else applies).
// ---------------------------------------------------------------------------

test("synthetic: dowel pin with a generic 'Head Type' and no breadcrumbs still classifies as 'other', not 'fastener'", () => {
  // Some non-threaded parts (this one included) carry a generic "Head
  // Type" field of their own -- classifyKindFromAttributes must check the
  // part-specific "Pin Type" signal before falling back to the generic
  // "Fastener Head Type"/"Head Type" rule, or this would wrongly become a
  // fastener and lose its diameter through fastenerQuery.
  const product = parseProductRecord(
    record({
      part: "98381A400",
      title: 'Steel Clevis Pin, 1/4" Diameter, 1" Length',
      family: "Clevis Pins",
      breadcrumbs: [],
      entries: [
        specRow("Pin Type", "Clevis", false),
        specRow("Head Type", "Round", false),
        specRow("Diameter", '1/4"', false),
        specRow("Length", '1"', false),
        specRow("Material", "Steel", false),
      ],
    })
  );
  const { kind } = classifyProduct(product);
  assert.equal(kind, "other");
});

test("synthetic: o-ring with only a Dash Number and no breadcrumbs classifies as 'sealing'", () => {
  const product = parseProductRecord(
    record({
      part: "9464K11",
      title: "Buna-N O-Ring",
      family: "O-Rings",
      breadcrumbs: [],
      entries: [specRow("Dash Number", "-014", false), specRow("Material", "Buna-N Rubber", false)],
    })
  );
  const { kind } = classifyProduct(product);
  assert.equal(kind, "sealing");
});

test("synthetic: NPT pipe fitting with no Pipe Size field and no breadcrumbs classifies as 'fitting' off Thread Type", () => {
  const product = parseProductRecord(
    record({
      part: "48925K111",
      title: "Steel Pipe Coupling",
      family: "Pipe Couplings",
      breadcrumbs: [],
      entries: [specRow("Thread Type", "NPT", false), specRow("Material", "Steel", false)],
    })
  );
  const { kind } = classifyProduct(product);
  assert.equal(kind, "fitting");
});

test("synthetic: raw stock with only Wall Thickness (no Shape field) and no breadcrumbs classifies as 'rawstock'", () => {
  const product = parseProductRecord(
    record({
      part: "89785K25",
      title: '304 Stainless Steel Round Tube, 1" OD',
      family: "Stainless Steel",
      breadcrumbs: [],
      entries: [
        specRow("Material", "304 Stainless Steel", false),
        specRow("OD", '1"', false),
        specRow("Wall Thickness", '0.065"', false),
      ],
    })
  );
  const { kind } = classifyProduct(product);
  assert.equal(kind, "rawstock");
});

test("synthetic: no breadcrumbs and no recognized attribute -- title/family text is the last-resort signal ('Hex Nut' -> nut)", () => {
  const product = parseProductRecord(
    record({
      part: "90480ATEST",
      title: 'Steel Hex Nut, 1/4"-20 Thread Size',
      family: "Hex Nuts",
      breadcrumbs: [],
      entries: [specRow("Material", "Steel", false)],
    })
  );
  const { kind } = classifyProduct(product);
  assert.equal(kind, "nut");
});

test("synthetic: a bare 'Class' attribute is only read as a grade when it is metric-class-shaped, never a thread-fit class", () => {
  const product = parseProductRecord(
    record({
      part: "91257ATEST",
      title: "Steel Hex Bolt",
      family: "Hex Bolts",
      breadcrumbs: [crumb("Fastening and Joining", "product-category"), crumb("Screws and Bolts", "product-line-2")],
      entries: [specRow("Class", "2A", false), specRow("Material", "Steel", false), specRow("Length", '2"', false)],
    })
  );
  const { terms } = buildQueries(product);
  assert.equal(terms.grade, null, "a bare 'Class: 2A' is a thread-fit class, not a strength grade");
});

test("synthetic: a bare 'Class' attribute shaped like a metric property class ('10.9') is read as a grade", () => {
  const product = parseProductRecord(
    record({
      part: "91257ATEST2",
      title: "Alloy Steel Hex Bolt",
      family: "Hex Bolts",
      breadcrumbs: [crumb("Fastening and Joining", "product-category"), crumb("Screws and Bolts", "product-line-2")],
      entries: [specRow("Class", "10.9", false), specRow("Material", "Alloy Steel", false), specRow("Length", '20mm', false)],
    })
  );
  const { terms } = buildQueries(product);
  assert.equal(terms.grade, "Class 10.9");
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

test("synthetic: dowel pin under 'Fastening and Joining' -- 'other' kind, not fastener; keeps its diameter", () => {
  const product = parseProductRecord(
    record({
      part: "90145A123",
      title: 'Alloy Steel Dowel Pin, 1/4" Diameter, 1" Length',
      family: "Dowel Pins",
      breadcrumbs: [
        crumb("Fastening and Joining", "product-category"),
        crumb("Pins", "product-line-1"),
        crumb("Dowel Pins", "product-family"),
      ],
      entries: [
        specRow("Diameter", '1/4"', false),
        specRow("Length", '1"', false),
        specRow("Material", "Alloy Steel", false),
      ],
    })
  );

  const { noun, kind } = classifyProduct(product);
  // Before the fix, the bare top-level "Fastening and Joining" segment
  // matched the fastener keyword regex on its own, so this classified as
  // "fastener" and went through fastenerQuery -- which only reads Thread
  // Size/Length/Material, dropping the pin's diameter and leaving a
  // stray leading "x" ("x 1" dowel pin Alloy Steel").
  assert.equal(kind, "other");
  assert.equal(noun, "dowel pin");

  const { primary } = buildQueries(product);
  assert.match(primary, /^1\/4" x 1" dowel pin/i);
  assert.match(primary, /alloy steel/i);
  assert.ok(!/^x /i.test(primary), `expected no stray leading "x", got ${JSON.stringify(primary)}`);
});

test("synthetic: extension spring under 'Fastening and Joining' -- 'other' kind, keeps wire/OD/free length", () => {
  const product = parseProductRecord(
    record({
      part: "9662K25",
      title: 'Music Wire Extension Spring, 3/8" OD, 2" Long',
      family: "Extension Springs",
      breadcrumbs: [
        crumb("Fastening and Joining", "product-category"),
        crumb("Springs", "product-line-1"),
        crumb("Extension Springs", "product-family"),
      ],
      entries: [
        specRow("Wire Diameter", '0.035"', false),
        specRow("OD", '3/8"', false),
        specRow("Free Length", '2"', false),
        specRow("Material", "Music Wire", false),
      ],
    })
  );

  const { noun, kind } = classifyProduct(product);
  // Before the fix this also misclassified as "fastener" off the bare
  // "Fastening and Joining" segment and lost every dimension --
  // fastenerQuery has no idea what "Wire Diameter"/"OD"/"Free Length" are.
  assert.equal(kind, "other");
  assert.equal(noun, "extension spring");

  const { primary } = buildQueries(product);
  assert.match(primary, /extension spring/i);
  assert.match(primary, /0\.035" wire/);
  assert.match(primary, /3\/8" OD/);
  assert.match(primary, /2"/);
});

test("synthetic: fastenerQuery has no stray leading 'x' when thread size is missing but length is present", () => {
  const product = parseProductRecord(
    record({
      part: "91257A123",
      title: 'Steel Hex Bolt, 2" Long',
      family: "Hex Bolts",
      breadcrumbs: [
        crumb("Fastening and Joining", "product-category"),
        crumb("Screws and Bolts", "product-line-2"),
        crumb("Hex Bolts", "product-family"),
      ],
      entries: [specRow("Length", '2"', false), specRow("Material", "Steel", false)],
    })
  );

  const { kind } = classifyProduct(product);
  // "Screws and Bolts" is a non-first breadcrumb segment naming bolts, so
  // this is a fastener even with no thread-size signal at all.
  assert.equal(kind, "fastener");

  const { primary, terms } = buildQueries(product);
  assert.equal(terms.threadSize, null);
  assert.equal(terms.length, '2"');
  assert.ok(!/^x\b/i.test(primary), `expected no stray leading "x", got ${JSON.stringify(primary)}`);
  assert.match(primary, /^2" hex bolt/i);
});

test("synthetic: headless fastener -- Material is not appended when the noun already spells it out", () => {
  const product = parseProductRecord(
    record({
      part: "98750A031",
      title: '316 Stainless Steel Threaded Rod, 1/2"-13 Thread Size, 3 feet Long',
      family: "Threaded Rods",
      breadcrumbs: [
        crumb("Fastening and Joining", "product-category"),
        crumb("Screws and Bolts", "product-line-2"),
        crumb("Threaded Rods", "product-family"),
        crumb("316 Stainless Steel Threaded Rods", "presentation"),
      ],
      entries: [
        groupHeader("Thread"),
        specRow("Size", '1/2"-13', true),
        specRow("Length", "3 feet", false),
        specRow("Material", "316 Stainless Steel", false),
      ],
    })
  );

  const { noun, kind } = classifyProduct(product);
  assert.equal(kind, "fastener");
  assert.equal(noun, "316 stainless steel threaded rod");

  const { primary } = buildQueries(product);
  // Before the fix: '1/2"-13 x 3 feet 316 stainless steel threaded rod
  // 316 Stainless Steel' -- the material duplicated because the noun
  // itself (chosen from the more specific breadcrumb leaf) already
  // carries it.
  const materialMatches = primary.match(/316 stainless steel/gi) || [];
  assert.equal(materialMatches.length, 1, `expected "316 stainless steel" once, got ${JSON.stringify(primary)}`);
});

test("synthetic: 304 stainless round tube -- rawstock keeps OD and wall thickness", () => {
  const product = parseProductRecord(
    record({
      part: "89785K21",
      title: '304 Stainless Steel Round Tube, 1" OD, 0.065" Wall Thickness, 6 feet Long',
      family: "Stainless Steel",
      breadcrumbs: [
        crumb("Raw Materials", "product-category"),
        crumb("Metals", "product-line-1"),
        crumb("Stainless Steel", "product-family"),
        crumb("Stainless Steel Round Tubes", "presentation"),
      ],
      entries: [
        specRow("Material", "304 Stainless Steel", false),
        specRow("Shape", "Round Tube", false),
        specRow("OD", '1"', false),
        specRow("Wall Thickness", '0.065"', false),
        specRow("Length", "6 feet", false),
      ],
    })
  );

  const { noun, kind } = classifyProduct(product);
  assert.equal(kind, "rawstock");
  assert.equal(noun, "stainless steel round tube");

  const { primary } = buildQueries(product);
  // Before the fix, rawstockQuery only read Diameter/Thickness/Width, so
  // this lost its size entirely: '304 stainless steel round tube'.
  assert.equal(primary, '1" OD x 0.065" wall 304 stainless steel round tube');
});

test("synthetic: shaft collar -- routed to bearing kind, bore comes before the OD", () => {
  const product = parseProductRecord(
    record({
      part: "6432K11",
      title: 'One-Piece Clamping Shaft Collar, 1/2" For Shaft Diameter, 1" OD',
      family: "Shaft Collars",
      breadcrumbs: [
        crumb("Power Transmission", "product-category"),
        crumb("Shaft Collars", "product-line-1"),
      ],
      entries: [
        specRow("For Shaft Diameter", '1/2"', false),
        specRow("OD", '1"', false),
        specRow("Material", "Steel", false),
      ],
    })
  );

  const { noun, kind } = classifyProduct(product);
  assert.equal(kind, "bearing");
  assert.equal(noun, "shaft collar");

  const { primary } = buildQueries(product);
  const boreIndex = primary.indexOf('1/2"');
  const odIndex = primary.indexOf('1" OD');
  assert.ok(boreIndex !== -1 && odIndex !== -1 && boreIndex < odIndex, `expected bore before OD, got ${JSON.stringify(primary)}`);
});

test("synthetic: roller chain -- ANSI chain number leads the query, from a labeled attribute", () => {
  const product = parseProductRecord(
    record({
      part: "6261K17",
      title: 'Steel Roller Chain, ANSI 40',
      family: "Roller Chain",
      breadcrumbs: [
        crumb("Power Transmission", "product-category"),
        crumb("Chain, Sprockets, and Accessories", "product-line-1"),
        crumb("Roller Chain", "product-family"),
      ],
      entries: [specRow("Chain Number", "40", false), specRow("Material", "Steel", false)],
    })
  );

  const { noun, kind } = classifyProduct(product);
  assert.equal(kind, "other");
  assert.equal(noun, "roller chain");

  const { primary } = buildQueries(product);
  assert.match(primary, /^#40 roller chain/);
});

test("synthetic: roller chain -- ANSI chain number leads the query, recovered from the title", () => {
  const product = parseProductRecord(
    record({
      part: "6261K18",
      title: 'Steel Roller Chain, #50',
      family: "Roller Chain",
      breadcrumbs: [
        crumb("Power Transmission", "product-category"),
        crumb("Chain, Sprockets, and Accessories", "product-line-1"),
        crumb("Roller Chain", "product-family"),
      ],
      entries: [specRow("Material", "Steel", false)],
    })
  );

  const { primary } = buildQueries(product);
  assert.match(primary, /^#50 roller chain/);
});

test("synthetic: ball bearing -- leads with its trade number when the title has one, bore/OD/width as an alternate", () => {
  const product = parseProductRecord(
    record({
      part: "60355K33",
      title: '6203 Two-Shield Ball Bearing, 1/2" Bore, 1-1/8" OD',
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

  const { primary, alternates } = buildQueries(product);
  assert.equal(primary, "6203 ball bearing");
  assert.ok(
    alternates.some((a) => /1\/2" bore/.test(a) && /1-1\/8" OD/.test(a)),
    `expected a bore/OD alternate, got ${JSON.stringify(alternates)}`
  );
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

// ---------------------------------------------------------------------------
// Grouped head/drive/tip attributes: a flat umbrella field ("Fastener Head
// Type": "Rounded" covers button/pan/oval/truss/fillister/cheese/round
// heads alike) must never stand in for the grouped, more specific row
// ("Head" > "Style": "Button") when one is present. See the module doc
// comment and 92949A150 (a real captured record) for the defect this
// fixes: the noun used to come out "round head screw" with the socket
// drive dropped entirely.
// ---------------------------------------------------------------------------

const remoteFixtureExists = (part) => fs.existsSync(path.join(REMOTE_FIXTURES_DIR, `${part}.json`));

test("92949A150 (real record): grouped Head > Style 'Button' + Drive > Style 'Hex' wins over the flat 'Rounded' umbrella", () => {
  const product = loadRemoteFixture("92949A150");
  assert.equal(product.byName("Fastener Head Type"), "Rounded");
  assert.equal(product.byName("Style", "Head"), "Button");
  assert.equal(product.byName("Style", "Drive"), "Hex");

  const { noun, kind } = classifyProduct(product);
  assert.equal(kind, "fastener");
  assert.equal(noun, "button head socket cap screw");
  assert.doesNotMatch(noun, /round/i);

  const { primary } = buildQueries(product);
  assert.equal(primary, '6-32 x 5/8" button head socket cap screw 18-8 Stainless Steel');
});

test("91375A194 (real record): headless + Tip Type 'Cup' -> noun 'cup point set screw', material appended once", () => {
  const product = loadRemoteFixture("91375A194");
  assert.equal(product.byName("Fastener Head Type"), "Headless");
  assert.equal(product.byName("Tip Type"), "Cup");

  const { noun, kind } = classifyProduct(product);
  assert.equal(kind, "fastener");
  assert.equal(noun, "cup point set screw");

  const { primary } = buildQueries(product);
  assert.match(primary, /8-32 x 1\/2" cup point set screw/);
  const steelMatches = primary.match(/steel/gi) || [];
  assert.equal(steelMatches.length, 1, `expected "steel" once (from the material, not a duplicated noun), got ${JSON.stringify(primary)}`);
  assert.match(primary, /alloy steel/i);
  assert.match(primary, /black oxide/i);
});

test("90272A110 (real record): Head > Style 'Pan' + Drive > Style 'Phillips' -> 'pan head Phillips machine screw'", () => {
  const product = loadRemoteFixture("90272A110");
  const { noun, kind } = classifyProduct(product);
  assert.equal(kind, "fastener");
  assert.equal(noun, "pan head Phillips machine screw");

  const { primary } = buildQueries(product);
  assert.match(primary, /4-40 x 1\/2"/);
  assert.match(primary, /pan head Phillips machine screw/);
  assert.match(primary, /zinc plated/i);
  assert.match(primary, /steel/i);
});

test("91771A831 (real record, flat-only): 'Flat' + Phillips + 82 degree countersink -> 'flat head Phillips screw', never 'cap'", () => {
  if (!remoteFixtureExists("91771A831")) return; // not present in every sweep
  const product = loadRemoteFixture("91771A831");
  assert.equal(product.byName("Fastener Head Type"), "Flat");
  assert.equal(product.byName("Drive Style"), "Phillips");

  const { noun, kind } = classifyProduct(product);
  assert.equal(kind, "fastener");
  assert.match(noun, /flat head/i);
  assert.match(noun, /phillips/i);
  assert.doesNotMatch(noun, /cap/i);

  const { primary } = buildQueries(product);
  assert.match(primary, /10-32 x 3\/4"/);
  assert.match(primary, /flat head/i);
  assert.match(primary, /phillips/i);
  assert.doesNotMatch(primary, /cap/i);
});

// ---------------------------------------------------------------------------
// Synthetic: one test per head style/drive combination named in the fix,
// using the existing record()/specRow()/groupHeader()/crumb() builders.
// "cap" must only ever appear on a socket- or hex-cap-screw noun.
// ---------------------------------------------------------------------------

const FASTENER_BREADCRUMBS = [crumb("Fastening and Joining", "product-category"), crumb("Screws and Bolts", "product-line-2")];

function headedFastener(part, entries) {
  return parseProductRecord(
    record({ part, title: "test", family: "Screws", breadcrumbs: FASTENER_BREADCRUMBS, entries })
  );
}

test("synthetic: button head, socket/hex drive -> 'button head socket cap screw'", () => {
  const product = headedFastener("BTNHEX", [
    specRow("Fastener Head Type", "Button", false),
    specRow("Drive Style", "Hex", false),
    specRow("Thread Size", "6-32", false),
    specRow("Length", '5/8"', false),
    specRow("Material", "18-8 Stainless Steel", false),
  ]);
  assert.equal(classifyProduct(product).noun, "button head socket cap screw");
});

test("synthetic: button head, no socket/hex/torx drive -> 'button head screw' (no 'cap')", () => {
  const product = headedFastener("BTNSLOT", [
    specRow("Fastener Head Type", "Button", false),
    specRow("Drive Style", "Slotted", false),
    specRow("Thread Size", "6-32", false),
    specRow("Length", '5/8"', false),
    specRow("Material", "Steel", false),
  ]);
  const { noun } = classifyProduct(product);
  assert.equal(noun, "button head screw");
  assert.doesNotMatch(noun, /cap/i);
});

test("synthetic: flat/82-degree-countersunk head, socket drive -> 'flat head socket cap screw'", () => {
  const product = headedFastener("FLATSOC", [
    specRow("Fastener Head Type", "Flat", false),
    specRow("Drive Style", "Hex", false),
    specRow("Countersink Angle", "82°", false),
    specRow("Thread Size", "1/4-20", false),
    specRow("Length", '1"', false),
    specRow("Material", "Alloy Steel", false),
  ]);
  assert.equal(classifyProduct(product).noun, "flat head socket cap screw");
});

test("synthetic: flat head, Phillips drive -> 'flat head Phillips screw' (no 'cap')", () => {
  const product = headedFastener("FLATPHIL", [
    specRow("Fastener Head Type", "Flat", false),
    specRow("Drive Style", "Phillips", false),
    specRow("Thread Size", "10-32", false),
    specRow("Length", '3/4"', false),
    specRow("Material", "18-8 Stainless Steel", false),
  ]);
  const { noun } = classifyProduct(product);
  assert.equal(noun, "flat head Phillips screw");
  assert.doesNotMatch(noun, /cap/i);
});

test("synthetic: pan head, Phillips drive -> 'pan head Phillips machine screw'", () => {
  const product = headedFastener("PANPHIL", [
    specRow("Fastener Head Type", "Rounded", false),
    groupHeader("Head"),
    specRow("Style", "Pan", true),
    groupHeader("Drive"),
    specRow("Style", "Phillips", true),
    specRow("Thread Size", "4-40", false),
    specRow("Length", '1/2"', false),
    specRow("Material", "Zinc-Plated Steel", false),
  ]);
  const { noun } = classifyProduct(product);
  assert.equal(noun, "pan head Phillips machine screw");
  assert.doesNotMatch(noun, /cap/i);
});

test("synthetic: socket head -> 'socket head cap screw'", () => {
  const product = headedFastener("SOCK", [
    specRow("Fastener Head Type", "Socket", false),
    specRow("Drive Style", "Hex", false),
    specRow("Thread Size", "1/4-20", false),
    specRow("Length", '3/4"', false),
    specRow("Material", "Alloy Steel", false),
  ]);
  assert.equal(classifyProduct(product).noun, "socket head cap screw");
});

test("synthetic: low-profile socket head (grouped Head > Style 'Socket' + Profile 'Low') -> 'low head socket cap screw'", () => {
  const product = headedFastener("LOWSOCK", [
    groupHeader("Head"),
    specRow("Style", "Socket", true),
    specRow("Profile", "Low", true),
    groupHeader("Drive"),
    specRow("Style", "Hex", true),
    specRow("Thread Size", "10-32", false),
    specRow("Length", '1/2"', false),
    specRow("Material", "Alloy Steel", false),
  ]);
  const { noun } = classifyProduct(product);
  assert.equal(noun, "low head socket cap screw");
});

test("synthetic: hex head -> 'hex head cap screw'", () => {
  const product = headedFastener("HEX", [
    specRow("Fastener Head Type", "Hex", false),
    specRow("Thread Size", "3/8-16", false),
    specRow("Length", '1"', false),
    specRow("Material", "Grade 8 Steel", false),
  ]);
  assert.equal(classifyProduct(product).noun, "hex head cap screw");
});

test("synthetic: truss head -> 'truss head screw' (no 'cap')", () => {
  const product = headedFastener("TRUSS", [
    specRow("Fastener Head Type", "Truss", false),
    specRow("Drive Style", "Phillips", false),
    specRow("Thread Size", "8-32", false),
    specRow("Length", '1/2"', false),
    specRow("Material", "Steel", false),
  ]);
  const { noun } = classifyProduct(product);
  assert.equal(noun, "truss head screw");
  assert.doesNotMatch(noun, /cap/i);
});

test("synthetic: oval head, no socket drive -> 'oval head screw' (no 'cap')", () => {
  const product = headedFastener("OVAL", [
    specRow("Fastener Head Type", "Oval", false),
    specRow("Drive Style", "Phillips", false),
    specRow("Thread Size", "8-32", false),
    specRow("Length", '1/2"', false),
    specRow("Material", "Steel", false),
  ]);
  const { noun } = classifyProduct(product);
  assert.equal(noun, "oval head screw");
  assert.doesNotMatch(noun, /cap/i);
});

test("synthetic: cheese head -> 'cheese head screw' (no 'cap')", () => {
  const product = headedFastener("CHEESE", [
    specRow("Fastener Head Type", "Cheese", false),
    specRow("Thread Size", "6-32", false),
    specRow("Length", '3/8"', false),
    specRow("Material", "Steel", false),
  ]);
  const { noun } = classifyProduct(product);
  assert.equal(noun, "cheese head screw");
  assert.doesNotMatch(noun, /cap/i);
});

test("synthetic: fillister head -> 'fillister head screw' (no 'cap')", () => {
  const product = headedFastener("FILL", [
    specRow("Fastener Head Type", "Fillister", false),
    specRow("Thread Size", "6-32", false),
    specRow("Length", '3/8"', false),
    specRow("Material", "Steel", false),
  ]);
  const { noun } = classifyProduct(product);
  assert.equal(noun, "fillister head screw");
  assert.doesNotMatch(noun, /cap/i);
});

test("synthetic: Head > Style genuinely 'Round' -> 'round head screw'; the flat 'Rounded' umbrella alone never produces it", () => {
  const roundProduct = headedFastener("ROUND", [
    groupHeader("Head"),
    specRow("Style", "Round", true),
    specRow("Thread Size", "6-32", false),
    specRow("Length", '3/8"', false),
    specRow("Material", "Steel", false),
  ]);
  assert.equal(classifyProduct(roundProduct).noun, "round head screw");

  // No grouped Head > Style at all -- only the bare umbrella field, which
  // covers several real head shapes and must never be read as "round".
  const umbrellaOnly = headedFastener("UMBRELLA", [
    specRow("Fastener Head Type", "Rounded", false),
    specRow("Thread Size", "6-32", false),
    specRow("Length", '3/8"', false),
    specRow("Material", "Steel", false),
  ]);
  assert.doesNotMatch(classifyProduct(umbrellaOnly).noun, /\bround\b/i);
});

test("synthetic: shoulder screw -- McMaster spells its head type/drive the same as a plain socket cap screw ('Socket'/'Hex'), but Shoulder Diameter/Length wins -- noun 'shoulder screw', query leads with the shoulder, not the tapped thread", () => {
  const product = headedFastener("SHLD", [
    specRow("Fastener Head Type", "Socket", false),
    specRow("Drive Style", "Hex", false),
    specRow("Shoulder Diameter", '1/4"', false),
    specRow("Shoulder Length", '1/2"', false),
    specRow("Thread Size", "10-24", false),
    specRow("Thread Length", '3/8"', false),
    specRow("Material", "Alloy Steel", false),
  ]);
  const { noun, kind } = classifyProduct(product);
  assert.equal(kind, "fastener");
  assert.equal(noun, "shoulder screw");
  assert.doesNotMatch(noun, /cap/i);

  const { primary, terms } = buildQueries(product);
  assert.equal(terms.shoulderDiameter, '1/4"');
  assert.equal(terms.shoulderLength, '1/2"');
  assert.match(primary, /^1\/4" x 1\/2" shoulder screw/);
  assert.doesNotMatch(primary, /10-24/, "the tapped thread size is not the part's searchable size");
});

test("90298A537 (real record): a shoulder screw whose own Head/Drive fields read exactly like a socket cap screw still comes out 'shoulder screw'", () => {
  if (!remoteFixtureExists("90298A537")) return; // written by the concurrent sweep; not guaranteed present
  const product = loadRemoteFixture("90298A537");
  assert.equal(product.byName("Fastener Head Type"), "Socket");
  assert.equal(product.byName("Drive Style"), "Hex");
  assert.equal(product.byName("Shoulder Diameter"), '1/4"');
  assert.equal(product.byName("Shoulder Length"), '1/2"');

  const { noun, kind } = classifyProduct(product);
  assert.equal(kind, "fastener");
  assert.equal(noun, "shoulder screw");
  assert.doesNotMatch(noun, /cap/i);

  const { primary } = buildQueries(product);
  assert.match(primary, /^1\/4" x 1\/2" shoulder screw/);
  assert.doesNotMatch(primary, /10-24/, "the tapped thread size must not stand in for the shoulder's own size");
  assert.match(primary, /18-8 stainless steel/i);
});

test("synthetic: thumb screw -> 'thumb screw'", () => {
  const product = headedFastener("THUMB", [
    specRow("Fastener Head Type", "Thumb", false),
    specRow("Thread Size", "8-32", false),
    specRow("Length", '1"', false),
    specRow("Material", "Steel", false),
  ]);
  assert.equal(classifyProduct(product).noun, "thumb screw");
});

test("synthetic: wing screw -> 'wing screw'", () => {
  const product = headedFastener("WING", [
    specRow("Fastener Head Type", "Wing", false),
    specRow("Thread Size", "8-32", false),
    specRow("Length", '1"', false),
    specRow("Material", "Steel", false),
  ]);
  assert.equal(classifyProduct(product).noun, "wing screw");
});

test("synthetic: set screw -- Tip Type 'Flat' -> 'flat point set screw' (never confused with a flat *head*)", () => {
  const product = headedFastener("SETFLAT", [
    specRow("Fastener Head Type", "Headless", false),
    specRow("Tip Type", "Flat", false),
    specRow("Thread Size", "1/4-20", false),
    specRow("Length", '1/2"', false),
    specRow("Material", "Steel", false),
  ]);
  const { noun, kind } = classifyProduct(product);
  assert.equal(kind, "fastener");
  assert.equal(noun, "flat point set screw");
  assert.doesNotMatch(noun, /\bflat head\b/);
});

test("synthetic: set screw -- Tip Type already ends in 'Point' ('Dog Point') is not doubled to 'dog point point'", () => {
  const product = headedFastener("SETDOG", [
    specRow("Fastener Head Type", "Headless", false),
    specRow("Tip Type", "Dog Point", false),
    specRow("Thread Size", "1/4-20", false),
    specRow("Length", '1/2"', false),
    specRow("Material", "Steel", false),
  ]);
  assert.equal(classifyProduct(product).noun, "dog point set screw");
});
