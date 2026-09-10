/**
 * McMaster-Carr Cross-Reference backend. The frontend (frontend/) is a
 * static site on GitHub Pages -- Pages can't run server code, so this
 * runs separately (Render) and the frontend calls it cross-origin, hence
 * the CORS headers below.
 *
 * POST /api/xref
 *   Body: { partNumber?: string, specs?: PartialSpecs }
 *   - If partNumber is given, renders the live McMaster product page with
 *     a real headless Chrome instance (Playwright) and parses the fully-
 *     rendered text. McMaster is a JS-only SPA, so a plain HTTP fetch
 *     never sees real spec data -- confirmed directly: fetching a product
 *     URL returns 200 and ~151KB that contains the Angular shell and not
 *     one spec value. Results are cached per part number, because
 *     McMaster allows only a limited number of anonymous views before it
 *     serves a login wall instead (no credentials are stored or used
 *     here) -- see README.
 *   - specs, if given, are merged on top of (and override) anything
 *     parsed live, so manual entry always works as a fallback.
 *   Returns: { source, specs, query, links, mcmasterFetchError,
 *     mcmasterErrorCode }
 */

const express = require("express");
const cors = require("cors");
const { chromium } = require("playwright");

const app = express();
app.use(cors());
app.use(express.json());

app.get("/", (_req, res) => res.json({ status: "ok" }));

app.post("/api/xref", async (req, res) => {
  const partNumber = (req.body.partNumber || "").trim();
  const manualSpecs = sanitizeSpecs(req.body.specs || {});

  let mcmasterSpecs = {};
  let mcmasterError = null;
  let mcmasterErrorCode = null;

  if (partNumber) {
    try {
      mcmasterSpecs = await fetchMcMasterSpecsLive(partNumber);
    } catch (err) {
      mcmasterError = err.message;
      mcmasterErrorCode = err.code || "FETCH_FAILED";
    }
  }

  const specs = { ...mcmasterSpecs, ...manualSpecs };
  const hasAnySpec = Object.keys(specs).length > 0;

  let source = "manual";
  if (Object.keys(mcmasterSpecs).length && Object.keys(manualSpecs).length) {
    source = "mcmaster+manual";
  } else if (Object.keys(mcmasterSpecs).length) {
    source = "mcmaster";
  }

  const links = hasAnySpec ? buildSupplierLinks(specs) : [];

  res.json({
    partNumber: partNumber || null,
    source,
    specs,
    query: hasAnySpec ? buildQuery(specs) : null,
    mcmasterFetchError: mcmasterError,
    mcmasterErrorCode,
    links,
  });
});

async function newStealthContext(browser) {
  const context = await browser.newContext({
    userAgent:
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36",
    viewport: { width: 1280, height: 900 },
    locale: "en-US",
  });
  await context.addInitScript(() => {
    Object.defineProperty(navigator, "webdriver", { get: () => undefined });
    window.chrome = { runtime: {} };
    Object.defineProperty(navigator, "plugins", { get: () => [1, 2, 3, 4, 5] });
    Object.defineProperty(navigator, "languages", { get: () => ["en-US", "en"] });
  });
  return context;
}

// What McMaster serves instead of a product page once this server has spent
// its anonymous-view allowance. Diagnosed from the rendered text itself:
// every URL -- product pages and category pages alike -- came back as the
// same 776-char page reading "To continue browsing, please log in." Two
// earlier rounds of timeout tuning were chasing this as if it were a slow
// render, because only the text *length* was ever logged.
const LOGIN_WALL_RE = /to continue browsing,?\s*please log in|please log in to continue/i;

class LoginWallError extends Error {
  constructor() {
    super(
      "McMaster is requiring a login for this server right now (it allows a limited number of anonymous page views). Specs can't be read automatically until that lifts -- enter them below and the supplier links still work."
    );
    this.code = "LOGIN_WALL";
  }
}

/**
 * Resolved specs, keyed by part number. McMaster's anonymous-view budget is
 * the scarcest resource this app has -- exhausting it is what takes the
 * whole feature down -- so a part is rendered once and then answered from
 * memory. Cleared when the instance restarts, which on a free tier happens
 * often; that's a cold-start cost, not a correctness problem.
 */
const specCache = new Map();

/**
 * Renders the live McMaster product page in a real headless browser and
 * parses the fully-rendered text. Throws LoginWallError when McMaster is
 * gating this server, and a plain Error on any other failure; the caller
 * treats both as "unavailable, fall back to manual entry" but reports them
 * differently, since one is temporary and not the user's fault.
 */
async function fetchMcMasterSpecsLive(partNumber) {
  const cached = specCache.get(partNumber);
  if (cached) {
    console.log(`[xref] part=${partNumber} served from cache`);
    return cached;
  }

  const pageUrl = `https://www.mcmaster.com/${encodeURIComponent(partNumber)}/`;

  // These flags/patches mask the usual automation fingerprints. Worth
  // keeping, but note they were never the blocker: the page renders fine
  // for this exact browser setup until the view allowance runs out, and no
  // amount of fingerprint masking buys more views.
  const browser = await chromium.launch({
    args: ["--disable-blink-features=AutomationControlled"],
  });
  try {
    const context = await newStealthContext(browser);
    const page = await context.newPage();
    const response = await page.goto(pageUrl, { waitUntil: "load", timeout: 25000 });

    // McMaster's Angular app fetches product data on a separate call after
    // load, so waiting for network-quiet returns nav/footer chrome only.
    // Wait for real content to appear instead.
    try {
      await page.waitForFunction(() => document.body.innerText.length > 1500, { timeout: 15000 });
    } catch {
      // proceed with whatever rendered -- classified below
    }

    const text = await page.evaluate(() => document.body.innerText);
    console.log(
      `[xref] part=${partNumber} finalUrl=${page.url()} status=${response && response.status()} textLen=${text ? text.length : 0}`
    );

    if (LOGIN_WALL_RE.test(text || "")) {
      console.log(`[xref] part=${partNumber} LOGIN_WALL`);
      throw new LoginWallError();
    }

    if (!text || text.trim().length < 50) {
      throw new Error("page rendered but had no usable text");
    }

    const specs = { ...parseSpecsFromText(text), ...parseKeyValueText(text) };
    console.log(`[xref] extractedSpecs: ${JSON.stringify(specs)}`);

    if (Object.keys(specs).length === 0) {
      // A real page that parses to nothing is a different failure from a
      // gated one, and the raw text is the only way to tell them apart --
      // so log it here, where it's rare, rather than on every request.
      console.log(`[xref] part=${partNumber} parsed nothing. text=${JSON.stringify((text || "").slice(0, 1500))}`);
      throw new Error("page loaded but no recognizable specs were on it (part may not exist)");
    }

    specCache.set(partNumber, specs);
    return specs;
  } finally {
    await browser.close();
  }
}

const MATERIALS = [
  "18-8 stainless steel", "316 stainless steel", "stainless steel",
  "carbon fiber", "aluminum", "brass", "bronze", "copper", "titanium",
  "alloy steel", "carbon steel", "steel", "nylon", "polycarbonate",
  "acetal", "delrin", "pvc", "rubber",
];
const DRIVE_TYPES = ["hex", "phillips", "slotted", "torx", "socket", "square", "combination"];
const FINISHES = ["zinc plated", "black oxide", "galvanized", "chrome plated", "plain", "anodized", "powder coated"];

function parseSpecsFromText(text) {
  const lower = text.toLowerCase();
  const specs = {};

  const material = MATERIALS.find((m) => lower.includes(m));
  if (material) specs.material = material;

  const drive = DRIVE_TYPES.find((d) => lower.includes(d));
  if (drive) specs.driveType = drive;

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

  if (out.threadSize && out.diameter) delete out.diameter;

  const grade = strengthGrade(out.grade);
  if (grade) out.grade = grade;
  else delete out.grade;

  return out;
}

// Trade names, in the order a supplier's catalog uses them. Checked most
// specific first: a "Hex" *head* is an external hex bolt, but a hex *drive*
// on a flat or button head is a socket cap screw, which is a different
// aisle.
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
  return specs.threadSize ? "machine screw" : null;
}

function isFastener(specs) {
  return Boolean(specs.threadSize || specs.headType || (specs.category || "").toLowerCase().includes("fastener"));
}

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

  if (isFastener(specs)) {
    const size = [specs.threadSize, specs.length].filter(Boolean).join(" x ");
    return [size, fastenerNoun(specs), specs.material, specs.finish, specs.grade]
      .filter(Boolean)
      .join(" ")
      .trim();
  }

  return [specs.material, specs.shape, specs.diameter, specs.thickness, specs.width, specs.length, specs.finish]
    .filter(Boolean)
    .join(" ")
    .trim();
}

/**
 * Search links on other suppliers, using each site's own search URL rather
 * than a site-scoped Google search. Every pattern here was taken from a
 * real indexed results URL on that supplier, and each one is re-checked
 * against a live response by the verification sweep -- the previous round
 * of "verification" passed anything whose body didn't match a short
 * no-results regex, which a Google consent page clears trivially, so four
 * of six links were unexamined Google searches.
 */
function buildSupplierLinks(rawSpecs) {
  const specs = normalizeSpecs(rawSpecs);
  const query = buildQuery(rawSpecs);
  if (!query) return [];

  const q = encodeURIComponent(query);
  const plus = encodeURIComponent(query).replace(/%20/g, "+");

  const rawStockSuppliers = [
    { name: "Online Metals", url: `https://www.onlinemetals.com/en/search?text=${q}` },
    { name: "MSC Direct", url: `https://www.mscdirect.com/browse/tn?searchterm=${plus}` },
    { name: "Speedy Metals", url: `https://www.speedymetals.com/Search?searchTerm=${q}` },
    { name: "Grainger", url: `https://www.grainger.com/search?searchQuery=${q}` },
  ];

  const fastenerSuppliers = [
    { name: "Fastenal", url: `https://www.fastenal.com/product?query=${plus}` },
    { name: "Grainger", url: `https://www.grainger.com/search?searchQuery=${q}` },
    { name: "MSC Direct", url: `https://www.mscdirect.com/browse/tn?searchterm=${plus}` },
    { name: "Bolt Depot", url: boltDepotUrl(specs, q) },
    { name: "Amazon", url: `https://www.amazon.com/s?k=${plus}` },
    { name: "AliExpress", url: `https://www.aliexpress.com/wholesale?SearchText=${plus}` },
  ];

  const suppliers = isFastener(specs) ? fastenerSuppliers : rawStockSuppliers;
  return suppliers.map((s) => ({ ...s, query }));
}

// Bolt Depot has no free-text search, only a filtered category browse
// (pattern taken from real indexed URLs, e.g.
// /Browse?Category=Hex_bolts&F_Diameter=3%2F8%22&F_Length=1%22&Units=US).
// Filters only get applied when the size parses cleanly; otherwise this
// falls back to the category landing page rather than emitting a URL with
// half-filled filters that returns nothing.
function boltDepotUrl(specs, q) {
  const head = (specs.headType || "").toLowerCase();
  const category = /socket|button|flat/.test(head)
    ? "Socket_screws"
    : /hex/.test(head)
      ? "Hex_bolts"
      : null;
  if (!category) return `https://boltdepot.com/Catalog-Tabs`;

  const params = new URLSearchParams({ Category: category, Units: "US" });
  // Only fractional-inch diameters get filtered. Bolt Depot writes gauge
  // sizes as "#4", and a bare F_Diameter=4 (which is what splitting "4-40"
  // gives) silently matches nothing -- an unfiltered category page is a
  // better landing spot than a filter that returns an empty grid.
  const dia = (specs.threadSize || "").split("-")[0].trim();
  if (dia && /["\/]/.test(dia)) {
    params.set("F_Diameter", dia);
    if (specs.length) params.set("F_Length", specs.length);
  }
  return `https://boltdepot.com/Browse?${params.toString()}`;
}


// Exported so the pure parsing/query logic can be tested directly against
// real captured McMaster output, without a network round trip or a server.
module.exports = { parseKeyValueText, parseSpecsFromText, normalizeSpecs, buildQuery, buildSupplierLinks };

if (require.main !== module) return;

const port = process.env.PORT || 3000;
app.listen(port, () => {
  console.log(`mcmaster-xref listening on ${port}`);
  if (process.env.RUN_VERIFY === "1") runVerification();
});

/**
 * Env-gated (RUN_VERIFY=1) verification of the two things that can only be
 * checked against live responses.
 *
 * Deliberately small on the McMaster side. The previous version rendered
 * 100 part pages back to back, and that is what took the app down: McMaster
 * allows a limited number of anonymous views per client, the sweep spent
 * them all, and every lookup afterwards -- including real ones from the
 * actual UI -- got the login wall instead of a product page. A test that
 * destroys the thing it is testing is worse than no test, so this renders
 * three parts, spaced out, and reports the wall as a distinct outcome
 * rather than as a mysterious empty page.
 *
 * The supplier links get the opposite treatment: those sites have no such
 * budget, every generated URL is fetched for real, and a link only passes
 * if the response actually looks like a results page for the query. The
 * old check called anything that didn't match a short "no results" regex a
 * pass, which is how four unexamined Google searches and a Grainger page
 * reading "Whoops, we couldn't find that." were all counted as working.
 */
const VERIFY_PARTS = ["91251A051", "91251A540", "92196A106"];
const RENDER_SPACING_MS = 20000;

async function runVerification() {
  const started = Date.now();
  console.log("[verify] START");

  const resolved = [];
  for (const [i, part] of VERIFY_PARTS.entries()) {
    if (i > 0) await new Promise((r) => setTimeout(r, RENDER_SPACING_MS));
    try {
      const specs = await fetchMcMasterSpecsLive(part);
      resolved.push({ part, specs });
      console.log(`[verify] render ${part}: OK (${Object.keys(specs).length} fields) query=${JSON.stringify(buildQuery(specs))}`);
    } catch (err) {
      console.log(`[verify] render ${part}: ${err.code === "LOGIN_WALL" ? "LOGIN_WALL" : "FAILED"} -- ${err.message}`);
    }
  }

  // Link checking must not depend on McMaster being reachable, or a walled
  // run would silently verify nothing at all -- which is exactly what the
  // last sweep did (0 parts discovered, "0 ok, 0 bad", reported as a run).
  const cases = resolved.length
    ? resolved
    : [
        { part: "91251A540(known)", specs: { material: "Black-Oxide Alloy Steel", driveType: "Hex", threadSize: '1/4"-20', length: '3/4"', grade: "Class 3", headType: "Socket", diameter: '3/8"' } },
        { part: "92196A106(known)", specs: { material: "18-8 Stainless Steel", driveType: "Hex", threadSize: "4-40", length: '1/4"', headType: "Socket" } },
        { part: "raw-stock(known)", specs: { material: "6061 Aluminum", shape: "Round Bar", diameter: '3/8"' } },
      ];
  if (!resolved.length) console.log("[verify] no live renders available; checking links against known-good specs instead");

  let ok = 0;
  let bad = 0;
  for (const { part, specs } of cases) {
    const query = buildQuery(specs);
    console.log(`[verify] links for ${part}: query=${JSON.stringify(query)}`);
    for (const { name, url } of buildSupplierLinks(specs)) {
      const verdict = await checkSupplierLink(name, url, specs);
      if (verdict.ok) ok++;
      else bad++;
      console.log(`[verify]   ${verdict.ok ? "PASS" : "FAIL"} ${name}: ${verdict.detail}`);
    }
  }

  console.log(`[verify] DONE in ${Math.round((Date.now() - started) / 1000)}s -- links ${ok} pass / ${bad} fail across ${cases.length} parts`);
}

/**
 * A link passes only if the response is a results page that actually
 * mentions the part's defining terms. Checking for a 200 is not enough:
 * bot walls, consent interstitials and empty-result pages all return 200,
 * and that is precisely what the previous check scored as success.
 */
async function checkSupplierLink(name, url, specs) {
  try {
    const res = await fetch(url, {
      redirect: "follow",
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36",
        "Accept-Language": "en-US,en;q=0.9",
      },
      signal: AbortSignal.timeout(20000),
    });
    const body = await res.text();
    const title = ((body.match(/<title[^>]*>([^<]*)<\/title>/i) || [])[1] || "").trim().slice(0, 90);
    const detail = `status=${res.status} len=${body.length} title=${JSON.stringify(title)}`;

    if (res.status >= 400) return { ok: false, detail };
    if (/we couldn.?t find|no results (were )?found|0 results|did not match any/i.test(body)) {
      return { ok: false, detail: `${detail} <- no-results page` };
    }
    if (/unusual traffic|before you continue|consent\.google|are you a robot|just a moment|access denied/i.test(body)) {
      return { ok: false, detail: `${detail} <- bot/consent wall` };
    }

    // The defining term of the search should appear in the results. For a
    // fastener that's the thread size; for raw stock, the shape.
    const marker = specs.threadSize || specs.shape || specs.material;
    const normalize = (s) => s.toLowerCase().replace(/["”]/g, "").replace(/\s+/g, " ");
    if (marker && !normalize(body).includes(normalize(marker))) {
      return { ok: false, detail: `${detail} <- no mention of ${JSON.stringify(marker)}` };
    }
    return { ok: true, detail };
  } catch (err) {
    return { ok: false, detail: `fetch failed -- ${err.message}` };
  }
}
