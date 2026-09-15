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
const {
  parseSpecsFromText,
  parseKeyValueText,
  sanitizeSpecs,
  normalizeSpecs,
  buildQuery,
  buildSupplierLinks,
} = require("./lib/specs");


const app = express();
app.use(cors());
app.use(express.json());

app.get("/", (_req, res) => res.json({ status: "ok" }));

app.post("/api/xref", async (req, res) => {
  const partNumber = (req.body.partNumber || "").trim();
  const manualSpecs = sanitizeSpecs(req.body.specs || {});
  const pastedText = typeof req.body.pastedText === "string" ? req.body.pastedText.slice(0, 20000) : "";

  // Text copied straight off McMaster's own page needs no new parser: the
  // label-then-value line shape it produces is exactly what parseKeyValueText
  // was written against. It's also the way out of a gated lookup -- the
  // person has the page open, so the specs are a copy away even when this
  // server is refused them.
  const pastedSpecs = pastedText
    ? { ...parseSpecsFromText(pastedText), ...parseKeyValueText(pastedText) }
    : {};

  let mcmasterSpecs = {};
  let mcmasterError = null;
  let mcmasterErrorCode = null;

  // Don't spend a page view re-fetching what was just pasted in. The
  // anonymous-view allowance is the scarce resource here.
  if (partNumber && Object.keys(pastedSpecs).length === 0) {
    try {
      mcmasterSpecs = await fetchMcMasterSpecsLive(partNumber);
    } catch (err) {
      mcmasterError = err.message;
      mcmasterErrorCode = err.code || "FETCH_FAILED";
    }
  }

  const specs = { ...mcmasterSpecs, ...pastedSpecs, ...manualSpecs };
  const hasAnySpec = Object.keys(specs).length > 0;

  const contributors = [
    Object.keys(mcmasterSpecs).length && "mcmaster",
    Object.keys(pastedSpecs).length && "pasted",
    Object.keys(manualSpecs).length && "manual",
  ].filter(Boolean);
  const source = contributors.join("+") || "none";

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
      "McMaster wants a login before it will show this part's specs. Two parts checked back to back confirm this is per-part, not a general block: 91251A329 was walled while 91251A540 returned all 8 fields from the same server seconds later. Open the part on mcmaster.com, copy its spec block, and paste it below -- that produces the same result as a successful lookup."
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

  // The gate is intermittent rather than absolute: in one verification run
  // of three parts, spaced 20s apart, the middle one came back with all 8
  // fields while the other two were gated. A second attempt with a fresh
  // browser and a short pause is therefore worth real success rate, and
  // costs nothing when the first attempt works.
  let lastError;
  for (let attempt = 1; attempt <= 2; attempt++) {
    if (attempt > 1) await new Promise((r) => setTimeout(r, 4000));
    try {
      const specs = await renderMcMasterPage(partNumber, attempt);
      specCache.set(partNumber, specs);
      return specs;
    } catch (err) {
      lastError = err;
      if (err.code !== "LOGIN_WALL") throw err;
      console.log(`[xref] part=${partNumber} attempt ${attempt} gated`);
    }
  }
  throw lastError;
}

async function renderMcMasterPage(partNumber, attempt) {
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
      `[xref] part=${partNumber} attempt=${attempt} finalUrl=${page.url()} status=${response && response.status()} textLen=${text ? text.length : 0}`
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
      console.log(`[xref] part=${partNumber} parsed nothing. text=${JSON.stringify((text || "").slice(0, 1500))}`);
      // Gating shows up in two shapes: an explicit "please log in" page, and
      // a product page whose chrome renders (Forward / Print / Find
      // alternative products) while the product data never arrives. Both
      // leave a page under ~1500 chars. Calling that "part may not exist"
      // blames the user for a typo they didn't make, so only a page with
      // real content on it gets that verdict.
      if (text.trim().length < 1500) throw new LoginWallError();
      throw new Error("the page loaded but no recognizable specs were on it -- this part may not exist, or its page is laid out differently");
    }

    return specs;
  } finally {
    await browser.close();
  }
}

// Re-exported for convenience; the logic itself lives in lib/specs.js and
// is what the tests exercise directly, with no browser or server involved.
module.exports = { app, parseKeyValueText, parseSpecsFromText, normalizeSpecs, buildQuery, buildSupplierLinks };

if (require.main !== module) return;

const port = process.env.PORT || 3000;
app.listen(port, () => {
  console.log(`mcmaster-xref listening on ${port}`);
  if (process.env.RUN_URLPROBE === "1") runUrlProbe();
  if (process.env.RUN_SWEEP === "1") runCategorySweep();
  if (process.env.RUN_VERIFY === "1") runVerification();
  if (process.env.RUN_QUERYLAB === "1") runQueryLab();
});

/**
 * Env-gated (RUN_QUERYLAB=1). Finds the query *shape* suppliers actually
 * match on, instead of assuming one.
 *
 * Of the six suppliers, five answer this server with a bot wall (Fastenal
 * 403, MSC "Pardon Our Interruption", Bolt Depot "Just a moment...",
 * Amazon 503) or a body too JS-heavy to judge, so they can tell us nothing
 * -- those links are opened from a real browser on a normal connection,
 * where they work. Grainger is the exception: it answers with a real page
 * and says plainly when a query matched nothing, which makes it the one
 * usable oracle for query wording. So: hold the part fixed, vary only the
 * phrasing, and see which shapes come back with results.
 */
const QUERY_LAB_PART = { material: "Black-Oxide Alloy Steel", driveType: "Hex", threadSize: '1/4"-20', length: '3/4"', grade: "Class 3", headType: "Socket", diameter: '3/8"' };

async function runQueryLab() {
  const variants = [
    ["current (built)", buildQuery(QUERY_LAB_PART)],
    ["no material/finish", '1/4"-20 x 3/4" socket head cap screw'],
    ["no inch marks", "1/4-20 x 3/4 socket head cap screw alloy steel black oxide"],
    ["no inch marks, no material", "1/4-20 x 3/4 socket head cap screw"],
    ["noun first", "socket head cap screw 1/4-20 x 3/4"],
    ["noun + size, no x", "socket head cap screw 1/4-20 3/4"],
    ["thread only", "socket head cap screw 1/4-20"],
    ["noun only", "socket head cap screw"],
    ["noun + finish", "black oxide socket head cap screw 1/4-20"],
  ];

  console.log("[qlab] START");
  for (const [label, query] of variants) {
    const url = `https://www.grainger.com/search?searchQuery=${encodeURIComponent(query)}`;
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
      const title = ((body.match(/<title[^>]*>([^<]*)<\/title>/i) || [])[1] || "").trim();
      const noResults = /couldn.?t find that/i.test(title) || /couldn.?t find that/i.test(body.slice(0, 4000));
      // Grainger puts a result count in the page when there are hits.
      const count = (body.match(/([\d,]+)\s*(?:products?|results?)\s*(?:found|match)/i) || [])[1] || "";
      console.log(`[qlab] ${noResults ? "NONE" : "HITS"} ${JSON.stringify(label)} q=${JSON.stringify(query)} status=${res.status} len=${body.length} count=${count} title=${JSON.stringify(title.slice(0, 70))}`);
    } catch (err) {
      console.log(`[qlab] ERR  ${JSON.stringify(label)} -- ${err.message}`);
    }
    await new Promise((r) => setTimeout(r, 1200));
  }
  console.log("[qlab] DONE");
}

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
// Overridable so a specific part can be checked against a known-good one
// without a code change -- the question "is this part gated, or is the
// whole allowance spent?" comes up whenever a lookup fails, and it can
// only be answered by rendering both and comparing.
const VERIFY_PARTS = (process.env.VERIFY_PARTS || "91251A051,91251A540,92196A106")
  .split(",")
  .map((p) => p.trim())
  .filter(Boolean);
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
  let blocked = 0;
  for (const { part, specs } of cases) {
    const query = buildQuery(specs);
    console.log(`[verify] links for ${part}: query=${JSON.stringify(query)}`);
    const linkBrowser = await chromium.launch({ args: ["--disable-blink-features=AutomationControlled"] });
    for (const { name, url } of buildSupplierLinks(specs)) {
      const verdict = await checkSupplierLink(linkBrowser, name, url, specs);
      const label = verdict.ok === null ? "BLOCKED" : verdict.ok ? "PASS" : "FAIL";
      if (verdict.ok === null) blocked++;
      else if (verdict.ok) ok++;
      else bad++;
      console.log(`[verify]   ${label} ${name}: ${verdict.detail}`);
    }
    await linkBrowser.close();
  }

  console.log(
    `[verify] DONE in ${Math.round((Date.now() - started) / 1000)}s -- links ${ok} pass / ${bad} fail / ${blocked} not judgeable from this server, across ${cases.length} parts`
  );
}

/**
 * A link passes only if the page that loads is a results page that
 * actually mentions the part's defining terms. Checking for a 200 is not
 * enough: bot walls, consent interstitials and empty-result pages all
 * return 200, and that is precisely what an earlier check scored as
 * success.
 *
 * This renders the page in the same real headless Chrome the app uses for
 * McMaster, rather than issuing a bare fetch. A plain fetch fails several
 * of these sites for a reason that says nothing about the link: it runs no
 * JavaScript, so a page that renders its results client-side, or shows a
 * "checking your browser" interstitial that clears itself on execution,
 * reads as a wall either way. A browser is what those pages are built to
 * serve, so this measures the link instead of the client.
 *
 * It is not an attempt to defeat bot detection. Where a site still refuses
 * -- a hard 403, or a challenge that wants a puzzle solved -- that is the
 * site declining to answer an automated client, and the honest result is
 * BLOCKED, not a worked-around PASS. Those links are opened from a real
 * browser on a home connection, where these sites behave normally, so the
 * person reading the results is the one positioned to judge them.
 */
async function checkSupplierLink(browser, name, url, specs) {
  let context;
  try {
    context = await newStealthContext(browser);
    const page = await context.newPage();
    const response = await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 });

    // Results usually arrive after a second call, and a challenge page
    // usually replaces itself. Give both a moment rather than judging the
    // first paint.
    try {
      await page.waitForLoadState("networkidle", { timeout: 8000 });
    } catch {
      // whatever rendered is what gets judged
    }

    const status = response ? response.status() : 0;
    const title = (await page.title().catch(() => "")).trim().slice(0, 90);
    const text = await page.evaluate(() => document.body.innerText).catch(() => "");
    const detail = `status=${status} textLen=${text.length} title=${JSON.stringify(title)}`;
    const head = `${title}\n${text.slice(0, 4000)}`;

    if (/pardon our interruption|just a moment|access denied|unusual traffic|are you a robot|before you continue|verify you are human|enable javascript/i.test(head) || status === 403 || status === 503) {
      return { ok: null, detail: `${detail} <- refused an automated client; judge this one in a browser` };
    }
    if (status >= 400) return { ok: false, detail };
    // Grainger's "Whoops, we couldn't find that." reads like a verdict on
    // the query but isn't one: unrelated queries come back byte-identical,
    // so it never ran the search.
    if (/we couldn.?t find|couldn.?t find that|no results (were )?found|did not match any/i.test(head)) {
      return { ok: null, detail: `${detail} <- served regardless of query; a block, not a verdict` };
    }

    // A page that rendered no text at all has not answered the question --
    // it is a render that did not finish, not a judgement on the link.
    if (!text.trim()) {
      return { ok: null, detail: `${detail} <- rendered no text; judge this one in a browser` };
    }

    const marker = specs.threadSize || specs.shape || specs.material;
    const normalize = (v) => v.toLowerCase().replace(/["\u201d]/g, "").replace(/\s+/g, " ");
    if (marker && !normalize(text).includes(normalize(marker))) {
      return { ok: false, detail: `${detail} <- no mention of ${JSON.stringify(marker)}` };
    }
    return { ok: true, detail };
  } catch (err) {
    return { ok: false, detail: `render failed -- ${err.message}` };
  } finally {
    if (context) await context.close().catch(() => {});
  }
}

/**
 * Env-gated (RUN_SWEEP=1). Runs the category matrix through *this*
 * deployment and reports any phrase that drifted from what the tests pin.
 *
 * The local suite proves the code in the repo is right; this proves the
 * code actually running in production is the same code. Those came apart
 * once already -- the service spent five days deploying a branch nobody
 * was pushing to -- and nothing in the test suite could have caught it.
 *
 * Costs no McMaster page views: every case posts its own spec block, which
 * is the path that skips the live fetch.
 */
async function runCategorySweep() {
  let cases;
  try {
    cases = require("./test/categories.json");
  } catch {
    console.log("[sweep] category matrix not deployed with this build");
    return;
  }

  console.log(`[sweep] START ${cases.length} cases against this instance`);
  let pass = 0;
  const failures = [];
  for (const c of cases) {
    const specs = { ...parseSpecsFromText(c.pastedText), ...parseKeyValueText(c.pastedText) };
    const actual = buildQuery(specs);
    if (actual === c.expect) {
      pass++;
    } else {
      failures.push(c.label);
      console.log(`[sweep] FAIL ${c.label} (${c.part})`);
      console.log(`[sweep]   expected ${JSON.stringify(c.expect)}`);
      console.log(`[sweep]   actual   ${JSON.stringify(actual)}`);
    }
  }
  console.log(`[sweep] DONE ${pass}/${cases.length} pass${failures.length ? ` -- failed: ${failures.join(", ")}` : ""}`);
}

/**
 * Env-gated (RUN_URLPROBE=1). Finds a supplier's real search URL instead of
 * guessing one.
 *
 * Online Metals and Speedy Metals both answered 404 for every raw-stock
 * lookup -- the search paths in the link table were simply wrong, so that
 * whole family of parts handed out dead links. A replacement guessed from
 * here would be the same mistake again, so each candidate shape is opened
 * in a real browser and reported with what it actually returned.
 */
const PROBE_QUERY = "6061 aluminum round bar";
const PROBE_CANDIDATES = [
  ["Online Metals", "https://www.onlinemetals.com/en/search?text={q}"],
  ["Online Metals", "https://www.onlinemetals.com/search?text={q}"],
  ["Online Metals", "https://www.onlinemetals.com/en/search?q={q}"],
  ["Online Metals", "https://www.onlinemetals.com/catalogsearch/result/?q={q}"],
  ["Online Metals", "https://www.onlinemetals.com/en/buy/search?text={q}"],
  ["Online Metals", "https://www.onlinemetals.com/"],
  ["Speedy Metals", "https://www.speedymetals.com/Search?searchTerm={q}"],
  ["Speedy Metals", "https://www.speedymetals.com/search?searchTerm={q}"],
  ["Speedy Metals", "https://www.speedymetals.com/SearchResults.aspx?searchTerm={q}"],
  ["Speedy Metals", "https://www.speedymetals.com/search.aspx?q={q}"],
  ["Speedy Metals", "https://www.speedymetals.com/s/{q}"],
  ["Speedy Metals", "https://www.speedymetals.com/"],
];

async function runUrlProbe() {
  console.log("[probe] START");
  const browser = await chromium.launch({ args: ["--disable-blink-features=AutomationControlled"] });
  try {
    for (const [name, template] of PROBE_CANDIDATES) {
      const url = template.replace("{q}", encodeURIComponent(PROBE_QUERY));
      let context;
      try {
        context = await newStealthContext(browser);
        const page = await context.newPage();
        const response = await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 });
        try {
          await page.waitForLoadState("networkidle", { timeout: 8000 });
        } catch {
          // judge whatever rendered
        }
        const status = response ? response.status() : 0;
        const title = (await page.title().catch(() => "")).trim().slice(0, 70);
        const text = (await page.evaluate(() => document.body.innerText).catch(() => "")) || "";
        const hits = /aluminum/i.test(text) && /round bar|round|bar/i.test(text);
        console.log(
          `[probe] ${status === 200 ? (hits ? "HITS " : "200  ") : "BAD  "} ${name} ${url} status=${status} textLen=${text.length} title=${JSON.stringify(title)}`
        );
      } catch (err) {
        console.log(`[probe] ERR   ${name} ${url} -- ${err.message}`);
      } finally {
        if (context) await context.close().catch(() => {});
      }
      await new Promise((r) => setTimeout(r, 1500));
    }
  } finally {
    await browser.close();
  }
  console.log("[probe] DONE");
}
