/**
 * Parts outside the noun table: most of McMaster's catalog is not hardware
 * or stock, and these used to come back with no query at all, or a wrong
 * one ("Brass Ball Valve" searched as "Brass tube" at the metal suppliers).
 * They are now named by the page's own title, sized by the labels a buyer
 * would search on, and sent to the general distributors.
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const X = require("../lib/specs");

const MRO = ["Grainger", "MSC Direct", "Amazon", "AliExpress"];
const parse = (t) => ({ ...X.parseSpecsFromText(t), ...X.parseKeyValueText(t) });

const CASES = [
  ["ball valve", "Brass Ball Valve\nPipe Size\n1/2\nThread Type\nNPT\nMaximum Pressure\n600 psi\nMaterial\nBrass", "Brass Ball Valve 1/2 NPT 600 psi"],
  ["push-to-connect", "Push-to-Connect Tube Fitting for Air\nTube OD\n1/4\"\nPipe Size\n1/8\nBody Material\nNickel-Plated Brass", '1/4" push-to-connect fitting brass'],
  ["fuse", "Fast-Acting Glass Fuse\nCurrent\n5 A\nVoltage\n250V AC\nDiameter\n1/4\"\nLength\n1-1/4\"", 'Fast-Acting Glass Fuse 5 A 250V AC 1/4" 1-1/4"'],
  ["safety glasses", "Safety Glasses\nLens Color\nClear\nFrame Color\nBlack", "Safety Glasses"],
  ["gearmotor", "DC Gearmotor\nVoltage\n12V DC\nSpeed\n100 rpm\nTorque\n20 in.-lbs.", "DC Gearmotor 12V DC 100 rpm"],
  ["caster", "Swivel Caster\nWheel Diameter\n3\"\nWheel Material\nPolyurethane\nCapacity\n200 lbs.", 'Swivel Caster 3" 200 lbs.'],
  ["end mill", "Carbide End Mill\nMill Diameter\n1/4\"\nNumber of Flutes\n4\nMaterial\nCarbide", 'Carbide End Mill 1/4" 4 flute'],
  ["t-slot rail", "T-Slotted Framing Rail\nSeries\n10\nSingle Rail Profile\n1\" x 1\"\nLength\n4 ft.\nMaterial\n6063 Aluminum", "6063 Aluminum T-Slotted Framing Rail 10 series 4 ft."],
  ["hook-up wire", "Hook-Up Wire\nWire Gauge\n18\nConductor\nStranded Copper\nLength\n100 ft.", "copper Hook-Up Wire 18 AWG 100 ft."],
  ["air cylinder", "Air Cylinder\nBore Diameter\n3/4\"\nStroke Length\n2\"\nThread Size\n1/8\"-27", 'Air Cylinder 3/4" 2" 1/8"-27'],
];

for (const [label, text, expect] of CASES) {
  test(`${label} is searched by its own name`, () => {
    const specs = parse(text);
    assert.equal(X.buildQuery(specs), expect);
    assert.deepEqual(X.buildSupplierLinks(specs).map((l) => l.name), MRO);
  });
}

test("a spec label is never read as the part type", () => {
  // "Pipe Size" once made every valve a tube.
  assert.equal(X.detectPartType("Material\nBrass\nPipe Size\n1/2"), null);
});

test("page chrome and labels are not titles", () => {
  for (const line of ["Forward", "Print", "Find alternative products", "Thread Size", "Material", "1/4\"-20"]) {
    assert.equal(X.productTitle(`${line}\nMaterial\nSteel`), null, line);
  }
  assert.equal(X.productTitle("Swivel Caster\nCapacity\n200 lbs."), "Swivel Caster");
});

test("the frontend can load the same parser as a plain script", () => {
  const src = fs.readFileSync(path.join(__dirname, "../lib/specs.js"), "utf8");
  const sandbox = { URLSearchParams };
  sandbox.globalThis = sandbox;
  vm.runInNewContext(src, sandbox);
  assert.equal(typeof sandbox.XrefSpecs.buildSupplierLinks, "function");
  // Nothing but the one namespace lands in the page's global scope.
  assert.equal(sandbox.MATERIALS, undefined);
  assert.equal(sandbox.XrefSpecs.buildQuery({ material: "6061 Aluminum", shape: "Round Bar", diameter: '3/8"' }), '6061 Aluminum Round Bar 3/8"');
});

test("the frontend copy of the parser matches the backend's", () => {
  // A real copy, not a symlink: symlinks break on Windows checkouts and on
  // static hosts that serve the link text instead of the file. This test is
  // what keeps the two from drifting. After editing lib/specs.js, run
  // `npm run sync-frontend`.
  const copy = fs.readFileSync(path.join(__dirname, "../../frontend/specs.js"), "utf8");
  assert.equal(copy, fs.readFileSync(path.join(__dirname, "../lib/specs.js"), "utf8"));
});

test("a spec table read as Label<TAB>Value parses like separate lines", () => {
  // What innerText gives for a <table>, and so what the bookmarklet sends.
  const tabbed = parse("Brass Ball Valve\nPipe Size\t1/2\nThread Type\tNPT\nMaterial\tBrass");
  assert.equal(X.buildQuery(tabbed), "Brass Ball Valve 1/2 NPT");
  const screw = parse('Black-Oxide Alloy Steel Socket Head Screw\nMaterial\tBlack-Oxide Alloy Steel\nThread Size\t1/4"-20\nLength\t3/4"\nFastener Head Type\tSocket\nDrive Style\tHex');
  assert.equal(X.buildQuery(screw), '1/4"-20 x 3/4" socket head cap screw Alloy Steel Black-Oxide');
});
