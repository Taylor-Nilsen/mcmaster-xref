const SPEC_FIELD_IDS = [
  "category",
  "material",
  "shape",
  "threadSize",
  "diameter",
  "thickness",
  "width",
  "length",
  "driveType",
  "finish",
  "grade",
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
  const scrapedText = document.getElementById("pastedText").value.trim();

  if (!partNumber && Object.keys(specs).length === 0 && !scrapedText) {
    setStatus("Enter a part number, paste specs, or fill in manual specs.", true);
    return;
  }

  if (!workerUrlConfigured()) {
    setStatus(
      "Worker URL isn't configured yet. Edit frontend/config.js after deploying the worker (see README).",
      true
    );
    return;
  }

  setStatus("Looking up...");
  resultsPanel.hidden = true;

  try {
    const res = await fetch(`${WORKER_URL}/api/xref`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ partNumber, specs, scrapedText }),
    });

    if (!res.ok) {
      throw new Error(`Worker returned HTTP ${res.status}`);
    }

    const data = await res.json();
    renderResults(data);
  } catch (err) {
    setStatus(`Lookup failed: ${err.message}`, true);
  }
}

function workerUrlConfigured() {
  return typeof WORKER_URL === "string" && !WORKER_URL.includes("YOUR-SUBDOMAIN");
}

// Bookmarklet: build its javascript: URI from bookmarklet.js, substituting
// this deployment's real worker/frontend URLs, so there's nothing for the
// user to hand-edit.
async function setUpBookmarklet() {
  const link = document.getElementById("bookmarklet");
  const status = document.getElementById("bookmarkletStatus");

  if (!workerUrlConfigured()) {
    status.textContent = "Configure frontend/config.js with your worker URL first.";
    link.addEventListener("click", (e) => e.preventDefault());
    return;
  }

  try {
    const res = await fetch("bookmarklet.js");
    let src = await res.text();
    const frontendUrl = location.href.split("#")[0];
    src = src.replace(/__WORKER_URL__/g, WORKER_URL).replace(/__FRONTEND_URL__/g, frontendUrl);
    link.href = "javascript:" + encodeURIComponent(src);
  } catch (err) {
    status.textContent = `Couldn't build bookmarklet: ${err.message}`;
  }
}

// If we were opened by the bookmarklet (frontendUrl#result=<base64 JSON>),
// render that result immediately instead of requiring a manual lookup.
function renderResultFromHash() {
  if (!location.hash.startsWith("#result=")) return;
  try {
    const encoded = location.hash.slice("#result=".length);
    const data = JSON.parse(decodeURIComponent(escape(atob(encoded))));
    if (data.partNumber) document.getElementById("partNumber").value = data.partNumber;
    renderResults(data);
    history.replaceState(null, "", location.pathname + location.search);
  } catch (err) {
    setStatus(`Couldn't read bookmarklet result: ${err.message}`, true);
  }
}

setUpBookmarklet();
renderResultFromHash();

function setStatus(msg, isError = false) {
  statusEl.textContent = msg;
  statusEl.classList.toggle("error", isError);
}

function renderResults(data) {
  const specEntries = Object.entries(data.specs || {});

  if (specEntries.length === 0) {
    setStatus(
      data.mcmasterFetchError
        ? `Couldn't extract specs (${data.mcmasterFetchError}). Try manual entry.`
        : "No specs found. Try manual entry.",
      true
    );
    return;
  }

  let statusMsg = `Specs sourced from: ${data.source}.`;
  if (data.mcmasterFetchError) {
    statusMsg += ` (McMaster auto-fetch failed: ${data.mcmasterFetchError})`;
  }
  setStatus(statusMsg);

  specsList.innerHTML = specEntries
    .map(
      ([key, value]) =>
        `<div class="spec-row"><span>${escapeHtml(key)}</span><span>${escapeHtml(value)}</span></div>`
    )
    .join("");

  linksList.innerHTML = (data.links || [])
    .map(
      (link) =>
        `<li><a href="${escapeHtml(link.url)}" target="_blank" rel="noopener">${escapeHtml(link.name)}</a></li>`
    )
    .join("") || "<li>No supplier links generated.</li>";

  resultsPanel.hidden = false;
}

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
