/**
 * McMaster-Carr Cross-Reference Worker
 *
 * POST /api/xref
 *   Body: { partNumber?: string, specs?: PartialSpecs }
 *   - If partNumber is given, best-effort fetch + parse of the McMaster
 *     product page (McMaster gates full spec data behind login/JS, so this
 *     is unreliable and expected to fail often — see README).
 *   - specs, if given, are merged on top of (and override) anything parsed
 *     from McMaster, so the UI's manual-entry fallback always works even
 *     when live scraping is blocked.
 *   Returns: { source: "mcmaster"|"manual"|"mcmaster+manual", specs, links }
 */

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

export default {
  async fetch(request) {
    const url = new URL(request.url);

    if (request.method === "OPTIONS") {
      return new Response(null, { headers: CORS_HEADERS });
    }

    if (url.pathname === "/api/xref" && request.method === "POST") {
      return handleXref(request);
    }

    if (url.pathname === "/" || url.pathname === "/api/health") {
      return json({ status: "ok" });
    }

    return json({ error: "not found" }, 404);
  },
};

async function handleXref(request) {
  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: "invalid JSON body" }, 400);
  }

  const partNumber = (body.partNumber || "").trim();
  const manualSpecs = sanitizeSpecs(body.specs || {});

  let mcmasterSpecs = {};
  let mcmasterError = null;

  if (partNumber) {
    try {
      mcmasterSpecs = await fetchMcMasterSpecs(partNumber);
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

  const links = hasAnySpec ? buildSupplierLinks(specs, partNumber) : [];

  return json({
    partNumber: partNumber || null,
    source,
    specs,
    mcmasterFetchError: mcmasterError,
    links,
  });
}

/**
 * Best-effort fetch + parse of a McMaster-Carr product page. McMaster
 * actively blocks scraping and renders most spec detail client-side, so
 * this only extracts what's present in <title>/<meta description> server
 * side. Throws on any failure — caller treats that as "unavailable, fall
 * back to manual entry", not a hard error.
 */
async function fetchMcMasterSpecs(partNumber) {
  const pageUrl = `https://www.mcmaster.com/${encodeURIComponent(partNumber)}/`;

  const res = await fetch(pageUrl, {
    headers: {
      "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36",
      Accept: "text/html,application/xhtml+xml",
    },
    cf: { cacheTtl: 3600, cacheEverything: true },
  });

  if (!res.ok) {
    throw new Error(`McMaster returned HTTP ${res.status}`);
  }

  const html = await res.text();
  const title = firstMatch(html, /<title>([^<]*)<\/title>/i);
  const description = firstMatch(
    html,
    /<meta\s+name=["']description["']\s+content=["']([^"']*)["']/i
  );

  const text = [title, description].filter(Boolean).join(". ");
  if (!text) {
    throw new Error("no usable metadata in McMaster response (likely blocked/JS-only)");
  }

  return parseSpecsFromText(text);
}

function firstMatch(str, re) {
  const m = str.match(re);
  return m ? decodeHtmlEntities(m[1].trim()) : null;
}

function decodeHtmlEntities(str) {
  return str
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">");
}

const MATERIALS = [
  "18-8 stainless steel",
  "316 stainless steel",
  "stainless steel",
  "carbon fiber",
  "aluminum",
  "brass",
  "bronze",
  "copper",
  "titanium",
  "alloy steel",
  "carbon steel",
  "steel",
  "nylon",
  "polycarbonate",
  "acetal",
  "delrin",
  "pvc",
  "rubber",
];

const DRIVE_TYPES = [
  "hex",
  "phillips",
  "slotted",
  "torx",
  "socket",
  "square",
  "combination",
];

const FINISHES = [
  "zinc plated",
  "black oxide",
  "galvanized",
  "chrome plated",
  "plain",
  "anodized",
  "powder coated",
];

function parseSpecsFromText(text) {
  const lower = text.toLowerCase();
  const specs = {};

  const material = MATERIALS.find((m) => lower.includes(m));
  if (material) specs.material = material;

  const drive = DRIVE_TYPES.find((d) => lower.includes(d));
  if (drive) specs.driveType = drive;

  const finish = FINISHES.find((f) => lower.includes(f));
  if (finish) specs.finish = finish;

  const thread = firstMatch(
    text,
    /(#\d{1,2}-\d{2,3}|\d{1,2}\/\d{1,2}"?-\d{1,2}|M\d{1,2}(?:\.\d)?\s*x\s*\d(?:\.\d+)?)/i
  );
  if (thread) specs.threadSize = thread.replace(/\s+/g, "");

  const length = firstMatch(text, /(\d+(?:\.\d+)?\s?(?:\/\s?\d+)?)"?\s*(?:long|length)/i);
  if (length) specs.length = `${length.trim()}"`;

  const diameter = firstMatch(
    text,
    /(\d+(?:\.\d+)?(?:\/\d+)?)"?\s*(?:dia(?:meter)?|od|o\.d\.)/i
  );
  if (diameter) specs.diameter = `${diameter.trim()}"`;

  const grade = firstMatch(text, /(grade\s?\d+|class\s?\d+(?:\.\d+)?)/i);
  if (grade) specs.grade = grade;

  return specs;
}

function sanitizeSpecs(specs) {
  const allowed = [
    "material",
    "shape",
    "driveType",
    "finish",
    "threadSize",
    "length",
    "diameter",
    "thickness",
    "width",
    "grade",
    "category",
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
 * those sites (most block bots as aggressively as McMaster does) — it
 * hands the user a pre-filled search so they can judge fit themselves,
 * per the spec's workflow step 5.
 */
function buildSupplierLinks(specs, partNumber) {
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

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json",
      ...CORS_HEADERS,
    },
  });
}
