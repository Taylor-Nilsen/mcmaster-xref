#!/usr/bin/env node
/**
 * Paced sweep of real McMaster-Carr part numbers against THIS APP'S OWN
 * deployed backend (https://mcmaster-xref-api.onrender.com by default, or
 * BACKEND_URL) -- never mcmaster.com directly. The backend itself is what
 * drives a headless browser against McMaster; this script only ever calls
 * POST /api/xref on that one deployed instance, one request at a time, at a
 * polite pace, so it never opens a second, concurrent path to McMaster.
 *
 * Contract (see backend/server.js): POST /api/xref { partNumber } ->
 *   { partNumber, source, product, classification, queries, links, error }
 * error.code is one of LOGIN_WALL, NO_DATA, NOT_FOUND, NAV_FAILED,
 * FETCH_FAILED, BUSY (503), BAD_REQUEST.
 *
 * Pacing / backoff policy (deliberately mirrors the lessons already learned
 * in sweep-mcmaster.js, but adapted for driving the deployed API instead of
 * a local browser, and with one important difference: a block moves on to
 * the next part rather than retrying the same one immediately):
 *   - at least MIN_SPACING_MS (120s) between the START of one request and
 *     the start of the next -- never concurrent.
 *   - LOGIN_WALL or NO_DATA: a real McMaster-side block. Back off 5, then
 *     10, then 20 minutes (escalating per consecutive block), and move on
 *     to the NEXT part in the queue rather than retrying this one right
 *     away -- the blocked part is pushed to the back of the queue so it
 *     gets a later, naturally-spaced-out retry rather than being abandoned
 *     outright. After three consecutive blocks at the 20-minute tier (5
 *     consecutive blocks total: 5m,10m,20m,20m,20m), the whole run stops.
 *   - NOT_FOUND: final for that part. Logged and dropped from the queue,
 *     never retried.
 *   - FETCH_FAILED / NAV_FAILED / BUSY / a network-level error or timeout
 *     talking to our own backend: transient. Retried once, same part,
 *     after 60s. If the retry ALSO fails transiently, the part is pushed
 *     to the back of the queue (same "move on" treatment as a block) but
 *     does NOT count toward the LOGIN_WALL/NO_DATA consecutive-block stop
 *     condition above -- that condition is specifically about McMaster
 *     blocking us, not about our own backend being briefly busy.
 *   - Any part requeued (block or transient-retry-failure) is capped at
 *     MAX_ATTEMPTS_PER_PART total attempts across the run, so a
 *     persistently failing part cannot loop forever and starve the queue;
 *     once exhausted it is logged "gave_up" and dropped.
 *   - The run also self-stops after MAX_WALL_MS (a safety cap beyond the
 *     3-hour evaluation checkpoint the operating agent uses) so an
 *     unattended run can never continue indefinitely.
 *
 * Output: each successful response body -> <OUT_DIR>/<PART>.json (the full
 * JSON response, not just `product`). One JSON line per event appended to
 * <OUT_DIR>/remote-sweep.log: captured / not_found / blocked / retry /
 * backoff / stop / run_end (with ms, error code, title where relevant).
 *
 * Idempotent: a part with an existing <OUT_DIR>/<PART>.json is skipped on
 * startup (and never re-fetched even if named again by a later run of this
 * script), so re-running after an interruption picks up where it left off
 * without spending a request on work already done.
 *
 * Usage:
 *   node backend/scripts/remote-sweep.js
 *   BACKEND_URL=... node backend/scripts/remote-sweep.js
 */

"use strict";

const fs = require("fs");
const path = require("path");

const BACKEND_URL = (process.env.BACKEND_URL || "https://mcmaster-xref-api.onrender.com").replace(/\/+$/, "");
const OUT_DIR = path.join(__dirname, "..", "test", "fixtures", "mcmaster", "remote");
const SWEEP_DIR = path.join(__dirname, "..", "test", "fixtures", "mcmaster", "sweep");
const LOG_PATH = path.join(OUT_DIR, "remote-sweep.log");

const MIN_SPACING_MS = 120 * 1000;
const BACKOFF_MIN = [5, 10, 20]; // minutes, by consecutive-block tier (capped at the last entry)
const MAX_CONSECUTIVE_BLOCKS = 5; // 5m,10m,20m,20m,20m -> 3 blocks at the 20m tier -> stop
const TRANSIENT_RETRY_DELAY_MS = 60 * 1000;
const MAX_ATTEMPTS_PER_PART = 3; // initial + up to 2 requeued retries, then give up on that part
const REQUEST_TIMEOUT_MS = 120 * 1000; // generous: backend's own hard timeout is ~33s server-side,
  // plus up to 20s queue wait, plus a possible Render cold start (30-60s) on the very first hit.
const MAX_WALL_MS = 4 * 3600 * 1000; // safety cap; the operating agent's own checkpoint is 3h.

// ---------------------------------------------------------------------------
// Part list -- copied as plain data from backend/scripts/sweep-mcmaster.js's
// PART_LIST (never `require`d: that file runs a real Playwright sweep
// against mcmaster.com as a side effect of being loaded, which must never
// happen from here) plus backend/scripts/sweep-parts-2.json (loaded with
// JSON.parse, which -- unlike `require` on a .js file -- never executes
// code, so that one is safe to read directly).
// ---------------------------------------------------------------------------
const PART_LIST_1 = [
  { part: "92620A624", label: "Hex head cap screw" },
  { part: "91771A831", label: "Flat head screw (Phillips)" },
  { part: "92949A150", label: "Button head socket cap screw" },
  { part: "91375A194", label: "Set screw" },
  { part: "90272A110", label: "Pan head machine screw (Phillips)" },
  { part: "90286A118", label: "Sheet metal screw" },
  { part: "90298A537", label: "Shoulder screw" },
  { part: "98861A030", label: "Threaded rod" },
  { part: "91290A115", label: "Socket head cap screw (metric)" },
  { part: "97049A101", label: "Dowel pin (2mm, ISO 2338-H8 undersized)" },
  { part: "90631A011", label: "Nylon-insert lock nut" },
  { part: "94300A140", label: "Wing nut" },
  { part: "94000A330", label: "Acorn / cap nut" },
  { part: "96887A331", label: "Square nut" },
  { part: "90107A029", label: "Flat washer" },
  { part: "92146A029", label: "Lock washer" },
  { part: "91100A160", label: "Fender washer" },
  { part: "8974K21", label: "Aluminum round bar" },
  { part: "8983K115", label: "Stainless sheet" },
  { part: "9220K11", label: "Steel tube" },
  { part: "98870A150", label: "Keystock" },
  { part: "8546K42", label: "PTFE rod (10mm OD x 3mm bore)" },
  { part: "9299K12", label: "Brass shim stock roll" },
  { part: "60355K505", label: "Ball bearing" },
  { part: "2938T3", label: "Flanged sleeve bearing (SAE 863 bronze)" },
  { part: "9414T6", label: "Shaft collar (set screw)" },
  { part: "9452K113", label: "O-ring" },
  { part: "8516K61", label: "Gasket sheet" },
  { part: "9657K277", label: "Compression spring" },
  { part: "6409K18", label: "DC gearmotor, 12V 50 RPM" },
  { part: "6535K292", label: "DC gearmotor, 24V" },
  { part: "52555T73", label: "Disposable nitrile glove, L, 8 mil, powdered" },
  { part: "4591K11", label: "PTFE thread-seal tape" },
  { part: "2278N13", label: "Precision machine oil" },
  { part: "2958A61", label: "Drill bit" },
  { part: "7122A18", label: "Hex key (1/8\")" },
  { part: "7026A16", label: "Miniature screwdriver" },
  { part: "57295K73", label: "Alnico disc magnet" },
  { part: "8930T16", label: "Nylon-coated stainless wire rope" },
  { part: "51075K27", label: "Neoprene tubing" },
  { part: "7527K51", label: "Terminal block, 10-position" },
  { part: "69145K73", label: "Terminal lug (spade), blue" },
  { part: "7610A17", label: "3M spray adhesive #76" },
  { part: "92745A346", label: "Hex standoff, 6-32 x 1\", M-F" },
  { part: "94510A030", label: "M3 press-fit threaded insert" },
  { part: "5012K83", label: "Quick-disconnect coupling, female socket" },
  { part: "5012K72", label: "Quick-disconnect coupling, male plug" },
];

function loadPartList2() {
  const raw = fs.readFileSync(path.join(__dirname, "sweep-parts-2.json"), "utf8");
  const items = JSON.parse(raw);
  return items.map((it) => ({ part: it.part, label: it.family || it.part }));
}

function buildQueue() {
  const combined = [...PART_LIST_1, ...loadPartList2()];
  const seen = new Set();
  const deduped = [];
  for (const item of combined) {
    if (seen.has(item.part)) continue;
    seen.add(item.part);
    deduped.push(item);
  }
  let alreadyInSweepDir = new Set();
  try {
    alreadyInSweepDir = new Set(
      fs.readdirSync(SWEEP_DIR).filter((f) => f.endsWith(".json")).map((f) => f.replace(/\.json$/, "")),
    );
  } catch {
    /* sweep dir missing is fine -- nothing to skip */
  }
  return deduped.filter((item) => !alreadyInSweepDir.has(item.part));
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function nowIso() {
  return new Date().toISOString();
}

function appendLog(obj) {
  fs.appendFileSync(LOG_PATH, JSON.stringify({ ts: nowIso(), ...obj }) + "\n");
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function alreadyCaptured(part) {
  return fs.existsSync(path.join(OUT_DIR, `${part}.json`));
}

/** One POST /api/xref call. Returns { ok, ms, body, transportError }. */
async function callXref(part) {
  const t0 = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const resp = await fetch(`${BACKEND_URL}/api/xref`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ partNumber: part }),
      signal: controller.signal,
    });
    const ms = Date.now() - t0;
    let body = null;
    try {
      body = await resp.json();
    } catch (e) {
      return { ok: false, ms, transportError: `non-JSON response (HTTP ${resp.status}): ${e.message}` };
    }
    return { ok: true, ms, httpStatus: resp.status, body };
  } catch (e) {
    const ms = Date.now() - t0;
    const msg = e.name === "AbortError" ? `client timeout after ${REQUEST_TIMEOUT_MS}ms` : e.message;
    return { ok: false, ms, transportError: msg };
  } finally {
    clearTimeout(timer);
  }
}

const TRANSIENT_CODES = new Set(["FETCH_FAILED", "NAV_FAILED", "BUSY"]);
const BLOCK_CODES = new Set(["LOGIN_WALL", "NO_DATA"]);

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const startMs = Date.now();

  const queue = buildQueue().map((item) => ({ ...item, attempts: 0 }));
  appendLog({ event: "run_start", backendUrl: BACKEND_URL, totalParts: queue.length });

  let captured = 0;
  let notFound = 0;
  let blockedEvents = 0; // count of individual LOGIN_WALL/NO_DATA block events
  let retryEvents = 0; // count of individual transient-retry events
  let gaveUp = 0;
  let consecutiveBlocks = 0;
  let lastStart = 0;

  while (queue.length > 0) {
    if (Date.now() - startMs > MAX_WALL_MS) {
      appendLog({ event: "stop", reason: "max_wall_clock", elapsedMs: Date.now() - startMs });
      break;
    }

    const item = queue.shift();

    if (alreadyCaptured(item.part)) {
      // Another run (or a manual capture) already produced this file --
      // idempotent skip, no request spent.
      appendLog({ event: "skip_already_captured", part: item.part });
      continue;
    }

    // Pacing floor: at least MIN_SPACING_MS since the previous request START.
    const waitMs = Math.max(0, lastStart + MIN_SPACING_MS - Date.now());
    if (waitMs > 0) await sleep(waitMs);
    lastStart = Date.now();

    item.attempts++;
    appendLog({ event: "request_start", part: item.part, label: item.label, attempt: item.attempts });

    const result = await callXref(item.part);

    if (!result.ok) {
      // Transport-level failure talking to our own backend (network error,
      // non-JSON body, client timeout) -- treated exactly like a
      // FETCH_FAILED response from the app itself.
      retryEvents++;
      appendLog({
        event: "retry",
        part: item.part,
        label: item.label,
        reason: "transport_error",
        detail: result.transportError,
        ms: result.ms,
        attempt: item.attempts,
      });
      if (item.attempts >= MAX_ATTEMPTS_PER_PART) {
        gaveUp++;
        appendLog({ event: "gave_up", part: item.part, label: item.label, attempts: item.attempts });
      } else {
        await sleep(TRANSIENT_RETRY_DELAY_MS);
        queue.push(item); // move on / requeue at the back, not an immediate retry
      }
      continue;
    }

    const body = result.body || {};
    const errCode = body.error && body.error.code;

    if (!errCode && body.source === "mcmaster" && body.product) {
      // Captured.
      consecutiveBlocks = 0;
      captured++;
      fs.writeFileSync(path.join(OUT_DIR, `${item.part}.json`), JSON.stringify(body, null, 2));
      appendLog({
        event: "captured",
        part: item.part,
        label: item.label,
        title: body.product.title,
        ms: result.ms,
        attempt: item.attempts,
      });
      continue;
    }

    if (errCode === "NOT_FOUND") {
      notFound++;
      appendLog({ event: "not_found", part: item.part, label: item.label, ms: result.ms, attempt: item.attempts });
      continue; // final for this part, never requeued
    }

    if (BLOCK_CODES.has(errCode)) {
      consecutiveBlocks++;
      blockedEvents++;
      const tierIdx = Math.min(consecutiveBlocks - 1, BACKOFF_MIN.length - 1);
      const backoffMin = BACKOFF_MIN[tierIdx];
      appendLog({
        event: "blocked",
        part: item.part,
        label: item.label,
        code: errCode,
        message: body.error && body.error.message,
        ms: result.ms,
        attempt: item.attempts,
        consecutiveBlocks,
        backoffMin,
      });

      if (consecutiveBlocks >= MAX_CONSECUTIVE_BLOCKS) {
        appendLog({ event: "stop", reason: "three_consecutive_blocks_at_20min_tier", consecutiveBlocks });
        break;
      }

      appendLog({ event: "backoff_start", minutes: backoffMin });
      await sleep(backoffMin * 60 * 1000);
      appendLog({ event: "backoff_end", minutes: backoffMin });

      if (item.attempts >= MAX_ATTEMPTS_PER_PART) {
        gaveUp++;
        appendLog({ event: "gave_up", part: item.part, label: item.label, attempts: item.attempts });
      } else {
        queue.push(item); // move on to the next part; this one goes to the back of the queue
      }
      continue;
    }

    if (TRANSIENT_CODES.has(errCode) || !errCode) {
      // BUSY / FETCH_FAILED / NAV_FAILED, or an unrecognized/empty error
      // shape -- treated the same conservative way.
      retryEvents++;
      appendLog({
        event: "retry",
        part: item.part,
        label: item.label,
        code: errCode || "UNKNOWN",
        message: body.error && body.error.message,
        ms: result.ms,
        attempt: item.attempts,
      });
      if (item.attempts >= MAX_ATTEMPTS_PER_PART) {
        gaveUp++;
        appendLog({ event: "gave_up", part: item.part, label: item.label, attempts: item.attempts });
      } else {
        await sleep(TRANSIENT_RETRY_DELAY_MS);
        queue.push(item);
      }
      continue;
    }

    // Fully unrecognized error code -- log and move on rather than looping.
    appendLog({ event: "retry", part: item.part, label: item.label, code: errCode, ms: result.ms, attempt: item.attempts });
    if (item.attempts >= MAX_ATTEMPTS_PER_PART) {
      gaveUp++;
      appendLog({ event: "gave_up", part: item.part, label: item.label, attempts: item.attempts });
    } else {
      await sleep(TRANSIENT_RETRY_DELAY_MS);
      queue.push(item);
    }
  }

  if (queue.length === 0) {
    appendLog({ event: "stop", reason: "queue_exhausted" });
  }

  appendLog({
    event: "run_end",
    elapsedMs: Date.now() - startMs,
    captured,
    notFound,
    blockedEvents,
    retryEvents,
    gaveUp,
    remaining: queue.length,
    remainingParts: queue.map((q) => q.part),
  });
}

main().catch((e) => {
  appendLog({ event: "fatal_error", error: e.message, stack: e.stack });
  process.exitCode = 1;
});
