/**
 * McMaster -> Xref bookmarklet.
 *
 * The backend can't reliably render McMaster: McMaster blocks datacenter
 * IPs by request velocity (Akamai bot scoring) and serves an anonymous
 * server client a login wall, even though the same part loads fine in a
 * real browser. This script runs *in that real browser* instead -- on the
 * product page the user already has open -- and reads the rendered page
 * directly. No fetch/XHR back to our origin: McMaster's CSP `connect-src`
 * forbids it, and it isn't needed anyway, because the only thing this does
 * is build a small JSON record and open our site with it in the URL
 * fragment (`window.open`, a plain navigation, not a cross-origin request).
 *
 * The record it builds is in the exact shape backend/lib/product.js's
 * `parseProductRecord` already accepts (the same shape McMaster's own
 * embedded JSON uses):
 *
 *   {
 *     PartNbrTxt, TitleTxt,
 *     TargetPageMetadata: { ProductFamily },
 *     ReactData: {
 *       Breadcrumbs: [{ Name }],
 *       TableEntries: [{ Name, Value, IsIndented, Type: "TableEntrySpec" }],
 *     },
 *   }
 *
 * so the frontend runs it through the exact same parse/classify/query/link
 * pipeline as a server-fetched record, with zero divergence between the
 * two paths.
 *
 * This file is dual-purpose:
 *   - As plain source, it's what a person reads to see what the
 *     bookmarklet does before installing it, and what
 *     backend/test/bookmarklet.test.js exercises directly (`require`d as a
 *     normal Node module -- see the export branch at the bottom).
 *   - As a bookmarklet, scripts/build-bookmarklet.js wraps this exact file
 *     verbatim in `(function(){ ... })();void 0;`, URL-encodes it, and
 *     writes the result as the href of the draggable link in
 *     frontend/index.html. There is one source of truth; nothing here is
 *     hand-minified or duplicated.
 *
 * McMaster's spec table ships in two markups seen in the wild, and this
 * handles both:
 *   - Current (React): a `<table>` whose class contains
 *     `product-detail-spec-table`. Rows are `<tr>`; a group header row
 *     ("Thread", "Head") has an empty value cell and is not indented, and
 *     its members are the indented rows right after it.
 *   - Legacy: `table.spec-table--pd`, with `attr-cell--table` /
 *     `value-cell--table` cells, and `child-attr--table` marking an
 *     indented (grouped) row.
 *
 * The McMaster DOM can't be loaded from this sandbox to check exact cell
 * class names on the current markup, so the React-table reader is written
 * defensively: it prefers a cell whose own class hints "name"/"value", and
 * falls back to first-cell/last-cell; it treats a class containing
 * "indent" or "child" -- on the row or either cell -- as the indent
 * signal. If McMaster's markup drifts, this degrades to reading the table
 * positionally rather than failing outright.
 */

// Where the built record is opened. GitHub Pages URL for this repo
// (github.com/Taylor-Nilsen/mcmaster-xref); Pages lowercases the owner in
// the *.github.io hostname.
var PAGES_URL = "https://taylor-nilsen.github.io/mcmaster-xref/";

// ---------------------------------------------------------------------------
// Pure logic: row objects in, McMaster-shaped TableEntries out. No DOM.
// This is what backend/test/bookmarklet.test.js exercises most directly.
// ---------------------------------------------------------------------------

/**
 * @param {{name: string, value: string, indented: boolean}[]} rows
 * @returns {{Name: string, Value: string, IsIndented: boolean, Type: string}[]}
 */
function rowsToTableEntries(rows) {
  var entries = [];
  for (var i = 0; i < rows.length; i++) {
    var row = rows[i] || {};
    var name = String(row.name || "").trim();
    if (!name) continue;
    var rawValue = row.value == null ? "" : String(row.value).trim();
    // Same rule parseProductRecord uses to tell a group header row from a
    // real spec: an empty value on a row that is not itself indented is a
    // header ("Thread", "Head"), not a spec with a blank value.
    var isHeader = rawValue === "" && !row.indented;
    entries.push({
      Name: name,
      Value: isHeader ? "" : rawValue,
      IsIndented: !!row.indented,
      Type: "TableEntrySpec",
    });
  }
  return entries;
}

// ---------------------------------------------------------------------------
// DOM reading. Every function here takes the DOM node(s) it needs as an
// argument (never reaches for the global `document`/`location` itself)
// specifically so the test suite can hand it a small fake DOM instead.
// ---------------------------------------------------------------------------

function textOf(node) {
  if (!node) return "";
  var raw = node.textContent;
  return String(raw == null ? "" : raw).replace(/\s+/g, " ").trim();
}

function classNameOf(el) {
  if (!el) return "";
  if (typeof el.className === "string") return el.className;
  if (el.classList && typeof el.classList.value === "string") return el.classList.value;
  return "";
}

function hasClassLike(el, needle) {
  return classNameOf(el).toLowerCase().indexOf(needle) !== -1;
}

/** Reads one `<tr>` of the current React spec table into a row object. */
function reactRowFromTr(tr) {
  var cells = Array.prototype.slice.call(tr.querySelectorAll("td, th"));
  if (cells.length === 0) return null;
  var nameCell = null;
  var valueCell = null;
  for (var i = 0; i < cells.length; i++) {
    if (!nameCell && hasClassLike(cells[i], "name")) nameCell = cells[i];
    if (hasClassLike(cells[i], "value")) valueCell = cells[i];
  }
  if (!nameCell) nameCell = cells[0];
  if (!valueCell) valueCell = cells[cells.length - 1];

  var indented = hasClassLike(tr, "indent") || hasClassLike(tr, "child");
  for (var j = 0; !indented && j < cells.length; j++) {
    if (hasClassLike(cells[j], "indent") || hasClassLike(cells[j], "child")) indented = true;
  }
  return { name: textOf(nameCell), value: textOf(valueCell), indented: indented };
}

/** Reads one `<tr>` of the legacy `table.spec-table--pd` into a row object. */
function legacyRowFromTr(tr) {
  var nameCell = tr.querySelector(".attr-cell--table");
  var valueCell = tr.querySelector(".value-cell--table");
  if (!nameCell && !valueCell) return null;
  var indented = hasClassLike(tr, "child-attr--table") || hasClassLike(nameCell, "child-attr--table");
  return { name: textOf(nameCell), value: textOf(valueCell), indented: indented };
}

/**
 * Finds the spec table on the page and says which reader to use.
 * @returns {{table: Element, kind: "react"|"legacy"}|null}
 */
function findSpecTable(doc) {
  var tables = Array.prototype.slice.call(doc.querySelectorAll("table"));
  for (var i = 0; i < tables.length; i++) {
    if (hasClassLike(tables[i], "product-detail-spec-table")) return { table: tables[i], kind: "react" };
  }
  var legacy = doc.querySelector("table.spec-table--pd");
  if (legacy) return { table: legacy, kind: "legacy" };
  return null;
}

/** @returns {{name: string, value: string, indented: boolean}[]} */
function extractRows(tableInfo) {
  var trs = Array.prototype.slice.call(tableInfo.table.querySelectorAll("tr"));
  var mapper = tableInfo.kind === "legacy" ? legacyRowFromTr : reactRowFromTr;
  var rows = [];
  for (var i = 0; i < trs.length; i++) {
    var row = mapper(trs[i]);
    if (row && row.name) rows.push(row);
  }
  return rows;
}

// A McMaster part number: digits, then 1-4 letters, then more digits
// ("91251A540", "9528K13", "48605K111"), optionally with a trailing
// letter/digit suffix McMaster sometimes appends.
var PART_NUMBER_RE = /\b([0-9]{2,6}[A-Za-z]{1,4}[0-9]{1,6}[A-Za-z0-9]*)\b/;

function extractPartNumber(doc, loc) {
  var path = String((loc && loc.pathname) || "");
  var segments = path.split("/").filter(Boolean);
  for (var i = segments.length - 1; i >= 0; i--) {
    var m = segments[i].match(PART_NUMBER_RE);
    if (m) return m[1];
  }
  var h1 = doc.querySelector("h1");
  var h1Text = textOf(h1);
  var m2 = h1Text.match(PART_NUMBER_RE);
  if (m2) return m2[1];
  return "";
}

function extractTitle(doc) {
  var h1 = doc.querySelector("h1");
  var h1Text = textOf(h1);
  if (h1Text) return h1Text;
  var h3 = doc.querySelector("h3");
  return textOf(h3);
}

// A few reasonable, independent guesses at the breadcrumb container --
// unverifiable from this sandbox, so several are tried and the results
// merged (deduped) rather than betting on one exact class name.
var BREADCRUMB_SELECTORS = [
  "nav[aria-label='breadcrumb'] a",
  "nav.breadcrumb a",
  ".breadcrumb a",
  ".breadcrumbs a",
];

function extractBreadcrumbs(doc) {
  var names = [];
  var seen = {};
  for (var i = 0; i < BREADCRUMB_SELECTORS.length; i++) {
    var nodes;
    try {
      nodes = doc.querySelectorAll(BREADCRUMB_SELECTORS[i]);
    } catch (e) {
      continue;
    }
    var list = Array.prototype.slice.call(nodes || []);
    for (var j = 0; j < list.length; j++) {
      var name = textOf(list[j]);
      if (name && !seen[name]) {
        seen[name] = true;
        names.push(name);
      }
    }
    if (names.length) break;
  }
  return names;
}

/**
 * Builds the parseProductRecord-shaped record from a live McMaster product
 * page, or an `{error}` with a one-line, user-facing reason when the spec
 * table can't be found.
 */
function buildRecord(doc, loc) {
  var tableInfo = findSpecTable(doc);
  if (!tableInfo) {
    return { error: "Could not find the spec table on this page. Make sure you're on a McMaster part page (not a category or search page)." };
  }
  var rows = extractRows(tableInfo);
  if (!rows.length) {
    return { error: "Found the spec table, but it had no readable rows." };
  }

  var entries = rowsToTableEntries(rows);
  var partNumber = extractPartNumber(doc, loc);
  var title = extractTitle(doc);
  var breadcrumbs = extractBreadcrumbs(doc);
  // McMaster's own record gives ProductFamily explicitly; the rendered page
  // doesn't expose it directly, so the last breadcrumb before the part
  // itself (the most specific category name) stands in for it -- the same
  // fallback classifyProduct/baseNoun already leans on when family is
  // missing.
  var family = breadcrumbs.length ? breadcrumbs[breadcrumbs.length - 1] : null;

  return {
    record: {
      PartNbrTxt: partNumber,
      TitleTxt: title,
      TargetPageMetadata: { ProductFamily: family },
      ReactData: {
        Breadcrumbs: breadcrumbs.map(function (name) {
          return { Name: name };
        }),
        TableEntries: entries,
      },
    },
  };
}

// ---------------------------------------------------------------------------
// Fragment encoding: base64url of the JSON, compressed with
// CompressionStream when the browser has it, plain otherwise. The fragment
// says which: `#r=dr.<data>` (deflate-raw) or `#r=raw.<data>` (uncompressed).
// ---------------------------------------------------------------------------

function toBase64Url(bytes) {
  var binary = "";
  for (var i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** @returns {Promise<string>} e.g. "dr.AbCd..." or "raw.AbCd..." */
function encodeRecord(record) {
  var json = JSON.stringify(record);
  var bytes = new TextEncoder().encode(json);

  if (typeof CompressionStream === "function") {
    return (function () {
      try {
        var cs = new CompressionStream("deflate-raw");
        var writer = cs.writable.getWriter();
        writer.write(bytes);
        writer.close();
        return new Response(cs.readable)
          .arrayBuffer()
          .then(function (buf) {
            return "dr." + toBase64Url(new Uint8Array(buf));
          })
          .catch(function () {
            return "raw." + toBase64Url(bytes);
          });
      } catch (e) {
        return Promise.resolve("raw." + toBase64Url(bytes));
      }
    })();
  }
  return Promise.resolve("raw." + toBase64Url(bytes));
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

/**
 * @param {Document} doc
 * @param {{pathname: string}} loc
 * @param {{alert: Function, open: Function}} [io] Overridable for testing.
 */
function run(doc, loc, io) {
  var alertFn = (io && io.alert) || (typeof alert === "function" ? alert : function () {});
  var openFn = (io && io.open) || (typeof window !== "undefined" && window.open ? window.open.bind(window) : null);

  var built = buildRecord(doc, loc);
  if (built.error) {
    alertFn("McMaster → Xref: " + built.error);
    return Promise.resolve();
  }
  return encodeRecord(built.record).then(function (encoded) {
    var url = PAGES_URL + "#r=" + encoded;
    if (openFn) openFn(url, "_blank");
  });
}

if (typeof module !== "undefined" && module.exports) {
  // Node (backend/test/bookmarklet.test.js): export the testable surface,
  // do not touch document/location/alert/window, which don't exist here.
  module.exports = {
    PAGES_URL: PAGES_URL,
    rowsToTableEntries: rowsToTableEntries,
    reactRowFromTr: reactRowFromTr,
    legacyRowFromTr: legacyRowFromTr,
    findSpecTable: findSpecTable,
    extractRows: extractRows,
    extractPartNumber: extractPartNumber,
    extractTitle: extractTitle,
    extractBreadcrumbs: extractBreadcrumbs,
    buildRecord: buildRecord,
    toBase64Url: toBase64Url,
    encodeRecord: encodeRecord,
    run: run,
  };
} else {
  // Real bookmarklet context: no `module`, so just go.
  run(document, location);
}
