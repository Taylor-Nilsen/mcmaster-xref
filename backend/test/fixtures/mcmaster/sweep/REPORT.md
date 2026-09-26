# McMaster sweep report (IN PROGRESS)

**Status: this is an interim snapshot, not a finished report.** The sweep
(`backend/scripts/sweep-mcmaster.js`) was started as a detached background
process (`nohup ... &`, PID 3083 at launch) and is still running as of this
write-up. It paces itself at >=90s between navigations with an escalating
5m/10m/20m backoff on any block signal, a hard cap of 80 navigations, and a
stop condition after 3 consecutive failures at the 20-minute backoff tier
(see the script's header comment for why -- it's a direct writeup of what an
earlier session in this repo measured about how McMaster/Akamai blocks). It
was deliberately built to keep running long after the agent session that
launched it hands back, and it needs no supervision to finish correctly or
stop safely on its own.

**To pick this back up:** check
`backend/test/fixtures/mcmaster/sweep/sweep.log` (one JSON line per event:
`nav_start` / `captured` / `not_found` / `blocked` / `backoff_start` /
`backoff_end` / `stop` / `run_end`) and `ps aux | grep sweep-mcmaster` for
whether it's still alive. Every captured part gets a `<PART>.raw` (the raw
XHR body) and `<PART>.json` (parsed) in this directory. Once the run has
stopped (`run_end` in the log, or the process is gone), re-run each
`<PART>.json` through `parseProductRecord` / `classifyProduct` /
`buildQueries` / `buildSupplierLinks` from `backend/lib/product.js` to
regenerate the full table below and extend the "Weak or wrong" section with
whatever new families got captured.

Confirmed already working (from the log as of this write-up): the first
block occurred at part 2 (`91771A831`, a `no_xhr` timeout after 32s) and the
script correctly logged it, started a 5-minute backoff, and will retry the
same part afterward without any manual intervention -- i.e. the pacing/
backoff/retry machinery described in the script's header is confirmed live,
not just written.

## Progress at time of this write-up

- **Captured so far: 6** (5 reused from an earlier session's captures under
  `backend/test/fixtures/mcmaster/`, copied in without spending a navigation
  from this run's budget, + 1 fresh navigation: `92620A624`).
- **Navigations spent from this run's 80-navigation budget: 2** (of 47
  queued new parts; the queue and its priority order -- fasteners, nuts,
  washers, raw stock, bearings, seals, motors, PPE, then everything else --
  live in `PART_LIST` inside `sweep-mcmaster.js`, each entry tagged with the
  real public source its part number came from, since none were guessed).
- **Not found: 0. Blocked: 1** (`91771A831`, `no_xhr` -- the page shell
  rendered but the ItmPrsnttnWebPart XHR never arrived within 30s -- 5-minute
  backoff in progress, will retry automatically).

## Part number provenance

Every part number swept is real, not guessed, per the run's instructions.
24 came from `backend/test/categories.json` (this repo's own pre-existing,
individually-reviewed matrix of one real part per McMaster family -- see
that file's header). The rest were sourced by web search against real,
independently-published McMaster BOMs/cross-references (a RepRap 3D-printer
parts wiki, the LumenPnP pick-and-place BOM, a Stanford Hapkit haptic-paddle
parts-list PDF, a tabletop-MRI-scanner parts-list PDF, a UCSB electronics
McMaster order PDF, a VORON-RGB 3D-printer BOM, an Instructables PCB-drill
project, an Instructables wheelchair project, and a Boeing shop
cross-reference page for a McMaster glove part) rather than recalled from
training data, specifically to avoid spending a navigation on a wrong guess.
Each `PART_LIST` entry in the script carries its `src`. Families the run's
instructions asked for but that turned up **no independently-verifiable
real part number** after a good-faith search -- and were therefore skipped
rather than guessed, per the run's own instructions -- were: AC motor
(plain, non-gear), electromechanical or valve solenoid, relay, toggle
switch, fuse, power supply, LED indicator, cable tie, heat-shrink tubing,
air cylinder, air regulator, ball valve, check valve, push-to-connect
fitting, hose barb, pipe nipple, PVC tubing, hose clamp, safety glasses,
earplugs, hard hat, respirator, first-aid kit, timing belt/pulley, V-belt,
sprocket, roller chain, spur gear, lead screw, rod end, universal joint,
retaining ring, blind/solid rivet, anchor, U-bolt, eyebolt, carriage bolt,
lag screw, wood screw, thumb screw, caster, hinge, latch, knob, drawer
slide, leveling foot, vibration mount, wrench, caliper, clamp, end mill,
tap, cutting fluid, epoxy, grease, hook, turnbuckle, shackle, strap, label,
storage bin, filter, heater, thermocouple, thermostat, fan, light bulb.
**This is the single biggest gap in this report's coverage** and is worth
flagging to the user directly: PPE in particular (the user's own named
priority) only got one item (a glove), and motors got two DC gearmotors but
no plain AC/DC motor and no solenoid of either kind.

## Results table (6 captured so far)

| Part | Title | Family | Category path | Kind | Noun | Primary query | Alt. count | Suppliers |
|---|---|---|---|---|---|---|---|---|
| 90480A005 | Zinc-Plated Low-Strength Steel Hex Nuts, 4-40 Thread Size | Hex Nuts | Fastening and Joining > Fastening > Nuts > Hex Nuts | nut | hex nut | `4-40 hex nut Steel Zinc-Plated` | 1 | Fastenal, Grainger, MSC Direct, Bolt Depot, Amazon, AliExpress, Banggood |
| 91102A029 | Zinc-Plated Steel Split Lock Washer, for 1/4" Screw Size, 0.26" ID, 0.487" OD | Lock Washers | Fastening and Joining > Fastening > Washers > Lock Washers > Split Lock Washers | washer | split lock washer | `1/4" split lock washer Steel Zinc Plated` | 1 | Fastenal, Grainger, MSC Direct, Bolt Depot, Amazon, AliExpress, Banggood |
| 91251A540 | Black-Oxide Alloy Steel Socket Head Screw, US Origin, 1/4"-20 Thread Size, 3/4" Long | Socket Head Screws | Fastening and Joining > Fastening > Screws and Bolts > Socket Head Screws > Steel Socket Head Screws | fastener | socket head cap screw | `1/4"-20 x 3/4" socket head cap screw Alloy Steel Black-Oxide` | 1 | Fastenal, Grainger, MSC Direct, Bolt Depot, Amazon, AliExpress, Banggood |
| 92196A106 | 18-8 Stainless Steel Socket Head Screw, 4-40 Thread Size, 1/4" Long, Fully Threaded | Socket Head Screws | Fastening and Joining > Fastening > Screws and Bolts > Socket Head Screws > Stainless Steel Socket Head Screws | fastener | socket head cap screw | `4-40 x 1/4" socket head cap screw 18-8 Stainless Steel` | 0 | Fastenal, Grainger, MSC Direct, Bolt Depot, Amazon, AliExpress, Banggood |
| 92620A624 | High-Strength Zinc Yellow-Chromate Plated Hex Head Screw, Grade 8 Steel, 3/8"-16 Thread Size, 1" Long, Fully Threaded | Hex Head Screws | *(empty -- see finding below)* | fastener | hex head cap screw | `3/8"-16 x 1" hex head cap screw Zinc-Yellow-Chromate-Plated Steel` | 0 | Fastenal, Grainger, MSC Direct, Bolt Depot, Amazon, AliExpress, Banggood |
| 9528K13 | Hard Wear-Resistant 52100 Alloy Steel Balls, 3/16" Diameter | Steel | Raw Materials > Metals > Steel > Steel Balls | rawstock | steel ball | `3/16" 52100 steel ball` | 2 | Speedy Metals, Metal Supermarkets, MSC Direct, Grainger, Online Metals |

## Weak or wrong (2 findings so far)

### 1. `92620A624` (hex head cap screw, Grade 8) -- drops the grade entirely

The primary query is `3/8"-16 x 1" hex head cap screw Zinc-Yellow-Chromate-Plated Steel`.
A person searching a fastener catalog for this exact part would search
"...Grade 8..." -- grade is *the* defining spec that separates this from a
cheap low-strength hex bolt of the same size, and it is completely absent.

Root cause, in the exact attribute names McMaster used on this record:

- The grade lives in an attribute literally named **`Fastener Strength
  Grade/Class`**, value **`SAE Grade 8`** -- a field name `fastenerQuery()`
  never reads. It only reads `product.byName("Grade")` (no such attribute
  exists on this record) or a grade folded into the front of the
  **`Material`** string via `GRADE_PREFIX_RE`. On this record `Material` is
  `Zinc-Yellow-Chromate-Plated Steel` -- the grade was never folded into
  Material at all here; McMaster kept it in its own separate row instead.
  Neither existing path finds it, so `terms.grade` comes out `null`.
- Separately, `Material` is `Zinc-Yellow-Chromate-Plated Steel` -- every
  word hyphenated together, including "Zinc" to "Yellow"
  (`Zinc-Yellow-Chromate-Plated`), not `Zinc-Plated` or `Zinc
  Yellow-Chromate Plated`. `FINISH_PREFIXES` has `"zinc yellow-chromate
  plated"` (space after "zinc"), which does not match this record's
  all-hyphenated phrasing case-insensitively, so the finish never gets
  split out of Material either -- it rides along as part of the
  noun-trailing material blob instead (cosmetically fine for a human
  reader, but the code's own finish/grade-split logic silently no-ops on
  this record without either half being caught by any fallback).

Fix should read `Fastener Strength Grade/Class` (stripping a leading
`"SAE "`/`"Grade "` the way `GRADE_PREFIX_RE` already does for the
Material-embedded case) as another source for `grade`, and add the
all-hyphenated phrasing to `FINISH_PREFIXES` (or match it with a
looser/regex-based finish detector instead of a fixed prefix list).

### 2. `92620A624` -- empty `categoryPath`, classification surviving only by luck

This record's `ReactData.Breadcrumbs` array is `[]` on McMaster's own
response -- not a parsing bug, the site itself served no breadcrumb trail
for this part. `classifyKind()`'s primary signal is keyword-matching the
category path (`KIND_RULES`, `isFastenerCategory`); with an empty path,
every one of those checks is vacuously false, and classification falls all
the way through to `classifyKindFromAttributes()`. That fallback happens to
work here only because this particular record also carries a `Fastener
Head Type` attribute (`Hex`), which is one of the few signals
`classifyKindFromAttributes` checks. A record with an empty breadcrumb
trail *and* without one of that fallback's narrow set of recognized
attribute names (nothing there covers, e.g., a pin, a retaining ring, a
rivet, or a spring) would silently fall to `"other"` with no warning. This
is worth a defensive test case in `product.js`'s own suite (a fixture with
`Breadcrumbs: []`) independent of whatever this sweep captures next, since
it's evidently a real shape McMaster serves, not a hypothetical.

## Outcome counts (partial, at time of write-up)

- Captured: 6 (5 reused, 1 fresh)
- Not found: 0
- Blocked: 1 (`91771A831`, reason `no_xhr`, in its first 5-minute backoff)
- Backoffs triggered: 1
- Consecutive-failure stops: 0
- Navigations spent (of 80 hard cap): 2
- Parts remaining in queue: 46

## Timeline of blocks and backoffs (so far)

- `2026-09-26T00:47:56Z` -- part `91771A831` (flat head Phillips screw):
  `blocked`, reason `no_xhr` (page shell rendered, no ItmPrsnttnWebPart
  response within 30s), `navStatus: 200`, `navMs: 32415`. Consecutive
  failures: 1. Backoff: 5 minutes, started.

*(This table needs to be regenerated from the full set once the background
run finishes -- see "To pick this back up" above.)*

---

# Remote sweep (backend/scripts/remote-sweep.js) -- IN PROGRESS

**Status: interim snapshot, not a finished report.** This is a second,
independent sweep, run in parallel with (but never concurrently against
McMaster itself, see below) the `sweep-mcmaster.js` run documented above.
It was started as a detached background process (`nohup ... &`, PID 10826
at launch) and is still running as of this write-up. Per this run's
instructions, it deliberately does **not** drive a browser against
mcmaster.com at all -- it only ever calls `POST /api/xref` on this app's own
deployed backend (`https://mcmaster-xref-api.onrender.com`, or `BACKEND_URL`),
one request at a time, at least 120s apart, never concurrently, so the two
sweeps never open more than the one path to McMaster that the deployed
backend itself already serializes. It exists to answer a different question
than the browser sweep above: not "can real records be captured at all" but
"once captured through the app's own production API, does the
classify/query/link pipeline hold up on a wider variety of real parts."

Pacing/backoff policy (see the script's header comment for the full
reasoning): >=120s between request starts; on `LOGIN_WALL`/`NO_DATA` an
escalating 5m/10m/20m backoff, moving on to the *next* part rather than
retrying the blocked one immediately (it goes to the back of the queue
instead); a hard stop after three consecutive blocks at the 20-minute tier;
`NOT_FOUND` is final for that part; `BUSY`/`FETCH_FAILED`/`NAV_FAILED`/a
timeout talking to our own backend gets one retry after 60s before also
moving on. Every part gets at most 3 total attempts across the run before
this script gives up on it, so a persistently failing part cannot loop
forever. Idempotent: a part with an existing
`backend/test/fixtures/mcmaster/remote/<PART>.json` is skipped on startup.

**To pick this back up:** check
`backend/test/fixtures/mcmaster/remote/remote-sweep.log` (one JSON line per
event: `run_start` / `request_start` / `captured` / `not_found` / `blocked` /
`backoff_start` / `backoff_end` / `retry` / `gave_up` / `stop` / `run_end`)
and `ps aux | grep remote-sweep` for whether it's still alive. Once the run
has stopped (`run_end` in the log, or the process is gone -- or once 3 hours
of wall clock have passed, whichever comes first, per this run's own
instructions), re-run `node backend/scripts/evaluate-records.js` (merges
this directory with the browser-sweep's `sweep/*.json` files, deduplicated
by part number) to regenerate the table below in full and extend the "Weak
or wrong" section with whatever new families got captured.

## Progress at time of this write-up

- **Captured so far (this run): 3** -- `91771A831` (flat head Phillips
  screw, 481ms -- a fast/cached response, not a fresh McMaster navigation),
  `92949A150` (button head hex-drive screw, 12.4s -- a real navigation
  through the backend), `91375A194` (cup-tip set screw, 11.0s -- also a real
  navigation).
- **Not found: 0. Blocked: 0. Retries: 0. Gave up: 0.**
- **Elapsed: ~5.5 minutes of a queue of 90 parts** (the combined,
  deduplicated `sweep-mcmaster.js` `PART_LIST` + `sweep-parts-2.json`, minus
  the 6 parts that already had a JSON under `sweep/` when this run started).
  At the ~120s/part floor (no blocks so far) this run needs on the order of
  3+ hours to clear the full queue, per this run's own instructions -- it is
  expected to still be going when this snapshot is taken, and it is designed
  (detached, `nohup`+disowned, exactly like `sweep-mcmaster.js`'s PID 3083,
  which has itself survived across multiple agent sessions in this sandbox)
  to keep running and writing to its own log/output directory with no
  supervision needed.
- **Block timeline: none yet.** No `LOGIN_WALL`/`NO_DATA`/`BUSY` response
  has occurred in this run so far -- every request has resolved on its first
  attempt.

## Results table (9 captured records evaluated: 6 from the browser sweep's
`sweep/*.json`, 3 fresh from this run's `remote/*.json`)

<!-- generated by `node backend/scripts/evaluate-records.js` -->

| Part | Title | Family | Category path | Kind | Noun | Primary query | Suppliers |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 90480A005 | Zinc-Plated Low-Strength Steel Hex Nuts, 4-40 Thread Size | Hex Nuts | Fastening and Joining > Fastening > Nuts > Hex Nuts | nut | hex nut | `4-40 hex nut Steel zinc plated` | Fastenal, Grainger, MSC Direct, Bolt Depot, Amazon, AliExpress |
| 91102A029 | Zinc-Plated Steel Split Lock Washer, for 1/4" Screw Size, 0.26" ID, 0.487" OD | Lock Washers | Fastening and Joining > Fastening > Washers > Lock Washers > Split Lock Washers | washer | split lock washer | `1/4" split lock washer Steel zinc plated` | Fastenal, Grainger, MSC Direct, Bolt Depot, Amazon, AliExpress |
| 91251A540 | Black-Oxide Alloy Steel Socket Head Screw, US Origin, 1/4"-20 Thread Size, 3/4" Long | Socket Head Screws | Fastening and Joining > Fastening > Screws and Bolts > Socket Head Screws > Steel Socket Head Screws | fastener | socket head cap screw | `1/4"-20 x 3/4" socket head cap screw Alloy Steel black oxide` | Fastenal, Grainger, MSC Direct, Bolt Depot, Amazon, AliExpress |
| 91375A194 | Alloy Steel Cup-Tip Set Screw, Black Oxide, 8-32 Thread, 1/2" Long | Set Screws | Fastening and Joining > Fastening > Screws and Bolts > Set Screws > Steel Cup-Tip Set Screws | fastener | steel cup-tip set screw | `8-32 x 1/2" steel cup-tip set screw Alloy Steel black oxide` | Fastenal, Grainger, MSC Direct, Bolt Depot, Amazon, AliExpress |
| 91771A831 | 18-8 Stainless Steel Phillips Flat Head Screw, 82 Degree Countersink, 10-32 Thread Size, 3/4" Long | Flat Head Screws | *(empty breadcrumbs -- see note below)* | fastener | flat head screw | `10-32 x 3/4" flat head screw 18-8 Stainless Steel` | Fastenal, Grainger, MSC Direct, Bolt Depot, Amazon, AliExpress |
| 92196A106 | 18-8 Stainless Steel Socket Head Screw, 4-40 Thread Size, 1/4" Long, Fully Threaded | Socket Head Screws | Fastening and Joining > Fastening > Screws and Bolts > Socket Head Screws > Stainless Steel Socket Head Screws | fastener | socket head cap screw | `4-40 x 1/4" socket head cap screw 18-8 Stainless Steel` | Fastenal, Grainger, MSC Direct, Bolt Depot, Amazon, AliExpress |
| 92620A624 | High-Strength Zinc Yellow-Chromate Plated Hex Head Screw, Grade 8 Steel, 3/8"-16 Thread Size, 1" Long, Fully Threaded | Hex Head Screws | *(empty breadcrumbs -- see note below)* | fastener | hex head cap screw | `3/8"-16 x 1" hex head cap screw Steel zinc yellow chromate Grade 8` | Fastenal, Grainger, MSC Direct, Bolt Depot, Amazon, AliExpress |
| **92949A150** | 18-8 Stainless Steel Button Head Hex-Drive Screw, 6-32 Thread Size, 5/8" Long | Rounded Head Screws | *(empty breadcrumbs -- see note below)* | fastener | **round head screw** | `6-32 x 5/8" round head screw 18-8 Stainless Steel` | Fastenal, Grainger, MSC Direct, Bolt Depot, Amazon, AliExpress |
| 9528K13 | Hard Wear-Resistant 52100 Alloy Steel Balls, 3/16" Diameter | Steel | Raw Materials > Metals > Steel > Steel Balls | rawstock | steel ball | `3/16" 52100 steel ball` | Speedy Metals, Metal Supermarkets, MSC Direct, Grainger, Online Metals |

Note on the two previously-flagged findings against `92620A624` in the
browser-sweep report above (missing `Fastener Strength Grade/Class`, and the
all-hyphenated `"Zinc-Yellow-Chromate-Plated"` finish text not matching
`FINISH_PREFIXES`): both now read correctly in this table (`Grade 8` and
`zinc yellow chromate` both appear in the primary query). `lib/product.js`
already reads `Fastener Strength Grade/Class` as its first `GRADE_ATTR_NAMES`
entry as of this write-up -- that fix has landed (by the agent concurrently
editing that file) since the browser-sweep report was written. Good to
confirm as fixed rather than re-flag.

Also note: three of the four fresh navigations captured by either sweep so
far (`92620A624`, `91771A831`, `92949A150`) all have empty
`ReactData.Breadcrumbs` on McMaster's own served page. This matches finding
#2 in the browser-sweep report above (not a parsing bug -- McMaster itself
serves no breadcrumb trail for these part pages) and appears to be common,
not a one-off, across parts reached directly by exact part number.

## Weak or wrong (1 new finding this run)

Judged the way a person would check for drop-in equivalence: does the
primary query, on its own, find the *same part*, not just something in the
same family.

### 1. `92949A150` (18-8 Stainless Steel Button Head Hex-Drive Screw) -- wrong noun entirely: "round head screw" instead of "button head socket cap screw"

The primary query is `6-32 x 5/8" round head screw 18-8 Stainless Steel`. A
person shopping for this exact part -- a button-head cap screw with a hex
socket drive -- would never type "round head screw": in trade terminology a
"round head screw" is a distinct, older style (a plain domed head, almost
always slotted or Phillips-driven, McMaster's own separate "Round Head
Screws" family) from a button head socket cap screw. Searching a supplier
site for "round head screw" surfaces the wrong shape of screw and, worse,
implies the wrong drive type (slotted/Phillips, not hex socket) -- this is
not a cosmetic wording gap, it would return the wrong physical part.

Root cause, in the exact attribute names McMaster used on this record:

- This record carries **two different, disagreeing "what shape is the head"
  signals**. A flat, top-level (`group: null`) attribute named
  **`Fastener Head Type`**, value **`Rounded`** -- McMaster's own broad
  catalog-family bucket (the record's `family` is literally `"Rounded Head
  Screws"`, the umbrella McMaster files button/round/truss/oval heads
  under). Separately, a **grouped** attribute, **`Head` > `Style`**, value
  **`Button`** -- the actual, specific head shape.
- `deriveNoun()`'s fastener branch reads
  `product.byName("Fastener Head Type") || product.byName("Head Type")`
  first. `byName(name)` with no group argument matches a name in *any*
  group, including `null` -- so it finds the flat `"Rounded"` value before
  ever considering the more specific `Head > Style` attribute, which isn't
  even one of the names this code looks for (it only ever reads
  `"Fastener Head Type"`/`"Head Type"`, never `"Style"` under a `"Head"`
  group).
- `fastenerHeadNoun("Rounded", driveStyle)` is then asked to pick a noun
  from a head-type string that only ever describes the *generic family*, not
  the specific shape -- and it falls through every specific regex (`socket`,
  `button`, `flat|countersunk`, `pan`, `truss`, `cheese`, `oval`) to land on
  `/round/.test("rounded")` -> `"round head screw"`.
- The drive type is lost too, for the same reason: this record's drive
  attribute is **`Drive` > `Style`**, value **`Hex`** -- but
  `deriveNoun()`/`fastenerHeadNoun()` only ever read
  `product.byName("Drive Style")`/`product.byName("Drive Type")` (a flat
  name), which does not exist on this record (the real one lives grouped
  under `"Drive"` as bare `"Style"`), so `driveStyle` resolves to
  `undefined` and the `socketDrive` check that would have caught a hex/
  socket/torx drive and picked `"button head socket cap screw"` never even
  gets a chance to run.

Fix should prefer a grouped `Head > Style`/`Head > Type` attribute over the
flat `Fastener Head Type` catalog-family label when both are present (the
grouped one is the specific shape; the flat one is often just the umbrella
family name repeated), and should also read a grouped `Drive > Style` the
same way `Thread > Size` is already read via `byName("Size", "Thread")` --
right now `fastenerHeadNoun`'s socket-drive detection is silently disabled
on any record that groups its drive fields (which, per this record, is not
a hypothetical shape McMaster serves).

## Outcome counts (partial, at time of write-up)

- Captured: 3 (of 90 queued this run; 0 reused)
- Not found: 0
- Blocked: 0
- Retry events (transient, e.g. BUSY/FETCH_FAILED/NAV_FAILED): 0
- Gave up (exhausted 3 attempts): 0
- Elapsed wall clock: ~5.5 minutes
- Parts remaining in queue: 87

## Timeline of blocks and backoffs (so far)

*(none -- no block or retry event has occurred yet in this run)*

*(This section needs to be regenerated from the full run once it finishes or
the 3-hour checkpoint is reached -- see "To pick this back up" above. The
process (PID 10826 at launch) is detached and will continue running and
appending to `backend/test/fixtures/mcmaster/remote/remote-sweep.log` and
writing captured records to `backend/test/fixtures/mcmaster/remote/*.json`
with no supervision needed.)*
