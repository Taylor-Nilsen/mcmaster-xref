#!/usr/bin/env node
/**
 * Diagnostic probe for the McMaster ItmPrsnttnWebPart XHR.
 *
 * Usage:
 *   node backend/scripts/probe-mcmaster.js PART1 PART2 ...
 *
 * Env vars (all optional, used to run the Task 1 experiments):
 *   MODE=shared|freshcontext|freshbrowser   (default shared)
 *     shared       - one browser, one context, reused for every part
 *     freshcontext - one browser, new context (new cookies) per part
 *     freshbrowser - new browser process per part
 *   SPACING_MS=5000        delay between parts (default 5000)
 *   WAIT_UNTIL=domcontentloaded|load   goto waitUntil (default domcontentloaded)
 *   POST_WAIT_MS=25000     how long to wait after nav for the XHR to show up
 *   URL_FORM=slash|products   https://www.mcmaster.com/PART/ vs .../products/PART/
 *
 * For every part this prints one JSON line to stdout with:
 *   part, navStatus, navMs, xhrs:[{path,status,bodyLen}], requestFailed:[...],
 *   itmPrsnttnArrived, itmPrsnttnParsed, title, walled, shellTextLen
 */

const path = require("path");
const { chromium } = require(path.join(__dirname, "..", "node_modules", "playwright"));
const { parseFragment, browserLaunchOptions } = require("../lib/mcmaster");

const parts = process.argv.slice(2);
if (parts.length === 0) {
  console.error("usage: node probe-mcmaster.js PART1 PART2 ...");
  process.exit(1);
}

const MODE = process.env.MODE || "shared";
const SPACING_MS = Number(process.env.SPACING_MS || 5000);
const WAIT_UNTIL = process.env.WAIT_UNTIL || "domcontentloaded";
const POST_WAIT_MS = Number(process.env.POST_WAIT_MS || 25000);
const URL_FORM = process.env.URL_FORM || "slash";

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36";

const launchOptions = browserLaunchOptions;

function urlFor(part) {
  return URL_FORM === "products"
    ? `https://www.mcmaster.com/products/${part}/`
    : `https://www.mcmaster.com/${part}/`;
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function probeOne(page, part) {
  const xhrs = [];
  const requestFailed = [];
  const consoleMsgs = [];
  let itmBody = null;

  const onResponse = async (resp) => {
    const u = resp.url();
    if (!/mcmaster\.com/.test(u)) return;
    let bodyLen = null;
    let text = null;
    try {
      text = await resp.text();
      bodyLen = text.length;
    } catch {
      bodyLen = -1;
    }
    const pathOnly = u.replace(/^https?:\/\/[^/]+/, "").split("?")[0];
    xhrs.push({ path: pathOnly, status: resp.status(), bodyLen });
    if (/ItmPrsnttnWebPart/i.test(u) && text) {
      itmBody = text;
    }
  };
  const onReqFailed = (req) => {
    const u = req.url();
    if (!/mcmaster\.com/.test(u)) return;
    if (/trk\/|204\.asp|socket\.io/.test(u)) return;
    const f = req.failure();
    requestFailed.push({ url: u.slice(0, 140), error: f && f.errorText });
  };
  const onConsole = (msg) => {
    try {
      const t = msg.text();
      if (/error|fail|denied|blocked/i.test(t)) consoleMsgs.push(t.slice(0, 200));
    } catch {}
  };

  page.on("response", onResponse);
  page.on("requestfailed", onReqFailed);
  page.on("console", onConsole);

  const t0 = Date.now();
  let navStatus = null;
  let navErr = null;
  try {
    const resp = await page.goto(urlFor(part), { waitUntil: WAIT_UNTIL, timeout: 60000 });
    navStatus = resp ? resp.status() : null;
  } catch (e) {
    navErr = e.message.split("\n")[0];
  }
  const navMs = Date.now() - t0;

  // Wait for either the login wall text, a spec table, or the XHR itself,
  // up to POST_WAIT_MS.
  await page
    .waitForFunction(
      () => {
        const t = document.body.innerText || "";
        return (
          /please log in/i.test(t) ||
          document.querySelector(".spec-table--pd, table[class*='spec']") ||
          document.querySelector(".ItmPrsnttnWebPart")
        );
      },
      null,
      { timeout: POST_WAIT_MS },
    )
    .catch(() => {});

  const shellInfo = await page
    .evaluate(() => {
      const t = document.body.innerText || "";
      return {
        walled: /please log in/i.test(t),
        shellTextLen: t.length,
        title: document.title,
      };
    })
    .catch(() => ({ walled: null, shellTextLen: null, title: null }));

  page.off("response", onResponse);
  page.off("requestfailed", onReqFailed);
  page.off("console", onConsole);

  let itmPrsnttnParsed = false;
  let parsedTitle = null;
  let parseErr = null;
  if (itmBody) {
    try {
      const json = parseFragment(itmBody);
      itmPrsnttnParsed = !!(json && json.TitleTxt);
      parsedTitle = json && json.TitleTxt;
    } catch (e) {
      parseErr = e.message;
    }
  }

  return {
    part,
    mode: MODE,
    waitUntil: WAIT_UNTIL,
    urlForm: URL_FORM,
    navStatus,
    navErr,
    navMs,
    totalMs: Date.now() - t0,
    xhrs,
    requestFailed,
    consoleMsgs,
    itmPrsnttnArrived: !!itmBody,
    itmPrsnttnBodyLen: itmBody ? itmBody.length : null,
    itmPrsnttnParsed,
    parsedTitle,
    parseErr,
    shellWalled: shellInfo.walled,
    shellTextLen: shellInfo.shellTextLen,
    pageTitle: shellInfo.title,
  };
}

(async () => {
  let browser = null;
  let ctx = null;
  let page = null;

  if (MODE !== "freshbrowser") {
    browser = await chromium.launch(launchOptions());
  }
  if (MODE === "shared") {
    ctx = await browser.newContext({ userAgent: UA, viewport: { width: 1280, height: 900 }, locale: "en-US", ignoreHTTPSErrors: true });
    page = await ctx.newPage();
  }

  for (let i = 0; i < parts.length; i++) {
    const part = parts[i];
    let localBrowser = null;
    try {
      if (MODE === "freshbrowser") {
        localBrowser = await chromium.launch(launchOptions());
        ctx = await localBrowser.newContext({ userAgent: UA, viewport: { width: 1280, height: 900 }, locale: "en-US", ignoreHTTPSErrors: true });
        page = await ctx.newPage();
      } else if (MODE === "freshcontext") {
        ctx = await browser.newContext({ userAgent: UA, viewport: { width: 1280, height: 900 }, locale: "en-US", ignoreHTTPSErrors: true });
        page = await ctx.newPage();
      }

      const result = await probeOne(page, part);
      console.log(JSON.stringify(result));
    } catch (e) {
      console.log(JSON.stringify({ part, mode: MODE, error: e.message }));
    } finally {
      if (MODE === "freshcontext" && ctx) {
        await ctx.close().catch(() => {});
      }
      if (MODE === "freshbrowser" && localBrowser) {
        await localBrowser.close().catch(() => {});
      }
    }

    if (i < parts.length - 1) {
      await sleep(SPACING_MS);
    }
  }

  if (MODE === "shared" && ctx) await ctx.close().catch(() => {});
  if (browser) await browser.close().catch(() => {});
})();
