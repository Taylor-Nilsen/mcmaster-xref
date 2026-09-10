# Backend: Render (free)

Renders the live McMaster page with real headless Chrome (Playwright) on
every request -- no caching. Separate from the frontend because GitHub
Pages (static-only) can't run this; the frontend calls it cross-origin
(CORS is handled in `server.js`).

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

What follows from that, and what `server.js` now does:

- **Cache every resolved part** (`specCache`), so a given part number is
  rendered at most once per instance.
- **Detect the wall explicitly** (`LOGIN_WALL_RE`) and report it to the UI
  as a temporary, not-your-fault condition, rather than as "no specs
  found" -- which is what it looked like before, and is why it read as a
  parser bug.
- **Never batch-render.** The verification (`RUN_VERIFY=1`) renders three
  parts spaced 20s apart. Supplier links, which have no such budget, are
  verified exhaustively instead.

The wall appears to lift on its own; if lookups are returning it, waiting
is the fix. Manual spec entry works throughout, and the supplier links are
built from whatever specs are present regardless of where they came from.

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
