# Backend: Render (free)

`POST /api/xref` resolves a product from, in order: a `record` (JSON
product record, or the raw captured page fragment string, taken directly
off mcmaster.com by a bookmarklet running in the person's own browser),
`pastedText` (spec text copied off McMaster's rendered page), or
`partNumber` (this server drives a headless Chromium to mcmaster.com
itself and captures the same structured record the bookmarklet would).
Manual `specs` (key/value entry) layer on top by attribute name, or
synthesize a product on their own if nothing else resolved one. Whatever
the source, the result runs through the same pipeline --
`lib/product.js`'s `parseProductRecord` -> `classifyProduct` ->
`buildQueries` -> `buildSupplierLinks` -- so a bookmarklet capture, a
paste, and a live server fetch all produce identical output for the same
part. `GET /api/health` reports queue/cache state. Separate from the
frontend because GitHub Pages (static-only) can't run this; the frontend
calls it cross-origin (CORS is handled in `server.js`).

This replaces the earlier approach of rendering the McMaster page with
Playwright and regexing its rendered `innerText` (`lib/specs.js`, still
present and still covered by its own tests, but no longer in the request
path) -- that path had no structured signal for what a part *was*, so it
had to guess a product's noun from prose. `lib/product.js` instead reads
McMaster's own embedded JSON product record directly, which is exact.

**Live at: `https://mcmaster-xref-api.onrender.com`** -- already deployed,
already wired up in `frontend/config.js`. Nothing left to do here unless
you're redeploying after a code change (pushing to this branch does that
automatically) or setting it up fresh elsewhere.

Runs on [Render](https://render.com)'s free Web Service tier: no credit
card required to create one, so there's no way to rack up a surprise bill
even if the URL gets hit by something other than you -- worst case Render
just throttles or sleeps it.

## Deploy (only needed for a fresh setup)

- Root directory: `backend`
- Environment: **Node**
- Build command: `npm install && npx playwright install chromium`
- Start command: `node server.js`
- Instance type: **Free**

Don't add `--with-deps` to the build command -- it tries to `apt-get`
system packages as root via `su`, which Render's build container refuses
("Authentication failure"). Plain `chromium` (no flag) just downloads the
browser binary, which is all that's needed; Render's Node image already
has the shared libraries Chromium wants at runtime.

## The real constraint: McMaster's anonymous-view limit

**It is not bot detection.** That was the working theory for a while, and
it's wrong. Measured directly against live responses:

- Headless Chromium with the stealth patches renders McMaster product
  pages perfectly and parses 8 correct spec fields. Verified repeatedly
  against three different real parts.
- Then, mid-session, *every* McMaster URL -- product pages and category
  pages alike -- started returning the same 776-character page reading
  **"To continue browsing, please log in."**
- What happened in between was a 100-part verification sweep. McMaster
  allows a limited number of anonymous page views per client and then
  requires a login. The sweep spent the budget; the app went down with it.

So the scarce resource is *page views*, not fingerprint plausibility. No
amount of stealth work buys more of them, and a headed browser under Xvfb
(the old plan below this line) would not have helped either.

This deployment has had **zero successful server-side lookups in three
days** -- McMaster's block on this IP is not intermittent any more, it is
the steady state. The `partNumber` -> live-fetch path is kept as an
optimistic first attempt (it costs nothing extra to try, and the block may
lift), but it is not the primary way this app is meant to work now: the
bookmarklet path (a person's own browser captures the record, which
carries no datacenter IP at all) is. Every error this endpoint returns
says so in its message.

What follows from that, and what `server.js` now does:

- **Fail fast.** A failed lookup answers within ~35s total
  (`HARD_TIMEOUT_MS` in `server.js`), never the ~80s a two-attempt render
  used to take before it could report the wall.
- **A machine-readable error code**, not just a message: `LOGIN_WALL`,
  `NO_DATA`, `NOT_FOUND`, `NAV_FAILED`, `FETCH_FAILED` (plus `BUSY` for the
  request queue and `BAD_RECORD` for a malformed `record` body) in
  `error.code`, so the frontend can branch to its own bookmarklet path
  instead of just displaying prose.
- **Cache every resolved part** (in-memory, plus a `LOGIN_WALL`/`NO_DATA`
  negative cache with a 5-minute TTL, plus an optional on-disk cache -- see
  `XREF_CACHE_FILE` below), so a given part number is rendered at most once
  per instance and a redeploy on a host with a disk keeps what was already
  resolved.
- **Serialize requests to McMaster.** The block is triggered by request
  *velocity*, not by any one request looking automated, so `server.js`
  runs McMaster fetches one at a time through a small queue with a minimum
  3s spacing between navigations, and refuses (503, `error.code: "BUSY"`)
  anything queued more than 5 deep rather than let a burst make the block
  worse.
- **Never batch-render.** `backend/scripts/probe-mcmaster.js` is the only
  supported way to run several parts through McMaster now -- run by hand,
  spaced out, never from the deployed service. (The old `RUN_VERIFY` /
  `RUN_SWEEP` / `RUN_QUERYLAB` / `RUN_URLPROBE` env-gated blocks that used
  to live in `server.js` are gone -- a 100-part sweep through one of them is
  what burned the anonymous-view budget and took the whole service down in
  the first place.)

The wall appears to lift on its own; if lookups are returning it, waiting
is the fix. The `record`, `pastedText` and manual-`specs` paths all work
regardless of whether the live fetch does, and the supplier links are
built from whatever product was resolved, however it got here.

## Environment variables

- `PORT` -- what the server listens on (default `3000`).
- `XREF_CACHE_FILE` -- path to a JSON file used as a write-through cache of
  resolved parts, so a redeploy on a host with persistent disk doesn't
  start every part over from zero. Optional; a missing or corrupt file is
  tolerated (starts empty) rather than crashing the server. Render's free
  tier has no persistent disk, so this is unset there today -- it matters
  on a host that does.
- `XREF_NO_BROWSER` -- set to `1` to make every McMaster fetch fail fast
  with `NO_DATA` instead of launching Chromium. Used by the test suite;
  also useful for running the server somewhere Playwright isn't installed,
  with only the `record`/`pastedText`/`specs` paths working.
- `PLAYWRIGHT_CHROMIUM_PATH` -- points Playwright at a specific Chromium
  binary instead of the one it downloaded itself. See `lib/mcmaster.js`.

### Things checked and ruled out

- **Plain HTTP fetch of a product page**: returns 200 with ~151KB, but it
  is the Angular shell only -- zero spec values in it. A browser is
  genuinely required.
- **McMaster's own JSON endpoints** (`WebSrchEng.aspx`): reachable without
  login and useful for *validating* a part number and getting its family
  and catalog page, but they don't carry the spec table.
- **Third-party fallbacks** (Bing, Google, MROSupply, MPParts): all
  reachable, none usable. Bing returns generic McMaster category pages,
  MROSupply finds nothing for the part number, Google serves a consent
  page. There is no second source for the specs.

## Notes

- **Cold starts**: the free tier sleeps after 15 minutes with no traffic
  and takes ~30-60 seconds to wake on the next request (spinning the
  service back up, then launching Chromium for that request). Free, just
  not instant if it's been idle.
- **Redeploying after code changes**: push to the connected branch --
  Render rebuilds and redeploys automatically.
- **Local run**: `cd backend && npm install && npx playwright install chromium && npm start`, then it's listening on `http://localhost:3000`.
- There's a second, broken Render service left over from getting this
  working (`mcmaster-xref-backend`, the one with `--with-deps` in its
  build command). It's inert and free -- safe to delete whenever you're in
  the Render dashboard for something else, no rush.
- **Tests**: `cd backend && npm install && npm test`. The structured-record
  pipeline (`lib/product.js`) and the McMaster fragment parser
  (`lib/mcmaster.js`'s `parseFragment`) are pure and dependency-free, and
  are tested directly against the captured fixtures in
  `test/fixtures/mcmaster/*.raw`. The `POST /api/xref` endpoint tests
  (`test/api.test.js`) stub `fetchProductRecord` for anything that would
  otherwise hit McMaster, either via `buildApp({ fetchProductRecord })` or
  `XREF_NO_BROWSER=1`, so the whole suite runs with no Chromium and no
  anonymous-view spend. The older `lib/specs.js` prose parser is left in
  place with its own tests (`test/specs.test.js`, `test/categories.test.js`)
  even though it's no longer in the request path. CI runs it on every push
  (`.github/workflows/test.yml`).
