const SPEC_FIELD_IDS = [
  "category",
  // Part type decides the product noun in the query and which suppliers
  // get asked ("hex nut" goes to Bolt Depot's nut aisle, "o-ring" to the
  // MRO distributors), so it has to be correctable by hand -- the page
  // title it is normally read from is exactly what a login wall hides.
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
  // Head type drives the product noun in the supplier query ("socket head
  // cap screw" vs "flat head screw"), so it has to be enterable by hand --
  // manual entry is exactly what gets used when McMaster won't answer.
  "headType",
  "driveType",
  "finish",
  "grade",
  "durometer",
];

const statusEl = document.getElementById("status");
const resultsPanel = document.getElementById("resultsPanel");
const specsList = document.getElementById("specsList");
const linksList = document.getElementById("linksList");
const manualPanel = document.getElementById("manualPanel");

document.getElementById("manualToggle").addEventListener("click", () => {
  manualPanel.hidden = !manualPanel.hidden;
  if (!manualPanel.hidden) manualPanel.open = true;
});

document.getElementById("lookupBtn").addEventListener("click", runLookup);
document.getElementById("partNumber").addEventListener("keydown", (e) => {
  if (e.key === "Enter") runLookup();
});

function readManualSpecs() {
  const specs = {};
  for (const id of SPEC_FIELD_IDS) {
    const el = document.getElementById(id);
    if (el && el.value.trim()) specs[id] = el.value.trim();
  }
  return specs;
}

async function runLookup() {
  const partNumber = document.getElementById("partNumber").value.trim();
  const specs = readManualSpecs();
  const pastedText = document.getElementById("pastedText").value.trim();

  if (!partNumber && !pastedText && Object.keys(specs).length === 0) {
    setStatus("Enter a part number, paste a spec block, or fill in manual specs.", true);
    return;
  }

  if (typeof BACKEND_URL !== "string" || BACKEND_URL.includes("YOUR-SERVICE-NAME")) {
    setStatus(
      "Backend URL isn't configured yet. Edit frontend/config.js after deploying the backend (see backend/README.md).",
      true
    );
    return;
  }

  resultsPanel.hidden = true;

  // A live lookup renders a real browser on the far end, and the backend
  // may be cold on top of that, so this can genuinely run past a minute.
  // With a single unchanging "Looking up..." there is nothing on screen to
  // tell a slow answer from a dead one, and on a phone that reads as a page
  // that never loads. A counter says it is still going, and the wording
  // says roughly how long is normal before that is worth doubting.
  const startedAt = Date.now();
  const tick = setInterval(() => {
    const secs = Math.round((Date.now() - startedAt) / 1000);
    setStatus(
      secs < 20
        ? `Looking up... ${secs}s`
        : `Looking up... ${secs}s (a live render, or a cold backend, can take up to ${LOOKUP_TIMEOUT_MS / 1000}s)`
    );
  }, 1000);
  setStatus("Looking up... 0s");

  try {
    const res = await fetch(`${BACKEND_URL}/api/xref`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ partNumber, specs, pastedText }),
      // Without this the request has no deadline at all: a stalled backend
      // leaves the spinner up forever with nothing the person can act on.
      signal: timeoutSignal(LOOKUP_TIMEOUT_MS),
    });

    if (!res.ok) {
      throw new Error(`Backend returned HTTP ${res.status}`);
    }

    const data = await res.json();
    renderResults(data);
  } catch (err) {
    const timedOut = err.name === "TimeoutError" || err.name === "AbortError";
    setStatus(
      timedOut
        ? `Lookup timed out after ${LOOKUP_TIMEOUT_MS / 1000}s. The backend may be starting up -- try again, or paste the spec block below to skip the live render.`
        : `Lookup failed: ${err.message}`,
      true
    );
  } finally {
    clearInterval(tick);
  }
}

// AbortSignal.timeout is Safari 16+. Reaching for it unguarded on an older
// phone throws before the request is even made, which would turn a slow
// lookup into no lookup at all -- so fall back to an AbortController, and
// to no deadline where even that is missing.
function timeoutSignal(ms) {
  if (typeof AbortSignal !== "undefined" && typeof AbortSignal.timeout === "function") {
    return AbortSignal.timeout(ms);
  }
  if (typeof AbortController === "undefined") return undefined;
  const controller = new AbortController();
  setTimeout(() => controller.abort(), ms);
  return controller.signal;
}

// Long enough to cover a cold start plus a live render, short enough that
// a genuinely stuck request says so instead of hanging.
const LOOKUP_TIMEOUT_MS = 120000;

function setStatus(msg, isError = false) {
  statusEl.textContent = msg;
  statusEl.classList.toggle("error", isError);
}

function renderResults(data) {
  const specEntries = Object.entries(data.specs || {});

  if (specEntries.length === 0) {
    setStatus(data.mcmasterFetchError || "No specs found. Try manual entry.", true);
    // Nothing came back, so the only way forward is manual entry -- open it
    // rather than leaving the user to find the toggle.
    manualPanel.hidden = false;
    manualPanel.open = true;
    return;
  }

  let statusMsg = `Specs sourced from: ${data.source}.`;
  if (data.mcmasterFetchError) {
    statusMsg += ` (${data.mcmasterFetchError})`;
  }
  setStatus(statusMsg);

  specsList.innerHTML = specEntries
    .map(
      ([key, value]) =>
        `<div class="spec-row"><span>${escapeHtml(key)}</span><span>${escapeHtml(value)}</span></div>`
    )
    .join("");

  renderLinks(data);

  resultsPanel.hidden = false;
}

/**
 * Renders the supplier links along with the search phrase, kept editable.
 *
 * These are search links on sites that all refuse automated checking, so
 * nothing here can promise the results are any good -- the person reading
 * them is the only one who can see them. Rather than hand over a fixed
 * guess, the query it was built from is shown and can be changed: edit the
 * wording and every link below repoints at the new phrase.
 */
function renderLinks(data) {
  const links = data.links || [];
  if (!links.length) {
    linksList.innerHTML = "<li>No supplier links generated.</li>";
    return;
  }

  linksList.innerHTML = `
    <li class="query-note">
      <label for="queryEdit">Searching for</label>
      <input id="queryEdit" value="${escapeHtml(data.query || "")}" />
      <span class="hint">Edit to refine — the links below follow.</span>
    </li>
  ` + links
    .map(
      (link, i) =>
        `<li><a id="supplierLink${i}" href="${escapeHtml(link.url)}" target="_blank" rel="noopener">${escapeHtml(link.name)}</a></li>`
    )
    .join("");

  const queryEdit = document.getElementById("queryEdit");
  queryEdit.addEventListener("input", () => {
    const q = queryEdit.value.trim();
    links.forEach((link, i) => {
      const a = document.getElementById(`supplierLink${i}`);
      // A supplier without a placeholder (Bolt Depot browses by filter, not
      // by text) has nothing to substitute, so its link is left alone.
      if (!a || !link.urlTemplate || !/\{q\}|\{plus\}/.test(link.urlTemplate)) return;
      // Same rule the backend applied when it built these links: a
      // cut-to-order stock house indexes a product by material and form and
      // sells the sizes as options on it, so a dimension in the search string
      // matches no product name and returns nothing. Mirrored here so the
      // transform survives an edit rather than being undone by the first
      // keystroke.
      const linkQuery = link.dimensionless ? stripDimensions(q) || q : q;
      a.href = link.urlTemplate
        .replace("{plus}", encodeURIComponent(linkQuery).replace(/%20/g, "+"))
        .replace("{q}", encodeURIComponent(linkQuery));
    });
  });
}

// Drops the dimension tokens from a query: anything carrying a digit and
// ending in an inch mark. Kept identical to stripDimensions in
// backend/lib/specs.js -- the two files share no module, so the rule is
// written out in both.
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

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
