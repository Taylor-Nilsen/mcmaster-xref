/**
 * Pure spec parsing / query building. No express, no playwright, no
 * network -- so the logic that decides what a part *is* and what to search
 * for can be exercised directly by `npm test` without a browser or a
 * server. server.js is the only place that touches the outside world.
 */


// Wrapped so that, loaded as a browser <script>, none of these names land
// in the page's global scope.
(function () {
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
  [/drill bushing/i, "drill bushing", "other"],
  [/sleeve bearing|\bbushing\b/i, "sleeve bearing", "other"],
  [/ball bearing/i, "ball bearing", "other"],
  // Mounted, tapered-roller, cam-follower and the rest: the title's own
  // words in front say which, so the noun stays generic.
  [/\bbearing\b/i, "bearing", "other"],
  [/\bwasher\b/i, "washer", "washer"],

  // Pins before springs, or a spring pin reads as a spring.
  [/spring pin|roll pin/i, "spring pin", "other"],
  [/dowel pin/i, "dowel pin", "other"],
  [/cotter pin/i, "cotter pin", "other"],
  [/clevis pin/i, "clevis pin", "other"],
  [/taper pin/i, "taper pin", "other"],
  [/\bpin\b/i, "pin", "other"],

  [/retaining ring|snap ring|circlip|e.?style ring|e.?clip/i, "retaining ring", "other"],
  // Not a bare "insert": a carbide lathe insert is cutting tooling.
  [/helical insert|threaded insert|keylocking insert|heat.?set insert|press.?fit insert/i, "threaded insert", "fastener"],
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
  // Spur, bevel, miter, worm, helical: the qualifier carries the kind.
  // Calling every gear a spur gear searched bevel gears as spur gears.
  [/gear rack/i, "gear rack", "other"],
  [/\bgear\b/i, "gear", "other"],
  [/sprocket/i, "sprocket", "other"],
  [/roller chain/i, "roller chain", "other"],
  [/\bchain\b/i, "chain", "other"],
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
  [/push.?to.?connect/i, "push-to-connect fitting", "fitting"],
  [/hose fitting|tube fitting|pipe fitting/i, "fitting", "fitting"],
  [/quick.?disconnect/i, "quick-disconnect coupling", "fitting"],

  // Products whose names carry a raw-stock word without being stock.
  [/heat.?shrink/i, "heat-shrink tubing", "other"],
  [/(?:pipe|hose|tube) clamp/i, "clamp", "other"],

  // Raw stock. On a title these only count as the last word ("6061
  // Aluminum Sheet"), so a wall plate or plastic tubing isn't sent to the
  // metal suppliers -- see nounInTitle.
  [/key ?stock/i, "keystock", "rawstock"],
  [/round bar|rod stock/i, "round bar", "rawstock"],
  [/\brod\b/i, "rod", "rawstock"],
  [/hex bar/i, "hex bar", "rawstock"],
  [/square bar|rectangular bar|flat bar|\bbar stock\b/i, "bar", "rawstock"],
  [/\b(?:sheet|plate)\b/i, "sheet", "rawstock"],
  [/\bangle\b/i, "angle", "rawstock"],
  [/\bchannel\b/i, "channel", "rawstock"],
  [/\btub(?:e|ing)\b|\bpipe\b/i, "tube", "rawstock"],
];

// A spec table read with innerText comes out "Label<TAB>Value" on one line;
// McMaster's own layout, and a copy off it, puts them on separate lines.
// Both mean the same thing, so tabs are line breaks here.
function asLines(text) {
  return String(text || "").replace(/\r/g, "").replace(/[ \t]*\t[ \t]*/g, "\n");
}

const NOUN_FAMILY = new Map(PART_TYPES.map(([, noun, family]) => [noun, family]));

/**
 * Finds the product noun in a page's opening lines. Only the top of the
 * text is scanned: McMaster's rendered page starts with the product name,
 * and further down it lists related products and category links -- matching
 * those would rename the part to whatever it sits next to in the catalog.
 */
function detectPartType(text) {
  text = asLines(text);
  const lines = String(text || "")
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .slice(0, 5);

  // The title line says what the part is; check it on its own first, so a
  // word further down cannot outvote it.
  const title = productTitle(text);
  if (title) return nounInTitle(title);

  // Spec labels sit in these same top lines, and a label names a property,
  // not the part: "Pipe Size" on a ball valve made it a "tube" and sent it
  // to the metal suppliers.
  const head = lines.filter((l) => !SPEC_LABEL_RE.test(l)).join(" | ");
  for (const [re, noun] of PART_TYPES) {
    if (re.test(head)) return noun;
  }
  return null;
}

// The noun-table entry a title names, or null for a product the table does
// not know. A raw-stock word only counts as the title's last word: "6061
// Aluminum Sheet" is stock, a "Wall Plate" or "Soft Plastic Tubing" is not.
function nounInTitle(title) {
  for (const [re, noun, family] of PART_TYPES) {
    const m = re.exec(title);
    if (!m) continue;
    if (family === "rawstock") {
      const tail = title.slice(m.index + m[0].length).replace(/[\s,]*(?:stock)?s?$/i, "");
      if (tail.trim()) continue;
      if (/tub|pipe/i.test(m[0]) ? !METAL_RE.test(title) : !STOCK_MATERIAL_RE.test(title)) continue;
    }
    return noun;
  }
  return null;
}

const METAL_RE = /aluminum|steel|brass|bronze|copper|titanium|iron|nickel/i;
const STOCK_MATERIAL_RE =
  /aluminum|steel|brass|bronze|copper|titanium|iron|nickel|plastic|acrylic|polycarbonate|nylon|acetal|delrin|hdpe|uhmw|ptfe|pvc|garolite|fiberglass|carbon fiber|rubber|foam|felt|wood/i;

// Words in a title that say what the part is made of or coated with. Those
// have their own fields; what is left in front of the noun is what makes
// the part a *kind* of that noun.
const MATERIAL_WORD_RE =
  /^(?:metal|steel|stainless|alloy|carbon|low-carbon|high-carbon|aluminum|brass|bronze|copper|titanium|nylon|rubber|neoprene|silicone|nitrile|buna-n|epdm|viton|polyurethane|acetal|delrin|pvc|polycarbonate|plastic|zinc|galvanized|hot-dipped|plain|multipurpose|general-purpose|class|grade|[a-z]+-plated|black-oxide|[\d.\-]+)$/i;

/**
 * The words in front of the product noun in the title, minus material and
 * finish: "Ultra Low-Profile" in "Black-Oxide Alloy Steel Ultra Low-Profile
 * Socket Head Screw". The noun table maps every socket head screw to one
 * noun, so without this a low-profile screw was searched for as a regular
 * one, and every link showed regular screws.
 */
function titleQualifier(title) {
  if (!title) return null;
  let first = -1;
  for (const [re] of PART_TYPES) {
    const m = re.exec(title);
    if (m) {
      first = m.index;
      break;
    }
  }
  if (first <= 0) return null;
  const words = title
    .slice(0, first)
    .split(/\s+/)
    .filter((w) => w && !MATERIAL_WORD_RE.test(w));
  return words.length ? words.join(" ").toLowerCase() : null;
}

const SPEC_LABEL_RE =
  /\b(?:size|type|material|diameter|length|width|height|style|class|color|colour|pressure|rating|temperature|thread|od|id|gauge|voltage|current|capacity|profile|series|finish|thickness|for)\s*$/i;

// Lines McMaster's page frame can put above the product name.
const PAGE_CHROME_RE = /^(?:forward|print|share|find alternative|add to order|order|log ?in|sign in|home|products?|cad|\d+ in stock)\b/i;

/**
 * The product name. McMaster's page frame, the bookmarklet and the backend
 * all put it near the top, but not always on the first line, and a nav
 * link like "Socket Head Screws" can sit above it. So every line in the
 * top of the text is scored: one that names a known product wins, then one
 * that reads like a product name (a few words carrying a material or a
 * catalog noun), and earlier beats later.
 *
 * This is what names a part the noun table has never heard of -- a "Brass
 * Ball Valve" or "Nitrile Disposable Glove" is searchable as exactly that.
 */
function productTitle(text) {
  text = asLines(text);
  const lines = String(text || "")
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .slice(0, 40);
  let best = null;
  let bestScore = 0;
  // The product name sits directly above its spec table; a nav link sits
  // among other nav links. That position is the strongest signal there is,
  // so the next few lines being spec labels counts for more than anything
  // in the line itself.
  const isLabel = (l) =>
    !!l && (KEY_MAP[l.toLowerCase()] || EXTRA_LABEL_RE.test(l) || SPEC_LABEL_RE.test(l) || /^[\w -]+ type$/i.test(l));
  lines.forEach((line, i) => {
    const base = titleScore(line);
    const aboveSpecs = isLabel(lines[i + 1]) ? 4 : isLabel(lines[i + 2]) ? 2 : isLabel(lines[i + 3]) ? 1 : 0;
    const score = base + aboveSpecs - i * 0.05 + (i === 0 ? 1 : 0);
    if (base > 0 && score > bestScore) {
      best = line;
      bestScore = score;
    }
  });
  return best ? best.replace(/\s*[|\u2013\u2014]\s*McMaster-Carr.*$/i, "").trim() : null;
}

function titleScore(line) {
  if (line.length > 90 || !/[a-z]{3}/i.test(line) || /^https?:/i.test(line)) return 0;
  const words = line.split(/\s+/);
  if (words.length > 12) return 0;
  if (KEY_MAP[line.toLowerCase()] || SPEC_LABEL_RE.test(line) || PAGE_CHROME_RE.test(line) || /:\s*$/.test(line)) return 0;
  if (/^mcmaster/i.test(line)) return 0;
  const known = PART_TYPES.some(([re]) => re.test(line));
  const generic = CATALOG_NOUN_RE.test(line);
  // A value, not a name: "Number 10", '1/4"-20', "Clear". A name has at
  // least two real words ("18-8 Stainless Steel Hex Nut" counts), or is a
  // single catalog noun ("Earplugs").
  const realWords = words.filter((w) => /[a-z]{3}/i.test(w)).length;
  if (realWords < 2 && !((known || generic) && realWords === 1)) return 0;
  let score = 1;
  if (known) score += 5;
  else if (generic) score += 4;
  if (METAL_RE.test(line) || MATERIAL_WORD_RE.test(words[0])) score += 1;
  return score;
}

// Product nouns across the rest of McMaster's catalog -- the ones the
// noun table has no special query shape for, but which mark a line as a
// product name rather than a spec value or page text.
const CATALOG_NOUN_RE =
  /\b(?:valves?|pumps?|motors?|gearmotors?|switch(?:es)?|relays?|fuses?|breakers?|connectors?|terminals?|resistors?|capacitors?|diodes?|sensors?|transformers?|power suppl(?:y|ies)|batter(?:y|ies)|wires?|cables?|cords?|lights?|lamps?|leds?|fans?|heaters?|thermostats?|thermocouples?|gauges?|meters?|timers?|controllers?|actuators?|cylinders?|regulators?|filters?|lubricants?|greases?|oils?|adhesives?|epox(?:y|ies)|tapes?|sealants?|gloves?|glasses|goggles|earplugs?|ear ?muffs?|respirators?|masks?|hard hats?|helmets?|face ?shields?|vests?|coveralls?|aprons?|boots?|casters?|wheels?|hinges?|latch(?:es)?|handles?|knobs?|clamps?|hooks?|magnets?|brushes?|drills?|drill bits?|end mills?|taps?|dies|reamers?|saws?|blades?|wrench(?:es)?|screwdrivers?|pliers|hammers?|sockets?|bits?|files?|abrasives?|sandpaper|discs?|labels?|signs?|bins?|carts?|shelv(?:es|ing)|ladders?|containers?|bottles?|buckets?|funnels?|hoses?|couplings?|nozzles?|mufflers?|manifolds?|framing|rails?|extrusions?|slides?|guides?|bushings?|pulleys?|sprockets?|shafts?|collars?|mounts?|levelers?|bumpers?|grommets?|plugs?|caps?|ties?|straps?|chains?|ropes?|slings?|shackles?|turnbuckles?|springs?|dampers?|shocks?|struts?|locks?|padlocks?|enclosures?|boxes|cabinets?|panels?|tools?|kits?)\b/i;

// Spec rows whose value is what a buyer types into a search box, across the
// catalog: sizes, gear geometry, electrical ratings, PPE sizing. Rows the
// main parser already maps (thread size, length, material...) are left to
// it.
const EXTRA_LABEL_RE = new RegExp(
  "^(?:" +
    [
      "(?:nominal |trade |pipe |tube |hose |wire |drill |bit |wheel |mill |shank |port |bore |glove |fits? )?(?:size|od|gauge|diameter)",
      "stroke length", "stroke", "drill bit size", "point angle", "extended length", "force",
      "sensing (?:range|distance)", "niosh rating", "ansi (?:chain )?number",
      // Gears and power transmission.
      "(?:diametral )?pitch", "module", "number of teeth", "teeth", "pressure angle", "chain (?:size|number)", "belt (?:width|trade size)",
      // Electrical and electronic.
      "(?:ac |dc )?voltage", "current", "amperage", "(?:current|amperage) rating", "resistance", "capacitance",
      "wattage", "power", "number of poles", "number of throws", "number of positions", "number of conductors",
      "circuit", "switch action", "contact form",
      // PPE.
      "noise reduction rating(?: \\(nrr\\))?", "nrr", "(?:ansi )?cut level", "lens color", "lens tint",
      // Everything else.
      "capacity", "load capacity", "number of flutes", "series", "horsepower", "speed", "rpm",
      "flow rate", "maximum pressure", "pressure rating", "thread type", "grit",
    ].join("|") +
    ")$",
  "i"
);

// A bare number means nothing without the unit the label carried.
const EXTRA_UNITS = [
  [/wire gauge/i, "AWG"],
  [/flutes/i, "flute"],
  [/series/i, "series"],
  [/teeth/i, "teeth"],
  [/pitch/i, "pitch"],
  [/module/i, "module"],
  [/poles/i, "pole"],
  [/positions/i, "position"],
  [/conductors/i, "conductor"],
  [/grit/i, "grit"],
  [/nrr|noise reduction/i, "dB NRR"],
];

// A "Gear Type: Spur" row names the kind of part when the title doesn't
// ("Metal Gear"). Only a row about the title's own noun counts -- a
// "Thread Type" row on a gear says nothing about which gear it is.
function typeRow(text, title) {
  if (!title) return null;
  const lines = asLines(text).split("\n").map((l) => l.trim()).filter(Boolean);
  const lowerTitle = title.toLowerCase();
  for (let i = 0; i < lines.length - 1; i++) {
    const m = /^([a-z][a-z -]*?) type$/i.exec(lines[i]);
    if (!m) continue;
    const subject = m[1].toLowerCase().split(" ").pop();
    const value = lines[i + 1];
    if (!lowerTitle.includes(subject) || value.length > 25 || /\d/.test(value)) continue;
    if (lowerTitle.includes(value.toLowerCase())) return null;
    return value.toLowerCase();
  }
  return null;
}

// Values that say nothing a search can use.
const EMPTY_VALUE_RE = /^(?:standard|one size|n\/a|not rated|none|yes|no|various)$/i;

function titleExtras(text) {
  text = asLines(text);
  const lines = String(text || "").split("\n").map((l) => l.trim()).filter(Boolean);
  const out = [];
  for (let i = 0; i < lines.length - 1 && out.length < 4; i++) {
    if (!EXTRA_LABEL_RE.test(lines[i]) || KEY_MAP[lines[i].toLowerCase()]) continue;
    let v = lines[i + 1];
    if (v.length > 20 || EXTRA_LABEL_RE.test(v) || SPEC_LABEL_RE.test(v) || EMPTY_VALUE_RE.test(v)) continue;
    // A bare number means nothing without the unit the label carried.
    const unit = /^\d+$/.test(v) && EXTRA_UNITS.find(([re]) => re.test(lines[i]));
    if (unit) v = `${v} ${unit[1]}`;
    // A roller chain is sold as "#40", not "40".
    if (/ansi|chain (?:size|number)/i.test(lines[i]) && /^\d+$/.test(v)) v = `#${v}`;
    // "Clear" on its own could be anything; "clear lens" is a search term.
    if (/lens (?:color|tint)/i.test(lines[i])) v = `${v} lens`;
    if (!out.includes(v)) out.push(v);
    i++;
  }
  return out.join(" ");
}

function parseSpecsFromText(text) {
  text = asLines(text);
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

  // The page's own product name is kept whatever else is found: it is what
  // the results show the part was read as, and for most of McMaster's
  // catalog (anything the noun table doesn't know) it is the query.
  const title = productTitle(text);
  if (title) specs.title = title;
  const partType = detectPartType(text);
  if (partType) {
    specs.partType = partType;
    const qualifier = titleQualifier(title);
    if (qualifier) specs.qualifier = qualifier;
  }
  const extra = titleExtras(text);
  if (extra) specs.extra = extra;
  const kind = typeRow(text, title);
  if (kind) specs.qualifier = specs.qualifier ? `${kind} ${specs.qualifier}` : kind;

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
  "tube od": "diameter",
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
  "head profile": "headProfile",
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
  text = asLines(text);
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
    "title", "extra", "qualifier", "headProfile",
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
  // Electronics and PPE have their own distributors. Read from the title,
  // and only where the noun table has no stronger claim on the part.
  if ((!declared || declared === "other") && specs.title) {
    if (ELECTRICAL_RE.test(specs.title)) return "electrical";
    if (PPE_RE.test(specs.title)) return "ppe";
  }
  if (declared) return declared;

  // The manual-entry Category select is the person telling us directly.
  const category = (specs.category || "").toLowerCase();
  if (category.includes("fastener")) return "fastener";
  if (category.includes("stock")) return "rawstock";

  if (specs.headType) return "fastener";
  // A page title the noun table doesn't know means the part is none of the
  // families below. A pneumatic cylinder has a thread size too, and reading
  // it as a screw is the confidently wrong answer this function avoids.
  // A Shape row ("Round Bar") is raw stock's own spec, so it outranks a
  // title the noun table doesn't know ("6061 Aluminum Rod").
  if (specs.shape) return "rawstock";
  if (specs.title) return "other";
  if (specs.screwSize) return "washer";
  if (specs.threadSize) return "fastener";
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
  const noun = basePartNoun(specs, family);
  if (!noun) return null;
  // The spec table's "Head Profile" row says the same thing as a title's
  // "Low-Profile", for a spec block pasted without its title.
  const profile = specs.headProfile && !/standard/i.test(specs.headProfile) ? `${specs.headProfile} profile` : null;
  const q = specs.qualifier || (profile && profile.toLowerCase());
  // Skip what the noun already says ("nylon-insert" on a lock nut is
  // fine to add; "socket" on a socket head screw is not).
  const extra = q ? q.split(" ").filter((w) => !noun.includes(w.replace(/-/g, " ")) && !noun.includes(w)).join(" ") : "";
  return extra ? `${extra} ${noun}` : noun;
}

function basePartNoun(specs, family) {
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

// A title already carries its material ("Brass Ball Valve"); repeating it
// adds a term that narrows nothing.
function titleQuery(specs) {
  const title = specs.title;
  const lower = title.toLowerCase();
  // "304 Stainless Steel" on a "Stainless Steel Butt Hinge" repeats itself.
  const materialWords = specs.material ? specs.material.toLowerCase().split(/\s+/).filter((w) => /[a-z]{3}/.test(w)) : [];
  const material = materialWords.length && !materialWords.some((w) => lower.includes(w)) ? specs.material : null;
  return joinTerms([
    material,
    title,
    extraTerms(specs),
    specs.threadSize,
    specs.insideDiameter && `${specs.insideDiameter} ID`,
    specs.diameter,
    specs.length,
  ]);
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

  if (!noun && specs.title) return titleQuery(specs);

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
    // Pitch and tooth count for a gear, load rating for a caster: the spec
    // rows that tell one of these from its neighbours.
    extraTerms(specs),
  ]);
}

// The extras, minus anything another field already puts in the query.
function extraTerms(specs) {
  let extra = specs.extra || "";
  for (const key of ["threadSize", "diameter", "insideDiameter", "length", "width", "thickness", "screwSize"]) {
    if (specs[key]) extra = extra.split(specs[key]).join(" ");
  }
  return extra.replace(/\s+/g, " ").trim() || null;
}

const ELECTRICAL_RE =
  /\b(?:switch(?:es)?|relays?|fuses?|fuse holders?|circuit breakers?|connectors?|terminal blocks?|terminals?|resistors?|capacitors?|diodes?|transistors?|leds?|sensors?|transformers?|power suppl(?:y|ies)|batter(?:y|ies)|wires?|cables?|cords?|heat.?shrink|solder|potentiometers?|thermocouples?|encoders?|contactors?|receptacles?|outlets?|electrical|electronic|circuit|indicator lights?|pilot lights?|timers?|motor controllers?|speed controls?)\b/i;

const PPE_RE =
  /\b(?:gloves?|safety glasses|glasses|goggles|earplugs?|ear ?muffs?|hearing protect\w*|respirators?|dust masks?|masks?|hard hats?|helmets?|face ?shields?|safety vests?|vests?|coveralls?|aprons?|safety boots?|boots?|sleeves?|fall.protection|harness(?:es)?|lanyards?|knee pads?)\b/i;

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
// Measured 20 Sep 2026, by opening each search and reading what came back.
//
// Speedy Metals' path was simply wrong: /Search returns an IIS "404 - File
// or directory not found" for every query. Their own search form posts to
// search.aspx with a SearchTerm parameter, and that path returns real
// product rows.
//
// Online Metals is dropped. Its /en/search?text= was measured returning a
// Tomcat 404 (PR #7), and it now answers a datacenter client with a
// Cloudflare challenge on every path, so there is no way to confirm a
// replacement from a server. Their robots.txt disallows /*?q=, which says
// the storefront queries on q rather than text -- evidence, but not a
// measurement, and a supplier earns its place here by measurement. Metal
// Supermarkets takes the slot: it answers, and it reports its own result
// count in the page, so the count below is read rather than inferred.
//
// dimensionless: these two are cut-to-order stock houses. They index a
// product by material and form and sell the dimensions as options on it,
// so a size in the search string matches no product name and returns
// nothing at all. Measured over the seven raw-stock queries in the
// category matrix, carrying the dimensions scored 0/7 at both; dropping
// them scored 5/7 at Metal Supermarkets (5, 14, 6, 9 and 3 results) and
// 2/7 at Speedy Metals. Speedy Metals' own no-results page gives the same
// advice: "it's often best to search without dimensions first."
//
// MSC and Grainger are distributors that do index dimensions, and both
// refuse a datacenter client, so there is no measurement that would
// justify taking the size away from them. They keep the full query.
const RAW_STOCK_SUPPLIERS = [
  {
    name: "Speedy Metals",
    urlTemplate: "https://www.speedymetals.com/search.aspx?SearchTerm={plus}",
    dimensionless: true,
  },
  {
    name: "Metal Supermarkets",
    urlTemplate: "https://www.metalsupermarkets.com/?s={plus}",
    dimensionless: true,
  },
  { name: "MSC Direct", urlTemplate: "https://www.mscdirect.com/browse/tn?searchterm={plus}" },
  { name: "Grainger", urlTemplate: "https://www.grainger.com/search?searchQuery={q}" },
];

const FASTENER_SUPPLIERS = [
  { name: "Fastenal", urlTemplate: "https://www.fastenal.com/product?query={plus}" },
  { name: "Grainger", urlTemplate: "https://www.grainger.com/search?searchQuery={q}" },
  { name: "MSC Direct", urlTemplate: "https://www.mscdirect.com/browse/tn?searchterm={plus}" },
  { name: "Amazon", urlTemplate: "https://www.amazon.com/s?k={plus}" },
  { name: "AliExpress", urlTemplate: "https://www.aliexpress.com/wholesale?SearchText={plus}" },
];

// Drops the dimension tokens from a query: anything carrying a digit and
// ending in an inch mark ('3/8"', '0.063"'). Material, grade and form are
// what a cut-to-order stock house indexes, and they are all that is left.
function stripDimensions(query) {
  return String(query || "")
    .replace(/\S*[0-9][^\s]*"/g, "")
    // Dimensions are joined by "x" ('1/2" x 0.035"'), so removing them can
    // leave the separator behind. These searches are a strict AND over the
    // product name, and a stray "x" is a term that matches nothing.
    .replace(/(^|\s)x(?=\s|$)/g, "$1")
    .replace(/\s+/g, " ")
    .trim();
}

function applyTemplate(urlTemplate, query) {
  return urlTemplate
    .replace("{plus}", encodeURIComponent(query).replace(/%20/g, "+"))
    .replace("{q}", encodeURIComponent(query));
}

// Everything that is neither threaded hardware nor a length of metal --
// o-rings, gaskets, bearings, springs. Sending these to the metal
// suppliers, as the old two-way split did, offers bar stock to someone
// who asked for a seal; the general MRO distributors actually carry them.
const MRO_SUPPLIERS = [
  { name: "Grainger", urlTemplate: "https://www.grainger.com/search?searchQuery={q}" },
  { name: "MSC Direct", urlTemplate: "https://www.mscdirect.com/browse/tn?searchterm={plus}" },
  { name: "Amazon", urlTemplate: "https://www.amazon.com/s?k={plus}" },
  { name: "AliExpress", urlTemplate: "https://www.aliexpress.com/wholesale?SearchText={plus}" },
];

// Electronics distributors index by the part's electrical ratings, which is
// what the extras carry. Their search URLs could not be checked from a
// server either: Digi-Key answers with a Cloudflare challenge and Mouser's
// results render client-side.
const ELECTRICAL_SUPPLIERS = [
  { name: "Digi-Key", urlTemplate: "https://www.digikey.com/en/products/result?keywords={plus}" },
  { name: "Mouser", urlTemplate: "https://www.mouser.com/c/?q={q}" },
  { name: "Grainger", urlTemplate: "https://www.grainger.com/search?searchQuery={q}" },
  { name: "Amazon", urlTemplate: "https://www.amazon.com/s?k={plus}" },
  { name: "AliExpress", urlTemplate: "https://www.aliexpress.com/wholesale?SearchText={plus}" },
];

// Safety gear is rated gear (ANSI, NRR, cut level); the MRO houses carry
// rated stock, and an unrated knockoff is the wrong cheaper equivalent.
const PPE_SUPPLIERS = [
  { name: "Grainger", urlTemplate: "https://www.grainger.com/search?searchQuery={q}" },
  { name: "MSC Direct", urlTemplate: "https://www.mscdirect.com/browse/tn?searchterm={plus}" },
  { name: "Amazon", urlTemplate: "https://www.amazon.com/s?k={plus}" },
];

const SUPPLIERS_BY_FAMILY = {
  electrical: ELECTRICAL_SUPPLIERS,
  ppe: PPE_SUPPLIERS,
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
  // as screws, so every threaded-hardware family gets one. Not for a
  // qualified part, though: its category grid can only show the plain
  // version, which is the wrong part presented as a match.
  if (SUPPLIERS_BY_FAMILY[family] === FASTENER_SUPPLIERS && !specs.qualifier && !specs.headProfile) {
    suppliers.splice(3, 0, { name: "Bolt Depot", urlTemplate: boltDepotUrl(specs, family) });
  }

  // A dimensionless supplier gets its own query, and carries the flag so the
  // frontend applies the same transform when the query is edited by hand.
  return suppliers.map((s) => {
    const supplierQuery = s.dimensionless ? stripDimensions(query) || query : query;
    return { ...s, url: applyTemplate(s.urlTemplate, supplierQuery), query: supplierQuery };
  });
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

const api = {
  parseSpecsFromText,
  parseKeyValueText,
  detectPartType,
  productTitle,
  titleQualifier,
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
  stripDimensions,
  buildSupplierLinks,
  boltDepotUrl,
};

// Loaded two ways: required by the Node backend, and as a plain <script>
// by the frontend, which runs the same parser and query builder in the
// browser. A pasted spec block or manual entry then never leaves the phone:
// no backend round trip, no cold start, and it works offline.
if (typeof module !== "undefined" && module.exports) module.exports = api;
else globalThis.XrefSpecs = api;
})();
