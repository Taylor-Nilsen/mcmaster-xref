/**
 * Pure spec parsing / query building. No express, no playwright, no
 * network -- so the logic that decides what a part *is* and what to search
 * for can be exercised directly by `npm test` without a browser or a
 * server. server.js is the only place that touches the outside world.
 */

const MATERIALS = [
  "18-8 stainless steel", "316 stainless steel", "stainless steel",
  "carbon fiber", "aluminum", "brass", "bronze", "copper", "titanium",
  "alloy steel", "carbon steel", "steel", "nylon", "polycarbonate",
  "acetal", "delrin", "pvc", "rubber",
];
const DRIVE_TYPES = ["hex", "phillips", "slotted", "torx", "socket", "square", "combination"];
const FINISHES = ["zinc plated", "black oxide", "galvanized", "chrome plated", "plain", "anodized", "powder coated"];

/**
 * Product nouns, read off the title line McMaster puts at the top of every
 * product page ("18-8 Stainless Steel Hex Nut"). This is the only reliable
 * signal for what a part *is*: the spec table alone cannot tell a nut from
 * a screw, because both are a thread size and a material, and guessing
 * "screw" from a thread is how a nut lookup ended up searching for screws.
 *
 * Most specific phrasing first -- "threaded rod" has to beat "rod", and
 * "lock nut" has to beat "nut".
 */
const PART_TYPES = [
  // Headed screws. The head style alone does not fix the noun -- a
  // Phillips flat head is not a socket cap screw -- so these stay generic
  // and fastenerNoun refines them when the drive is known.
  [/socket head (?:cap )?screw/i, "socket head cap screw", "fastener"],
  [/button head (?:socket )?(?:cap )?screw/i, "button head screw", "fastener"],
  [/(?:flat|countersunk) head (?:socket )?(?:cap )?screw/i, "flat head screw", "fastener"],
  [/pan head screw/i, "pan head screw", "fastener"],
  [/truss head screw/i, "truss head screw", "fastener"],
  [/cheese head screw/i, "cheese head screw", "fastener"],
  [/hex head (?:cap )?screw|hex (?:cap )?bolt/i, "hex head cap screw", "fastener"],
  [/shoulder screw|shoulder bolt/i, "shoulder screw", "fastener"],
  [/set screw/i, "set screw", "fastener"],
  [/thumb screw/i, "thumb screw", "fastener"],
  [/wood screw/i, "wood screw", "fastener"],
  [/(?:sheet metal|self.?tapping) screw/i, "sheet metal screw", "fastener"],
  [/concrete screw|masonry screw/i, "concrete screw", "fastener"],
  [/carriage bolt/i, "carriage bolt", "fastener"],
  [/toggle bolt/i, "toggle bolt", "fastener"],
  [/machine screw/i, "machine screw", "fastener"],

  // Rod, stud and anchor forms. "threaded rod" has to beat "rod", and the
  // anchors have to beat the bolt and screw words inside their own names.
  [/acme threaded rod/i, "acme threaded rod", "fastener"],
  [/double.?end.*stud|threaded stud|\bstud\b/i, "threaded stud", "fastener"],
  [/threaded rod|all.?thread/i, "threaded rod", "fastener"],
  [/wedge anchor/i, "wedge anchor", "fastener"],
  [/sleeve anchor/i, "sleeve anchor", "fastener"],
  [/drop.?in anchor/i, "drop-in anchor", "fastener"],
  [/\banchor\b/i, "anchor", "fastener"],
  [/shoulder eyebolt/i, "shoulder eyebolt", "fastener"],
  [/eye ?bolt/i, "eyebolt", "fastener"],
  [/eye ?nut/i, "eye nut", "nut"],
  [/u.?bolt/i, "u-bolt", "fastener"],
  [/j.?bolt/i, "j-bolt", "fastener"],

  // Rivets before the generic nut rule, so a rivet nut stays a rivet nut.
  [/rivet ?nut|nutsert/i, "rivet nut", "fastener"],
  [/blind rivet|pop rivet/i, "blind rivet", "fastener"],
  [/semi.?tubular rivet/i, "semi-tubular rivet", "fastener"],
  [/drive rivet/i, "drive rivet", "fastener"],
  [/solid rivet/i, "solid rivet", "fastener"],
  [/\brivet\b/i, "rivet", "fastener"],

  // Nuts, specific trade names first.
  [/(?:nylon.insert|nyloc|lock).?nut|locknut/i, "lock nut", "nut"],
  [/coupling nut/i, "coupling nut", "nut"],
  [/flange nut/i, "flange nut", "nut"],
  [/wing nut/i, "wing nut", "nut"],
  [/(?:cap|acorn|dome) nut/i, "acorn nut", "nut"],
  [/square nut/i, "square nut", "nut"],
  [/jam nut/i, "jam nut", "nut"],
  [/hex nut/i, "hex nut", "nut"],
  [/\bnut\b/i, "nut", "nut"],

  // Named washers. A "thrust washer bearing" is a bearing, so the bearing
  // rule below has to see it before the bare washer rule does.
  [/lock washer/i, "lock washer", "washer"],
  [/flat washer/i, "flat washer", "washer"],
  [/fender washer/i, "fender washer", "washer"],
  [/belleville|disc spring washer/i, "belleville washer", "washer"],
  [/sealing washer/i, "sealing washer", "washer"],
  [/shoulder washer/i, "shoulder washer", "washer"],
  [/\bshim\b/i, "shim", "washer"],

  // Rotating parts. These precede the generic washer and spring rules.
  [/thrust washer bearing|thrust bearing/i, "thrust bearing", "other"],
  [/linear (?:ball )?bearing/i, "linear bearing", "other"],
  [/needle.?roller bearing/i, "needle-roller bearing", "other"],
  [/flanged (?:ball |sleeve )?bearing/i, "flanged bearing", "other"],
  [/sleeve bearing|\bbushing\b/i, "sleeve bearing", "other"],
  [/ball bearing|\bbearing\b/i, "ball bearing", "other"],
  [/\bwasher\b/i, "washer", "washer"],

  // Pins before springs, or a spring pin reads as a spring.
  [/spring pin|roll pin/i, "spring pin", "other"],
  [/dowel pin/i, "dowel pin", "other"],
  [/cotter pin/i, "cotter pin", "other"],
  [/clevis pin/i, "clevis pin", "other"],
  [/taper pin/i, "taper pin", "other"],
  [/\bpin\b/i, "pin", "other"],

  [/retaining ring|snap ring|circlip|e.?style ring|e.?clip/i, "retaining ring", "other"],
  [/helical insert|threaded insert|keylocking insert|heat.?set insert|\binsert\b/i, "threaded insert", "fastener"],
  [/standoff/i, "standoff", "fastener"],
  [/\bspacer\b/i, "spacer", "other"],

  // Power transmission.
  [/shaft collar/i, "shaft collar", "other"],
  [/(?:shaft |flexible |rigid )?coupling\b/i, "shaft coupling", "other"],
  [/universal joint|u.?joint/i, "universal joint", "other"],
  [/rod end|ball joint/i, "rod end", "other"],
  [/timing belt pulley/i, "timing belt pulley", "other"],
  [/\bpulley\b|sheave/i, "pulley", "other"],
  [/timing belt/i, "timing belt", "other"],
  [/v.?belt/i, "v-belt", "other"],
  [/\bbelt\b/i, "belt", "other"],
  [/spur gear|\bgear\b/i, "spur gear", "other"],
  [/sprocket/i, "sprocket", "other"],
  [/roller chain|\bchain\b/i, "roller chain", "other"],
  [/shock absorber/i, "shock absorber", "other"],
  [/\bactuator\b/i, "actuator", "other"],

  // Springs, after every part whose name contains the word.
  [/compression spring/i, "compression spring", "other"],
  [/extension spring/i, "extension spring", "other"],
  [/torsion spring/i, "torsion spring", "other"],
  [/\bspring\b/i, "spring", "other"],

  // Sealing.
  [/o-?ring/i, "o-ring", "sealing"],
  [/quad ring|x-?ring/i, "quad ring", "sealing"],
  [/oil seal|shaft seal|lip seal/i, "shaft seal", "sealing"],
  [/\bgasket\b/i, "gasket", "sealing"],

  // Pipe and tube fittings, before the raw-stock pipe and tube rules --
  // a pipe nipple is a fitting sold by an MRO house, not a length of bar.
  [/pipe nipple/i, "pipe nipple", "fitting"],
  [/(?:pipe|tube) elbow|\belbow\b/i, "elbow fitting", "fitting"],
  [/(?:pipe|tube) tee|\btee\b/i, "tee fitting", "fitting"],
  [/compression (?:tube )?fitting/i, "compression fitting", "fitting"],
  [/barbed (?:hose |tube )?fitting/i, "barbed fitting", "fitting"],
  [/hose fitting|tube fitting|pipe fitting/i, "fitting", "fitting"],
  [/quick.?disconnect/i, "quick-disconnect coupling", "fitting"],

  // Raw stock.
  [/key ?stock/i, "keystock", "rawstock"],
  [/round bar|rod stock/i, "round bar", "rawstock"],
  [/hex bar/i, "hex bar", "rawstock"],
  [/square bar|rectangular bar|flat bar|\bbar stock\b/i, "bar", "rawstock"],
  [/\b(?:sheet|plate)\b/i, "sheet", "rawstock"],
  [/\bangle\b/i, "angle", "rawstock"],
  [/\bchannel\b/i, "channel", "rawstock"],
  [/\btub(?:e|ing)\b|\bpipe\b/i, "tube", "rawstock"],
];

const NOUN_FAMILY = new Map(PART_TYPES.map(([, noun, family]) => [noun, family]));

/**
 * Finds the product noun in a page's opening lines. Only the top of the
 * text is scanned: McMaster's rendered page starts with the product name,
 * and further down it lists related products and category links -- matching
 * those would rename the part to whatever it sits next to in the catalog.
 */
function detectPartType(text) {
  const head = String(text || "")
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .slice(0, 5)
    .join(" | ");
  for (const [re, noun] of PART_TYPES) {
    if (re.test(head)) return noun;
  }
  return null;
}

function parseSpecsFromText(text) {
  const lower = text.toLowerCase();
  const specs = {};

  const material = MATERIALS.find((m) => lower.includes(m));
  if (material) specs.material = material;

  // Only read a drive type out of prose when the text actually says
  // "drive". Without that guard the word "Socket" in a *head* type
  // ("Fastener Head Type" / "Socket") sets driveType to "socket", filling
  // a field the structured parser owns with a value from another one.
  const drive = /drive/i.test(text) ? DRIVE_TYPES.find((d) => lower.includes(d)) : null;
  if (drive) specs.driveType = drive;

  const partType = detectPartType(text);
  if (partType) specs.partType = partType;

  const finish = FINISHES.find((f) => lower.includes(f));
  if (finish) specs.finish = finish;

  const thread = firstMatch(text, /(#\d{1,2}-\d{2,3}|\d{1,2}\/\d{1,2}"?-\d{1,2}|M\d{1,2}(?:\.\d)?\s*x\s*\d(?:\.\d+)?)/i);
  if (thread) specs.threadSize = thread.replace(/\s+/g, "");

  const length = firstMatch(text, /(\d+(?:\.\d+)?\s?(?:\/\s?\d+)?)"?\s*(?:long|length)/i);
  if (length) specs.length = `${length.trim()}"`;

  const diameter = firstMatch(text, /(\d+(?:\.\d+)?(?:\/\d+)?)"?\s*(?:dia(?:meter)?|od|o\.d\.)/i);
  if (diameter) specs.diameter = `${diameter.trim()}"`;

  const grade = firstMatch(text, /(grade\s?\d+|class\s?\d+(?:\.\d+)?)/i);
  if (grade) specs.grade = grade;

  return specs;
}

const KEY_MAP = {
  material: "material",
  shape: "shape",
  "thread size": "threadSize",
  "thread pitch": "threadSize",
  length: "length",
  diameter: "diameter",
  "outside diameter": "diameter",
  od: "diameter",
  // A washer's defining spec is the screw it fits, and an o-ring's is its
  // inside diameter. Both were dropped on the floor, which left those
  // parts searching on nothing but a material.
  "for screw size": "screwSize",
  "screw size": "screwSize",
  "for thread size": "screwSize",
  "inside diameter": "insideDiameter",
  "for shaft diameter": "shaftDiameter",
  "shaft diameter": "shaftDiameter",
  id: "insideDiameter",
  durometer: "durometer",
  hardness: "durometer",
  thickness: "thickness",
  width: "width",
  "drive style": "driveType",
  "drive type": "driveType",
  "fastener head type": "headType",
  "head type": "headType",
  finish: "finish",
  grade: "grade",
  class: "grade",
  "system of measurement": "measurementSystem",
};

// McMaster renders a spec's label and value as separate lines (confirmed
// against a real rendered page), not "Label: Value" on one line -- e.g.
// "Drive Style" then "Hex" as two consecutive non-empty lines. A few
// fields (thread size) are nested one level under a bare group-header
// line ("Thread" -> "Size" -> "0-80"), which needs disambiguating since
// "Size" alone is ambiguous outside that context.
const GROUP_SUBFIELDS = {
  thread: { size: "threadSize" },
};

/**
 * Parses McMaster's real label/value line pairs. Higher confidence than
 * the fuzzy keyword matching in parseSpecsFromText, so the caller lets
 * this override it.
 */
function parseKeyValueText(text) {
  const lines = text.split("\n").map((l) => l.trim()).filter(Boolean);
  const specs = {};

  for (let i = 0; i < lines.length - 1; i++) {
    const label = lines[i].toLowerCase();

    const group = GROUP_SUBFIELDS[label];
    if (group && lines[i + 1] && group[lines[i + 1].toLowerCase()]) {
      const key = group[lines[i + 1].toLowerCase()];
      if (!specs[key] && lines[i + 2]) specs[key] = lines[i + 2];
      continue;
    }

    const key = KEY_MAP[label];
    if (key && !specs[key]) {
      const value = lines[i + 1];
      if (value && !KEY_MAP[value.toLowerCase()] && !GROUP_SUBFIELDS[value.toLowerCase()]) {
        specs[key] = value;
      }
    }
  }

  return specs;
}

function firstMatch(str, re) {
  const m = str.match(re);
  return m ? m[1].trim() : null;
}

function sanitizeSpecs(specs) {
  const allowed = [
    "material", "shape", "driveType", "finish", "threadSize", "length",
    "diameter", "thickness", "width", "grade", "category", "headType",
    // partType is the manual override for what the part *is* -- the one
    // field that decides the product noun and which suppliers get asked.
    "partType", "screwSize", "insideDiameter", "durometer", "shaftDiameter",
  ];
  const out = {};
  for (const key of allowed) {
    if (typeof specs[key] === "string" && specs[key].trim()) {
      out[key] = specs[key].trim();
    }
  }
  return out;
}

// McMaster folds the finish into the material ("Black-Oxide Alloy Steel");
// suppliers index the two separately, so split them apart.
const FINISH_PREFIXES = [
  "black-oxide", "black oxide", "zinc yellow-chromate plated",
  "yellow-chromate plated", "zinc-plated", "zinc plated",
  "hot-dipped galvanized", "galvanized", "chrome-plated", "chrome plated",
  "nickel-plated", "nickel plated", "passivated", "anodized",
  "powder-coated", "powder coated", "phosphate", "cadmium-plated",
];

/**
 * "Class 1/2/3" (with or without an A/B suffix) is a thread *fit* class --
 * a tolerance band, not a strength rating -- and McMaster reports it in the
 * same field as real strength ratings. Searching a supplier for "Class 3"
 * returns noise, so only genuine ratings ("Grade 8", metric property
 * classes like "Class 10.9") survive into a query.
 */
function strengthGrade(value) {
  if (!value) return null;
  const v = String(value).trim();
  if (/^class\s*\d\s*[ab]?$/i.test(v)) return null;
  return v;
}

/**
 * Reshapes raw parsed McMaster fields into what a supplier's search box
 * actually expects. Two fields actively mislead if passed through as-is:
 * the finish hides inside `material`, and on a threaded fastener
 * `diameter` is the *head* diameter -- searching "1/4-20 ... 3/8"" reads
 * as a 3/8" screw, which is a different part.
 */
/**
 * McMaster folds a metric property class into the material string
 * ("Class 12.9 Alloy Steel") and reports it as the grade as well, so a
 * query built from both said "Class 12.9" twice.
 */
const GRADE_PREFIX_RE = /^(class\s*\d+(?:\.\d+)?|grade\s*[\w.]+)\s+/i;

/**
 * "M6 x 1 mm" is McMaster's phrasing for a metric thread. Left as-is it
 * joins with the length to read "M6 x 1 mm x 20 mm", which parses as two
 * lengths rather than a thread and a length; catalogs index it as "M6-1".
 */
function normalizeThread(value) {
  const m = String(value).match(/^m(\d{1,2}(?:\.\d+)?)\s*[x\u00d7]\s*(\d+(?:\.\d+)?)\s*(?:mm)?$/i);
  return m ? `M${m[1]}-${m[2]}` : String(value).trim();
}

// McMaster writes gauge sizes as "Number 10"; every supplier indexes "#10".
// A bare number is a gauge size: McMaster's sheet metal screws list
// "Thread Size: 8", and searching "8 x 1/2\"" matches nothing anywhere.
function normalizeGauge(value) {
  const v = String(value).trim();
  return /^\d{1,2}$/.test(v) ? `#${v}` : v;
}

function normalizeScrewSize(value) {
  const m = String(value).match(/^number\s*(\d+)$/i);
  return m ? `#${m[1]}` : String(value).trim();
}

function normalizeSpecs(specs) {
  const out = { ...specs };

  if (out.material) {
    const lower = out.material.toLowerCase();
    const hit = FINISH_PREFIXES.find((f) => lower.startsWith(f));
    if (hit) {
      out.material = out.material.slice(hit.length).trim();
      if (!out.finish) out.finish = specs.material.slice(0, hit.length).trim();
    }
  }

  if (out.material) {
    const hit = out.material.match(GRADE_PREFIX_RE);
    if (hit) {
      out.material = out.material.slice(hit[0].length).trim();
      if (!out.grade) out.grade = hit[1].trim();
    }
  }

  if (out.threadSize) out.threadSize = normalizeGauge(normalizeThread(out.threadSize));
  if (out.screwSize) out.screwSize = normalizeGauge(normalizeScrewSize(out.screwSize));

  if (out.threadSize && out.diameter) delete out.diameter;

  const grade = strengthGrade(out.grade);
  if (grade) out.grade = grade;
  else delete out.grade;

  return out;
}

// Trade names for a headed fastener, in the order a supplier's catalog
// uses them. Checked most specific first: a "Hex" *head* is an external
// hex bolt, but a hex *drive* on a flat or button head is a socket cap
// screw, which is a different aisle.
function fastenerNoun(specs) {
  const head = (specs.headType || "").toLowerCase();
  const drive = (specs.driveType || "").toLowerCase();
  const socketDrive = /hex|socket|torx/.test(drive);

  if (/socket/.test(head)) return "socket head cap screw";
  if (/button/.test(head)) return socketDrive ? "button head socket cap screw" : "button head screw";
  if (/flat|countersunk/.test(head)) return socketDrive ? "flat head socket cap screw" : "flat head screw";
  if (/pan/.test(head)) return "pan head screw";
  if (/truss/.test(head)) return "truss head screw";
  if (/cheese/.test(head)) return "cheese head screw";
  if (/round/.test(head)) return "round head screw";
  if (/hex/.test(head)) return "hex head cap screw";
  if (/set screw/.test(head)) return "set screw";
  // A thread with a drive but no head type is a driven fastener, so
  // "machine screw" is a fair description. A thread with *neither* is not:
  // a nut, a coupling and a threaded insert all look like that, and
  // calling them screws sends the search to the wrong product entirely.
  return specs.threadSize && drive ? "machine screw" : null;
}

/**
 * What kind of part this is, which decides both the product noun and which
 * suppliers get asked. Families: fastener, nut, washer, sealing, rawstock,
 * other.
 *
 * The page's product noun is trusted first, because it is the only thing
 * that actually states the part type. Everything below it is structural
 * inference from the spec fields, for pasted spec blocks that carry no
 * title -- deliberately conservative, since a wrong family is what put
 * washers in front of bar-stock vendors.
 */
function partFamily(specs) {
  const declared = NOUN_FAMILY.get(String(specs.partType || "").toLowerCase());
  if (declared) return declared;

  // The manual-entry Category select is the person telling us directly.
  const category = (specs.category || "").toLowerCase();
  if (category.includes("fastener")) return "fastener";
  if (category.includes("stock")) return "rawstock";

  if (specs.headType) return "fastener";
  if (specs.screwSize) return "washer";
  if (specs.threadSize) return "fastener";
  if (specs.shape) return "rawstock";
  // An inside diameter used to imply a seal, which put shaft collars,
  // spacers, pulleys, gears and every other bored part in front of the
  // o-ring suppliers. It only means "this part has a hole in it". A seal
  // is identified by its name or by being made of rubber.
  if (specs.insideDiameter && /rubber|buna|viton|nitrile|silicone|neoprene|epdm/i.test(specs.material || "")) return "sealing";
  return "other";
}

/**
 * The noun to put in the search phrase. A detected part type wins; failing
 * that a headed fastener can be named from its head and drive. When
 * neither applies this returns null and the query carries sizes and
 * material only -- an under-specified search beats a confidently wrong one.
 */
function partNoun(specs, family) {
  // A known head type beats the title, because the title does not say what
  // the drive is: McMaster calls both of these a "Flat Head Screw", but a
  // hex-drive one is a flat head socket cap screw and a Phillips one is
  // not, and they sit in different aisles. fastenerNoun reads both fields.
  if (family === "fastener" && specs.headType) {
    return fastenerNoun(specs) || specs.partType || null;
  }
  if (specs.partType) return specs.partType;
  if (family === "fastener") return fastenerNoun(specs);
  return null;
}

// Kept for callers that only care whether a part is threaded hardware.
function isFastener(specs) {
  return partFamily(specs) === "fastener";
}

const joinTerms = (parts) => parts.filter(Boolean).join(" ").trim();

/**
 * Builds the phrase a person would actually type into a supplier's search
 * box -- "1/4"-20 x 3/4" socket head cap screw alloy steel black oxide" --
 * rather than concatenating every parsed field in schema order. The old
 * version produced "Alloy Steel 1/4"-20 3/8" Hex Black Oxide": head
 * diameter and thread class in, the words "socket head cap screw" missing
 * entirely, which is why Grainger answered "Whoops, we couldn't find that."
 */
function buildQuery(rawSpecs) {
  const specs = normalizeSpecs(rawSpecs);
  const family = partFamily(specs);
  const noun = partNoun(specs, family);

  if (family === "fastener") {
    // Rivets, anchors and pins have a diameter where a screw has a thread,
    // and dropping it left "1/4\" rivet" describing only the length.
    const size = [specs.threadSize || specs.diameter, specs.length].filter(Boolean).join(" x ");
    return joinTerms([size, noun, specs.material, specs.finish, specs.grade]);
  }

  // A nut has a thread and no length -- its own height is not something
  // anyone searches on, and pairing it with the thread as "1/4"-20 x 7/32""
  // would read as a screw length.
  if (family === "nut") {
    return joinTerms([specs.threadSize, noun, specs.material, specs.finish, specs.grade]);
  }

  // A washer is sold by the screw it fits, not by its own outside
  // diameter, so that is what leads the query.
  if (family === "washer") {
    return joinTerms([specs.screwSize || specs.threadSize, noun, specs.material, specs.finish]);
  }

  if (family === "sealing") {
    const size = [
      specs.insideDiameter && `${specs.insideDiameter} ID`,
      specs.width && `${specs.width} wide`,
    ]
      .filter(Boolean)
      .join(" x ");
    return joinTerms([
      size,
      noun,
      specs.material,
      specs.thickness && `${specs.thickness} thick`,
      specs.durometer,
    ]);
  }

  // Raw stock deliberately drops length: McMaster's is the length of the
  // stick it ships ("1 ft."), while metal suppliers cut to order, so
  // carrying it over just narrows the search with a number that means
  // something else on the other site.
  if (family === "fitting") {
    return joinTerms([specs.threadSize || specs.diameter, noun, specs.material, specs.finish]);
  }

  if (family === "rawstock") {
    return joinTerms([specs.material, specs.shape || noun, specs.diameter, specs.thickness, specs.width, specs.finish]);
  }

  // Bearings, springs, dowel pins. Inside diameter is a bearing's defining
  // spec and length is a pin's, so neither may be dropped here the way the
  // raw-stock branch deliberately drops stock length.
  return joinTerms([
    specs.material,
    noun,
    specs.threadSize,
    specs.insideDiameter && `${specs.insideDiameter} ID`,
    specs.shaftDiameter && `for ${specs.shaftDiameter} shaft`,
    specs.diameter,
    specs.thickness,
    specs.width,
    specs.length,
    specs.finish,
  ]);
}

// Each supplier's own search URL, taken from a real indexed results URL on
// that site. {q} is the percent-encoded query, {plus} the +-separated form.
//
// These cannot be verified from here, and that is a finding rather than an
// omission: every one of these sites refuses this server. Fastenal answers
// 403, MSC serves "Pardon Our Interruption", Bolt Depot a Cloudflare
// challenge, Amazon 503, and Grainger returns a byte-identical 18,269-byte
// "Whoops, we couldn't find that." page for nine different queries
// including a bare "socket head cap screw" -- so its no-results page is a
// bot wall too, not a verdict on the query. The links open in a real
// browser on a normal connection, where these sites behave normally, so a
// datacenter fetch tests the wrong thing. Hence the editable query in the
// UI: the person looking at the results is the only one positioned to
// judge them, so they get the controls rather than a claim.
const RAW_STOCK_SUPPLIERS = [
  { name: "Online Metals", urlTemplate: "https://www.onlinemetals.com/en/search?text={q}" },
  { name: "MSC Direct", urlTemplate: "https://www.mscdirect.com/browse/tn?searchterm={plus}" },
  { name: "Speedy Metals", urlTemplate: "https://www.speedymetals.com/Search?searchTerm={q}" },
  { name: "Grainger", urlTemplate: "https://www.grainger.com/search?searchQuery={q}" },
];

const FASTENER_SUPPLIERS = [
  { name: "Fastenal", urlTemplate: "https://www.fastenal.com/product?query={plus}" },
  { name: "Grainger", urlTemplate: "https://www.grainger.com/search?searchQuery={q}" },
  { name: "MSC Direct", urlTemplate: "https://www.mscdirect.com/browse/tn?searchterm={plus}" },
  { name: "Amazon", urlTemplate: "https://www.amazon.com/s?k={plus}" },
  { name: "AliExpress", urlTemplate: "https://www.aliexpress.com/wholesale?SearchText={plus}" },
];

function applyTemplate(urlTemplate, query) {
  return urlTemplate
    .replace("{plus}", encodeURIComponent(query).replace(/%20/g, "+"))
    .replace("{q}", encodeURIComponent(query));
}

// Everything that is neither threaded hardware nor a length of metal --
// o-rings, gaskets, bearings, springs. Sending these to Online Metals or
// Speedy Metals, as the old two-way split did, offers bar stock to someone
// who asked for a seal; the general MRO distributors actually carry them.
const MRO_SUPPLIERS = [
  { name: "Grainger", urlTemplate: "https://www.grainger.com/search?searchQuery={q}" },
  { name: "MSC Direct", urlTemplate: "https://www.mscdirect.com/browse/tn?searchterm={plus}" },
  { name: "Amazon", urlTemplate: "https://www.amazon.com/s?k={plus}" },
  { name: "AliExpress", urlTemplate: "https://www.aliexpress.com/wholesale?SearchText={plus}" },
];

const SUPPLIERS_BY_FAMILY = {
  fastener: FASTENER_SUPPLIERS,
  nut: FASTENER_SUPPLIERS,
  washer: FASTENER_SUPPLIERS,
  sealing: MRO_SUPPLIERS,
  fitting: MRO_SUPPLIERS,
  rawstock: RAW_STOCK_SUPPLIERS,
  other: MRO_SUPPLIERS,
};

function buildSupplierLinks(rawSpecs) {
  const specs = normalizeSpecs(rawSpecs);
  const query = buildQuery(rawSpecs);
  if (!query) return [];

  const family = partFamily(specs);
  const suppliers = [...(SUPPLIERS_BY_FAMILY[family] || MRO_SUPPLIERS)];

  // Bolt Depot has no free-text search, so its link is a filtered category
  // browse built from the specs directly -- it doesn't follow the query and
  // stays put when the query is edited. It stocks nuts and washers as well
  // as screws, so every threaded-hardware family gets one.
  if (SUPPLIERS_BY_FAMILY[family] === FASTENER_SUPPLIERS) {
    suppliers.splice(3, 0, { name: "Bolt Depot", urlTemplate: boltDepotUrl(specs, family) });
  }

  return suppliers.map((s) => ({ ...s, url: applyTemplate(s.urlTemplate, query), query }));
}

// Bolt Depot has no free-text search, only a filtered category browse
// (pattern taken from real indexed URLs, e.g.
// /Browse?Category=Hex_bolts&F_Diameter=3%2F8%22&F_Length=1%22&Units=US).
// Filters only get applied when the size parses cleanly; otherwise this
// falls back to the category landing page rather than emitting a URL with
// half-filled filters that returns nothing.
function boltDepotUrl(specs, family) {
  const head = (specs.headType || "").toLowerCase();
  const noun = (specs.partType || "").toLowerCase();
  const category =
    family === "washer" || /washer/.test(noun)
      ? "Washers"
      : family === "nut" || /\bnut\b/.test(noun)
        ? "Nuts"
        : /socket|button|flat/.test(head) || /socket|button|flat/.test(noun)
          ? "Socket_screws"
          : /hex/.test(head) || /hex (?:head|cap)/.test(noun)
            ? "Hex_bolts"
            : null;
  if (!category) return `https://boltdepot.com/Catalog-Tabs`;

  const params = new URLSearchParams({ Category: category, Units: "US" });
  // Only fractional-inch diameters get filtered. Bolt Depot writes gauge
  // sizes as "#4", and a bare F_Diameter=4 (which is what splitting "4-40"
  // gives) silently matches nothing -- an unfiltered category page is a
  // better landing spot than a filter that returns an empty grid.
  const dia = (specs.threadSize || specs.screwSize || "").split("-")[0].trim();
  if (dia && /["\/]/.test(dia)) {
    params.set("F_Diameter", dia);
    // Length belongs to a screw. A nut or washer has none, and sending one
    // filters the grid down to nothing.
    if (specs.length && family !== "nut" && family !== "washer") params.set("F_Length", specs.length);
  }
  return `https://boltdepot.com/Browse?${params.toString()}`;
}

module.exports = {
  parseSpecsFromText,
  parseKeyValueText,
  detectPartType,
  sanitizeSpecs,
  strengthGrade,
  normalizeThread,
  normalizeScrewSize,
  normalizeGauge,
  normalizeSpecs,
  fastenerNoun,
  partFamily,
  partNoun,
  isFastener,
  buildQuery,
  applyTemplate,
  buildSupplierLinks,
  boltDepotUrl,
};
