const SPEC_FIELD_IDS = [
  "category",
  "material",
  "shape",
  "threadSize",
  "diameter",
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

  setStatus("Looking up...");
  resultsPanel.hidden = true;

  try {
    const res = await fetch(`${BACKEND_URL}/api/xref`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ partNumber, specs, pastedText }),
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
      a.href = link.urlTemplate
        .replace("{plus}", encodeURIComponent(q).replace(/%20/g, "+"))
        .replace("{q}", encodeURIComponent(q));
    });
  });
}

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
