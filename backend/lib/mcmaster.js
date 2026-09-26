"use strict";

/**
 * Fetch layer for McMaster-Carr product pages.
 *
 * McMaster product pages are a single-page app: the actual product data
 * (title, breadcrumbs, spec table) arrives on ONE XHR fired from the page,
 * not in the initial HTML:
 *
 *   https://www.mcmaster.com/<mvNNN>/WebParts/Navigate/ItmPrsnttnWebPart.aspx?partnbrtxt=<PART>&...
 *
 * That XHR needs Akamai bot-defense cookies and a per-request token the SPA
 * sets on itself (x-mcm-t-id / x-mcm-ps-id / x-mcm-features headers), so it
 * cannot be curled directly - the practical way to get it is to drive a real
 * Chromium page via Playwright, navigate to the product page, and capture
 * the XHR's response body from `page.on("response")`.
 *
 * That body is:
 *   <10-digit decimal length><JSON of that length><trailing HTML fragment>
 *
 * IMPORTANT: the 10-digit length is a count of JS/.NET string *characters*
 * (i.e. JS string .length / UTF-16 code units) in the JSON text, not UTF-8
 * bytes. Slicing by byte offset silently truncates the JSON whenever it
 * contains multi-byte UTF-8 characters (e.g. "°", smart quotes). See
 * parseFragment() below - it decodes to a JS string first and slices by
 * character index.
 */

const path = require("path");

const ITM_PRSNTTN_RE = /ItmPrsnttnWebPart/i;
const LOGIN_WALL_RE = /to continue browsing,?\s*please log in/i;
const NOT_FOUND_RE = /we couldn't find|no results for|page not found/i;

const DEFAULT_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36";

// ---------------------------------------------------------------------------
// parseFragment - pure, no I/O. Exported for tests.
// ---------------------------------------------------------------------------

const LENGTH_PREFIX_RE = /^\s*(\d{10})/;

/**
 * Fallback for when the length-prefix slice doesn't parse cleanly: scan
 * forward from the first "{" and balance braces (respecting quoted strings
 * and escapes) to find the matching top-level "}", then JSON.parse that
 * span.
 */
function balancedJsonParse(text, fromIndex) {
  const start = text.indexOf("{", fromIndex || 0);
  if (start === -1) return null;

  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (ch === "\\") {
        escaped = true;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }
    if (ch === '"') {
      inString = true;
    } else if (ch === "{") {
      depth++;
    } else if (ch === "}") {
      depth--;
      if (depth === 0) {
        const candidate = text.slice(start, i + 1);
        try {
          return JSON.parse(candidate);
        } catch {
          return null;
        }
      }
    }
  }
  return null;
}

/**
 * Parse a raw ItmPrsnttnWebPart response body into the JSON object it
 * carries. Accepts a Buffer or a string. Pure function - no network, no
 * throwing on shape it doesn't like; throws only when nothing usable can be
 * extracted at all.
 */
function parseFragment(rawBody) {
  if (rawBody == null) {
    throw new Error("parseFragment: empty body");
  }
  const text = Buffer.isBuffer(rawBody) ? rawBody.toString("utf-8") : String(rawBody);

  const m = text.match(LENGTH_PREFIX_RE);
  if (m) {
    const n = parseInt(m[1], 10);
    const start = text.indexOf(m[1]) + m[1].length;
    const jsonStr = text.slice(start, start + n);
    try {
      const json = JSON.parse(jsonStr);
      if (json && typeof json === "object") return json;
    } catch {
      // length-prefixed slice didn't parse (truncated response, off-by-one,
      // etc.) - fall through to the balanced-brace fallback below.
    }
  }

  const fallback = balancedJsonParse(text, m ? text.indexOf(m[1]) : 0);
  if (fallback) return fallback;

  throw new Error("parseFragment: could not locate/parse JSON payload in response body");
}

// ---------------------------------------------------------------------------
// Browser launch options
// ---------------------------------------------------------------------------

/**
 * Chromium launch options. In this dev sandbox, outbound HTTPS goes through
 * a TLS-intercepting proxy and needs a handful of flags to avoid
 * ERR_TOO_MANY_RETRIES; none of that is needed (or wanted) in production, so
 * it's all gated behind HTTPS_PROXY being set. PLAYWRIGHT_CHROMIUM_PATH lets
 * either environment point at a specific Chromium binary explicitly.
 */
function browserLaunchOptions() {
  const opts = {
    args: ["--disable-blink-features=AutomationControlled"],
  };

  if (process.env.PLAYWRIGHT_CHROMIUM_PATH) {
    opts.executablePath = process.env.PLAYWRIGHT_CHROMIUM_PATH;
  }

  if (process.env.HTTPS_PROXY) {
    // Sandbox-only: TLS-intercepting proxy needs these to avoid
    // ERR_TOO_MANY_RETRIES on navigation.
    if (!opts.executablePath) {
      opts.executablePath = "/opt/pw-browsers/chromium";
    }
    opts.proxy = { server: process.env.HTTPS_PROXY };
    opts.args.push("--ignore-certificate-errors", "--disable-http2", "--disable-quic");
  }

  return opts;
}

function contextOptions() {
  return {
    userAgent: DEFAULT_UA,
    viewport: { width: 1280, height: 900 },
    locale: "en-US",
    ignoreHTTPSErrors: true,
  };
}

// ---------------------------------------------------------------------------
// logging
// ---------------------------------------------------------------------------

function log(level, msg, extra) {
  const line = { ts: new Date().toISOString(), level, component: "mcmaster", msg, ...extra };
  const out = level === "error" ? console.error : console.log;
  out(JSON.stringify(line));
}

// ---------------------------------------------------------------------------
// Warm shared browser
// ---------------------------------------------------------------------------

let playwrightModule = null;
function getPlaywright() {
  if (!playwrightModule) {
    playwrightModule = require(path.join(__dirname, "..", "node_modules", "playwright"));
  }
  return playwrightModule;
}

let sharedBrowser = null;
let launchingPromise = null;

async function getBrowser() {
  if (sharedBrowser && sharedBrowser.isConnected()) {
    return sharedBrowser;
  }
  if (launchingPromise) {
    return launchingPromise;
  }
  const { chromium } = getPlaywright();
  launchingPromise = (async () => {
    log("info", "launching browser");
    const browser = await chromium.launch(browserLaunchOptions());
    browser.on("disconnected", () => {
      log("warn", "browser disconnected");
      if (sharedBrowser === browser) sharedBrowser = null;
    });
    sharedBrowser = browser;
    return browser;
  })();
  try {
    return await launchingPromise;
  } finally {
    launchingPromise = null;
  }
}

/** For tests / graceful shutdown. */
async function closeBrowser() {
  if (sharedBrowser) {
    const b = sharedBrowser;
    sharedBrowser = null;
    await b.close().catch(() => {});
  }
}

// ---------------------------------------------------------------------------
// fetchProductRecord
// ---------------------------------------------------------------------------

function urlForPart(partNumber) {
  return `https://www.mcmaster.com/${encodeURIComponent(partNumber)}/`;
}

class McmasterError extends Error {
  constructor(message, code) {
    super(message);
    this.name = "McmasterError";
    this.code = code;
  }
}

/**
 * Some part numbers resolve to a JSON fragment that parses cleanly but is
 * not a product record at all -- a family-listing page, or some other page
 * type whose spec data (if any) doesn't live where a product page's does.
 * Left unchecked, that fragment sails through parseFragment and
 * parseProductRecord as a "successful" product with an empty partNumber,
 * empty title, no family, no categoryPath, and zero attributes -- reported
 * to the caller as `source: "mcmaster"`, `error: null`, and cached. This is
 * the actual defect this validates against (see the two live parts
 * captured in test/fixtures/mcmaster/remote/).
 *
 * A record earns "looks like a product" by having a real name for itself
 * (TitleTxt or PartNbrTxt) AND at least one spec row in its table. Anything
 * short of that throws NO_DATA with a message describing the JSON's actual
 * shape (its top-level keys, TargetPageMetadata.Type/.World if present, and
 * NewStyleIndicator) so the next capture of a not-yet-seen page type tells
 * us what to add support for, and with the raw parsed JSON attached as
 * `err.record` (never folded into the message string) so a caller wants it
 * -- e.g. for a debug echo -- without re-fetching anything.
 */
function describeRecordShape(json) {
  const keys = json && typeof json === "object" ? Object.keys(json) : [];
  const bits = [`top-level keys: [${keys.join(", ")}]`];
  const meta = json && typeof json === "object" ? json.TargetPageMetadata : null;
  if (meta && typeof meta === "object") {
    if (meta.Type != null) bits.push(`TargetPageMetadata.Type: ${meta.Type}`);
    if (meta.World != null) bits.push(`TargetPageMetadata.World: ${meta.World}`);
  }
  if (json && typeof json === "object" && json.NewStyleIndicator != null) {
    bits.push(`NewStyleIndicator: ${json.NewStyleIndicator}`);
  }
  return bits.join(", ");
}

function validateProductRecord(json) {
  const title = json && typeof json.TitleTxt === "string" ? json.TitleTxt.trim() : "";
  const partNbr = json && typeof json.PartNbrTxt === "string" ? json.PartNbrTxt.trim() : "";
  const reactData = json && typeof json === "object" ? json.ReactData : null;
  const tableEntries =
    reactData && Array.isArray(reactData.TableEntries) ? reactData.TableEntries : [];
  const hasSpecRow = tableEntries.some((e) => e && e.Type === "TableEntrySpec");

  if ((title || partNbr) && hasSpecRow) return json;

  const err = new McmasterError(
    `McMaster JSON did not look like a product record (${describeRecordShape(json)})`,
    "NO_DATA",
  );
  err.record = json;
  throw err;
}

/**
 * Fetch a product's data fragment from McMaster-Carr by driving a real
 * Chromium page to the product URL and capturing the ItmPrsnttnWebPart XHR
 * response.
 *
 * Strategy (see backend/scripts/probe-mcmaster.js and the diagnostic run
 * behind it): a single warm Chromium *process* is kept alive across calls
 * (relaunched lazily if it has died), but each call gets its OWN fresh
 * browser context (fresh cookies/storage) and is torn down afterwards. A
 * shared, long-lived context accumulated Akamai/session state across
 * requests that made later requests in the same context increasingly likely
 * to stall with no ItmPrsnttnWebPart XHR at all ("shape 2"); a fresh context
 * per request was the most reliable configuration found. Each attempt also
 * retries once with a brand new context if the first attempt produced shape
 * 2 (page shell rendered, XHR never arrived).
 *
 * @param {string} partNumber
 * @param {object} [opts]
 * @param {number} [opts.timeoutMs=30000] total time budget for this call
 * @param {number} [opts.retries=1] extra fresh-context attempts on shape-2 failure
 * @returns {Promise<{raw: string, json: object}>}
 */
async function fetchProductRecord(partNumber, opts = {}) {
  const timeoutMs = opts.timeoutMs || 30000;
  const maxAttempts = 1 + (opts.retries != null ? opts.retries : 1);
  const deadline = Date.now() + timeoutMs;

  let lastErr = null;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const remaining = deadline - Date.now();
    if (remaining <= 1000) break;

    try {
      const result = await attemptFetch(partNumber, remaining);
      log("info", "fetch succeeded", { partNumber, attempt });
      return result;
    } catch (e) {
      lastErr = e;
      log("warn", "fetch attempt failed", { partNumber, attempt, code: e.code, message: e.message });
      if (e.code === "LOGIN_WALL" || e.code === "NOT_FOUND") {
        // Not worth retrying - these are stable responses, not transient.
        break;
      }
      // NO_DATA / NAV_FAILED: worth a fresh-context retry.
    }
  }

  throw lastErr || new McmasterError(`fetchProductRecord: exhausted attempts for ${partNumber}`, "NO_DATA");
}

/**
 * @param {string} partNumber
 * @param {number} budgetMs
 * @param {object} [browserOverride] test-only: a fake browser (with a
 *   `newContext` method) to drive instead of the real, shared Chromium
 *   process from getBrowser() -- lets tests exercise this function's own
 *   context/page setup and teardown without launching Playwright at all.
 */
async function attemptFetch(partNumber, budgetMs, browserOverride) {
  const browser = browserOverride || (await getBrowser());

  // ctx/page creation happens INSIDE the try below (not before it) so that
  // a throw from newContext/newPage -- which can happen once the process is
  // low on memory/handles, the exact time you most need cleanup -- still
  // runs the finally block and closes whatever context did get created,
  // instead of leaking it.
  let ctx;
  let page;
  let itmBody = null;
  const onResponse = async (resp) => {
    if (itmBody) return;
    const u = resp.url();
    if (!ITM_PRSNTTN_RE.test(u)) return;
    try {
      const text = await resp.text();
      if (text) itmBody = text;
    } catch {
      /* response body unavailable (redirect/aborted) - ignore */
    }
  };

  try {
    ctx = await browser.newContext(contextOptions());
    page = await ctx.newPage();
    page.on("response", onResponse);

    let navResp;
    try {
      navResp = await page.goto(urlForPart(partNumber), {
        waitUntil: "domcontentloaded",
        timeout: Math.min(30000, budgetMs),
      });
    } catch (e) {
      throw new McmasterError(`navigation failed: ${e.message.split("\n")[0]}`, "NAV_FAILED");
    }

    if (navResp && navResp.status() === 404) {
      throw new McmasterError(`part not found (HTTP 404): ${partNumber}`, "NOT_FOUND");
    }

    const waitBudget = Math.max(1000, Math.min(25000, budgetMs - 3000));
    await page
      .waitForFunction(
        () => {
          const t = document.body.innerText || "";
          return (
            /to continue browsing,?\s*please log in/i.test(t) ||
            document.querySelector(".spec-table--pd, table[class*='spec']") ||
            document.querySelector(".ItmPrsnttnWebPart")
          );
        },
        null,
        { timeout: waitBudget },
      )
      .catch(() => {});

    if (!itmBody) {
      // Give any in-flight XHR a short grace period to finish.
      await page.waitForTimeout(Math.min(2000, Math.max(0, budgetMs - 1000)));
    }

    if (itmBody) {
      let json;
      try {
        json = parseFragment(itmBody);
      } catch (e) {
        throw new McmasterError(`could not parse ItmPrsnttnWebPart body: ${e.message}`, "NO_DATA");
      }
      validateProductRecord(json);
      return { raw: itmBody, json };
    }

    const shellText = await page
      .evaluate(() => document.body.innerText || "")
      .catch(() => "");

    if (LOGIN_WALL_RE.test(shellText)) {
      throw new McmasterError("hit the McMaster login wall", "LOGIN_WALL");
    }
    if (NOT_FOUND_RE.test(shellText)) {
      throw new McmasterError(`part not found: ${partNumber}`, "NOT_FOUND");
    }
    throw new McmasterError(
      `page shell rendered but ItmPrsnttnWebPart XHR never arrived (shellTextLen=${shellText.length})`,
      "NO_DATA",
    );
  } finally {
    if (page) page.off("response", onResponse);
    if (ctx) await ctx.close().catch(() => {});
  }
}

module.exports = {
  fetchProductRecord,
  parseFragment,
  validateProductRecord,
  browserLaunchOptions,
  closeBrowser,
  McmasterError,
  attemptFetch, // exported for tests only (accepts a fake browser override)
};
