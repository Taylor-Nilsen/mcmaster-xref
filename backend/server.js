/**
 * McMaster-Carr Cross-Reference backend. The frontend (frontend/) is a
 * static site on GitHub Pages -- Pages can't run server code, so this runs
 * separately (Render) and the frontend calls it cross-origin, hence the
 * CORS headers below.
 *
 * POST /api/xref
 *   Body (all optional): { partNumber?, record?, pastedText?, specs? }
 *
 *   Resolution order -- the first of these that is present wins, and
 *   decides `source`:
 *     1. `record` -- a JSON product record (or the raw captured page
 *        fragment string) taken directly off mcmaster.com by a bookmarklet
 *        running in the person's own browser. Parsed with
 *        lib/product.js's parseProductRecord (via lib/mcmaster.js's
 *        parseFragment first, when it's a raw string). source: "record".
 *     2. `pastedText` -- spec text copied by hand off McMaster's rendered
 *        page. Converted into a synthetic product record (see
 *        buildProductFromPastedText below) so it runs through the exact
 *        same classifier/query-builder as a real record. source: "pasted".
 *     3. `partNumber` -- this server drives a headless Chromium to
 *        mcmaster.com itself (lib/mcmaster.js's fetchProductRecord).
 *        source: "mcmaster" on success.
 *   If none of the three resolves a product, and `specs` (manual key/value
 *   entry) is given, a product is synthesized from that alone.
 *   source: "manual".
 *
 *   `specs`, when given, ALSO overrides attribute values by name on
 *   whatever product was otherwise resolved (see SPEC_KEY_TO_ATTR) -- it
 *   does not change `source` in that case, since `source` is a single enum
 *   value naming how the product was *found*, not every way it was edited.
 *
 *   Why the server path goes through fetchProductRecord instead of
 *   rendering the page and regexing its innerText (the old approach, still
 *   in lib/specs.js): McMaster blocks server IPs by request velocity
 *   (Akamai bot-defense) and also serves an anonymous-view login wall, and
 *   this Render deployment has had zero successful lookups in three days.
 *   The server path is therefore treated as an optimistic first attempt
 *   that must fail FAST and honestly -- a failed lookup answers within
 *   ~35s (HARD_TIMEOUT_MS below), never the ~80s the old per-request
 *   two-attempt render used to take -- and reports a machine-readable
 *   `error.code` the frontend can branch on to offer its own
 *   bookmarklet-based path instead.
 *
 *   Returns: { partNumber, source, product, classification, queries,
 *     links, error }
 *   See serializeProduct/buildQueries/buildSupplierLinks below for exact
 *   shapes.
 *
 * GET /api/health -> { status, uptimeSec, cacheSize, browserWarm }
 *
 * Batch renders (the old RUN_VERIFY / RUN_SWEEP / RUN_QUERYLAB /
 * RUN_URLPROBE env-gated blocks) are gone from this file -- a 100-part
 * sweep is exactly what burned through McMaster's anonymous-view budget
 * and took the whole service down (see README). The only supported way to
 * batch-probe McMaster now is backend/scripts/probe-mcmaster.js, run by
 * hand, spaced out, never from the deployed service.
 */

"use strict";

const fs = require("fs");
const express = require("express");
const cors = require("cors");

const {
  parseSpecsFromText,
  parseKeyValueText,
  sanitizeSpecs,
} = require("./lib/specs");
const {
  parseProductRecord,
  classifyProduct,
  buildQueries,
  buildSupplierLinks,
} = require("./lib/product");
const mcmaster = require("./lib/mcmaster");

// ---------------------------------------------------------------------------
// Legacy spec-key -> structured-attribute mapping
// ---------------------------------------------------------------------------

/**
 * How the old flat spec object (lib/specs.js's KEY_MAP / sanitizeSpecs
 * shape: { material, threadSize, length, ... }) maps onto the attribute
 * names lib/product.js's byName() reads. Deliberately simple and flat: a
 * legacy key becomes one top-level (`group: null`) attribute. That's
 * enough, because lib/product.js's byName(name) with no group argument
 * matches an attribute under ANY group, including null -- so a flat
 * "Thread Size" attribute here is found by both
 * `byName("Thread Size")` and satisfies the `||` half of
 * `byName("Thread Size") || byName("Size", "Thread")` call sites.
 *
 * Two legacy keys have no mapping and are intentionally dropped:
 *   - `partType` -- the old manual override for what the part *is*. The
 *     new pipeline derives that from classifyProduct(), which reads
 *     categoryPath and structured attributes (Fastener Head Type, Nut
 *     Type, Shape, ...), not a free-text noun; there is no equivalent
 *     single field to override it with here. A record or pastedText body
 *     that carries a real breadcrumb trail classifies correctly on its
 *     own; manual-only entry falls back to whatever
 *     classifyKindFromAttributes() can infer from the mapped keys below
 *     (e.g. threadSize alone reads as "fastener").
 *   - `category` -- the old manual Category <select>. Same story: nothing
 *     downstream reads a bare category string any more.
 * Also not mapped, for the same reason (no old spec key existed for them):
 * Nut Type, Bore, Bearing Type -- so manual entry cannot itself signal
 * "nut" or "bearing"; it falls through to categoryPath/threadSize
 * inference instead. Document this rather than growing sanitizeSpecs's
 * allowlist for a manual-entry UI the other agent may replace anyway.
 */
const SPEC_KEY_TO_ATTR = {
  material: "Material",
  shape: "Shape",
  driveType: "Drive Style",
  finish: "Finish",
  threadSize: "Thread Size",
  length: "Length",
  diameter: "Diameter",
  thickness: "Thickness",
  width: "Width",
  grade: "Grade",
  headType: "Fastener Head Type",
  screwSize: "For Screw Size",
  insideDiameter: "Inside Diameter",
  durometer: "Durometer",
  shaftDiameter: "For Shaft Diameter",
};

const lc = (v) => String(v == null ? "" : v).toLowerCase();

function legacyToTableEntries(legacySpecs) {
  const entries = [];
  for (const [legacyKey, attrName] of Object.entries(SPEC_KEY_TO_ATTR)) {
    const value = legacySpecs[legacyKey];
    if (typeof value === "string" && value.trim()) {
      entries.push({ Name: attrName, Value: value, IsIndented: false, Type: "TableEntrySpec" });
    }
  }
  return entries;
}

/** Mutates `product.attributes` in place: sets a value if that attribute
 * already exists (by name, any group), otherwise appends a new flat one.
 * Safe because lib/product.js's byName() closes over this same array. */
function applyManualOverrides(product, manualSpecs) {
  for (const [legacyKey, attrName] of Object.entries(SPEC_KEY_TO_ATTR)) {
    const value = manualSpecs[legacyKey];
    if (typeof value !== "string" || !value.trim()) continue;
    const existing = product.attributes.find((a) => lc(a.name) === lc(attrName));
    if (existing) {
      existing.value = value;
      existing.raw = value;
    } else {
      product.attributes.push({ group: null, name: attrName, value, raw: value });
    }
  }
}

function firstNonEmptyLine(text) {
  for (const line of String(text || "").split("\n")) {
    const trimmed = line.trim();
    if (trimmed) return trimmed;
  }
  return "";
}

/** A minimal record in the exact shape parseProductRecord expects, built
 * from pasted McMaster page text -- so the rest of the pipeline
 * (classifyProduct/buildQueries/buildSupplierLinks) runs identically
 * whether the product came from a live record or a paste. */
function buildProductFromPastedText(pastedText, partNumberInput) {
  const legacySpecs = { ...parseSpecsFromText(pastedText), ...parseKeyValueText(pastedText) };
  const record = {
    PartNbrTxt: partNumberInput || "",
    TitleTxt: firstNonEmptyLine(pastedText),
    TargetPageMetadata: { ProductFamily: null },
    ReactData: { Breadcrumbs: [], TableEntries: legacyToTableEntries(legacySpecs), Copies: [] },
    CtlgPgNbrs: [],
  };
  return parseProductRecord(record);
}

/** Same idea as buildProductFromPastedText, for a request that supplies
 * only manual `specs` with no record/pastedText/successful partNumber
 * lookup to attach them to. */
function buildProductFromManualSpecs(manualSpecs, partNumberInput) {
  const record = {
    PartNbrTxt: partNumberInput || "",
    TitleTxt: "",
    TargetPageMetadata: { ProductFamily: null },
    ReactData: { Breadcrumbs: [], TableEntries: legacyToTableEntries(manualSpecs), Copies: [] },
    CtlgPgNbrs: [],
  };
  return parseProductRecord(record);
}

/** `record` input is either an already-parsed JSON product object, or the
 * raw captured page fragment string a bookmarklet would grab straight off
 * the ItmPrsnttnWebPart XHR (same shape as test/fixtures/mcmaster/*.raw).
 * A raw string goes through parseFragment first, which does the
 * length-prefix bookkeeping parseProductRecord itself doesn't attempt. */
function buildProductFromRecordInput(recordInput) {
  if (typeof recordInput === "string") {
    const json = mcmaster.parseFragment(recordInput);
    return parseProductRecord(json);
  }
  return parseProductRecord(recordInput);
}

function serializeProduct(product) {
  return {
    partNumber: product.partNumber,
    title: product.title,
    family: product.family,
    categoryPath: product.categoryPath,
    attributes: product.attributes.map((a) => ({ group: a.group, name: a.name, value: a.value })),
  };
}

// ---------------------------------------------------------------------------
// Error codes / messages
// ---------------------------------------------------------------------------

// Every message says, briefly, that the bookmarklet path (capturing the
// record client-side, in the person's own browser, where McMaster doesn't
// see a datacenter IP) works when this server's own attempt doesn't --
// that's the actual escape hatch now, per the background above.
const ERROR_MESSAGES = {
  LOGIN_WALL:
    "McMaster served this server its anonymous-view login wall for this part. The bookmarklet path (capture the page in your own browser) works when the server path is blocked.",
  NO_DATA:
    "McMaster's page loaded but its product data never arrived for this part. The bookmarklet path works when the server path is blocked.",
  NOT_FOUND: "McMaster has no product page for that part number.",
  NAV_FAILED:
    "This server could not reach McMaster. The bookmarklet path works when the server path is blocked.",
  FETCH_FAILED:
    "The McMaster lookup failed for an unexpected reason. The bookmarklet path works when the server path is blocked.",
  BUSY: "Too many McMaster lookups are already queued on this server. Try again shortly, or use the bookmarklet path.",
  BAD_RECORD: "The captured record could not be parsed.",
};

function friendlyError(code, rawMessage) {
  return { code, message: ERROR_MESSAGES[code] || rawMessage || "Lookup failed." };
}

function codedError(message, code) {
  const err = new Error(message);
  err.code = code;
  return err;
}

// ---------------------------------------------------------------------------
// Serialized fetch queue
// ---------------------------------------------------------------------------

/**
 * McMaster's IP block is triggered by request *velocity* (Akamai bot
 * score), not by any one request looking automated -- so the fix is
 * structural: never let two navigations start less than `spacingMs` apart,
 * and refuse to queue more than `maxDepth` requests behind whatever's
 * already waiting rather than let a burst pile up and make things worse.
 *
 * A request's time in this queue is NOT covered by HARD_TIMEOUT_MS (that
 * applies only to the fetch itself, once it starts -- see
 * resolveViaMcMaster) -- at maxDepth 5, a request queued behind several
 * slow fetches could otherwise wait 60-120s for its turn and never even
 * begin. Instead, a request that has waited more than `maxQueueWaitMs`
 * without starting is rejected with BUSY on its own, so a caller finds out
 * fast that the server is backed up rather than silently waiting out a
 * queue that will die of a hard timeout anyway.
 */
class SerialFetchQueue {
  constructor({ maxDepth, spacingMs, maxQueueWaitMs }) {
    this.maxDepth = maxDepth;
    this.spacingMs = spacingMs;
    this.maxQueueWaitMs = maxQueueWaitMs;
    this.queue = [];
    this.pumping = false;
    this.lastStart = 0;
  }

  get depth() {
    return this.queue.length;
  }

  run(fn) {
    if (this.queue.length >= this.maxDepth) {
      return Promise.reject(codedError("too many McMaster lookups already queued", "BUSY"));
    }
    return new Promise((resolve, reject) => {
      this.queue.push({ fn, resolve, reject, enqueuedAt: Date.now() });
      this._pump();
    });
  }

  async _pump() {
    if (this.pumping) return;
    this.pumping = true;
    while (this.queue.length) {
      const { fn, resolve, reject, enqueuedAt } = this.queue.shift();
      if (Date.now() - enqueuedAt > this.maxQueueWaitMs) {
        reject(codedError("McMaster lookup queue wait exceeded", "BUSY"));
        continue;
      }
      // The 3s navigation-spacing floor applies between the START of one
      // fetch and the start of the next, regardless of how long the
      // previous fetch took to finish -- lastStart is set below, right
      // before fn() runs, not after it resolves.
      const wait = this.spacingMs - (Date.now() - this.lastStart);
      if (wait > 0) await new Promise((r) => setTimeout(r, wait));
      this.lastStart = Date.now();
      try {
        resolve(await fn());
      } catch (err) {
        reject(err);
      }
    }
    this.pumping = false;
  }
}

const QUEUE_MAX_DEPTH = 5;
const QUEUE_SPACING_MS = 3000;

// A request that has been sitting in the queue this long without its fetch
// starting gets rejected with BUSY rather than keep waiting -- see the
// SerialFetchQueue comment above.
const QUEUE_MAX_WAIT_MS = 20000;

// A failed fetch must answer fast and honestly (see file header) --
// fetchProductRecord's own internal budget defaults to 30s, and this wraps
// just the fetch itself (started inside resolveViaMcMaster, once it's this
// request's turn in the queue) in a hard ceiling above that so a stuck
// browser/navigation can never turn into the old ~80s hang. It deliberately
// does NOT cover time spent waiting in the queue -- see QUEUE_MAX_WAIT_MS
// for that.
const HARD_TIMEOUT_MS = 33000;

function withHardTimeout(promise, ms) {
  let timer;
  const timeout = new Promise((_resolve, reject) => {
    timer = setTimeout(() => reject(codedError(`McMaster lookup exceeded ${ms}ms hard timeout`, "FETCH_FAILED")), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

// ---------------------------------------------------------------------------
// Disk cache (write-through, optional)
// ---------------------------------------------------------------------------

// Positive results only -- a negative (LOGIN_WALL/NO_DATA) result is
// deliberately short-lived (see NEGATIVE_TTL_MS) and not worth persisting
// across a redeploy, since the whole point of the negative cache is "don't
// re-spend a page view on a wall that might have lifted by now".
function loadFileCacheInto(map) {
  const file = process.env.XREF_CACHE_FILE;
  if (!file) return;
  try {
    const raw = fs.readFileSync(file, "utf8");
    const data = JSON.parse(raw);
    if (data && typeof data === "object") {
      for (const [part, entry] of Object.entries(data)) {
        if (entry && entry.raw) map.set(part, { raw: entry.raw, ts: entry.ts || Date.now() });
      }
    }
  } catch {
    // Missing or corrupt file: start empty and tolerate it, per spec --
    // a disk cache is a nice-to-have on a redeploy, not a dependency.
  }
}

function persistFileCacheFrom(map) {
  const file = process.env.XREF_CACHE_FILE;
  if (!file) return;
  try {
    const obj = {};
    for (const [part, entry] of map.entries()) obj[part] = entry;
    fs.writeFileSync(file, JSON.stringify(obj));
  } catch (err) {
    console.error(`[xref] failed to write XREF_CACHE_FILE (${file}): ${err.message}`);
  }
}

const NEGATIVE_TTL_MS = 5 * 60 * 1000;

// ---------------------------------------------------------------------------
// App factory
// ---------------------------------------------------------------------------

/**
 * @param {object} [overrideDeps]
 * @param {(partNumber: string, opts?: object) => Promise<{raw:string,json:object}>} [overrideDeps.fetchProductRecord]
 * @param {object} [options] test-only knobs, never used in production
 * @param {number} [options.queueMaxDepth]
 * @param {number} [options.queueSpacingMs]
 * @param {number} [options.queueMaxWaitMs]
 */
function buildApp(overrideDeps = {}, options = {}) {
  function defaultFetchProductRecord(partNumber, opts) {
    // XREF_NO_BROWSER=1 skips ever launching Chromium -- used by the test
    // suite (via api.test.js's own stubs, this is mostly belt-and-braces)
    // and available for any environment that wants the server up without
    // Playwright installed. It fails exactly like a real NO_DATA result.
    if (process.env.XREF_NO_BROWSER === "1") {
      return Promise.reject(codedError("XREF_NO_BROWSER=1: browser fetch disabled", "NO_DATA"));
    }
    return mcmaster.fetchProductRecord(partNumber, opts);
  }

  const deps = { fetchProductRecord: overrideDeps.fetchProductRecord || defaultFetchProductRecord };

  const positiveCache = new Map(); // partNumber -> { raw: jsonRecordObject, ts }
  const negativeCache = new Map(); // partNumber -> { code, message, ts }
  const mcQueue = new SerialFetchQueue({
    maxDepth: options.queueMaxDepth || QUEUE_MAX_DEPTH,
    spacingMs: options.queueSpacingMs != null ? options.queueSpacingMs : QUEUE_SPACING_MS,
    maxQueueWaitMs: options.queueMaxWaitMs != null ? options.queueMaxWaitMs : QUEUE_MAX_WAIT_MS,
  });
  // Best-effort signal for /api/health: lib/mcmaster.js keeps its warm
  // Chromium process behind a module-private variable it doesn't export,
  // so this is a proxy -- "this instance has at least attempted a real
  // (non-XREF_NO_BROWSER) fetch", which is when lib/mcmaster.js's
  // getBrowser() launches it, on success OR failure.
  let browserWarm = false;

  loadFileCacheInto(positiveCache);

  // Two concurrent requests for the same uncached part number must not
  // queue two separate navigations -- the second caller joins the first
  // one's in-flight promise instead. Cleared as soon as that promise
  // settles (success or failure), so the next distinct request tries fresh.
  const inFlight = new Map(); // partNumber -> Promise<jsonRecordObject>

  function resolveViaMcMaster(partNumber) {
    const cached = positiveCache.get(partNumber);
    if (cached) return Promise.resolve(cached.raw);

    const negative = negativeCache.get(partNumber);
    if (negative && Date.now() - negative.ts < NEGATIVE_TTL_MS) {
      return Promise.reject(codedError(negative.message, negative.code));
    }

    const existing = inFlight.get(partNumber);
    if (existing) return existing;

    // Only the real (default, non-stubbed) fetch path ever touches an
    // actual Chromium process -- see the browserWarm comment above.
    if (deps.fetchProductRecord === defaultFetchProductRecord && process.env.XREF_NO_BROWSER !== "1") {
      browserWarm = true;
    }

    const promise = (async () => {
      try {
        // The hard timeout wraps only the fetch itself, starting once this
        // request reaches the front of mcQueue and fn() actually runs --
        // not the time spent waiting in the queue (SerialFetchQueue caps
        // that separately, with its own BUSY rejection).
        const { json } = await mcQueue.run(() =>
          withHardTimeout(deps.fetchProductRecord(partNumber, { timeoutMs: 30000 }), HARD_TIMEOUT_MS),
        );
        positiveCache.set(partNumber, { raw: json, ts: Date.now() });
        persistFileCacheFrom(positiveCache);
        return json;
      } catch (err) {
        if (err.code === "LOGIN_WALL" || err.code === "NO_DATA") {
          negativeCache.set(partNumber, { code: err.code, message: err.message, ts: Date.now() });
        }
        throw err;
      } finally {
        inFlight.delete(partNumber);
      }
    })();

    inFlight.set(partNumber, promise);
    return promise;
  }

  const app = express();
  app.use(cors());
  app.use(express.json({ limit: "2mb" }));

  app.get("/", (_req, res) => res.json({ status: "ok" }));

  app.get("/api/health", (_req, res) => {
    res.json({
      status: "ok",
      uptimeSec: Math.round(process.uptime()),
      cacheSize: positiveCache.size,
      browserWarm,
    });
  });

  app.post("/api/xref", async (req, res) => {
    const body = req.body || {};
    const partNumberInput = typeof body.partNumber === "string" ? body.partNumber.trim() : "";
    const pastedText = typeof body.pastedText === "string" ? body.pastedText.slice(0, 20000) : "";
    const manualSpecs = sanitizeSpecs(body.specs || {});

    let product = null;
    let source = "none";
    let error = null;

    if (body.record != null) {
      try {
        product = buildProductFromRecordInput(body.record);
        source = "record";
      } catch (err) {
        error = friendlyError("BAD_RECORD", err.message);
      }
    } else if (pastedText.trim()) {
      product = buildProductFromPastedText(pastedText, partNumberInput);
      source = "pasted";
    } else if (partNumberInput) {
      try {
        const json = await resolveViaMcMaster(partNumberInput);
        product = parseProductRecord(json);
        source = "mcmaster";
      } catch (err) {
        const code = err.code || "FETCH_FAILED";
        if (code === "BUSY") {
          return res.status(503).json({
            partNumber: partNumberInput || null,
            source: "none",
            product: null,
            classification: { noun: null, kind: null },
            queries: { primary: null, alternates: [] },
            links: [],
            error: friendlyError("BUSY", err.message),
          });
        }
        error = friendlyError(code, err.message);
      }
    }

    if (Object.keys(manualSpecs).length) {
      if (product) {
        applyManualOverrides(product, manualSpecs);
      } else {
        product = buildProductFromManualSpecs(manualSpecs, partNumberInput);
        source = "manual";
      }
    }

    const classification = product ? classifyProduct(product) : { noun: null, kind: null };
    const builtQueries = product ? buildQueries(product) : { primary: null, alternates: [] };
    const queries = { primary: builtQueries.primary || null, alternates: builtQueries.alternates || [] };
    const links = product ? buildSupplierLinks(product) : [];

    res.json({
      partNumber: partNumberInput || (product && product.partNumber) || null,
      source,
      product: product ? serializeProduct(product) : null,
      classification,
      queries,
      links,
      error,
    });
  });

  // A malformed JSON body would otherwise reach express's default error
  // handler and come back as HTML, which is not a shape the frontend (or
  // this API's own contract) expects.
  app.use((err, _req, res, next) => {
    if (err && err.type === "entity.parse.failed") {
      // Full documented /api/xref response shape (see file header), not
      // just `error` -- the frontend's error handling assumes every
      // response, success or failure, has these keys.
      return res.status(400).json({
        partNumber: null,
        source: "none",
        product: null,
        classification: null,
        queries: null,
        links: [],
        error: { code: "BAD_REQUEST", message: "Request body must be valid JSON." },
      });
    }
    return next(err);
  });

  return app;
}

const app = buildApp();

module.exports = { app, buildApp };

if (require.main !== module) return;

const port = process.env.PORT || 3000;
app.listen(port, () => {
  console.log(`mcmaster-xref listening on ${port}`);
});
