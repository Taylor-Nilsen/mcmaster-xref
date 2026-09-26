/**
 * Live-DOM validation for frontend/bookmarklet.js -- runs the real
 * bookmarklet source, unmodified, inside a real Chromium page loaded from
 * a saved McMaster product-page fixture (a full `outerHTML` capture, not a
 * hand-rolled fake DOM), and checks its output against McMaster's own
 * captured ItmPrsnttnWebPart JSON for the same page.
 *
 * The DOM fixture (backend/test/fixtures/mcmaster/91251A540.dom.html) and
 * the JSON fixture (backend/test/fixtures/mcmaster/91251A540.itmprsnttn.json)
 * were both captured from https://www.mcmaster.com/91251A540/ in a real
 * browser on 25 Sep 2026 -- see frontend/bookmarklet.js's header comment
 * for what that run found. bookmarklet.test.js's hand-rolled fake DOM only
 * supports the small subset of CSS selectors bookmarklet.js itself uses
 * against simple synthetic markup; the real page is ~180KB of nested React
 * output, well beyond what that fake DOM's selector engine parses, so this
 * file drives an actual browser against the actual saved markup instead.
 *
 * Skipped unless RUN_BROWSER_TESTS=1 (Chromium + a real page load is slow
 * and not what a normal `npm test` run should pay for); run it explicitly
 * with:
 *   RUN_BROWSER_TESTS=1 node --test test/bookmarklet.live.test.js
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const zlib = require("zlib");

const RUN = process.env.RUN_BROWSER_TESTS === "1";

const { parseProductRecord } = require("../lib/product");

const DOM_FIXTURE = path.join(__dirname, "fixtures", "mcmaster", "91251A540.dom.html");
const JSON_FIXTURE = path.join(__dirname, "fixtures", "mcmaster", "91251A540.itmprsnttn.json");
const BOOKMARKLET_SRC = fs.readFileSync(path.join(__dirname, "..", "..", "frontend", "bookmarklet.js"), "utf8");

function fromBase64Url(str) {
  const b64 = str.replace(/-/g, "+").replace(/_/g, "/");
  const pad = b64.length % 4 === 0 ? "" : "=".repeat(4 - (b64.length % 4));
  return Buffer.from(b64 + pad, "base64");
}

function decodeFragment(url) {
  const frag = url.split("#r=")[1];
  const dot = frag.indexOf(".");
  const method = dot === -1 ? "raw" : frag.slice(0, dot);
  const data = dot === -1 ? frag : frag.slice(dot + 1);
  let bytes = fromBase64Url(data);
  if (method === "dr") bytes = zlib.inflateRawSync(bytes);
  return JSON.parse(bytes.toString("utf8"));
}

function stripTagsDecodeEntities(value) {
  return String(value == null ? "" : value)
    .replace(/<[^>]*>/g, "")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&deg;/g, "°")
    .replace(/\s+/g, " ")
    .trim();
}

test(
  "bookmarklet, run against a real captured McMaster DOM, matches McMaster's own JSON record",
  { skip: !RUN && "set RUN_BROWSER_TESTS=1 to run this (launches Chromium against the saved DOM fixture)" },
  async () => {
    const { chromium } = require("playwright");
    const { browserLaunchOptions } = require("../lib/mcmaster");

    const browser = await chromium.launch(browserLaunchOptions());
    let bookmarkletResult;
    try {
      const page = await browser.newPage();
      await page.goto("file://" + DOM_FIXTURE, { waitUntil: "domcontentloaded" });
      bookmarkletResult = await page.evaluate(async (src) => {
        window.__openedUrl = null;
        window.__alerted = null;
        window.open = (u) => {
          window.__openedUrl = u;
          return null;
        };
        window.alert = (m) => {
          window.__alerted = m;
        };
        // eslint-disable-next-line no-eval
        eval(src);
        await new Promise((r) => setTimeout(r, 500));
        return { openedUrl: window.__openedUrl, alerted: window.__alerted };
      }, BOOKMARKLET_SRC);
    } finally {
      await browser.close();
    }

    assert.equal(bookmarkletResult.alerted, null, "bookmarklet should not have alerted an error");
    assert.ok(bookmarkletResult.openedUrl, "bookmarklet should have opened a URL");

    const bookmarkletRecord = decodeFragment(bookmarkletResult.openedUrl);
    const bookmarkletProduct = parseProductRecord(bookmarkletRecord);
    const jsonProduct = parseProductRecord(fs.readFileSync(JSON_FIXTURE, "utf8"));

    assert.equal(bookmarkletProduct.partNumber, jsonProduct.partNumber);
    assert.equal(bookmarkletProduct.partNumber, "91251A540");

    assert.equal(bookmarkletProduct.title, jsonProduct.title);

    assert.deepEqual(bookmarkletProduct.categoryPath, jsonProduct.categoryPath);

    const clean = (attrs) =>
      attrs.map((a) => ({ group: a.group, name: a.name, value: stripTagsDecodeEntities(a.value) }));
    const bookmarkletAttrs = clean(bookmarkletProduct.attributes);
    const jsonAttrs = clean(jsonProduct.attributes);
    assert.equal(bookmarkletAttrs.length, jsonAttrs.length);
    assert.equal(jsonAttrs.length, 30);
    assert.deepEqual(bookmarkletAttrs, jsonAttrs);
  },
);
