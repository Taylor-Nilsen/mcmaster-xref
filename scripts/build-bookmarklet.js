#!/usr/bin/env node
/**
 * Builds frontend/bookmarklet.js into a `javascript:` URL and writes it as
 * the href of the draggable "McMaster -> Xref" link in frontend/index.html.
 *
 * There is exactly one source of the bookmarklet's logic
 * (frontend/bookmarklet.js, readable, tested directly by
 * backend/test/bookmarklet.test.js); this just wraps that file's own text
 * verbatim -- no separate minifier, no hand-copied duplicate. The wrapper
 * IIFE plus trailing `void 0` keeps a `javascript:` URL from replacing the
 * McMaster page with whatever value the script happens to evaluate to,
 * which is standard bookmarklet practice.
 *
 * Run via `scripts/sync-frontend.sh`, or directly with `node
 * scripts/build-bookmarklet.js`. Idempotent: re-running it just replaces
 * the same href.
 */
"use strict";

const fs = require("fs");
const path = require("path");

const root = path.join(__dirname, "..");
const srcPath = path.join(root, "frontend", "bookmarklet.js");
const htmlPath = path.join(root, "frontend", "index.html");

const src = fs.readFileSync(srcPath, "utf8");
const wrapped = "(function(){\n" + src + "\n})();void 0;";
// encodeURIComponent percent-encodes every character an HTML attribute
// would otherwise need escaped (&, ", <, >, space, newlines, ...), so the
// result is already safe to drop straight into href="...".
const href = "javascript:" + encodeURIComponent(wrapped);

let html = fs.readFileSync(htmlPath, "utf8");
// There are two draggable install links in the page (the always-visible
// install panel, and the one repeated inside the failed-lookup fallback
// panel) -- both carry class="bookmarklet-link" and both get the same href.
const hrefAttrRe = /(<a\s+class="bookmarklet-link"[^>]*\shref=")[^"]*(")/g;
if (!hrefAttrRe.test(html)) {
  throw new Error(
    'build-bookmarklet: could not find <a class="bookmarklet-link" ... href="..."> in frontend/index.html'
  );
}
const updated = html.replace(hrefAttrRe, (_m, pre, post) => pre + href + post);

if (updated === html) {
  console.log(`bookmarklet href already up to date (${href.length} chars)`);
} else {
  fs.writeFileSync(htmlPath, updated);
  console.log(`embedded bookmarklet into frontend/index.html (source ${src.length} chars, href ${href.length} chars)`);
}
