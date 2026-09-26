#!/usr/bin/env node
/**
 * check-supplier-links.js
 *
 * Drives a real headless Chromium (from /opt/pw-browsers/chromium, through
 * the sandbox's HTTPS_PROXY) against the supplier search links
 * lib/product.js's buildSupplierLinks() produces, to establish -- per
 * supplier -- whether the search page actually renders results for a
 * browser from this sandbox, as opposed to the plain-fetch bot walls
 * already measured.
 *
 * For each job it: opens the URL in a persistent per-supplier context,
 * waits for network idle (or 20s), saves a screenshot and the page's
 * rendered text to backend/test/fixtures/suppliers/<supplier>-<part>.png
 * and .txt, and records the outcome signals (http status, final URL,
 * title, a text snippet, and a best-effort bot-wall phrase match) to a
 * JSON results file. It does NOT itself decide RESULTS vs NO_RESULTS vs
 * BOT_WALL -- classification and drop-in/close/miss judging happens by
 * reading the saved text/screenshots (done by the calling agent), because
 * the site-specific "did this actually match" question needs real
 * reasoning, not a regex.
 *
 * Jobs are grouped by supplier and run through ONE BrowserContext per
 * supplier (cookies/session persist across that supplier's own requests,
 * like a real visitor clicking through searches -- not a fresh incognito
 * browser per request), with a random 10-20s gap between requests to the
 * SAME supplier. Different suppliers run concurrently (bounded pool) since
 * they're different domains and have no shared rate limit.
 *
 * Usage:
 *   node backend/scripts/check-supplier-links.js <jobs.json> <out-dir> <results.json>
 *
 * jobs.json: [{ supplier, testCaseId, url, note? }, ...]
 * out-dir:   directory for .png/.txt evidence (backend/test/fixtures/suppliers)
 * results.json: where the outcome log is written (also printed to stdout)
 */
const fs = require("fs");
const path = require("path");
const { chromium } = require("playwright");

const CHROMIUM_PATH = "/opt/pw-browsers/chromium";
const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36";

const BOT_WALL_PHRASES = [
  "pardon our interruption",
  "access denied",
  "are you a human",
  "are you a robot",
  "verify you are a human",
  "just a moment",
  "attention required",
  "checking your browser",
  "request blocked",
  "unusual traffic",
  "captcha",
  "whoops, we couldn't find that",
  "forbidden",
  "429 too many requests",
  "service unavailable",
];

const NO_RESULTS_PHRASES = [
  "no results found",
  "0 results",
  "did not match any products",
  "no matches found",
  "we couldn't find any",
  "no products found",
  "no search results",
];

function sanitize(s) {
  return String(s).replace(/[^a-z0-9._-]+/gi, "-").replace(/-{2,}/g, "-").slice(0, 120);
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function jitter(minMs, maxMs) {
  return minMs + Math.random() * (maxMs - minMs);
}

async function runJob(context, job, outDir) {
  const page = await context.newPage();
  const base = `${sanitize(job.supplier)}-${sanitize(job.testCaseId)}`;
  const result = {
    supplier: job.supplier,
    testCaseId: job.testCaseId,
    url: job.url,
    note: job.note || null,
    startedAt: new Date().toISOString(),
  };
  try {
    let httpStatus = null;
    page.on("response", (resp) => {
      if (resp.url() === job.url || httpStatus === null) {
        if (resp.frame() === page.mainFrame()) httpStatus = resp.status();
      }
    });
    let navError = null;
    try {
      await page.goto(job.url, { waitUntil: "networkidle", timeout: 20000 });
    } catch (e) {
      navError = e.message;
      // networkidle often never fires on sites with polling/analytics --
      // fall back to whatever DOM-loaded state we got, page may still be
      // usable.
      try {
        await page.waitForLoadState("domcontentloaded", { timeout: 5000 });
      } catch (e2) {
        /* ignore, we'll capture whatever is there */
      }
    }
    // Let client-side rendering settle a bit more either way.
    await page.waitForTimeout(2500);

    result.finalUrl = page.url();
    result.httpStatus = httpStatus;
    result.navError = navError;
    let title = null;
    try {
      title = await page.title();
    } catch (e) {}
    result.title = title;

    let text = "";
    try {
      text = await page.evaluate(() => document.body ? document.body.innerText : "");
    } catch (e) {
      text = `<failed to extract text: ${e.message}>`;
    }
    result.textLength = text.length;
    result.textSnippet = text.slice(0, 1500);

    const lowerText = text.toLowerCase();
    const lowerTitle = (title || "").toLowerCase();
    result.botWallPhraseHit = BOT_WALL_PHRASES.find(
      (p) => lowerText.includes(p) || lowerTitle.includes(p)
    ) || null;
    result.noResultsPhraseHit = NO_RESULTS_PHRASES.find((p) => lowerText.includes(p)) || null;

    const textFile = path.join(outDir, `${base}.txt`);
    fs.writeFileSync(textFile, text, "utf8");
    result.textFile = textFile;

    const pngFile = path.join(outDir, `${base}.png`);
    try {
      await page.screenshot({ path: pngFile, fullPage: false });
      result.screenshotFile = pngFile;
    } catch (e) {
      result.screenshotError = e.message;
    }

    // Best-effort generic extraction of candidate product links (href +
    // visible text), for the caller to sift through -- not authoritative.
    try {
      result.candidateLinks = await page.evaluate(() => {
        const anchors = Array.from(document.querySelectorAll("a[href]"));
        const seen = new Set();
        const out = [];
        for (const a of anchors) {
          const t = (a.innerText || "").trim().replace(/\s+/g, " ");
          if (t.length < 8 || t.length > 200) continue;
          const href = a.href;
          if (!href || seen.has(href)) continue;
          seen.add(href);
          out.push({ text: t, href });
          if (out.length >= 40) break;
        }
        return out;
      });
    } catch (e) {
      result.candidateLinks = [];
    }
  } catch (e) {
    result.error = e.message;
  } finally {
    await page.close().catch(() => {});
  }
  result.finishedAt = new Date().toISOString();
  return result;
}

async function runSupplierQueue(browser, supplier, jobs, outDir, resultsAccumulator) {
  const context = await browser.newContext({
    ignoreHTTPSErrors: true,
    userAgent: UA,
    viewport: { width: 1280, height: 900 },
    locale: "en-US",
  });
  try {
    for (let i = 0; i < jobs.length; i++) {
      const job = jobs[i];
      process.stderr.write(`[${supplier}] job ${i + 1}/${jobs.length}: ${job.testCaseId} -> ${job.url}\n`);
      const result = await runJob(context, job, outDir);
      resultsAccumulator.push(result);
      process.stderr.write(
        `[${supplier}] done ${job.testCaseId}: status=${result.httpStatus} botWall=${result.botWallPhraseHit} noResults=${result.noResultsPhraseHit} textLen=${result.textLength}\n`
      );
      if (i < jobs.length - 1) {
        const wait = jitter(10000, 20000);
        await sleep(wait);
      }
    }
  } finally {
    await context.close().catch(() => {});
  }
}

async function main() {
  const [jobsPath, outDir, resultsPath] = process.argv.slice(2);
  if (!jobsPath || !outDir || !resultsPath) {
    console.error("usage: check-supplier-links.js <jobs.json> <out-dir> <results.json>");
    process.exit(1);
  }
  fs.mkdirSync(outDir, { recursive: true });
  const jobs = JSON.parse(fs.readFileSync(jobsPath, "utf8"));

  const bySupplier = new Map();
  for (const job of jobs) {
    if (!bySupplier.has(job.supplier)) bySupplier.set(job.supplier, []);
    bySupplier.get(job.supplier).push(job);
  }

  const browser = await chromium.launch({
    executablePath: CHROMIUM_PATH,
    headless: true,
    proxy: process.env.HTTPS_PROXY ? { server: process.env.HTTPS_PROXY } : undefined,
    args: [
      "--ignore-certificate-errors",
      "--disable-http2",
      "--disable-quic",
      "--disable-blink-features=AutomationControlled",
    ],
  });

  const results = [];
  const CONCURRENCY = 4;
  const supplierEntries = Array.from(bySupplier.entries());
  let idx = 0;
  async function worker() {
    while (idx < supplierEntries.length) {
      const myIdx = idx++;
      const [supplier, supplierJobs] = supplierEntries[myIdx];
      await runSupplierQueue(browser, supplier, supplierJobs, outDir, results);
    }
  }
  const workers = Array.from({ length: Math.min(CONCURRENCY, supplierEntries.length) }, () => worker());
  await Promise.all(workers);

  await browser.close();

  fs.writeFileSync(resultsPath, JSON.stringify(results, null, 2), "utf8");
  console.log(`wrote ${results.length} results to ${resultsPath}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
