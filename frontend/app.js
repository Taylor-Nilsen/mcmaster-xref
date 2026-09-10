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

  if (!partNumber && Object.keys(specs).length === 0) {
    setStatus("Enter a part number or fill in manual specs.", true);
    return;
  }

  if (typeof BACKEND_URL !== "string" || BACKEND_URL.includes("YOUR-SERVICE-NAME")) {
    setStatus(
      "Backend URL isn't configured yet. Edit frontend/config.js after deploying the backend (see backend/README.md).",
      true
    );
    return;
  }

  setStatus("Looking up...");
  resultsPanel.hidden = true;

  try {
    const res = await fetch(`${BACKEND_URL}/api/xref`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ partNumber, specs }),
    });

    if (!res.ok) {
      throw new Error(`Backend returned HTTP ${res.status}`);
    }

    const data = await res.json();
    renderResults(data);
  } catch (err) {
    setStatus(`Lookup failed: ${err.message}`, true);
  }
}

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

  // Show the phrase being searched. It's built from the specs rather than
  // typed, so seeing it is the fastest way to tell a bad match from a bad
  // query.
  const queryNote = data.query
    ? `<li class="query-note">Searching for: <code>${escapeHtml(data.query)}</code></li>`
    : "";

  linksList.innerHTML =
    queryNote +
      (data.links || [])
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
