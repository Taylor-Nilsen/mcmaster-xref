/**
 * McMaster-Carr Cross-Reference backend (AWS Lambda, Function URL).
 *
 * POST /  (the function URL root)
 *   Body: { partNumber?: string, specs?: PartialSpecs }
 *   - If partNumber is given, renders the live McMaster product page with
 *     a real headless Chrome instance and parses the fully-rendered text.
 *     McMaster is a JS-only SPA, so a plain HTTP fetch never sees real
 *     spec data -- this actually executes the page's JS. Runs fresh on
 *     every request, no caching. Can't see anything McMaster gates behind
 *     account login (no credentials are stored or used here) -- see
 *     README.
 *   - specs, if given, are merged on top of (and override) anything
 *     parsed live, so manual entry always works as a fallback.
 *   Returns: { source, specs, links }
 *
 * Runs on AWS Lambda's Always Free tier (1M requests + 400,000 GB-s
 * compute per month, permanently, not a trial) -- see backend/README.md
 * for deploy steps. Chosen over Cloudflare Workers because Browser
 * Rendering (the only way to get headless Chrome there) requires the
 * Workers Paid plan; this needs no paid plan on either platform.
 */

const chromium = require("@sparticuz/chromium");
const puppeteer = require("puppeteer-core");

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

exports.handler = async (event) => {
  const method = event.requestContext?.http?.method || "GET";

  if (method === "OPTIONS") {
    return { statusCode: 204, headers: CORS_HEADERS, body: "" };
  }
  if (method !== "POST") {
    return respond(404, { error: "not found" });
  }

  let body;
  try {
    body = JSON.parse(event.body || "{}");
  } catch {
    return respond(400, { error: "invalid JSON body" });
  }

  const partNumber = (body.partNumber || "").trim();
  const manualSpecs = sanitizeSpecs(body.specs || {});

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

  return respond(200, {
    partNumber: partNumber || null,
    source,
    specs,
    mcmasterFetchError: mcmasterError,
    links,
  });
};

function respond(statusCode, data) {
  return {
    statusCode,
    headers: { "Content-Type": "application/json", ...CORS_HEADERS },
    body: JSON.stringify(data),
  };
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

  const browser = await puppeteer.launch({
    args: chromium.args,
    executablePath: await chromium.executablePath(),
    headless: chromium.headless,
  });

  try {
    const page = await browser.newPage();
    await page.goto(pageUrl, { waitUntil: "networkidle0", timeout: 25000 });
    await new Promise((resolve) => setTimeout(resolve, 1000)); // let any late client-side render settle

    const text = await page.evaluate(() => document.body.innerText);
    if (!text || text.trim().length < 50) {
      throw new Error("page rendered but had no usable text (likely blocked)");
    }

    return { ...parseSpecsFromText(text), ...parseKeyValueText(text) };
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
  "head type": "headType",
  finish: "finish",
  grade: "grade",
  class: "grade",
};

/**
 * Parses "Key: Value" / "Key - Value" lines -- the shape of McMaster's own
 * spec table once it's actually rendered. Higher confidence than the fuzzy
 * keyword matching in parseSpecsFromText, so the caller lets this override
 * it.
 */
function parseKeyValueText(text) {
  const specs = {};
  for (const line of text.split("\n")) {
    const m = line.match(/^\s*([A-Za-z][A-Za-z /]{1,40}?)\s*[:\-]\s*(.{1,80}?)\s*$/);
    if (!m) continue;
    const key = KEY_MAP[m[1].trim().toLowerCase()];
    if (key && !specs[key]) specs[key] = m[2].trim();
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
 */
function buildSupplierLinks(specs) {
  const query = [specs.material, specs.shape, specs.threadSize, specs.diameter, specs.thickness, specs.width, specs.length, specs.driveType, specs.finish, specs.grade]
    .filter(Boolean)
    .join(" ");

  if (!query) return [];

  const q = encodeURIComponent(query);

  const rawStockSuppliers = [
    { name: "Speedy Metals", url: `https://www.speedymetals.com/search?q=${q}` },
    { name: "MSC Direct", url: `https://www.mscdirect.com/search?q=${q}` },
    { name: "Online Metals", url: `https://www.onlinemetals.com/en/search?q=${q}` },
  ];
  const fastenerSuppliers = [
    { name: "Fastenal", url: `https://www.fastenal.com/products/search?query=${q}` },
    { name: "Grainger", url: `https://www.grainger.com/search?searchQuery=${q}` },
    { name: "Bolt Depot", url: `https://www.boltdepot.com/Search.aspx?search=${q}` },
    { name: "Amazon", url: `https://www.amazon.com/s?k=${q}` },
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
