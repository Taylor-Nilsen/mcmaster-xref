/**
 * Product model built from McMaster-Carr's own structured product record,
 * instead of regexing the rendered page's innerText (see lib/specs.js).
 * Pure, no network, no express -- exercised directly by `npm test`.
 *
 * McMaster serves each product page with a big inline JSON blob (a
 * "webpart" payload) embedded in the HTML. `parseProductRecord` finds that
 * object and turns it into a small, stable `Product`:
 *
 *   { partNumber, title, family, categoryPath, attributes, byName }
 *
 * `attributes` is a flat list of every spec row McMaster shows, in table
 * order, as `{ group, name, value, raw }`. `group` is the bare header row a
 * spec sits under ("Thread" -> Size/Spacing/Type/Fit/Direction, "Head" ->
 * Diameter/Height) or null for a top-level spec. Nothing is filtered out --
 * a part's full spec table survives the parse even though only a handful of
 * fields feed a query, because a caller may want the rest (Tensile
 * Strength, Hardness, compliance flags, ...) later. `byName(name, group?)`
 * is a small case-insensitive lookup over that list, and is what
 * disambiguates the two things McMaster happens to both call "Diameter" on
 * a socket screw: the head's diameter (group "Head") and the shank/thread
 * size, which lives under a different name entirely ("Thread" -> "Size").
 *
 * `classifyProduct` turns that structured record into `{ noun, kind }` --
 * the trade name a supplier search box expects ("socket head cap screw")
 * and a coarse bucket used to route the query (fastener/nut/washer/
 * rawstock/sealing/bearing/fitting/other). `ProductFamily` (and, when it is
 * too generic to be a noun by itself -- raw materials pages are filed under
 * their bare material name, e.g. family "Steel" for a page of steel balls
 * -- the more specific breadcrumb sitting just above the part) is the
 * default noun, singularized ("Hex Nuts" -> "hex nut"); a handful of
 * kind-specific rules refine it where the family name is not what a
 * supplier calls the part (a headed screw's noun depends on its Fastener
 * Head Type + Drive Style, not the generic "Screws" family a plain title
 * would give it). This mirrors the lessons already learned the hard way in
 * lib/specs.js -- a nut and a screw share a thread size and a material, so
 * only a real "what is this" signal may pick the noun -- except here that
 * signal is a structured field instead of prose.
 *
 * `buildQueries` assembles the supplier-neutral search phrase itself:
 * size, then noun, then material/finish/grade, in the order a catalog
 * indexes them. It applies the normalization rules learned from real
 * McMaster pages: "Class 3" (a thread *fit*, under the "Fit" field) never
 * reaches a query at all because nothing here ever reads that field for a
 * grade -- unlike the old prose parser, which had to specially exclude it
 * because "class" was one ambiguous label doing two jobs. A genuine
 * strength class ("Class 12.9") still comes through, because McMaster
 * folds it into the *Material* string ("Class 12.9 Alloy Steel") and that
 * is read deliberately. Finish is unfolded the same way ("Black-Oxide
 * Alloy Steel" -> material "Alloy Steel" + finish "Black-Oxide"). Metric
 * threads ("M6 x 1 mm") become "M6-1"; gauge sizes ("Number 10", or a bare
 * "8" on a sheet metal screw's thread field) become "#10"/"#8". Raw stock
 * is the one deliberate exception to "size, noun, material": a grade code
 * like "52100" or "6061" reads, in a real catalog, as a prefix on the
 * material-and-shape noun itself ("52100 steel ball", "6061 aluminum round
 * bar"), not as a trailing modifier, so its query keeps that order.
 *
 * `buildSupplierLinks` reuses the exact search URL formats already
 * verified (in a browser, not from this sandbox -- see lib/specs.js for
 * why a datacenter fetch cannot check most of these) for the suppliers
 * lib/specs.js already carries, and adds a small number of new ones the
 * caller asked for by name (Banggood, Zoro, Online Metals) using their
 * documented/well-known search URL shape -- flagged in comments below as
 * unverified from here, same as every fastener-supplier link already was.
 */

// ---------------------------------------------------------------------------
// JSON extraction
// ---------------------------------------------------------------------------

/**
 * Finds the first balanced `{...}` object starting at or after `start`,
 * tracking string/escape state so braces inside quoted values do not throw
 * off the depth count. McMaster's captured pages are `<10-digit byte
 * length><JSON><trailing HTML>`, but that length is a *byte* count while
 * the text here is a JS string (UTF-16 code units) -- multi-byte
 * punctuation in the copy (em dashes, curly quotes) makes the two disagree,
 * so slicing by the declared length lands mid-object. Scanning for the
 * matching brace instead works regardless of encoding.
 */
function extractJsonObject(text, start) {
  let i = start;
  if (text[i] !== "{") {
    i = text.indexOf("{", start);
    if (i === -1) return null;
  }
  let depth = 0;
  let inString = false;
  let escape = false;
  for (let j = i; j < text.length; j++) {
    const ch = text[j];
    if (inString) {
      if (escape) escape = false;
      else if (ch === "\\") escape = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') {
      inString = true;
      continue;
    }
    if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) return text.slice(i, j + 1);
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Text cleanup: strip HTML, decode entities
// ---------------------------------------------------------------------------

function stripHtml(value) {
  return String(value == null ? "" : value).replace(/<[^>]*>/g, "");
}

// Small, deliberately non-exhaustive table: covers what actually shows up
// in McMaster's spec values and marketing copy (fractions wrapped in
// <span class="af">, degree signs, multiplication signs, curly
// punctuation), not a general-purpose HTML entity decoder.
const NAMED_ENTITIES = {
  amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ",
  deg: "°", times: "×", mdash: "—", ndash: "–",
  rsquo: "’", lsquo: "‘", rdquo: "”", ldquo: "“",
  hellip: "…", plusmn: "±", micro: "µ",
};

function decodeEntities(value) {
  return String(value == null ? "" : value).replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (whole, ent) => {
    if (ent[0] === "#") {
      const isHex = ent[1] === "x" || ent[1] === "X";
      const code = parseInt(ent.slice(isHex ? 2 : 1), isHex ? 16 : 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : whole;
    }
    const key = ent.toLowerCase();
    return Object.prototype.hasOwnProperty.call(NAMED_ENTITIES, key) ? NAMED_ENTITIES[key] : whole;
  });
}

function cleanValue(value) {
  return decodeEntities(stripHtml(value)).replace(/\s+/g, " ").trim();
}

function lc(value) {
  return String(value == null ? "" : value).toLowerCase();
}

/**
 * "Hex Nuts" -> "Hex Nut". Deliberately simple: this is McMaster's own
 * category/family naming, which is regular enough (plural family names,
 * plain nouns) that a general English singularizer would be overkill and
 * would mishandle words this catalog never actually produces.
 */
function singularize(word) {
  if (!word) return word;
  const w = String(word).trim();
  if (/ies$/i.test(w)) return w.replace(/ies$/i, "y");
  if (/(ss|us|sis)$/i.test(w)) return w;
  if (/s$/i.test(w)) return w.slice(0, -1);
  return w;
}

// ---------------------------------------------------------------------------
// parseProductRecord
// ---------------------------------------------------------------------------

/**
 * @param {string|Buffer|object} input Either the raw captured page text
 *   (`<length prefix><JSON>...`), a bare JSON string, or an
 *   already-`JSON.parse`d record object (whatever the fetch layer hands
 *   back). All three are accepted so this stays decoupled from exactly how
 *   lib/mcmaster.js captures the page.
 * @returns {Product}
 */
// `Buffer` only exists under Node; guarded so this file stays loadable as a
// plain browser <script> (see the window.McmXref attachment at the bottom)
// without changing Node behavior at all -- isNodeBuffer is just false, never
// thrown, in a browser.
function isNodeBuffer(value) {
  return typeof Buffer !== "undefined" && Buffer.isBuffer(value);
}

function parseProductRecord(input) {
  let record;
  if (input && typeof input === "object" && !isNodeBuffer(input)) {
    record = input;
  } else {
    const text = isNodeBuffer(input) ? input.toString("utf8") : String(input);
    const start = text.indexOf("{");
    if (start === -1) throw new Error("parseProductRecord: no JSON object found in input");
    const jsonText = extractJsonObject(text, start);
    if (!jsonText) throw new Error("parseProductRecord: could not find a balanced JSON object");
    record = JSON.parse(jsonText);
  }

  const partNumber = record.PartNbrTxt || "";
  const title = cleanValue(record.TitleTxt || "");
  const meta = record.TargetPageMetadata || {};
  const family = meta.ProductFamily || null;

  const reactData = record.ReactData || {};
  const breadcrumbs = Array.isArray(reactData.Breadcrumbs) ? reactData.Breadcrumbs : [];
  // The last breadcrumb is always the part number itself (empty NodeType,
  // empty Href) -- drop it, since it is not a category name.
  const categoryPath = breadcrumbs
    .map((b) => (b && b.Name ? String(b.Name).trim() : ""))
    .filter((name) => name && name !== partNumber);

  // Spec rows come as a flat list where a group header is its own row (an
  // empty Value, not indented) immediately followed by its indented
  // children ("Thread" -> Size/Spacing/Type/Fit/Direction; "Head" ->
  // Diameter/Height). `group` tracks the header currently in scope; a
  // non-indented row with a real value ends that scope. TableEntryStandard
  // rows are links (SDS, etc.) and carry no spec value, so they're skipped.
  const attributes = [];
  let group = null;
  const tableEntries = Array.isArray(reactData.TableEntries) ? reactData.TableEntries : [];
  for (const entry of tableEntries) {
    if (!entry || entry.Type !== "TableEntrySpec") continue;
    const rawValue = entry.Value;
    const isHeader = (rawValue === "" || rawValue == null) && !entry.IsIndented;
    if (isHeader) {
      group = entry.Name;
      continue;
    }
    if (!entry.IsIndented) group = null;
    attributes.push({ group, name: entry.Name, value: cleanValue(rawValue), raw: rawValue });
  }

  const copies = Array.isArray(reactData.Copies) ? reactData.Copies.map(cleanValue) : [];
  const catalogPages = Array.isArray(record.CtlgPgNbrs) ? record.CtlgPgNbrs : [];

  function byName(name, matchGroup) {
    const nameLower = lc(name);
    const groupLower = matchGroup != null ? lc(matchGroup) : null;
    const hit = attributes.find(
      (a) => lc(a.name) === nameLower && (groupLower == null || lc(a.group) === groupLower)
    );
    return hit ? hit.value : undefined;
  }

  return { partNumber, title, family, categoryPath, attributes, copies, catalogPages, byName };
}

// ---------------------------------------------------------------------------
// classifyProduct
// ---------------------------------------------------------------------------

// Category-path keyword rules, most specific/reliable first. A part's
// breadcrumb trail says what it *is* far more reliably than its spec
// fields do (a nut and a screw share a thread size and a material), the
// same reason lib/specs.js trusts the page title over inferring from specs.
const KIND_RULES = [
  { kind: "nut", test: (p) => p.some((s) => s.includes("nut")) },
  { kind: "washer", test: (p) => p.some((s) => s.includes("washer")) },
  { kind: "bearing", test: (p) => p.some((s) => s.includes("bearing")) },
  { kind: "sealing", test: (p) => p.some((s) => /\bseal|o-ring|gasket/.test(s)) },
  { kind: "fitting", test: (p) => p.some((s) => /fitting|nipple|coupling|valve|adapter/.test(s)) },
  { kind: "rawstock", test: (p) => p.some((s) => s.includes("raw material")) },
];

// Screws/bolts/rivets/anchors/studs named in a *specific* breadcrumb
// segment ("Screws and Bolts", "Blind Rivets") really are a fastener no
// matter what else the record says. The catch-all top-level category
// ("Fastening and Joining"), though, also files pins, retaining rings and
// springs that are not threaded fasteners at all -- so a match on that
// bare top-level segment alone (whether it's the word "fastening" or one
// of the keywords themselves sitting at the top) only counts once the
// record shows an actual threaded-fastener signal. Otherwise a dowel pin
// or an extension spring, both filed under "Fastening and Joining", would
// be classified "fastener" and run through fastenerQuery, which only
// knows to read Thread Size/Length/Material -- dropping the pin's
// diameter or the spring's wire/OD/free-length entirely.
const FASTENER_KEYWORD_RE = /screw|bolt|rivet|anchor|\bstud\b/;

function hasThreadedFastenerSignal(product) {
  return Boolean(
    product.byName("Thread Size") ||
    product.byName("Size", "Thread") ||
    product.byName("Fastener Head Type") ||
    product.byName("Head Type")
  );
}

function isFastenerCategory(path, product) {
  if (path.slice(1).some((s) => FASTENER_KEYWORD_RE.test(s))) return true;
  const topLevelMatch = path.some((s) => FASTENER_KEYWORD_RE.test(s) || s.includes("fastening"));
  return topLevelMatch && hasThreadedFastenerSignal(product);
}

// Very small last-resort signal: when a record has neither a usable
// breadcrumb trail nor a spec field this module recognizes (an empty
// `ReactData.Breadcrumbs`, seen on a real captured record -- see
// test/fixtures/mcmaster/sweep/92620A624.json), the page's own title and
// family name still say what the part is in plain English. Deliberately
// narrow and checked dead last: a word search over free text is far less
// reliable than a labeled attribute, so it only ever gets a chance to run
// once every attribute-based rule above has already declined to answer.
function classifyKindFromTitleFamily(product) {
  const text = lc(`${product.title || ""} ${product.family || ""}`);
  if (!text.trim()) return null;
  if (/\bnut\b/.test(text)) return "nut";
  if (/\bwasher\b/.test(text)) return "washer";
  if (/\bbearing\b/.test(text)) return "bearing";
  if (/\b(o-ring|gasket|seal)\b/.test(text)) return "sealing";
  if (/\b(fitting|nipple|coupling|valve|adapter)\b/.test(text)) return "fitting";
  if (/\b(pin|retaining ring|rivet|spring|insert|standoff)\b/.test(text)) return "other";
  if (/\b(screw|bolt|\bstud\b)\b/.test(text)) return "fastener";
  return null;
}

/**
 * Structural fallback for a record with a thin or missing breadcrumb trail
 * -- deliberately conservative, mirroring lib/specs.js's own fallback
 * (partFamily): a wrong kind is what put washers in front of bar-stock
 * vendors there, so each rule below only fires on a field that really does
 * imply that kind.
 *
 * Order matters: a handful of non-fastener part types (pins, retaining
 * rings, rivets, springs, inserts, standoffs) sometimes carry a generic
 * "Head Type" of their own, so their own more specific fields are checked
 * *before* the generic "Fastener Head Type"/"Head Type"/"Thread Size"
 * rules -- those two now sit at the bottom as the true catch-alls they are,
 * exactly as reliable as before for an actual screw/bolt/nut/rod, just no
 * longer able to steal a pin or a rivet away from its own rule first.
 */
function classifyKindFromAttributes(product) {
  if (product.byName("Nut Type")) return "nut";
  if (product.byName("For Screw Size") || product.byName("Screw Size")) return "washer";
  // Pins, retaining rings, rivets, springs, inserts and standoffs have no
  // dedicated query builder of their own -- they fall through to the
  // generic "other" bucket (otherQuery already knows how to read a wire
  // diameter, a free length, a plain diameter+length pair, ...) -- but
  // routing them there explicitly, off their own field names, keeps them
  // out of fastenerQuery, which would otherwise read a stray "Head Type"
  // or thread field wrong or just silently drop a pin/spring's real specs.
  if (product.byName("Pin Type")) return "other";
  if (product.byName("Retaining Ring Type")) return "other";
  if (product.byName("Rivet Type")) return "other";
  if (product.byName("Spring Type") || product.byName("Wire Diameter")) return "other";
  if (product.byName("Insert Type")) return "other";
  if (product.byName("Standoff Type")) return "other";
  // "For Shaft Diameter" is what McMaster calls a shaft collar's bore --
  // a distinct field name from "Bore", but the same kind of part (a
  // bore-and-OD size, no thread), so it gets routed the same way.
  if (product.byName("Bore") || product.byName("Bearing Type") || product.byName("For Shaft Diameter")) return "bearing";
  // Dash Number (an AS568 o-ring size code) and Durometer are seal-specific
  // enough on their own that neither shows up on anything else this module
  // classifies.
  if (product.byName("Dash Number") || product.byName("Durometer")) return "sealing";
  if (product.byName("Pipe Size") || product.byName("Tube OD")) return "fitting";
  const threadType = product.byName("Thread Type");
  if (threadType && /npt/i.test(threadType)) return "fitting";
  if (product.byName("Shape") || product.byName("Wall Thickness")) return "rawstock";
  if (product.byName("Fastener Head Type") || product.byName("Head Type")) return "fastener";
  if (product.byName("Thread Size") || product.byName("Size", "Thread")) return "fastener";
  return classifyKindFromTitleFamily(product) || "other";
}

function classifyKind(product) {
  const path = product.categoryPath.map(lc);
  for (const rule of KIND_RULES) {
    if (rule.test(path)) return rule.kind;
  }
  if (isFastenerCategory(path, product)) return "fastener";
  return classifyKindFromAttributes(product);
}

/**
 * Trade names for a headed fastener, in the order a supplier catalog uses
 * them (checked most specific first: a "Hex" *drive* on a flat or button
 * head is a socket cap screw, not the external-hex bolt a "Hex" *head*
 * would be). Ported from lib/specs.js's fastenerNoun, now driven by the
 * structured "Fastener Head Type"/"Drive Style" fields instead of prose.
 */
function fastenerHeadNoun(headType, driveStyle) {
  const head = lc(headType);
  const drive = lc(driveStyle);
  const socketDrive = /hex|socket|torx/.test(drive);
  if (/socket/.test(head)) return "socket head cap screw";
  if (/button/.test(head)) return socketDrive ? "button head socket cap screw" : "button head screw";
  if (/flat|countersunk/.test(head)) return socketDrive ? "flat head socket cap screw" : "flat head screw";
  if (/pan/.test(head)) return "pan head screw";
  if (/truss/.test(head)) return "truss head screw";
  if (/cheese/.test(head)) return "cheese head screw";
  if (/oval/.test(head)) return socketDrive ? "oval head socket cap screw" : "oval head screw";
  if (/round/.test(head)) return "round head screw";
  if (/hex/.test(head)) return "hex head cap screw";
  return null;
}

/**
 * The default noun: the family name singularized, falling back to the most
 * specific breadcrumb when the family itself is too generic to say what
 * the part *is* -- the raw-materials catalog files a page of steel balls
 * under the bare family "Steel", with "Steel Balls" as the breadcrumb
 * sitting directly above the part.
 */
function baseNoun(product) {
  const family = product.family;
  const path = product.categoryPath;
  const leaf = path.length > 1 ? path[path.length - 1] : null;
  if (family && leaf && lc(leaf) !== lc(family) && lc(leaf).includes(lc(family))) {
    return lc(singularize(leaf));
  }
  if (family) return lc(singularize(family));
  if (leaf) return lc(singularize(leaf));
  return null;
}

function deriveNoun(product, kind) {
  const base = baseNoun(product);

  if (kind === "fastener") {
    const headType = product.byName("Fastener Head Type") || product.byName("Head Type");
    if (headType) {
      const driveStyle = product.byName("Drive Style") || product.byName("Drive Type");
      const headNoun = fastenerHeadNoun(headType, driveStyle);
      if (headNoun) return headNoun;
    }
    // A thread with a drive but no head type (e.g. a slotted machine
    // screw with no distinguishable head shape recorded) is still fairly
    // described as a machine screw; the family name is trusted otherwise.
    if (!base && product.byName("Thread Size") && (product.byName("Drive Style") || product.byName("Drive Type"))) {
      return "machine screw";
    }
    return base || "fastener";
  }

  if (kind === "nut") {
    const nutType = product.byName("Nut Type");
    if (nutType && base && !base.includes(lc(nutType))) return `${lc(nutType)} ${base}`.trim();
    return base || "nut";
  }

  if (kind === "washer") {
    const washerType = product.byName("Washer Type");
    if (washerType && base && !base.includes(lc(washerType))) return `${lc(washerType)} ${base}`.trim();
    return base || "washer";
  }

  if (kind === "rawstock") {
    const shape = product.byName("Shape");
    // Raw-material pages are filed under the bare material class ("Steel",
    // "Aluminum"); combined with the Shape attribute that is the trade
    // name ("steel ball", "aluminum round bar"). A grade code ("52100",
    // "6061") is *not* part of this noun -- it prefixes the query instead,
    // the way a real catalog phrase reads ("52100 steel ball").
    const materialClass = product.family ? lc(singularize(product.family)) : base;
    if (materialClass && shape) return `${materialClass} ${lc(shape)}`.trim();
    if (shape) return lc(shape);
    return base || "stock";
  }

  if (kind === "sealing") {
    if (base && /o-?ring/.test(base)) return "o-ring";
    return base || "seal";
  }

  return base || kind;
}

/**
 * @param {Product} product
 * @returns {{noun: string, kind: string}}
 */
function classifyProduct(product) {
  const kind = classifyKind(product);
  const noun = deriveNoun(product, kind) || baseNoun(product) || "part";
  return { noun, kind };
}

// ---------------------------------------------------------------------------
// buildQueries
// ---------------------------------------------------------------------------

// McMaster folds the finish into the material string ("Black-Oxide Alloy
// Steel"); suppliers index the two separately, so split them apart. Ported
// from lib/specs.js's FINISH_PREFIXES/normalizeSpecs, now applied to the
// structured Material field instead of a fuzzy label/value scan.
//
// `match` is checked against the material with every hyphen turned into a
// space first (McMaster is inconsistent about which finish words it
// hyphenates -- "Zinc Yellow-Chromate Plated" in some records, fully
// hyphenated "Zinc-Yellow-Chromate-Plated" in others -- and a hyphen and a
// space are both single characters, so the matched length still lines up
// with the *original*, un-normalized material string for slicing). `canonical`
// is what actually reaches a query: McMaster's own capitalized/hyphenated
// form ("Black-Oxide", "Zinc-Yellow-Chromate-Plated") is never a phrase a
// supplier search box expects -- plain lowercase words are.
const FINISH_PREFIXES = [
  { match: "black oxide", canonical: "black oxide" },
  { match: "zinc yellow chromate plated", canonical: "zinc yellow chromate" },
  { match: "yellow chromate plated", canonical: "yellow chromate" },
  { match: "zinc plated", canonical: "zinc plated" },
  { match: "hot dipped galvanized", canonical: "hot dip galvanized" },
  { match: "hot dip galvanized", canonical: "hot dip galvanized" },
  { match: "galvanized", canonical: "galvanized" },
  { match: "chrome plated", canonical: "chrome plated" },
  { match: "nickel plated", canonical: "nickel plated" },
  { match: "passivated", canonical: "passivated" },
  { match: "anodized", canonical: "anodized" },
  { match: "powder coated", canonical: "powder coated" },
  { match: "phosphate", canonical: "phosphate" },
  { match: "cadmium plated", canonical: "cadmium plated" },
];

function findFinishPrefix(normalizedLower) {
  return FINISH_PREFIXES.find((f) => normalizedLower.startsWith(f.match)) || null;
}

// For a finish that arrives as its own labeled attribute ("Finish": "Zinc
// Plated") rather than folded into Material -- still McMaster's
// hyphenated/capitalized form, so it gets the same plain-words treatment
// every builder now applies uniformly.
function canonicalizeFinishText(raw) {
  if (!raw) return null;
  const trimmed = String(raw).trim();
  if (!trimmed) return null;
  const normalized = lc(trimmed).replace(/-/g, " ");
  const hit = findFinishPrefix(normalized);
  return hit ? hit.canonical : normalized;
}

// McMaster folds a metric property class into the material string too
// ("Class 12.9 Alloy Steel"). A genuine strength rating survives this way;
// a thread *fit* class ("Unified Standard Class 3A") never reaches this
// function at all, because it lives in the "Fit" attribute, which nothing
// here reads for a grade -- the ambiguity lib/specs.js had to special-case
// (strengthGrade()) does not exist in the structured data.
const GRADE_PREFIX_RE = /^(class\s*\d+(?:\.\d+)?|grade\s*[\w.]+)\s+/i;

function splitMaterial(materialRaw) {
  let material = materialRaw ? String(materialRaw).trim() : "";
  let finish = null;
  let grade = null;
  if (material) {
    const normalized = lc(material).replace(/-/g, " ");
    const hitFinish = findFinishPrefix(normalized);
    if (hitFinish) {
      finish = hitFinish.canonical;
      material = material.slice(hitFinish.match.length).trim();
    }
  }
  if (material) {
    const hitGrade = material.match(GRADE_PREFIX_RE);
    if (hitGrade) {
      grade = normalizeGradeValue(hitGrade[1].trim());
      material = material.slice(hitGrade[0].length).trim();
    }
  }
  return { material: material || null, finish, grade };
}

// ---------------------------------------------------------------------------
// Grade / strength class
// ---------------------------------------------------------------------------

// McMaster spells a fastener's strength grade under several different
// attribute names depending on which standard it's rated to (SAE for a
// domestic hex/socket screw, a metric property class for an imported one,
// or occasionally a bare "Class"). None of these is the thread *fit* class
// ("Unified Standard Class 2A"/"3B") -- that always lives under a
// differently named attribute ("Thread Fit"/"Fit"), so it is never read
// here at all. The one exception is a bare "Class" attribute name, which
// McMaster does use for a genuine metric property class on some records;
// it is only trusted when its *value* is shaped like one (a decimal
// number such as "10.9", never a bare integer-plus-letter like "2A").
const GRADE_ATTR_NAMES = [
  "Fastener Strength Grade/Class",
  "Strength Grade",
  "Grade/Class",
  "Property Class",
  "Grade",
];

// A metric property class is a one- or two-digit number, a decimal point,
// then one digit ("8.8", "9.8", "10.9", "12.9") -- distinct in shape from a
// thread-fit class ("2A", "3B", a bare "2"), which is what lets a bare
// "Class" attribute be read safely for a grade.
const METRIC_CLASS_RE = /^(?:class\s*)?(\d{1,2}\.\d)$/i;

function normalizeGradeValue(raw) {
  if (!raw) return null;
  const v = String(raw).trim();
  if (!v) return null;
  const sae = v.match(/^SAE\s+Grade\s+([\w.]+)$/i);
  if (sae) return `Grade ${sae[1]}`;
  const metric = v.match(METRIC_CLASS_RE);
  if (metric) return `Class ${metric[1]}`;
  if (/^grade\s+[\w.]+$/i.test(v)) return v.replace(/^grade/i, "Grade");
  if (/^class\s+\d+(?:\.\d+)?$/i.test(v)) return v.replace(/^class/i, "Class");
  return v;
}

// Reads the grade off the record's own labeled attributes, trying each
// name McMaster uses in turn, before ever falling back to a grade folded
// into Material (splitMaterial's job). A bare "Class" is included only
// when its value is metric-class-shaped -- see METRIC_CLASS_RE above --
// so it never picks up a thread-fit class that happens to also be named
// "Class" on some other record.
function readGrade(product) {
  for (const name of GRADE_ATTR_NAMES) {
    const raw = product.byName(name);
    if (raw) return normalizeGradeValue(raw);
  }
  const classRaw = product.byName("Class");
  if (classRaw && METRIC_CLASS_RE.test(String(classRaw).trim())) {
    return normalizeGradeValue(classRaw);
  }
  return null;
}

// "M6 x 1 mm" is McMaster's phrasing for a metric thread; left as-is it
// reads as two lengths once joined with the screw's own length ("M6 x 1 mm
// x 20 mm"). Catalogs index it as "M6-1".
function normalizeThread(value) {
  if (!value) return value;
  const v = String(value).trim();
  const m = v.match(/^m(\d{1,2}(?:\.\d+)?)\s*[x×]\s*(\d+(?:\.\d+)?)\s*(?:mm)?$/i);
  return m ? `M${m[1]}-${m[2]}` : v;
}

// McMaster writes gauge sizes as "Number 10" (a screw-size field) or a
// bare "8" (a sheet-metal screw's thread-size field); every supplier
// indexes "#10"/"#8".
function normalizeScrewSizeWord(value) {
  if (!value) return value;
  const m = String(value).trim().match(/^number\s*(\d+)$/i);
  return m ? `#${m[1]}` : String(value).trim();
}

function normalizeGauge(value) {
  if (!value) return value;
  const v = String(value).trim();
  return /^\d{1,2}$/.test(v) ? `#${v}` : v;
}

const normalizeSize = (v) => normalizeGauge(normalizeScrewSizeWord(normalizeThread(v)));

// "20 mm" joins onto a metric thread as "M6-1 x 20mm", the way a metric
// catalog entry actually reads (no space before the unit).
function normalizeLength(value) {
  if (!value) return value;
  const v = String(value).trim();
  const mm = v.match(/^(\d+(?:\.\d+)?)\s*mm$/i);
  return mm ? `${mm[1]}mm` : v;
}

const joinTerms = (parts) => parts.filter((p) => p != null && String(p).trim() !== "").join(" ").trim();

// baseNoun sometimes prefers the more specific breadcrumb leaf precisely
// because it already carries the material ("Steel Socket Head Screws" over
// the family "Socket Head Screws"), and a headless fastener's own family
// name is often just the material-and-shape phrase itself ("316 Stainless
// Steel Threaded Rod"). Appending Material (or Finish/Grade) again after a
// noun like that would duplicate it in the query text. Every per-kind
// builder runs its material/finish/grade terms through this right before
// joining them in, so a term already spelled out in the noun is dropped.
function dedupeAgainstNoun(noun, ...terms) {
  const nounLower = lc(noun);
  return terms.map((t) => {
    const clean = t == null ? "" : String(t).trim();
    return clean && nounLower.includes(lc(clean)) ? null : t;
  });
}

// A trade/catalog number (a ball bearing's "6203", a roller chain's ANSI
// "40") sometimes only appears in the page's title text, not a labeled
// spec row -- McMaster's title is the trade name and spells it out
// directly ("6203 Two-Shield Ball Bearing").
function findFirstMatch(text, re) {
  const m = String(text || "").match(re);
  return m ? m[1] : null;
}

/**
 * The first word in a material string that carries a digit and is not
 * itself part of the family name -- "52100" out of "52100 Alloy Steel"
 * (family "Steel"), "6061" out of "6061 Aluminum" (family "Aluminum").
 * That is how raw stock is graded in a real catalog listing; the filler
 * word in between ("Alloy") is not.
 */
function leadingGradeToken(materialRaw, family) {
  if (!materialRaw) return null;
  const familyWords = new Set(lc(family).split(/\s+/).filter(Boolean));
  const words = String(materialRaw).trim().split(/\s+/);
  for (const w of words) {
    const clean = w.replace(/[.,]+$/, "");
    if (/\d/.test(clean) && !familyWords.has(lc(clean))) return clean;
  }
  return null;
}

// McMaster's marketing copy sometimes names a common trade synonym
// ("It's also known as chrome steel."). When present, it is worth offering
// as an alternate search phrase -- suppliers index by trade name as often
// as by alloy designation.
function findAka(copies) {
  const text = (copies || []).join(" ");
  const m = text.match(/also known as ([a-z0-9 \-]+?)[.,]/i);
  return m ? m[1].trim() : null;
}

function fastenerQuery(product, noun) {
  const threadRaw = product.byName("Thread Size") || product.byName("Size", "Thread");
  const threadSize = threadRaw ? normalizeSize(threadRaw) : null;
  const lengthRaw = product.byName("Length");
  const length = lengthRaw ? normalizeLength(lengthRaw) : null;
  const materialRaw = product.byName("Material");
  const { material, finish: derivedFinish, grade: materialGrade } = splitMaterial(materialRaw);
  const finish = canonicalizeFinishText(product.byName("Finish")) || derivedFinish;
  const grade = readGrade(product) || materialGrade;

  // "x" only belongs between two dimensions -- with no thread size to
  // join it to, a bare length is not "x 1"", it's just "1"".
  const size = joinTerms([threadSize, length && (threadSize ? `x ${length}` : length)]);
  const [dedupedMaterial, dedupedFinish, dedupedGrade] = dedupeAgainstNoun(noun, material, finish, grade);
  const primary = joinTerms([size, noun, dedupedMaterial, dedupedFinish, dedupedGrade]);
  const alternates = [joinTerms([size, noun, dedupeAgainstNoun(noun, material)[0]])];
  return {
    primary,
    alternates,
    terms: { noun, threadSize, length, material, finish, grade },
  };
}

function nutQuery(product, noun) {
  const threadRaw = product.byName("Thread Size") || product.byName("Size", "Thread");
  const threadSize = threadRaw ? normalizeSize(threadRaw) : null;
  const materialRaw = product.byName("Material");
  const { material, finish: derivedFinish, grade: materialGrade } = splitMaterial(materialRaw);
  const finish = canonicalizeFinishText(product.byName("Finish")) || derivedFinish;
  const grade = readGrade(product) || materialGrade;

  const [dedupedMaterial, dedupedFinish, dedupedGrade] = dedupeAgainstNoun(noun, material, finish, grade);
  const primary = joinTerms([threadSize, noun, dedupedMaterial, dedupedFinish, dedupedGrade]);
  const alternates = [joinTerms([threadSize, noun, dedupeAgainstNoun(noun, material)[0]])];
  return { primary, alternates, terms: { noun, threadSize, material, finish, grade } };
}

function washerQuery(product, noun) {
  const screwRaw = product.byName("For Screw Size") || product.byName("Screw Size") || product.byName("For Thread Size");
  const screwSize = screwRaw ? normalizeSize(screwRaw) : null;
  const materialRaw = product.byName("Material");
  const { material, finish: derivedFinish } = splitMaterial(materialRaw);
  const finish = canonicalizeFinishText(product.byName("Finish")) || derivedFinish;

  const [dedupedMaterial, dedupedFinish] = dedupeAgainstNoun(noun, material, finish);
  const primary = joinTerms([screwSize, noun, dedupedMaterial, dedupedFinish]);
  const alternates = [joinTerms([screwSize, noun, dedupeAgainstNoun(noun, material)[0]])];
  return { primary, alternates, terms: { noun, screwSize, material, finish } };
}

function rawstockQuery(product, noun) {
  const materialRaw = product.byName("Material");
  const grade = leadingGradeToken(materialRaw, product.family);
  const diameter = product.byName("Diameter");
  const thickness = product.byName("Thickness");
  const width = product.byName("Width");
  const od = product.byName("OD") || product.byName("Outside Diameter");
  const insideDiameter = product.byName("ID") || product.byName("Inside Diameter");
  const wallThickness = product.byName("Wall Thickness");
  // Deliberately no Length: McMaster's is the length of the stick it
  // ships ("6 ft."), while a metal supplier cuts to order, so carrying it
  // over narrows the search with a number that means something else on
  // the other site (see lib/specs.js buildQuery's rawstock branch).
  //
  // Round/square bar and sheet stock carry Diameter/Thickness/Width; tube
  // and pipe stock instead carry OD (plus ID and/or Wall Thickness) -- a
  // size prefix on the noun either way, joined with "x" the same way a
  // fastener's thread size and length are ("1" OD x 0.065" wall ...").
  const tubeDims = [od && `${od} OD`, insideDiameter && `${insideDiameter} ID`, wallThickness && `${wallThickness} wall`]
    .filter(Boolean);
  const dims = tubeDims.length ? [tubeDims.join(" x ")] : [diameter, thickness, width].filter(Boolean);

  const [dedupedGrade] = dedupeAgainstNoun(noun, grade);
  const primary = joinTerms([...dims, dedupedGrade, noun]);
  const alternates = [joinTerms([...dims, noun])];
  const aka = findAka(product.copies);
  if (aka) alternates.push(joinTerms([...dims, aka, noun.replace(/^\S+\s*/, "")]));
  return {
    primary,
    alternates,
    terms: { noun, grade, diameter, thickness, width, od, insideDiameter, wallThickness, material: materialRaw || null },
  };
}

function sealingQuery(product, noun) {
  const insideDiameter = product.byName("Inside Diameter") || product.byName("ID");
  const width = product.byName("Width");
  const materialRaw = product.byName("Material");
  const { material } = splitMaterial(materialRaw);
  const durometer = product.byName("Durometer") || product.byName("Hardness");

  const size = joinTerms([insideDiameter && `${insideDiameter} ID`, width && `${width} wide`]);
  const [dedupedMaterial] = dedupeAgainstNoun(noun, material);
  const primary = joinTerms([size, noun, dedupedMaterial, durometer]);
  const alternates = [joinTerms([size, noun])];
  return { primary, alternates, terms: { noun, insideDiameter, width, material, durometer } };
}

function bearingQuery(product, noun) {
  const bore = product.byName("Bore") || product.byName("For Shaft Diameter") || product.byName("Shaft Diameter");
  const od = product.byName("OD") || product.byName("Outside Diameter");
  const width = product.byName("Width");
  const materialRaw = product.byName("Material");
  const { material } = splitMaterial(materialRaw);
  const [dedupedMaterial] = dedupeAgainstNoun(noun, material);

  const size = joinTerms([bore && `${bore} bore`, od && `${od} OD`, width && `${width} wide`]);
  const sizeForm = joinTerms([size, noun, dedupedMaterial]);

  // A ball bearing's own trade/catalog number ("Trade Number"/"Bearing
  // Number", or a bare 4-5 digit token in the title -- "6203 Two-Shield
  // Ball Bearing") is how a distributor actually indexes it; bore/OD/
  // width is offered as the fallback (and stays the primary for anything
  // that isn't a ball bearing, or has no trade number of its own -- a
  // shaft collar's bore, routed here the same way, has no trade number).
  const tradeNumber =
    product.byName("Trade Number") ||
    product.byName("Bearing Number") ||
    findFirstMatch(product.title, /\b(\d{4,5})\b/);
  if (tradeNumber && /ball bearing/.test(lc(noun))) {
    const primary = joinTerms([tradeNumber, "ball bearing"]);
    const alternates = [sizeForm];
    return { primary, alternates, terms: { noun, bore, od, width, material, tradeNumber } };
  }

  const alternates = [joinTerms([size, noun])];
  return { primary: sizeForm, alternates, terms: { noun, bore, od, width, material } };
}

function fittingQuery(product, noun) {
  const threadRaw =
    product.byName("Thread Size") || product.byName("Size", "Thread") || product.byName("Pipe Size");
  const threadSize = threadRaw ? normalizeSize(threadRaw) : null;
  const materialRaw = product.byName("Material");
  const { material, finish: derivedFinish } = splitMaterial(materialRaw);
  const finish = canonicalizeFinishText(product.byName("Finish")) || derivedFinish;

  const [dedupedMaterial, dedupedFinish] = dedupeAgainstNoun(noun, material, finish);
  const primary = joinTerms([threadSize, noun, dedupedMaterial, dedupedFinish]);
  const alternates = [joinTerms([threadSize, noun])];
  return { primary, alternates, terms: { noun, threadSize, material, finish } };
}

// Springs, dowel pins, roller chain, and anything else that doesn't fit
// one of the named buckets above. Inside diameter, wire diameter and free
// length are each some part's defining spec, so all are offered and
// simply left out (via joinTerms) when the attribute isn't there.
function otherQuery(product, noun) {
  const materialRaw = product.byName("Material");
  const { material, finish: derivedFinish } = splitMaterial(materialRaw);
  const finish = canonicalizeFinishText(product.byName("Finish")) || derivedFinish;

  // Roller chain's own ANSI chain number ("ANSI Number"/"Chain Number"/
  // "Chain Size", or a "#40"-style token in the title when McMaster
  // doesn't break it out as its own field) is the identifier a supplier
  // catalog is actually built around, so it leads the query rather than
  // trailing the noun the way every other "other"-kind part's size does.
  const chainNumberRaw =
    product.byName("ANSI Number") || product.byName("Chain Number") || product.byName("Chain Size");
  const chainNumberFromTitle = chainNumberRaw ? null : findFirstMatch(product.title, /#\s*(\d{1,4})\b/);
  const chainNumber = chainNumberRaw
    ? (/^\d+$/.test(String(chainNumberRaw).trim()) ? `#${String(chainNumberRaw).trim()}` : String(chainNumberRaw).trim())
    : chainNumberFromTitle && `#${chainNumberFromTitle}`;
  if (chainNumber && /chain/.test(lc(noun))) {
    const [dedupedMaterial, dedupedFinish] = dedupeAgainstNoun(noun, material, finish);
    const primary = joinTerms([chainNumber, noun, dedupedMaterial, dedupedFinish]);
    const alternates = [joinTerms([noun, dedupeAgainstNoun(noun, material)[0]])];
    return { primary, alternates, terms: { noun, material, finish, chainNumber } };
  }

  const wireDiameter = product.byName("Wire Diameter");
  const od = product.byName("OD") || product.byName("Outside Diameter");
  const insideDiameter = product.byName("Inside Diameter") || product.byName("ID");
  const diameter = product.byName("Diameter");
  const length = product.byName("Length");
  const freeLength = product.byName("Free Length") || product.byName("Overall Length");

  // A plain diameter + length part -- a dowel/cotter/clevis/taper pin, or
  // anything else here with no wire/OD/ID spec of its own -- reads as a
  // catalog size prefix, "1/4" x 1"", the same "size, noun, material"
  // order every other per-kind builder uses (not the material-first,
  // dims-after phrasing a spring's wire/OD/free-length reads as below).
  if (!wireDiameter && !od && !insideDiameter && (diameter || length)) {
    const size = joinTerms([diameter, length && (diameter ? `x ${length}` : length)]);
    const [dedupedMaterial, dedupedFinish] = dedupeAgainstNoun(noun, material, finish);
    const primary = joinTerms([size, noun, dedupedMaterial, dedupedFinish]);
    const alternates = [joinTerms([size, noun])];
    return { primary, alternates, terms: { noun, material, finish, diameter, length } };
  }

  const dims = [
    wireDiameter && `${wireDiameter} wire`,
    od && `${od} OD`,
    insideDiameter && `${insideDiameter} ID`,
    freeLength || length,
  ].filter(Boolean);

  const [dedupedMaterial, dedupedFinish] = dedupeAgainstNoun(noun, material, finish);
  const primary = joinTerms([dedupedMaterial, noun, ...dims, dedupedFinish]);
  const alternates = [joinTerms([noun, ...dims])];
  return { primary, alternates, terms: { noun, material, finish, wireDiameter, od, insideDiameter, diameter, freeLength } };
}

const QUERY_BUILDERS = {
  fastener: fastenerQuery,
  nut: nutQuery,
  washer: washerQuery,
  rawstock: rawstockQuery,
  sealing: sealingQuery,
  bearing: bearingQuery,
  fitting: fittingQuery,
  other: otherQuery,
};

/**
 * @param {Product} product
 * @returns {{primary: string, alternates: string[], terms: object}}
 */
function buildQueries(product) {
  const { noun, kind } = classifyProduct(product);
  const builder = QUERY_BUILDERS[kind] || otherQuery;
  const { primary, alternates, terms } = builder(product, noun);
  terms.kind = kind;
  const uniqueAlternates = [...new Set(alternates.filter((a) => a && a !== primary))];
  return { primary, alternates: uniqueAlternates, terms };
}

// ---------------------------------------------------------------------------
// buildSupplierLinks
// ---------------------------------------------------------------------------

function applyTemplate(urlTemplate, query) {
  const encoded = encodeURIComponent(query);
  const plus = encoded.replace(/%20/g, "+");
  // A slug is a single path segment (Banggood's /search/<slug>.html), so a
  // literal "/" from a fraction ("1/4") has to go too, or it reads as
  // extra path segments and breaks the URL entirely.
  const slug = String(query)
    .trim()
    .toLowerCase()
    .replace(/["]/g, "")
    .replace(/\//g, "-")
    .replace(/\s+/g, "-")
    .replace(/-{2,}/g, "-");
  return urlTemplate.replace("{plus}", plus).replace("{q}", encoded).replace("{slug}", slug);
}

// Drops the dimension tokens from a query: anything carrying a digit and
// ending in an inch mark ('3/8"', '0.063"'). A cut-to-order stock house
// indexes by material, grade and form, not by a size it sells as an
// option, so those are all that's left. Ported from lib/specs.js.
function stripDimensions(query) {
  return String(query || "")
    .replace(/\S*[0-9][^\s]*"/g, "")
    .replace(/(^|\s)x(?=\s|$)/g, "$1")
    .replace(/\s+/g, " ")
    .trim();
}

// Same URL formats as lib/specs.js FASTENER_SUPPLIERS (measured 20 Sep
// 2026 by opening each search in a real browser -- see that file for why a
// datacenter fetch can't confirm them). Banggood is new here: its search
// page takes the query as a hyphenated path segment
// (https://www.banggood.com/search/hex-nut.html), which is the documented/
// observed shape of its storefront search, not something checked from this
// sandbox -- same caveat as every other supplier in this list already
// carries.
const FASTENER_SUPPLIERS = [
  { name: "Fastenal", urlTemplate: "https://www.fastenal.com/product?query={plus}" },
  { name: "Grainger", urlTemplate: "https://www.grainger.com/search?searchQuery={q}" },
  { name: "MSC Direct", urlTemplate: "https://www.mscdirect.com/browse/tn?searchterm={plus}" },
  { name: "Amazon", urlTemplate: "https://www.amazon.com/s?k={plus}" },
  { name: "AliExpress", urlTemplate: "https://www.aliexpress.com/wholesale?SearchText={plus}" },
  { name: "Banggood", urlTemplate: "https://www.banggood.com/search/{slug}.html" },
];

// lib/specs.js RAW_STOCK_SUPPLIERS, plus Online Metals. lib/specs.js
// dropped Online Metals after measuring its /en/search?text= path as a
// Tomcat 404 and later a Cloudflare challenge on everything -- there is no
// way to confirm a replacement path from here either. Its robots.txt
// disallows "/*?q=", which implies the storefront itself queries on `q`
// (evidence, not a measurement, per that file's own standard) -- included
// on request, flagged as unverified rather than left with a guessed path
// known to be wrong.
const RAW_STOCK_SUPPLIERS = [
  { name: "Speedy Metals", urlTemplate: "https://www.speedymetals.com/search.aspx?SearchTerm={plus}", dimensionless: true },
  { name: "Metal Supermarkets", urlTemplate: "https://www.metalsupermarkets.com/?s={plus}", dimensionless: true },
  { name: "MSC Direct", urlTemplate: "https://www.mscdirect.com/browse/tn?searchterm={plus}" },
  { name: "Grainger", urlTemplate: "https://www.grainger.com/search?searchQuery={q}" },
  { name: "Online Metals", urlTemplate: "https://www.onlinemetals.com/en/search?q={q}", dimensionless: true },
];

// Everything that is neither threaded hardware nor a length of metal --
// o-rings, gaskets, bearings, springs, fittings. Zoro is new here (its
// search path, https://www.zoro.com/search?q=, is well documented and
// consistent with how the rest of its site is structured) alongside the
// MRO_SUPPLIERS lib/specs.js already used.
const MRO_SUPPLIERS = [
  { name: "Grainger", urlTemplate: "https://www.grainger.com/search?searchQuery={q}" },
  { name: "MSC Direct", urlTemplate: "https://www.mscdirect.com/browse/tn?searchterm={plus}" },
  { name: "Zoro", urlTemplate: "https://www.zoro.com/search?q={q}" },
  { name: "Amazon", urlTemplate: "https://www.amazon.com/s?k={plus}" },
];

// Bolt Depot has no free-text search, only a filtered category browse
// (pattern taken from real indexed URLs, e.g.
// /Browse?Category=Hex_bolts&F_Diameter=3%2F8%22&F_Length=1%22&Units=US).
// Ported from lib/specs.js boltDepotUrl, driven by the Product/kind/terms
// this module already has instead of the old flat specs object.
function boltDepotUrl(kind, terms) {
  const noun = lc(terms.noun);
  const category =
    kind === "washer" ? "Washers"
    : kind === "nut" ? "Nuts"
    : /socket|button|flat/.test(noun) ? "Socket_screws"
    : /hex (?:head|cap)/.test(noun) ? "Hex_bolts"
    : null;
  if (!category) return "https://boltdepot.com/Catalog-Tabs";

  const params = new URLSearchParams({ Category: category, Units: "US" });
  // Only fractional-inch diameters get filtered; Bolt Depot writes gauge
  // sizes as "#4", and a bare F_Diameter=4 (splitting "4-40") silently
  // matches nothing.
  const dia = String(terms.threadSize || terms.screwSize || "").split("-")[0].trim();
  if (dia && /["/]/.test(dia)) {
    params.set("F_Diameter", dia);
    if (terms.length && kind !== "nut" && kind !== "washer") params.set("F_Length", terms.length);
  }
  return `https://boltdepot.com/Browse?${params.toString()}`;
}

/**
 * @param {Product} product
 * @returns {{supplier: string, url: string, query: string}[]}
 */
function buildSupplierLinks(product) {
  const { kind } = classifyProduct(product);
  const { primary: query, terms } = buildQueries(product);
  if (!query) return [];

  let suppliers;
  if (kind === "fastener" || kind === "nut" || kind === "washer") {
    // Fastenal, Grainger, MSC, Bolt Depot, Amazon, AliExpress, Banggood --
    // Bolt Depot's category-browse link is spliced in after the three
    // free-text suppliers, same placement as lib/specs.js.
    suppliers = FASTENER_SUPPLIERS.slice(0, 3)
      .concat([{ name: "Bolt Depot", urlTemplate: boltDepotUrl(kind, terms) }])
      .concat(FASTENER_SUPPLIERS.slice(3));
  } else if (kind === "rawstock") {
    suppliers = RAW_STOCK_SUPPLIERS;
  } else {
    suppliers = MRO_SUPPLIERS;
  }

  return suppliers.map((s) => {
    const supplierQuery = s.dimensionless ? stripDimensions(query) || query : query;
    return { supplier: s.name, url: applyTemplate(s.urlTemplate, supplierQuery), query: supplierQuery };
  });
}

const McmXref = {
  extractJsonObject,
  stripHtml,
  decodeEntities,
  cleanValue,
  singularize,
  parseProductRecord,
  classifyProduct,
  buildQueries,
  buildSupplierLinks,
  applyTemplate,
  stripDimensions,
  normalizeThread,
  normalizeGauge,
  normalizeScrewSizeWord,
};

// Node: `require("./product")` keeps working exactly as before.
if (typeof module !== "undefined" && module.exports) {
  module.exports = McmXref;
}
// Browser: loaded via a plain <script> tag (see frontend/vendor/product.js,
// synced from this file -- one source of truth, no bundler), this is the
// only environment where `window` exists, so the same API lands there as
// `window.McmXref` for frontend/app.js and the bookmarklet's consumer to use.
if (typeof window !== "undefined") {
  window.McmXref = McmXref;
}
