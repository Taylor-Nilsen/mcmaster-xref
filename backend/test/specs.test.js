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
  assert.equal(fastenerNoun({ threadSize: "4-40" }), "machine screw");
  assert.equal(fastenerNoun({}), null);
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

test("buildQuery on raw stock lists material, shape, size", () => {
  assert.equal(buildQuery(parseKeyValueText(ALUMINUM_BAR_PAGE)), "6061 Aluminum Round Bar 3/8\" 1 ft.");
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
