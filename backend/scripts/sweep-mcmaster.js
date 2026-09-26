#!/usr/bin/env node
/**
 * Long-running, paced sweep of real McMaster-Carr part numbers.
 *
 * Captures the ItmPrsnttnWebPart JSON record for each part in PART_LIST (or
 * for the part numbers given on argv, one per arg) and saves it under
 * backend/test/fixtures/mcmaster/sweep/. Appends one JSON line per
 * navigation attempt to sweep.log in that same directory.
 *
 * Why this looks nothing like lib/mcmaster.js's attemptFetch (fresh context
 * per call): that strategy was measured, in an earlier session against this
 * same site, to collapse after 3-5 navigations at 8s spacing -- a fresh
 * cookie jar per part did NOT help. What did work was behaving like a
 * single person idly browsing: one persistent browser + context + page for
 * the entire run, at least 90s between navigations, with an escalating
 * backoff (5m / 10m / 20m) on any sign of a block, and a hard stop after
 * three consecutive failures at the 20-minute tier. See REPORT.md for the
 * outcome of this run.
 *
 * Usage:
 *   node backend/scripts/sweep-mcmaster.js [PART1 PART2 ...]
 *
 * With no args, sweeps the built-in PART_LIST below (curated from
 * backend/test/categories.json and real, independently-verified public
 * BOMs -- see REPORT.md's "Part number provenance" section -- rather than
 * guessed, per the run's instructions not to spend a navigation on a wild
 * guess).
 */

"use strict";

const fs = require("fs");
const path = require("path");
const { chromium } = require(path.join(__dirname, "..", "node_modules", "playwright"));
const { parseFragment, browserLaunchOptions } = require("../lib/mcmaster");

const OUT_DIR = path.join(__dirname, "..", "test", "fixtures", "mcmaster", "sweep");
const LOG_PATH = path.join(OUT_DIR, "sweep.log");

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36";

const MIN_SPACING_MS = 90 * 1000;
const BACKOFF_MIN = [5, 10, 20]; // minutes, by consecutive-failure tier (capped at the last entry)
const MAX_CONSECUTIVE_FAILURES = 5; // 5m,10m,20m,20m,20m -> 3 failures at the 20m tier -> stop
const HARD_NAV_CAP = 80;
const XHR_WAIT_MS = 30 * 1000;

const LOGIN_WALL_RE = /to continue browsing,?\s*please log in/i;
const NOT_FOUND_RE = /we couldn't find|no results for|page not found|we don't carry that item/i;
const ITM_PRSNTTN_RE = /ItmPrsnttnWebPart/i;

// ---------------------------------------------------------------------------
// Part list: curated, not guessed. Each entry's `part` comes from either
// backend/test/categories.json (already a real, independently-reviewed
// McMaster part per REPORT.md's provenance section) or a real public BOM
// citing that exact mcmaster.com part number (source noted in `src`).
// Ordered per the run's priority: fasteners, nuts, washers, raw stock,
// bearings, seals, motors/solenoids/PPE, then everything else.
// ---------------------------------------------------------------------------
const PART_LIST = [
  // Fasteners
  { part: "92620A624", label: "Hex head cap screw", src: "categories.json" },
  { part: "91771A831", label: "Flat head screw (Phillips)", src: "categories.json" },
  { part: "92949A150", label: "Button head socket cap screw", src: "categories.json" },
  { part: "91375A194", label: "Set screw", src: "categories.json" },
  { part: "90272A110", label: "Pan head machine screw (Phillips)", src: "categories.json" },
  { part: "90286A118", label: "Sheet metal screw", src: "categories.json" },
  { part: "90298A537", label: "Shoulder screw", src: "categories.json" },
  { part: "98861A030", label: "Threaded rod", src: "categories.json" },
  { part: "91290A115", label: "Socket head cap screw (metric)", src: "categories.json" },
  { part: "97049A101", label: "Dowel pin (2mm, ISO 2338-H8 undersized)", src: "lumenpnp/bom.csv" },
  // Nuts
  { part: "90631A011", label: "Nylon-insert lock nut", src: "categories.json" },
  { part: "94300A140", label: "Wing nut", src: "categories.json" },
  { part: "94000A330", label: "Acorn / cap nut", src: "lumenpnp/bom.csv" },
  { part: "96887A331", label: "Square nut", src: "lumenpnp/bom.csv" },
  // Washers
  { part: "90107A029", label: "Flat washer", src: "categories.json" },
  { part: "92146A029", label: "Lock washer", src: "categories.json" },
  { part: "91100A160", label: "Fender washer", src: "reprap.org wiki" },
  // Raw stock
  { part: "8974K21", label: "Aluminum round bar", src: "categories.json" },
  { part: "8983K115", label: "Stainless sheet", src: "categories.json" },
  { part: "9220K11", label: "Steel tube", src: "categories.json" },
  { part: "98870A150", label: "Keystock", src: "categories.json" },
  { part: "8546K42", label: "PTFE rod (10mm OD x 3mm bore)", src: "reprap.org wiki" },
  { part: "9299K12", label: "Brass shim stock roll", src: "tabletop MRI parts list PDF" },
  // Bearings / power transmission
  { part: "60355K505", label: "Ball bearing", src: "categories.json" },
  { part: "2938T3", label: "Flanged sleeve bearing (SAE 863 bronze)", src: "Hapkit parts list PDF" },
  { part: "9414T6", label: "Shaft collar (set screw)", src: "Hapkit parts list PDF" },
  // Sealing
  { part: "9452K113", label: "O-ring", src: "categories.json" },
  { part: "8516K61", label: "Gasket sheet", src: "categories.json" },
  // Springs
  { part: "9657K277", label: "Compression spring", src: "categories.json" },
  // Motors (user priority)
  { part: "6409K18", label: "DC gearmotor, 12V 50 RPM", src: "Instructables PCB drill project" },
  { part: "6535K292", label: "DC gearmotor, 24V", src: "Instructables WHIM wheelchair project" },
  // PPE (user priority)
  { part: "52555T73", label: "Disposable nitrile glove, L, 8 mil, powdered", src: "shop.boeing.com cross-reference" },
  // Everything else with a confirmed real number
  { part: "4591K11", label: "PTFE thread-seal tape", src: "reprap.org wiki" },
  { part: "2278N13", label: "Precision machine oil", src: "lumenpnp/bom.csv" },
  { part: "2958A61", label: "Drill bit", src: "reprap.org wiki" },
  { part: "7122A18", label: "Hex key (1/8\")", src: "Hapkit parts list PDF" },
  { part: "7026A16", label: "Miniature screwdriver", src: "Hapkit parts list PDF" },
  { part: "57295K73", label: "Alnico disc magnet", src: "Hapkit parts list PDF" },
  { part: "8930T16", label: "Nylon-coated stainless wire rope", src: "Hapkit parts list PDF" },
  { part: "51075K27", label: "Neoprene tubing", src: "Hapkit parts list PDF" },
  { part: "7527K51", label: "Terminal block, 10-position", src: "tabletop MRI parts list PDF" },
  { part: "69145K73", label: "Terminal lug (spade), blue", src: "tabletop MRI parts list PDF" },
  { part: "7610A17", label: "3M spray adhesive #76", src: "tabletop MRI parts list PDF" },
  { part: "92745A346", label: "Hex standoff, 6-32 x 1\", M-F", src: "tabletop MRI parts list PDF" },
  { part: "94510A030", label: "M3 press-fit threaded insert", src: "VORON-RGB BOM" },
  { part: "5012K83", label: "Quick-disconnect coupling, female socket", src: "ScubaBoard forum post" },
  { part: "5012K72", label: "Quick-disconnect coupling, male plug", src: "ScubaBoard forum post" },
];

function argParts() {
  const args = process.argv.slice(2);
  if (args.length === 0) return PART_LIST;
  return args.map((p) => ({ part: p, label: p, src: "argv" }));
}

function nowIso() {
  return new Date().toISOString();
}

function appendLog(obj) {
  fs.appendFileSync(LOG_PATH, JSON.stringify({ ts: nowIso(), ...obj }) + "\n");
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function urlFor(part) {
  return `https://www.mcmaster.com/${encodeURIComponent(part)}/`;
}

/** One navigation attempt against the persistent page. Returns an outcome descriptor. */
async function attemptOne(page, part) {
  let itmBody = null;
  let itmStatus = null;
  const onResponse = async (resp) => {
    if (itmBody) return;
    const u = resp.url();
    if (!ITM_PRSNTTN_RE.test(u)) return;
    itmStatus = resp.status();
    try {
      const text = await resp.text();
      if (text) itmBody = text;
    } catch {
      /* aborted/redirected response body - ignore */
    }
  };
  page.on("response", onResponse);

  let navStatus = null;
  let navError = null;
  const t0 = Date.now();
  try {
    const resp = await page.goto(urlFor(part), { waitUntil: "domcontentloaded", timeout: 60000 });
    navStatus = resp ? resp.status() : null;
  } catch (e) {
    navError = e.message.split("\n")[0];
  }

  // Give the XHR (or the login-wall / not-found shell text) time to show up.
  await page
    .waitForFunction(
      () => {
        const t = document.body.innerText || "";
        return (
          /to continue browsing,?\s*please log in/i.test(t) ||
          /we couldn't find|no results for|page not found/i.test(t) ||
          document.querySelector(".spec-table--pd, table[class*='spec']") ||
          document.querySelector(".ItmPrsnttnWebPart")
        );
      },
      null,
      { timeout: XHR_WAIT_MS },
    )
    .catch(() => {});

  if (!itmBody) {
    // brief grace period for an in-flight XHR
    await page.waitForTimeout(2000);
  }

  const shellText = await page.evaluate(() => document.body.innerText || "").catch(() => "");
  page.off("response", onResponse);

  const navMs = Date.now() - t0;

  if (itmBody) {
    return { outcome: "captured", itmBody, itmStatus, navStatus, navMs };
  }
  if (itmStatus === 403) {
    return { outcome: "blocked", reason: "xhr_403", navStatus, navMs };
  }
  if (LOGIN_WALL_RE.test(shellText)) {
    return { outcome: "blocked", reason: "login_wall", navStatus, navMs };
  }
  if (NOT_FOUND_RE.test(shellText)) {
    return { outcome: "not_found", navStatus, navMs };
  }
  if (navError) {
    return { outcome: "blocked", reason: "nav_error", navError, navStatus, navMs };
  }
  return { outcome: "blocked", reason: "no_xhr", navStatus, navMs, shellTextLen: shellText.length };
}

async function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const queue = argParts().slice();

  appendLog({ event: "run_start", totalParts: queue.length, hardCap: HARD_NAV_CAP });

  const browser = await chromium.launch(browserLaunchOptions());
  const ctx = await browser.newContext({
    userAgent: UA,
    viewport: { width: 1280, height: 900 },
    locale: "en-US",
    ignoreHTTPSErrors: true,
  });
  const page = await ctx.newPage();

  let navCount = 0;
  let consecutiveFailures = 0;
  let captured = 0;
  let notFound = 0;
  let blocked = 0;
  let lastNavStart = 0;

  try {
    while (queue.length > 0) {
      if (navCount >= HARD_NAV_CAP) {
        appendLog({ event: "stop", reason: "hard_nav_cap", navCount });
        break;
      }

      const item = queue[0];

      // Pacing: at least MIN_SPACING_MS since the previous navigation START.
      const waitMs = Math.max(0, lastNavStart + MIN_SPACING_MS - Date.now());
      if (waitMs > 0) await sleep(waitMs);

      lastNavStart = Date.now();
      navCount++;
      appendLog({ event: "nav_start", part: item.part, label: item.label, navCount });

      let result;
      try {
        result = await attemptOne(page, item.part);
      } catch (e) {
        result = { outcome: "blocked", reason: "exception", error: e.message };
      }

      if (result.outcome === "captured") {
        consecutiveFailures = 0;
        captured++;
        queue.shift();
        let json = null;
        let parseErr = null;
        try {
          json = parseFragment(result.itmBody);
        } catch (e) {
          parseErr = e.message;
        }
        fs.writeFileSync(path.join(OUT_DIR, `${item.part}.raw`), result.itmBody);
        if (json) {
          fs.writeFileSync(path.join(OUT_DIR, `${item.part}.json`), JSON.stringify(json, null, 2));
        }
        appendLog({
          event: "captured",
          part: item.part,
          label: item.label,
          src: item.src,
          title: json && json.TitleTxt,
          navMs: result.navMs,
          parseErr,
        });
      } else if (result.outcome === "not_found") {
        consecutiveFailures = 0;
        notFound++;
        queue.shift();
        appendLog({ event: "not_found", part: item.part, label: item.label, navMs: result.navMs });
      } else {
        // blocked - retry the same part after backoff, do not shift the queue
        consecutiveFailures++;
        blocked++;
        const tierIdx = Math.min(consecutiveFailures - 1, BACKOFF_MIN.length - 1);
        const backoffMin = BACKOFF_MIN[tierIdx];
        appendLog({
          event: "blocked",
          part: item.part,
          label: item.label,
          reason: result.reason,
          navError: result.navError,
          navStatus: result.navStatus,
          navMs: result.navMs,
          consecutiveFailures,
          backoffMin,
        });

        if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
          appendLog({
            event: "stop",
            reason: "three_consecutive_failures_at_20min_tier",
            consecutiveFailures,
          });
          break;
        }

        appendLog({ event: "backoff_start", minutes: backoffMin });
        await sleep(backoffMin * 60 * 1000);
        appendLog({ event: "backoff_end", minutes: backoffMin });
        // lastNavStart stays as the failed attempt's start; the top-of-loop
        // pacing wait will be a no-op since the backoff already exceeds it.
      }
    }

    if (queue.length === 0) {
      appendLog({ event: "stop", reason: "queue_exhausted" });
    }
  } finally {
    await ctx.close().catch(() => {});
    await browser.close().catch(() => {});
  }

  appendLog({
    event: "run_end",
    navCount,
    captured,
    notFound,
    blocked,
    remaining: queue.length,
    remainingParts: queue.map((q) => q.part),
  });
}

main().catch((e) => {
  appendLog({ event: "fatal_error", error: e.message, stack: e.stack });
  process.exit(1);
});
