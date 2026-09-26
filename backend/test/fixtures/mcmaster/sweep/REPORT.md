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
