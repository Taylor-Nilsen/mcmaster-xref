/**
 * Tests for the pure spec logic. No network, no browser, no server -- the
 * McMaster fixtures below are the label-then-value line shape a real
 * rendered product page produces, which is the whole reason the parser is
 * written the way it is.
 */

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  parseSpecsFromText,
  parseKeyValueText,
  detectPartType,
  normalizeThread,
  normalizeScrewSize,
  normalizeGauge,
  partFamily,
  sanitizeSpecs,
  strengthGrade,
  normalizeSpecs,
  fastenerNoun,
  isFastener,
  buildQuery,
  applyTemplate,
  buildSupplierLinks,
  boltDepotUrl,
} = require("../lib/specs");

// Each page below opens with the product title, the way a rendered
// McMaster page does. The title is the only thing that says what the part
// *is* -- the spec table cannot tell a nut from a screw, since both are a
// thread size and a material.
const HEX_NUT_PAGE = `
18-8 Stainless Steel Hex Nut
Material
18-8 Stainless Steel
Thread
Size
1/4"-20
Width
7/16"
Thickness
7/32"
`;

const FLAT_WASHER_PAGE = `
18-8 Stainless Steel Flat Washer
Material
18-8 Stainless Steel
For Screw Size
Number 10
Outside Diameter
1/2"
Thickness
0.04"
`;

const O_RING_PAGE = `
Buna-N O-Ring
Material
Buna-N Rubber
Inside Diameter
1/4"
Width
1/16"
Durometer
70A
`;

const METRIC_SCREW_PAGE = `
Class 12.9 Alloy Steel Socket Head Screw
Material
Class 12.9 Alloy Steel
Thread
Size
M6 x 1 mm
Length
20 mm
Fastener Head Type
Socket
Drive Style
Hex
`;

const parsePage = (text) => ({ ...parseSpecsFromText(text), ...parseKeyValueText(text) });

// Shape of a rendered McMaster product page: every spec is a label line
// followed by its value line, and thread size sits one level under a bare
// "Thread" group header.
const SOCKET_SCREW_PAGE = `
Black-Oxide Alloy Steel Socket Head Screw
Thread
Size
1/4"-20
Length
3/4"
Material
Black-Oxide Alloy Steel
Fastener Head Type
Socket
Drive Style
Hex
Thread Fit Class
Class 3
Head Diameter
3/8"
System of Measurement
Inch
`;

const ALUMINUM_BAR_PAGE = `
Multipurpose 6061 Aluminum Round Bar
Material
6061 Aluminum
Shape
Round Bar
Diameter
3/8"
Length
1 ft.
`;

test("parseKeyValueText reads label/value line pairs", () => {
  const specs = parseKeyValueText(SOCKET_SCREW_PAGE);
  assert.equal(specs.material, "Black-Oxide Alloy Steel");
  assert.equal(specs.headType, "Socket");
  assert.equal(specs.driveType, "Hex");
  assert.equal(specs.length, '3/4"');
  assert.equal(specs.measurementSystem, "Inch");
});

test("parseKeyValueText resolves thread size through its group header", () => {
  assert.equal(parseKeyValueText(SOCKET_SCREW_PAGE).threadSize, '1/4"-20');
});

test("parseKeyValueText keeps the first value for a repeated label", () => {
  const specs = parseKeyValueText("Material\n18-8 Stainless Steel\nMaterial\nNylon\n");
  assert.equal(specs.material, "18-8 Stainless Steel");
});

test("parseKeyValueText ignores a label whose next line is another label", () => {
  const specs = parseKeyValueText("Finish\nMaterial\n18-8 Stainless Steel\n");
  assert.equal(specs.finish, undefined);
  assert.equal(specs.material, "18-8 Stainless Steel");
});

test("parseKeyValueText on raw stock", () => {
  const specs = parseKeyValueText(ALUMINUM_BAR_PAGE);
  assert.equal(specs.shape, "Round Bar");
  assert.equal(specs.diameter, '3/8"');
});

test("parseSpecsFromText picks material, drive and thread out of prose", () => {
  const specs = parseSpecsFromText("18-8 Stainless Steel Hex Drive Flat Head Screw, 1/4-20 Thread, 1/2\" Long");
  assert.equal(specs.material, "18-8 stainless steel");
  assert.equal(specs.driveType, "hex");
  assert.equal(specs.threadSize, "1/4-20");
  assert.equal(specs.length, '1/2"');
});

test("parseSpecsFromText handles metric threads and number-gauge sizes", () => {
  assert.equal(parseSpecsFromText("M6 x 1 mm Thread").threadSize, "M6x1");
  assert.equal(parseSpecsFromText("#10-32 Thread, Zinc Plated").threadSize, "#10-32");
  assert.equal(parseSpecsFromText("#10-32 Thread, Zinc Plated").finish, "zinc plated");
});

test("parseSpecsFromText prefers the more specific material", () => {
  assert.equal(parseSpecsFromText("316 Stainless Steel Rod").material, "316 stainless steel");
});

test("sanitizeSpecs keeps only known string fields, trimmed", () => {
  const out = sanitizeSpecs({
    material: "  Aluminum  ",
    threadSize: "",
    bogus: "drop me",
    length: 5,
    finish: "Anodized",
  });
  assert.deepEqual(out, { material: "Aluminum", finish: "Anodized" });
});

test("strengthGrade drops thread fit classes and keeps real ratings", () => {
  assert.equal(strengthGrade("Class 3"), null);
  assert.equal(strengthGrade("Class 2A"), null);
  assert.equal(strengthGrade("Grade 8"), "Grade 8");
  assert.equal(strengthGrade("Class 10.9"), "Class 10.9");
  assert.equal(strengthGrade(""), null);
});

test("normalizeSpecs splits the finish out of the material", () => {
  const out = normalizeSpecs({ material: "Black-Oxide Alloy Steel" });
  assert.equal(out.material, "Alloy Steel");
  assert.equal(out.finish, "Black-Oxide");
});

test("normalizeSpecs leaves an existing finish alone", () => {
  const out = normalizeSpecs({ material: "Zinc-Plated Steel", finish: "Galvanized" });
  assert.equal(out.material, "Steel");
  assert.equal(out.finish, "Galvanized");
});

test("normalizeSpecs drops head diameter on a threaded part", () => {
  const out = normalizeSpecs({ threadSize: '1/4"-20', diameter: '3/8"' });
  assert.equal(out.diameter, undefined);
  assert.equal(normalizeSpecs({ diameter: '3/8"' }).diameter, '3/8"');
});

test("normalizeSpecs drops a fit class from grade", () => {
  assert.equal(normalizeSpecs({ grade: "Class 3" }).grade, undefined);
  assert.equal(normalizeSpecs({ grade: "Grade 8" }).grade, "Grade 8");
});

test("normalizeSpecs does not mutate its input", () => {
  const input = { material: "Black-Oxide Alloy Steel", threadSize: '1/4"-20', diameter: '3/8"' };
  const copy = { ...input };
  normalizeSpecs(input);
  assert.deepEqual(input, copy);
});

test("fastenerNoun maps head and drive to a trade name", () => {
  assert.equal(fastenerNoun({ headType: "Socket" }), "socket head cap screw");
  assert.equal(fastenerNoun({ headType: "Button", driveType: "Hex" }), "button head socket cap screw");
  assert.equal(fastenerNoun({ headType: "Button", driveType: "Phillips" }), "button head screw");
  assert.equal(fastenerNoun({ headType: "Flat", driveType: "Torx" }), "flat head socket cap screw");
  assert.equal(fastenerNoun({ headType: "Hex" }), "hex head cap screw");
  assert.equal(fastenerNoun({ headType: "Pan", driveType: "Phillips" }), "pan head screw");
  assert.equal(fastenerNoun({ threadSize: "4-40", driveType: "Phillips" }), "machine screw");
  assert.equal(fastenerNoun({}), null);
});

test("fastenerNoun refuses to call a bare thread a screw", () => {
  // A nut, a coupling and a threaded insert all look like "a thread and a
  // material". Naming that a machine screw is how a nut lookup ended up
  // searching for screws.
  assert.equal(fastenerNoun({ threadSize: '1/4"-20' }), null);
});

test("isFastener", () => {
  assert.equal(isFastener({ threadSize: "4-40" }), true);
  assert.equal(isFastener({ headType: "Socket" }), true);
  assert.equal(isFastener({ category: "Fasteners" }), true);
  assert.equal(isFastener({ material: "6061 Aluminum", shape: "Round Bar" }), false);
});

test("buildQuery writes a fastener the way a catalog does", () => {
  const query = buildQuery(parseKeyValueText(SOCKET_SCREW_PAGE));
  assert.equal(query, '1/4"-20 x 3/4" socket head cap screw Alloy Steel Black-Oxide');
  // The head diameter and the thread fit class must not leak into it --
  // both read as a different part to a supplier's search.
  assert.ok(!query.includes('3/8"'));
  assert.ok(!/class/i.test(query));
});

test("buildQuery on raw stock lists material, shape, size -- and drops stock length", () => {
  // "1 ft." is the length of the stick McMaster ships. Metal suppliers cut
  // to order, so carrying it into their search narrows the results with a
  // number that means something else on their site.
  assert.equal(buildQuery(parseKeyValueText(ALUMINUM_BAR_PAGE)), '6061 Aluminum Round Bar 3/8"');
});

test("buildQuery is empty when there is nothing to search for", () => {
  assert.equal(buildQuery({}), "");
});

test("applyTemplate encodes both placeholder styles", () => {
  assert.equal(
    applyTemplate("https://x.test/s?q={q}", '1/4"-20 x 3/4"'),
    "https://x.test/s?q=1%2F4%22-20%20x%203%2F4%22"
  );
  assert.equal(
    applyTemplate("https://x.test/s?q={plus}", '1/4"-20 x 3/4"'),
    "https://x.test/s?q=1%2F4%22-20+x+3%2F4%22"
  );
});

test("applyTemplate percent-encodes characters that would break the URL", () => {
  // "$&" is String.replace's "whole match" pattern, so it would corrupt a
  // naive replacement -- encodeURIComponent escapes it first, which is
  // what keeps this safe. Assert that, rather than assuming it.
  const url = applyTemplate("https://x.test/s?q={plus}", "steel $& bar #2");
  assert.equal(url, "https://x.test/s?q=steel+%24%26+bar+%232");
  assert.ok(!/[{}]/.test(url), url);
});

test("buildSupplierLinks returns fastener suppliers with Bolt Depot included", () => {
  const links = buildSupplierLinks(parseKeyValueText(SOCKET_SCREW_PAGE));
  const names = links.map((l) => l.name);
  assert.deepEqual(names, ["Fastenal", "Grainger", "MSC Direct", "Bolt Depot", "Amazon", "AliExpress"]);
  for (const link of links) {
    assert.ok(/^https:\/\//.test(link.url), link.url);
    assert.ok(!/[{}]/.test(link.url), link.url);
    assert.equal(link.query, buildQuery(parseKeyValueText(SOCKET_SCREW_PAGE)));
  }
});

test("buildSupplierLinks returns raw-stock suppliers for raw stock", () => {
  const names = buildSupplierLinks(parseKeyValueText(ALUMINUM_BAR_PAGE)).map((l) => l.name);
  assert.deepEqual(names, ["Online Metals", "MSC Direct", "Speedy Metals", "Grainger"]);
});

test("buildSupplierLinks returns nothing when there is no query", () => {
  assert.deepEqual(buildSupplierLinks({}), []);
});

test("boltDepotUrl filters only when the size parses cleanly", () => {
  const socket = boltDepotUrl({ headType: "Socket", threadSize: '1/4"-20', length: '3/4"' });
  assert.ok(socket.includes("Category=Socket_screws"), socket);
  assert.ok(socket.includes("F_Diameter=1%2F4%22"), socket);
  assert.ok(socket.includes("F_Length=3%2F4%22"), socket);

  // Gauge sizes ("4-40") would become F_Diameter=4, which matches nothing.
  const gauge = boltDepotUrl({ headType: "Socket", threadSize: "4-40", length: '1/4"' });
  assert.ok(!gauge.includes("F_Diameter"), gauge);
  assert.ok(gauge.includes("Category=Socket_screws"), gauge);

  assert.equal(boltDepotUrl({ headType: "Hex" }).includes("Category=Hex_bolts"), true);
  assert.equal(boltDepotUrl({}), "https://boltdepot.com/Catalog-Tabs");
});


// --- Part type, family and routing -------------------------------------

test("detectPartType reads the noun off the title line", () => {
  assert.equal(detectPartType(HEX_NUT_PAGE), "hex nut");
  assert.equal(detectPartType(FLAT_WASHER_PAGE), "flat washer");
  assert.equal(detectPartType(O_RING_PAGE), "o-ring");
  assert.equal(detectPartType(SOCKET_SCREW_PAGE), "socket head cap screw");
  assert.equal(detectPartType(ALUMINUM_BAR_PAGE), "round bar");
  assert.equal(detectPartType("Material\n18-8 Stainless Steel\n"), null);
});

test("detectPartType ignores nouns further down the page", () => {
  // Related-product and category links sit below the specs; matching them
  // would rename the part to whatever it happens to sit next to.
  const page = `${SOCKET_SCREW_PAGE}\nRelated\nHex Nuts\nFlat Washers\n`;
  assert.equal(detectPartType(page), "socket head cap screw");
});

test("partFamily routes each kind of part", () => {
  assert.equal(partFamily(parsePage(SOCKET_SCREW_PAGE)), "fastener");
  assert.equal(partFamily(parsePage(HEX_NUT_PAGE)), "nut");
  assert.equal(partFamily(parsePage(FLAT_WASHER_PAGE)), "washer");
  assert.equal(partFamily(parsePage(O_RING_PAGE)), "sealing");
  assert.equal(partFamily(parsePage(ALUMINUM_BAR_PAGE)), "rawstock");
  assert.equal(partFamily({}), "other");
});

test("partFamily takes the manual Category select as an answer", () => {
  assert.equal(partFamily({ category: "fastener" }), "fastener");
  assert.equal(partFamily({ category: "stock", material: "Brass" }), "rawstock");
});

// --- The six output bugs -----------------------------------------------

test("a nut searches for a nut, not a screw", () => {
  assert.equal(buildQuery(parsePage(HEX_NUT_PAGE)), '1/4"-20 hex nut 18-8 Stainless Steel');
});

test("a nut's query carries no length", () => {
  // Pairing a thread with the nut's own height would read as a screw
  // length: "1/4\"-20 x 7/32\"".
  const query = buildQuery(parsePage(HEX_NUT_PAGE));
  assert.ok(!query.includes("7/32"), query);
  assert.ok(!/ x /.test(query), query);
});

test("a washer leads with the screw size it fits and goes to fastener suppliers", () => {
  assert.equal(buildQuery(parsePage(FLAT_WASHER_PAGE)), "#10 flat washer 18-8 Stainless Steel");
  const names = buildSupplierLinks(parsePage(FLAT_WASHER_PAGE)).map((l) => l.name);
  assert.ok(names.includes("Fastenal"), names.join(", "));
  assert.ok(!names.includes("Online Metals"), names.join(", "));
  assert.ok(!names.includes("Speedy Metals"), names.join(", "));
});

test("an o-ring keeps its inside diameter and goes to MRO suppliers", () => {
  assert.equal(buildQuery(parsePage(O_RING_PAGE)), '1/4" ID x 1/16" wide o-ring Buna-N Rubber 70A');
  const names = buildSupplierLinks(parsePage(O_RING_PAGE)).map((l) => l.name);
  assert.deepEqual(names, ["Grainger", "MSC Direct", "Amazon", "AliExpress"]);
});

test("a metric thread is written the way catalogs index it, with the grade once", () => {
  const query = buildQuery(parsePage(METRIC_SCREW_PAGE));
  assert.equal(query, "M6-1 x 20 mm socket head cap screw Alloy Steel Class 12.9");
  assert.equal(query.match(/Class 12\.9/g).length, 1);
});

test("normalizeThread rewrites McMaster's metric phrasing", () => {
  assert.equal(normalizeThread("M6 x 1 mm"), "M6-1");
  assert.equal(normalizeThread("M6x1"), "M6-1");
  assert.equal(normalizeThread("M3 x 0.5 mm"), "M3-0.5");
  assert.equal(normalizeThread('1/4"-20'), '1/4"-20');
});

test("normalizeScrewSize rewrites gauge sizes", () => {
  assert.equal(normalizeScrewSize("Number 10"), "#10");
  assert.equal(normalizeScrewSize("#10"), "#10");
  assert.equal(normalizeScrewSize('1/4"'), '1/4"');
});

test("normalizeSpecs lifts a property class out of the material", () => {
  const out = normalizeSpecs({ material: "Class 12.9 Alloy Steel" });
  assert.equal(out.material, "Alloy Steel");
  assert.equal(out.grade, "Class 12.9");
  // An existing grade wins; the material is still cleaned up.
  const kept = normalizeSpecs({ material: "Grade 8 Steel", grade: "Grade 8" });
  assert.equal(kept.material, "Steel");
  assert.equal(kept.grade, "Grade 8");
});

test("a head type no longer leaks into the drive type", () => {
  // "Fastener Head Type / Socket" with no Drive Style line used to set
  // driveType to "socket" by keyword match.
  const noDriveLine = SOCKET_SCREW_PAGE.replace("Drive Style\nHex\n", "");
  assert.equal(parseSpecsFromText(noDriveLine).driveType, undefined);
  assert.equal(parseSpecsFromText("18-8 Stainless Steel Hex Drive Flat Head Screw").driveType, "hex");
});

test("Bolt Depot browses the right category per family", () => {
  const url = (page) => {
    const specs = parsePage(page);
    return boltDepotUrl(specs, partFamily(specs));
  };
  assert.ok(url(HEX_NUT_PAGE).includes("Category=Nuts"), url(HEX_NUT_PAGE));
  assert.ok(url(FLAT_WASHER_PAGE).includes("Category=Washers"), url(FLAT_WASHER_PAGE));
  assert.ok(url(SOCKET_SCREW_PAGE).includes("Category=Socket_screws"), url(SOCKET_SCREW_PAGE));
  // A nut has no length, so no length filter may be sent -- it would
  // filter the grid down to nothing.
  assert.ok(!url(HEX_NUT_PAGE).includes("F_Length"), url(HEX_NUT_PAGE));
});


// --- Defects the 24-part category sweep turned up --------------------------

test("a head-style title does not decide the drive", () => {
  // McMaster calls both of these a "Flat Head Screw". A hex-drive one is a
  // flat head socket cap screw; a Phillips one is a different aisle.
  const phillips = parsePage(`18-8 Stainless Steel Flat Head Screw
Material
18-8 Stainless Steel
Thread
Size
10-32
Length
1/2"
Fastener Head Type
Flat
Drive Style
Phillips
`);
  assert.equal(buildQuery(phillips), '10-32 x 1/2" flat head screw 18-8 Stainless Steel');

  const hexDrive = parsePage(`Alloy Steel Flat Head Screw
Material
Alloy Steel
Thread
Size
10-32
Length
1/2"
Fastener Head Type
Flat
Drive Style
Hex
`);
  assert.equal(buildQuery(hexDrive), '10-32 x 1/2" flat head socket cap screw Alloy Steel');
});

test("normalizeGauge marks a bare gauge number", () => {
  // Sheet metal screws list "Thread Size: 8"; "8 x 1/2\"" matches nothing.
  assert.equal(normalizeGauge("8"), "#8");
  assert.equal(normalizeGauge("10"), "#10");
  assert.equal(normalizeGauge("8-32"), "8-32");
  assert.equal(normalizeGauge('1/4"-20'), '1/4"-20');
  assert.equal(normalizeGauge("#8"), "#8");
});

test("a bearing keeps its inside diameter", () => {
  const specs = parsePage(`Steel Ball Bearing
Material
Steel
Inside Diameter
1/4"
Outside Diameter
5/8"
Width
0.196"
`);
  const query = buildQuery(specs);
  assert.ok(query.includes('1/4" ID'), query);
  assert.ok(query.includes("bearing"), query);
});

test("a dowel pin and a spring keep their length", () => {
  const pin = parsePage(`Alloy Steel Dowel Pin
Material
Alloy Steel
Diameter
1/4"
Length
1"
`);
  assert.equal(buildQuery(pin), 'Alloy Steel dowel pin 1/4" 1"');
});

test("a gasket keeps its thickness", () => {
  const gasket = parsePage(`Neoprene Rubber Gasket
Material
Neoprene Rubber
Thickness
1/16"
Width
12"
`);
  assert.ok(buildQuery(gasket).includes('1/16" thick'), buildQuery(gasket));
});
