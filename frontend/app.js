/**
 * McMaster-Carr Cross-Reference frontend.
 *
 * Two independent ways a product record reaches this page:
 *
 *   1. Server lookup: POST { partNumber } to BACKEND_URL/api/xref.
 *      Best-effort -- McMaster blocks datacenter IPs by request velocity,
 *      so this can fail even for a part that loads fine in your own
 *      browser (see README). On failure/timeout, a fallback panel points
 *      at the bookmarklet.
 *   2. Bookmarklet fragment: `#r=<method>.<data>` in the URL, dropped off
 *      by frontend/bookmarklet.js after it scrapes a McMaster product page
 *      in the user's own browser (see that file). Decoded and run entirely
 *      client-side through window.McmXref (frontend/vendor/product.js, a
 *      synced copy of backend/lib/product.js -- see scripts/sync-frontend.sh),
 *      so this path needs no server at all. The record is also POSTed to
 *      the backend afterwards, purely so its cache learns it; that POST is
 *      fire-and-forget and its failure changes nothing on screen.
 *
 * Both paths, plus manual/pasted entry (still routed through the backend,
 * same as before) and "Recent" (localStorage), funnel into one shape and
 * one renderer -- server response and client-built result are
 * intentionally identical:
 *
 *   {
 *     partNumber, source,
 *     product: { partNumber, title, family, categoryPath, attributes } | null,
 *     classification: { noun, kind },
 *     queries: { primary, alternates },
 *     links: [{ supplier, url, query }],
 *     error: { code, message } | null,
 *   }
 */

// ---------------------------------------------------------------------------
// Elements
// ---------------------------------------------------------------------------

const statusEl = document.getElementById("status");
const resultsPanel = document.getElementById("resultsPanel");
const fallbackPanel = document.getElementById("fallbackPanel");
const specsList = document.getElementById("specsList");
const specsSummary = document.getElementById("specsSummary");
const linksList = document.getElementById("linksList");
const manualPanel = document.getElementById("manualPanel");
const recentSection = document.getElementById("recentSection");
const recentList = document.getElementById("recentList");

// ---------------------------------------------------------------------------
// Wiring
// ---------------------------------------------------------------------------

document.getElementById("manualToggle").addEventListener("click", () => {
  manualPanel.hidden = !manualPanel.hidden;
  if (!manualPanel.hidden) manualPanel.open = true;
});

document.getElementById("lookupBtn").addEventListener("click", () => runPartNumberLookup());
document.getElementById("partNumber").addEventListener("keydown", (e) => {
  if (e.key === "Enter") runPartNumberLookup();
});
document.getElementById("manualSubmitBtn").addEventListener("click", () => runManualOrPasted());

document.getElementById("openMcMasterBtn").addEventListener("click", () => {
  const partNumber = document.getElementById("partNumber").value.trim() || lastFailedPartNumber;
  if (!partNumber) return;
  window.open(`https://www.mcmaster.com/${encodeURIComponent(partNumber)}/`, "_blank", "noopener");
});

let lastFailedPartNumber = "";

// ---------------------------------------------------------------------------
// Backend calls
// ---------------------------------------------------------------------------

// A live render on the far end plus a possibly-cold free-tier backend can
// genuinely take a while, but the backend is a best-effort optimistic
// first attempt now (see README) -- if it hasn't answered in 45s, the
// bookmarklet fallback is a better use of the person's time than more
// waiting.
const LOOKUP_TIMEOUT_MS = 45000;

// Error codes the backend contract (spec.md / backend/README.md) uses for
// "the server couldn't do this, but the bookmarklet can" -- as opposed to
// something the person can fix by editing their input.
const FALLBACK_ERROR_CODES = new Set(["LOGIN_WALL", "NO_DATA", "NAV_FAILED", "FETCH_FAILED", "BUSY"]);

function backendConfigured() {
  return typeof BACKEND_URL === "string" && BACKEND_URL && !BACKEND_URL.includes("YOUR-SERVICE-NAME");
}

function timeoutSignal(ms) {
  if (typeof AbortSignal !== "undefined" && typeof AbortSignal.timeout === "function") {
    return AbortSignal.timeout(ms);
  }
  if (typeof AbortController === "undefined") return undefined;
  const controller = new AbortController();
  setTimeout(() => controller.abort(), ms);
  return controller.signal;
}

async function postXref(body) {
  const res = await fetch(`${BACKEND_URL}/api/xref`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: timeoutSignal(LOOKUP_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`Backend returned HTTP ${res.status}`);
  return res.json();
}

// Fire-and-forget: lets the server cache learn a record the bookmarklet
// resolved client-side. Never blocks rendering and never surfaces an error
// -- if the backend is unreachable, that's exactly the situation this
// whole bookmarklet path exists for.
function reportRecordToBackend(recordObj) {
  if (!backendConfigured()) return;
  try {
    fetch(`${BACKEND_URL}/api/xref`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ record: recordObj }),
    }).catch(() => {});
  } catch (e) {
    // ignore -- best effort only
  }
}

async function runPartNumberLookup() {
  const partNumber = document.getElementById("partNumber").value.trim();
  if (!partNumber) {
    setStatus("Enter a part number.", true);
    return;
  }
  if (!backendConfigured()) {
    setStatus(
      "Backend URL isn't configured. Use the bookmarklet below instead, or paste specs / enter them manually.",
      true
    );
    showFallback(partNumber);
    return;
  }

  hidePanels();
  lastFailedPartNumber = partNumber;

  const startedAt = Date.now();
  const tick = setInterval(() => {
    const secs = Math.round((Date.now() - startedAt) / 1000);
    setStatus(
      secs < 15
        ? `Looking up... ${secs}s`
        : `Looking up... ${secs}s (this is best-effort -- McMaster often blocks the server; the bookmarklet below always works)`
    );
  }, 1000);
  setStatus("Looking up... 0s");

  try {
    const body = await postXref({ partNumber });
    handleXrefResponse(body, partNumber);
  } catch (err) {
    const timedOut = err.name === "TimeoutError" || err.name === "AbortError";
    setStatus(
      timedOut ? `Lookup timed out after ${LOOKUP_TIMEOUT_MS / 1000}s.` : `Lookup failed: ${err.message}`,
      true
    );
    showFallback(partNumber);
  } finally {
    clearInterval(tick);
  }
}

async function runManualOrPasted() {
  const specs = readManualSpecs();
  const pastedText = document.getElementById("pastedText").value.trim();
  const partNumber = document.getElementById("partNumber").value.trim();

  if (!pastedText && Object.keys(specs).length === 0) {
    setStatus("Paste a spec block or fill in at least one manual field.", true);
    return;
  }
  if (!backendConfigured()) {
    setStatus("Backend URL isn't configured, so paste/manual entry can't be processed. Use the bookmarklet instead.", true);
    return;
  }

  hidePanels();
  setStatus("Processing...");
  try {
    const body = await postXref({ partNumber, specs, pastedText });
    handleXrefResponse(body, partNumber);
  } catch (err) {
    setStatus(`Failed: ${err.message}`, true);
  }
}

/**
 * Handles a /api/xref response the same way regardless of whether it came
 * from a partNumber lookup or a manual/pasted submission: render the
 * product if there is one, and show the fallback panel when the error is
 * one the bookmarklet path can route around.
 */
function handleXrefResponse(body, partNumberForFallback) {
  if (body.product) {
    renderResult(body);
    if (body.error) {
      setStatus(`Sourced from ${body.source}. (${body.error.message})`, true);
    } else {
      setStatus(`Sourced from ${body.source}.`);
    }
    saveRecent(body);
    return;
  }

  // No product at all: nothing to render, just say why and offer the way out.
  if (body.error) {
    setStatus(body.error.message, true);
    if (FALLBACK_ERROR_CODES.has(body.error.code)) {
      showFallback(partNumberForFallback);
    }
  } else {
    setStatus("No specs found. Try the bookmarklet, or paste specs / enter them manually.", true);
    showFallback(partNumberForFallback);
  }
}

// ---------------------------------------------------------------------------
// Manual spec fields
// ---------------------------------------------------------------------------

const SPEC_FIELD_IDS = [
  "partType",
  "material",
  "shape",
  "threadSize",
  "diameter",
  "insideDiameter",
  "screwSize",
  "thickness",
  "width",
  "length",
  "headType",
  "driveType",
  "finish",
  "grade",
  "durometer",
];

function readManualSpecs() {
  const specs = {};
  for (const id of SPEC_FIELD_IDS) {
    const el = document.getElementById(id);
    if (el && el.value.trim()) specs[id] = el.value.trim();
  }
  return specs;
}

// ---------------------------------------------------------------------------
// Bookmarklet fragment (#r=...)
// ---------------------------------------------------------------------------

function fromBase64Url(str) {
  const b64 = str.replace(/-/g, "+").replace(/_/g, "/");
  const pad = b64.length % 4 === 0 ? "" : "=".repeat(4 - (b64.length % 4));
  const binary = atob(b64 + pad);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/**
 * Reverses bookmarklet.js's encodeRecord: `<method>.<base64url data>`,
 * method "dr" (CompressionStream 'deflate-raw') or "raw" (uncompressed).
 */
async function decodeFragmentRecord(fragmentValue) {
  const dot = fragmentValue.indexOf(".");
  const method = dot === -1 ? "raw" : fragmentValue.slice(0, dot);
  const data = dot === -1 ? fragmentValue : fragmentValue.slice(dot + 1);
  const bytes = fromBase64Url(data);

  let jsonBytes = bytes;
  if (method === "dr") {
    if (typeof DecompressionStream !== "function") {
      throw new Error("This browser can't decompress the bookmarklet's data. Try a newer browser, or use manual entry.");
    }
    const ds = new DecompressionStream("deflate-raw");
    const writer = ds.writable.getWriter();
    writer.write(bytes);
    writer.close();
    const buf = await new Response(ds.readable).arrayBuffer();
    jsonBytes = new Uint8Array(buf);
  }
  const json = new TextDecoder().decode(jsonBytes);
  return JSON.parse(json);
}

/** Rebuilds a byName()-capable Product from the plain object either the
 * backend's serializeProduct() or our own buildResultFromRecord() produced
 * -- lets the query-edit box call McmXref.buildSupplierLinks() again
 * without needing the original parseProductRecord() Product kept around. */
function productFromSerialized(p) {
  const attributes = p.attributes || [];
  function byName(name, matchGroup) {
    const nameLower = String(name).toLowerCase();
    const groupLower = matchGroup != null ? String(matchGroup).toLowerCase() : null;
    const hit = attributes.find(
      (a) => String(a.name).toLowerCase() === nameLower && (groupLower == null || String(a.group || "").toLowerCase() === groupLower)
    );
    return hit ? hit.value : undefined;
  }
  return { partNumber: p.partNumber, title: p.title, family: p.family, categoryPath: p.categoryPath || [], attributes, byName };
}

/** Runs a parseProductRecord-shaped record through window.McmXref entirely
 * client-side, producing the same response shape the backend returns. */
function buildResultFromRecord(recordObj, source) {
  if (!window.McmXref) {
    throw new Error("frontend/vendor/product.js didn't load, so the bookmarklet record can't be processed client-side.");
  }
  const M = window.McmXref;
  const product = M.parseProductRecord(recordObj);
  const classification = M.classifyProduct(product);
  const built = M.buildQueries(product);
  const links = M.buildSupplierLinks(product);
  return {
    partNumber: product.partNumber || null,
    source: source || "bookmarklet",
    product: {
      partNumber: product.partNumber,
      title: product.title,
      family: product.family,
      categoryPath: product.categoryPath,
      attributes: product.attributes.map((a) => ({ group: a.group, name: a.name, value: a.value })),
    },
    classification,
    queries: { primary: built.primary || null, alternates: built.alternates || [] },
    links,
    error: null,
  };
}

async function handleFragmentOnLoad() {
  const hash = location.hash || "";
  if (!hash.startsWith("#r=")) return;
  const fragmentValue = hash.slice(3);

  setStatus("Reading bookmarklet data...");
  try {
    const recordObj = await decodeFragmentRecord(fragmentValue);
    const result = buildResultFromRecord(recordObj, "bookmarklet");
    hidePanels();
    renderResult(result);
    setStatus(`Sourced from your browser (bookmarklet) -- part ${result.partNumber || "?"}.`);
    saveRecent(result);
    reportRecordToBackend(recordObj);
  } catch (err) {
    setStatus(`Couldn't read the bookmarklet data: ${err.message}`, true);
  } finally {
    // Leave the record out of the visible URL/history once handled.
    history.replaceState(null, "", location.pathname + location.search);
  }
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

function setStatus(msg, isError = false) {
  statusEl.textContent = msg;
  statusEl.classList.toggle("error", isError);
}

function hidePanels() {
  resultsPanel.hidden = true;
  fallbackPanel.hidden = true;
}

function showFallback(partNumber) {
  lastFailedPartNumber = partNumber || lastFailedPartNumber;
  fallbackPanel.hidden = false;
  fallbackPanel.scrollIntoView({ behavior: "smooth", block: "nearest" });
}

// Local (non-McmXref) copy of the {q}/{plus}/{slug} substitution and
// dimension-stripping rules, used only when window.McmXref isn't loaded --
// mirrors backend/lib/product.js's applyTemplate/stripDimensions.
function localApplyTemplate(urlTemplate, query) {
  const encoded = encodeURIComponent(query);
  const plus = encoded.replace(/%20/g, "+");
  const slug = String(query).trim().toLowerCase().replace(/["]/g, "").replace(/\//g, "-").replace(/\s+/g, "-").replace(/-{2,}/g, "-");
  return urlTemplate.replace("{plus}", plus).replace("{q}", encoded).replace("{slug}", slug);
}

function localStripDimensions(query) {
  return String(query || "")
    .replace(/\S*[0-9][^\s]*"/g, "")
    .replace(/(^|\s)x(?=\s|$)/g, "$1")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Finds the {q}/{plus}/{slug} substitution point in an already-built URL by
 * looking for the encoded form of the query that produced it, so a link
 * can be re-templated without the backend needing to expose its literal
 * urlTemplate strings.
 */
function urlToTemplate(url, query) {
  if (!query) return null;
  const encoded = encodeURIComponent(query);
  const plus = encoded.replace(/%20/g, "+");
  const slug = String(query).trim().toLowerCase().replace(/["]/g, "").replace(/\//g, "-").replace(/\s+/g, "-").replace(/-{2,}/g, "-");
  if (plus && url.includes(plus)) return url.replace(plus, "{plus}");
  if (encoded && url.includes(encoded)) return url.replace(encoded, "{q}");
  if (slug && url.includes(slug)) return url.replace(slug, "{slug}");
  return null;
}

let currentResult = null;
let currentLinkTemplates = []; // [{supplier, template, wasStripped}], aligned to currentResult.links

function renderResult(data) {
  currentResult = data;
  const product = data.product;

  document.getElementById("resultTitle").textContent = product.title || product.partNumber || "Result";
  document.getElementById("resultCategory").textContent = (product.categoryPath || []).join(" › ");

  const noun = data.classification && data.classification.noun;
  const kind = data.classification && data.classification.kind;
  const nounBadge = document.getElementById("resultNounBadge");
  nounBadge.textContent = noun ? `${noun}${kind ? ` (${kind})` : ""}` : "unclassified";

  document.getElementById("resultSourceNote").textContent = product.partNumber ? `Part ${product.partNumber} · source: ${data.source}` : `source: ${data.source}`;

  const primary = (data.queries && data.queries.primary) || "";
  const queryEdit = document.getElementById("queryEdit");
  queryEdit.value = primary;

  const initialPrimary = primary;
  currentLinkTemplates = (data.links || []).map((link) => ({
    supplier: link.supplier,
    template: urlToTemplate(link.url, link.query),
    // A dimensionless supplier (a cut-to-order stock house) got a stripped
    // query even though the primary query carried the size -- detected by
    // comparing this link's own query to the primary the results opened
    // with, so an edit re-strips instead of re-inserting a size that site
    // can't search on.
    wasStripped: link.query !== initialPrimary,
  }));

  renderAlternates(data.queries && data.queries.alternates);
  renderLinks(data.links || []);
  renderSpecs(product.attributes || []);

  resultsPanel.hidden = false;
}

function renderAlternates(alternates) {
  const row = document.getElementById("alternatesRow");
  const list = alternates || [];
  if (!list.length) {
    row.innerHTML = "";
    return;
  }
  row.innerHTML = list
    .map((alt, i) => `<button type="button" class="chip" data-alt-index="${i}">${escapeHtml(alt)}</button>`)
    .join("");
  row.querySelectorAll(".chip").forEach((btn, i) => {
    btn.addEventListener("click", () => {
      const queryEdit = document.getElementById("queryEdit");
      queryEdit.value = list[i];
      applyQueryEdit(list[i]);
    });
  });
}

function renderLinks(links) {
  if (!links.length) {
    linksList.innerHTML = "<li>No supplier links generated.</li>";
    return;
  }
  linksList.innerHTML = links
    .map(
      (link, i) =>
        `<li><a id="supplierLink${i}" href="${escapeHtml(link.url)}" target="_blank" rel="noopener">${escapeHtml(link.supplier)}</a></li>`
    )
    .join("");

  const queryEdit = document.getElementById("queryEdit");
  // Re-bind (not addEventListener again) since renderResult replaces the
  // whole panel's content each time; a fresh listener each render is fine
  // since the old input node was discarded along with it -- but the input
  // element itself persists across renders, so guard with a data flag.
  if (!queryEdit.dataset.bound) {
    queryEdit.dataset.bound = "1";
    queryEdit.addEventListener("input", () => applyQueryEdit(queryEdit.value.trim()));
  }
}

function applyQueryEdit(newQuery) {
  const links = (currentResult && currentResult.links) || [];
  const M = window.McmXref;

  links.forEach((link, i) => {
    const a = document.getElementById(`supplierLink${i}`);
    if (!a) return;
    const info = currentLinkTemplates[i];
    if (!info || !info.template) return; // e.g. Bolt Depot's structured browse URL: nothing to substitute

    const stripFn = M && typeof M.stripDimensions === "function" ? M.stripDimensions : localStripDimensions;
    const applyFn = M && typeof M.applyTemplate === "function" ? M.applyTemplate : localApplyTemplate;
    const q = info.wasStripped ? stripFn(newQuery) || newQuery : newQuery;
    a.href = applyFn(info.template, q);
  });
}

function renderSpecs(attributes) {
  specsSummary.textContent = `All specs (${attributes.length})`;
  if (!attributes.length) {
    specsList.innerHTML = "<p class='muted'>No spec rows.</p>";
    return;
  }

  let html = "";
  let openGroup = null;
  for (const attr of attributes) {
    if (attr.group !== openGroup) {
      openGroup = attr.group;
      if (openGroup) html += `<h4 class="spec-group">${escapeHtml(openGroup)}</h4>`;
    }
    html += `<div class="spec-row"><span>${escapeHtml(attr.name)}</span><span>${escapeHtml(attr.value)}</span></div>`;
  }
  specsList.innerHTML = html;
}

function escapeHtml(str) {
  return String(str == null ? "" : str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// ---------------------------------------------------------------------------
// Recent (localStorage, last 20, keyed by part number)
// ---------------------------------------------------------------------------

const RECENT_KEY = "mcmxref.recent.v1";
const RECENT_LIMIT = 20;

function loadRecent() {
  try {
    const raw = localStorage.getItem(RECENT_KEY);
    const list = raw ? JSON.parse(raw) : [];
    return Array.isArray(list) ? list : [];
  } catch (e) {
    return [];
  }
}

function saveRecent(result) {
  const partNumber = (result.partNumber || (result.product && result.product.partNumber) || "").trim();
  if (!partNumber) return;
  try {
    let list = loadRecent().filter((r) => r.partNumber !== partNumber);
    list.unshift({
      partNumber,
      title: result.product && result.product.title,
      noun: result.classification && result.classification.noun,
      savedAt: Date.now(),
      result,
    });
    list = list.slice(0, RECENT_LIMIT);
    localStorage.setItem(RECENT_KEY, JSON.stringify(list));
    renderRecent(list);
  } catch (e) {
    // localStorage unavailable (private mode, quota, etc.) -- Recent is a
    // convenience, not a requirement, so just skip it.
  }
}

function renderRecent(list) {
  const items = list || loadRecent();
  if (!items.length) {
    recentSection.hidden = true;
    return;
  }
  recentSection.hidden = false;
  recentList.innerHTML = items
    .map(
      (item, i) =>
        `<li><button type="button" class="recent-item" data-recent-index="${i}">` +
        `<span class="recent-part">${escapeHtml(item.partNumber)}</span>` +
        `<span class="recent-desc">${escapeHtml(item.title || item.noun || "")}</span>` +
        `</button></li>`
    )
    .join("");
  recentList.querySelectorAll(".recent-item").forEach((btn, i) => {
    btn.addEventListener("click", () => {
      hidePanels();
      renderResult(items[i].result);
      setStatus(`From Recent -- part ${items[i].partNumber}.`);
      document.getElementById("partNumber").value = items[i].partNumber;
    });
  });
}

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

renderRecent();
if (location.hash && location.hash.startsWith("#r=")) {
  handleFragmentOnLoad();
}
