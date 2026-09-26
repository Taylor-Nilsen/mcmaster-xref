/**
 * Builds the test-case catalog (product -> classification, query, supplier
 * links) used by check-supplier-links.js. Not itself a supplier check --
 * pure use of lib/product.js against the five real fixtures plus the
 * synthetic records mirrored from backend/test/product.test.js.
 *
 * Run: node backend/scripts/build-cases.js > /tmp/.../cases.json
 */
const fs = require("fs");
const path = require("path");
const {
  parseProductRecord,
  classifyProduct,
  buildQueries,
  buildSupplierLinks,
} = require("../lib/product");

const FIXTURES_DIR = path.join(__dirname, "..", "test", "fixtures", "mcmaster");
const loadFixture = (name) =>
  parseProductRecord(fs.readFileSync(path.join(FIXTURES_DIR, `${name}.raw`)));

// --- synthetic record builders, mirrored from product.test.js ---
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
    ReactData: { Breadcrumbs: [...breadcrumbs, crumb(part, "")], TableEntries: entries, Copies: copies || [] },
    CtlgPgNbrs: [],
  };
}

const synthetic = {
  metricSocketScrew: record({
    part: "91290A123",
    title: "Class 12.9 Alloy Steel Socket Head Screw, M6 x 1 mm Thread Size, 20 mm Long",
    family: "Socket Head Screws",
    breadcrumbs: [
      crumb("Fastening and Joining", "product-category"),
      crumb("Screws and Bolts", "product-line-2"),
      crumb("Socket Head Screws", "product-family"),
      crumb("Alloy Steel Socket Head Screws", "presentation"),
    ],
    entries: [
      groupHeader("Thread"), specRow("Size", "M6 x 1 mm", true), specRow("Length", "20 mm", false),
      groupHeader("Head"), specRow("Diameter", "10 mm", true), specRow("Fastener Head Type", "Socket", false),
      specRow("Drive Style", "Hex", false), specRow("Material", "Class 12.9 Alloy Steel", false),
    ],
  }),
  oRing: record({
    part: "9452K12",
    title: 'Buna-N O-Ring, 1/4" ID, 1/16" Width',
    family: "O-Rings",
    breadcrumbs: [crumb("Sealing Devices", "product-category"), crumb("O-Rings", "product-family")],
    entries: [
      specRow("Material", "Buna-N Rubber", false), specRow("Inside Diameter", '1/4"', false),
      specRow("Width", '1/16"', false), specRow("Durometer", "70A", false),
    ],
  }),
  aluminumRoundBar: record({
    part: "8975K261",
    title: 'Multipurpose 6061 Aluminum Round Bar, 1/2" Diameter, 3 ft. Long',
    family: "Aluminum",
    breadcrumbs: [
      crumb("Raw Materials", "product-category"), crumb("Metals", "product-line-1"),
      crumb("Aluminum", "product-family"), crumb("Aluminum Round Bar", "presentation"),
    ],
    entries: [
      specRow("Material", "6061 Aluminum", false), specRow("Shape", "Round Bar", false),
      specRow("Diameter", '1/2"', false), specRow("Length", "3 ft.", false),
    ],
  }),
  ballBearing: record({
    part: "60355K33",
    title: '440C Stainless Steel Ball Bearing, 1/2" Bore, 1-1/8" OD',
    family: "Ball Bearings",
    breadcrumbs: [crumb("Bearings", "product-category"), crumb("Ball Bearings", "product-family")],
    entries: [
      specRow("Bore", '1/2"', false), specRow("OD", "1-1/8\"", false),
      specRow("Width", '5/16"', false), specRow("Material", "440C Stainless Steel", false),
    ],
  }),
  pipeNipple: record({
    part: "48605K111",
    title: 'Steel Pipe Nipple, 1/2" Pipe Size, 2" Long',
    family: "Pipe Nipples",
    breadcrumbs: [
      crumb("Plumbing", "product-category"), crumb("Pipe Fittings", "product-line-1"),
      crumb("Pipe Nipples", "product-family"),
    ],
    entries: [specRow("Pipe Size", '1/2"', false), specRow("Length", '2"', false), specRow("Material", "Steel", false)],
  }),
  compressionSpring: record({
    part: "9657K21",
    title: 'Music Wire Steel Compression Spring, 1/2" OD, 2" Long',
    family: "Compression Springs",
    breadcrumbs: [crumb("Springs", "product-category"), crumb("Compression Springs", "product-family")],
    entries: [
      specRow("Wire Diameter", '0.035"', false), specRow("OD", '1/2"', false),
      specRow("Free Length", '2"', false), specRow("Material", "Music Wire Steel", false),
    ],
  }),
  dowelPin: record({
    part: "90145A123",
    title: 'Alloy Steel Dowel Pin, 1/4" Diameter, 1" Length',
    family: "Dowel Pins",
    breadcrumbs: [
      crumb("Fastening and Joining", "product-category"), crumb("Pins", "product-line-1"),
      crumb("Dowel Pins", "product-family"),
    ],
    entries: [
      specRow("Diameter", '1/4"', false), specRow("Length", '1"', false), specRow("Material", "Alloy Steel", false),
    ],
  }),
  stainlessTube: record({
    part: "89785K21",
    title: '304 Stainless Steel Round Tube, 1" OD, 0.065" Wall Thickness, 6 feet Long',
    family: "Stainless Steel",
    breadcrumbs: [
      crumb("Raw Materials", "product-category"), crumb("Metals", "product-line-1"),
      crumb("Stainless Steel", "product-family"), crumb("Stainless Steel Round Tubes", "presentation"),
    ],
    entries: [
      specRow("Material", "304 Stainless Steel", false), specRow("Shape", "Round Tube", false),
      specRow("OD", '1"', false), specRow("Wall Thickness", '0.065"', false), specRow("Length", "6 feet", false),
    ],
  }),
  threadedRod: record({
    part: "98750A031",
    title: '316 Stainless Steel Threaded Rod, 1/2"-13 Thread Size, 3 feet Long',
    family: "Threaded Rods",
    breadcrumbs: [
      crumb("Fastening and Joining", "product-category"), crumb("Screws and Bolts", "product-line-2"),
      crumb("Threaded Rods", "product-family"), crumb("316 Stainless Steel Threaded Rods", "presentation"),
    ],
    entries: [
      groupHeader("Thread"), specRow("Size", '1/2"-13', true), specRow("Length", "3 feet", false),
      specRow("Material", "316 Stainless Steel", false),
    ],
  }),
  rollerChain: record({
    part: "6261K17",
    title: "Steel Roller Chain, ANSI 40",
    family: "Roller Chain",
    breadcrumbs: [
      crumb("Power Transmission", "product-category"), crumb("Chain, Sprockets, and Accessories", "product-line-1"),
      crumb("Roller Chain", "product-family"),
    ],
    entries: [specRow("Chain Number", "40", false), specRow("Material", "Steel", false)],
  }),
  shaftCollar: record({
    part: "6432K11",
    title: 'One-Piece Clamping Shaft Collar, 1/2" For Shaft Diameter, 1" OD',
    family: "Shaft Collars",
    breadcrumbs: [crumb("Power Transmission", "product-category"), crumb("Shaft Collars", "product-line-1")],
    entries: [
      specRow("For Shaft Diameter", '1/2"', false), specRow("OD", '1"', false), specRow("Material", "Steel", false),
    ],
  }),
};

const CASES = [
  { id: "91251A540", label: "socket head cap screw 1/4-20x3/4 alloy steel black oxide", product: loadFixture("91251A540") },
  { id: "90480A005", label: "hex nut 4-40", product: loadFixture("90480A005") },
  { id: "91102A029", label: "split lock washer 1/4", product: loadFixture("91102A029") },
  { id: "9528K13", label: "52100 steel ball 3/16", product: loadFixture("9528K13") },
  { id: "92196A106", label: "stainless socket head cap screw 4-40x1/4", product: loadFixture("92196A106") },
  { id: "metricSocketScrew", label: "M6-1x20mm socket head cap screw class 12.9 alloy steel", product: parseProductRecord(synthetic.metricSocketScrew) },
  { id: "oRing", label: 'buna-n o-ring 1/4 ID x 1/16 width', product: parseProductRecord(synthetic.oRing) },
  { id: "aluminumRoundBar", label: '6061 aluminum round bar 1/2 dia', product: parseProductRecord(synthetic.aluminumRoundBar) },
  { id: "ballBearing", label: '440C stainless ball bearing 1/2 bore x 1-1/8 OD', product: parseProductRecord(synthetic.ballBearing) },
  { id: "pipeNipple", label: 'steel pipe nipple 1/2 x 2', product: parseProductRecord(synthetic.pipeNipple) },
  { id: "compressionSpring", label: 'music wire compression spring 1/2 OD x 2 free length', product: parseProductRecord(synthetic.compressionSpring) },
  { id: "dowelPin", label: 'alloy steel dowel pin 1/4x1', product: parseProductRecord(synthetic.dowelPin) },
  { id: "stainlessTube", label: '304 stainless round tube 1 OD x 0.065 wall', product: parseProductRecord(synthetic.stainlessTube) },
  { id: "threadedRod", label: '316 stainless threaded rod 1/2-13x3ft', product: parseProductRecord(synthetic.threadedRod) },
  { id: "rollerChain", label: 'steel roller chain ANSI 40', product: parseProductRecord(synthetic.rollerChain) },
  { id: "shaftCollar", label: 'steel shaft collar 1/2 bore x 1 OD', product: parseProductRecord(synthetic.shaftCollar) },
];

const out = CASES.map((c) => {
  const { noun, kind } = classifyProduct(c.product);
  const { primary, alternates, terms } = buildQueries(c.product);
  const links = buildSupplierLinks(c.product);
  return {
    id: c.id,
    label: c.label,
    title: c.product.title,
    noun,
    kind,
    primary,
    alternates,
    terms,
    links,
  };
});

console.log(JSON.stringify(out, null, 2));
