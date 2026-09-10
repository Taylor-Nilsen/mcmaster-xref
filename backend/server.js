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
 *     never sees real spec data -- this actually executes the page's JS.
 *     Runs fresh on every request, no caching. Can't see anything
 *     McMaster gates behind account login (no credentials are stored or
 *     used here) -- see README.
 *   - specs, if given, are merged on top of (and override) anything
 *     parsed live, so manual entry always works as a fallback.
 *   Returns: { source, specs, links }
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

  if (partNumber) {
    try {
      mcmasterSpecs = await fetchMcMasterSpecsLive(partNumber);
    } catch (err) {
      mcmasterError = err.message;
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
    mcmasterFetchError: mcmasterError,
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

/**
 * Renders the live McMaster product page in a real headless browser and
 * parses the fully-rendered text. No caching -- a fresh browser launches
 * on every call. Throws on any failure (page never settles, no usable
 * text, etc.); caller treats that as "unavailable, fall back to manual
 * entry", not a hard error.
 */
async function fetchMcMasterSpecsLive(partNumber) {
  const pageUrl = `https://www.mcmaster.com/${encodeURIComponent(partNumber)}/`;

  // McMaster is known to detect and block plain headless Chromium (see
  // https://github.com/mjbraun/mcmaster-agent). These flags/patches mask the
  // most common automation fingerprints without needing a full stealth lib
  // (which sources say is no longer reliable in 2026 anyway) or a visible
  // display. If this still gets blocked, the proven fix is a genuinely
  // headed browser via a virtual display, which needs a Docker-based
  // deploy -- see backend/README.md.
  const browser = await chromium.launch({
    args: ["--disable-blink-features=AutomationControlled"],
  });
  try {
    const context = await newStealthContext(browser);
    const page = await context.newPage();
    const response = await page.goto(pageUrl, { waitUntil: "load", timeout: 25000 });

    // networkidle + a flat delay wasn't enough -- a first real test showed
    // the page settling into "idle" with only nav/footer chrome rendered
    // (714 chars, no product content), meaning McMaster's Angular app
    // fetches the actual product data on a separate call that hadn't
    // resolved yet. Actively wait for real content instead of a fixed
    // network-quiet signal.
    try {
      await page.waitForFunction(() => document.body.innerText.length > 1500, { timeout: 15000 });
    } catch {
      // proceed with whatever rendered -- logged below either way
    }

    const text = await page.evaluate(() => document.body.innerText);
    console.log(
      `[xref] part=${partNumber} finalUrl=${page.url()} status=${response && response.status()} textLen=${text ? text.length : 0}`
    );
    console.log(`[xref] fullText: ${JSON.stringify((text || "").slice(0, 3000))}`);

    if (!text || text.trim().length < 50) {
      throw new Error("page rendered but had no usable text (likely blocked)");
    }

    const specs = { ...parseSpecsFromText(text), ...parseKeyValueText(text) };
    console.log(`[xref] extractedSpecs: ${JSON.stringify(specs)}`);
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

/**
 * Builds direct search-results links on other suppliers' sites using the
 * extracted/entered specs as a query. This is deliberately NOT scraping
 * those sites (most block bots as aggressively as McMaster does) -- it
 * hands the user a pre-filled search so they can judge fit themselves,
 * per the spec's workflow step 5.
 *
 * Link patterns below were verified with a live diagnostic (checkSupplierUrls)
 * that hit each one directly and logged the real response -- most of the
 * originally-guessed internal search URLs turned out wrong (404s, or a
 * wrong query param landing on a "no results" page). Only Grainger (its
 * param confirmed against a real indexed example URL), AliExpress, and
 * Banggood get a direct site search link now; everything else routes
 * through a site-scoped Google search instead of guessing an undocumented
 * internal URL scheme that can silently break on the next site redesign.
 */
function buildSupplierLinks(specs) {
  const query = [specs.material, specs.shape, specs.threadSize, specs.diameter, specs.thickness, specs.width, specs.length, specs.driveType, specs.finish, specs.grade]
    .filter(Boolean)
    .join(" ");

  if (!query) return [];

  const q = encodeURIComponent(query);
  const googleSiteSearch = (domain) => `https://www.google.com/search?q=${encodeURIComponent(`site:${domain} ${query}`)}`;

  const rawStockSuppliers = [
    { name: "Speedy Metals", url: googleSiteSearch("speedymetals.com") },
    { name: "MSC Direct", url: googleSiteSearch("mscdirect.com") },
    { name: "Online Metals", url: googleSiteSearch("onlinemetals.com") },
  ];
  const fastenerSuppliers = [
    { name: "Fastenal", url: googleSiteSearch("fastenal.com") },
    { name: "Grainger", url: `https://www.grainger.com/search?searchQuery=${q}&searchBar=true` },
    { name: "Bolt Depot", url: googleSiteSearch("boltdepot.com") },
    { name: "Amazon", url: googleSiteSearch("amazon.com") },
    { name: "AliExpress", url: `https://www.aliexpress.com/wholesale?SearchText=${q}` },
    { name: "Banggood", url: `https://www.banggood.com/search/${q}-products.html` },
  ];

  const category = (specs.category || "").toLowerCase();
  let suppliers;
  if (category.includes("fastener") || specs.threadSize || specs.driveType) {
    suppliers = fastenerSuppliers;
  } else if (category.includes("stock") || specs.shape) {
    suppliers = rawStockSuppliers;
  } else {
    suppliers = [...rawStockSuppliers, ...fastenerSuppliers];
  }

  return suppliers.map((s) => ({ ...s, query }));
}

/**
 * TEMPORARY diagnostic: hits each supplier search URL pattern directly
 * (with a sample query) and logs status/final-URL/a body snippet, so the
 * actual URL patterns can be verified against real responses instead of
 * guessed -- same reason the McMaster render/parse issues could only be
 * fixed once real page content was visible via logs. No outbound network
 * access to these sites is available from wherever this gets
 * developed/debugged.
 */
async function checkSupplierUrls() {
  // Reuses the real buildSupplierLinks() so this diagnostic can never drift
  // out of sync with what the app actually generates.
  const rawStockLinks = buildSupplierLinks({ material: "18-8 stainless steel", shape: "round bar", diameter: '3/8"' });
  const fastenerLinks = buildSupplierLinks({ material: "18-8 stainless steel", threadSize: "1/4-20", driveType: "hex" });
  const urls = [...rawStockLinks, ...fastenerLinks];

  for (const { name, url } of urls) {
    try {
      const res = await fetch(url, {
        redirect: "follow",
        headers: {
          "User-Agent":
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36",
        },
        signal: AbortSignal.timeout(10000),
      });
      const body = await res.text();
      console.log(
        `[urlcheck] ${name}: status=${res.status} finalUrl=${res.url} bodyLen=${body.length} title=${JSON.stringify((body.match(/<title>([^<]*)<\/title>/i) || [])[1] || "")}`
      );
    } catch (err) {
      console.log(`[urlcheck] ${name}: FETCH FAILED -- ${err.message}`);
    }
  }
}

const port = process.env.PORT || 3000;
app.listen(port, () => {
  console.log(`mcmaster-xref listening on ${port}`);
  if (process.env.RUN_TEST_SWEEP === "1") {
    runTestSweep();
  } else {
    runStartupSelfTest();
    checkSupplierUrls();
  }
});

/**
 * TEMPORARY, env-gated (RUN_TEST_SWEEP=1): a real end-to-end verification
 * sweep, not a guess dressed up as a test. Three phases, each logged
 * incrementally so partial progress survives a free-tier idle sleep:
 *
 *  1. Discovery -- harvests real part numbers directly from McMaster's own
 *     category pages (not invented), starting from a known-good product
 *     page's own links so category URLs are real, not guessed.
 *  2. Render sweep -- runs fetchMcMasterSpecsLive-equivalent logic against
 *     up to 100 of those real parts, one shared browser instance (not one
 *     per part -- launch overhead would dominate), tallies success/empty/
 *     login-wall/error.
 *  3. Supplier link verification -- for a diverse 20 of the successful
 *     parts, fetches every generated supplier link for real and checks it
 *     returns substantive content. This proves the link resolves to a
 *     real, relevant results page -- it cannot prove "perfect drop-in
 *     replacement" for a hardware part, which needs engineering judgment
 *     (tolerances, thread fit class, load rating) no scraper can certify.
 */
async function runTestSweep() {
  const startedAt = Date.now();
  console.log("[sweep] START");

  const browser = await chromium.launch({ args: ["--disable-blink-features=AutomationControlled"] });
  const context = await newStealthContext(browser);
  const page = await context.newPage();

  async function renderText(url, timeout = 30000) {
    await page.goto(url, { waitUntil: "load", timeout });
    await page.waitForFunction(() => document.body.innerText.length > 1500, { timeout: 18000 }).catch(() => {});
    return page.evaluate(() => document.body.innerText);
  }

  // ---------- Phase 1: discovery ----------
  // Real McMaster part-page URLs end in a part number, e.g.
  // /91251A051/ or /products/6384K49/ -- both confirmed live.
  const partNumberRe = /\/(\d{2,6}[A-Z]\d{2,4})\/?(?:$|\?)/;
  // Real category/family URLs are /products/<slug>/ (confirmed live via
  // search, e.g. mcmaster.com/products/socket-head-screws/) -- a single
  // path segment after the domain is always static nav chrome (orders,
  // contact, login, ...), never a catalog page.
  const productPathRe = /mcmaster\.com\/products\/[a-z0-9-]+\/?(?:$|\?)/i;
  const parts = new Set();

  // Verified-real category pages (via live search, not guessed), spread
  // across distinct catalog areas so the resulting parts span different
  // categories: fasteners, bearings, tools, material handling, electrical,
  // pipe/tube fittings.
  const CATEGORY_SEEDS = [
    "https://www.mcmaster.com/products/machine-screws/",
    "https://www.mcmaster.com/products/socket-head-screws/",
    "https://www.mcmaster.com/products/specialty-fasteners/",
    "https://www.mcmaster.com/products/screw-sets/",
    "https://www.mcmaster.com/products/shaft-bearings/",
    "https://www.mcmaster.com/products/bearing-housings/",
    "https://www.mcmaster.com/products/self-lubricating-bearings/",
    "https://www.mcmaster.com/products/steel-bearings/",
    "https://www.mcmaster.com/products/hand-tools/",
    "https://www.mcmaster.com/products/power-tools/",
    "https://www.mcmaster.com/products/material-handling/",
    "https://www.mcmaster.com/products/cable-connectors/",
    "https://www.mcmaster.com/products/electrical-connectors/",
    "https://www.mcmaster.com/products/steel-pipe-fittings/",
    "https://www.mcmaster.com/products/steel-pipe-couplings/",
    "https://www.mcmaster.com/products/copper-pipe-fittings/",
  ];

  // Harvests direct part links from whatever page is currently loaded,
  // and separately any /products/<slug>/ links (candidate sub-families) --
  // category pages sometimes link straight to parts, sometimes one level
  // down to families, so both need to be checked.
  async function harvestCurrentPage() {
    const hrefs = await page.$$eval("a", (els) => els.map((e) => e.href));
    let found = 0;
    const subLinks = new Set();
    for (const href of hrefs) {
      const m = href.match(partNumberRe);
      if (m) {
        if (!parts.has(m[1])) found++;
        parts.add(m[1]);
      } else if (productPathRe.test(href)) {
        subLinks.add(href);
      }
    }
    return { found, subLinks: [...subLinks] };
  }

  try {
    let seedText = await renderText("https://www.mcmaster.com/91251A051/");
    if (seedText.length < 1500) {
      console.log(`[sweep] seed page short (${seedText.length} chars), retrying once...`);
      seedText = await renderText("https://www.mcmaster.com/91251A051/", 35000);
    }
    const { found } = await harvestCurrentPage();
    console.log(`[sweep] seed page rendered, ${seedText.length} chars, +${found} direct parts`);
  } catch (err) {
    console.log(`[sweep] discovery seed FAILED: ${err.message}`);
  }

  for (const catUrl of CATEGORY_SEEDS) {
    if (parts.size >= 130) break;
    try {
      const text = await renderText(catUrl, 30000);
      if (text.length < 1500) {
        console.log(`[sweep] category ${catUrl}: short render (${text.length} chars), skipping`);
        continue;
      }
      const { found, subLinks } = await harvestCurrentPage();
      console.log(`[sweep] category ${catUrl}: +${found} direct parts (total ${parts.size}), ${subLinks.length} sub-family links, textLen=${text.length}`);

      if (found === 0 && subLinks.length > 0) {
        for (const subUrl of subLinks.slice(0, 3)) {
          try {
            const subText = await renderText(subUrl, 30000);
            if (subText.length < 1500) continue;
            const sub = await harvestCurrentPage();
            console.log(`[sweep]   sub-family ${subUrl}: +${sub.found} parts (total ${parts.size})`);
          } catch (err) {
            console.log(`[sweep]   sub-family ${subUrl} FAILED: ${err.message}`);
          }
        }
      }
    } catch (err) {
      console.log(`[sweep] category ${catUrl} FAILED: ${err.message}`);
    }
  }

  const allParts = [...parts].slice(0, 100);
  console.log(`[sweep] DISCOVERY DONE: ${parts.size} unique real part numbers found, testing ${allParts.length}`);

  // ---------- Phase 2: render + parse sweep ----------
  let ok = 0, empty = 0, loginWall = 0, error = 0;
  const successfulSpecs = [];

  for (let i = 0; i < allParts.length; i++) {
    const pn = allParts[i];
    try {
      const text = await renderText(`https://www.mcmaster.com/${pn}/`);
      if (/please log in/i.test(text)) {
        loginWall++;
        console.log(`[sweep] ${i + 1}/${allParts.length} ${pn}: LOGIN_WALL`);
        continue;
      }
      const specs = { ...parseSpecsFromText(text), ...parseKeyValueText(text) };
      const count = Object.keys(specs).length;
      if (count > 0) {
        ok++;
        successfulSpecs.push({ pn, specs });
        console.log(`[sweep] ${i + 1}/${allParts.length} ${pn}: OK (${count} fields)`);
      } else {
        empty++;
        console.log(`[sweep] ${i + 1}/${allParts.length} ${pn}: EMPTY`);
      }
    } catch (err) {
      error++;
      console.log(`[sweep] ${i + 1}/${allParts.length} ${pn}: ERROR -- ${err.message}`);
    }
  }

  console.log(
    `[sweep] RENDER SWEEP DONE: ${allParts.length} tested -- OK=${ok} EMPTY=${empty} LOGIN_WALL=${loginWall} ERROR=${error}`
  );

  await browser.close();

  // ---------- Phase 3: supplier link verification ----------
  // Spread picks across the successful set rather than the first 20, for
  // category diversity (discovery order roughly tracks category order).
  const sampleCount = Math.min(20, successfulSpecs.length);
  const step = Math.max(1, Math.floor(successfulSpecs.length / sampleCount));
  const sample = [];
  for (let i = 0; i < successfulSpecs.length && sample.length < sampleCount; i += step) {
    sample.push(successfulSpecs[i]);
  }

  console.log(`[sweep] LINK VERIFICATION START: ${sample.length} parts`);

  let linkOk = 0, linkBad = 0;
  for (const { pn, specs } of sample) {
    const links = buildSupplierLinks(specs);
    for (const { name, url } of links) {
      try {
        const res = await fetch(url, {
          redirect: "follow",
          headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36" },
          signal: AbortSignal.timeout(10000),
        });
        const body = await res.text();
        const bad = res.status >= 400 || /couldn.?t find|no results|access denied|just a moment/i.test(body.slice(0, 2000));
        if (bad) {
          linkBad++;
          console.log(`[sweep] link ${pn}/${name}: BAD status=${res.status} len=${body.length}`);
        } else {
          linkOk++;
          console.log(`[sweep] link ${pn}/${name}: OK status=${res.status} len=${body.length}`);
        }
      } catch (err) {
        linkBad++;
        console.log(`[sweep] link ${pn}/${name}: FAILED -- ${err.message}`);
      }
    }
  }

  console.log(`[sweep] LINK VERIFICATION DONE: ${linkOk} ok, ${linkBad} bad, out of ${linkOk + linkBad} checks across ${sample.length} parts`);
  console.log(`[sweep] COMPLETE in ${Math.round((Date.now() - startedAt) / 1000)}s`);
}

/**
 * Renders a handful of real parts on every startup (including free-tier
 * cold-start wakes) and logs each result. Lets this get verified by
 * reading Render's logs directly -- no outbound network access to the
 * deployed URL is available from wherever this gets developed/debugged,
 * so this is the only way to see whether live rendering actually works,
 * and across more than one part, without asking the user to test it by
 * hand each time. Run sequentially, not in parallel, so the free-tier
 * instance isn't launching several Chromium processes at once.
 */
const SELFTEST_PARTS = [
  "91251A051", // socket head screw -- known-good baseline
];

async function runStartupSelfTest() {
  for (const testPart of SELFTEST_PARTS) {
    console.log(`[selftest] rendering ${testPart}...`);
    try {
      const specs = await fetchMcMasterSpecsLive(testPart);
      const count = Object.keys(specs).length;
      console.log(`[selftest] ${testPart}: ${count ? "OK" : "EMPTY"} (${count} fields) -- ${JSON.stringify(specs)}`);
    } catch (err) {
      console.log(`[selftest] ${testPart}: FAILED -- ${err.message}`);
    }
  }
}
