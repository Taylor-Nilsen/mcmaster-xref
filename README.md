# McMaster-Carr Cross-Reference

Given a McMaster-Carr part number, extract its specs and get direct search
links to equivalent parts at other suppliers. See [spec.md](spec.md) for the
full design.

## Status

There are two independent ways to get a part's specs into this tool, and
only one of them is reliable.

**The server lookup (part number box, "Look up") is best-effort.**
McMaster doesn't gate specs behind login for anonymous visitors in general
-- it blocks *this server specifically* by request velocity (Akamai bot
scoring on datacenter IPs), and serves it a login wall even for parts that
load completely normally in your own browser seconds later. The backend
(`backend/`, on Render) still renders the live page with a real headless
Chrome instance and parses McMaster's own structured product record when
it does get through, and it's worth trying first because it's zero-effort
-- but treat a login-wall/blocked response as expected, not as something
broken to fix, and reach for the bookmarklet below.

**The bookmarklet works for every part, from your own browser, with no
server involved at all.** Drag the **"McMaster → Xref"** link (in the
"Install the bookmarklet" panel on the site, or in the fallback panel that
appears when a server lookup fails) to your bookmarks bar once. Then, on
any McMaster product page:

1. Click the bookmarklet.
2. It reads the part number, title, breadcrumbs and the full spec table
   directly out of the page you're already looking at (`frontend/bookmarklet.js`
   -- readable source, no obfuscation) and opens this site in a new tab
   with that data attached to the URL (`#r=...`, compressed and
   base64url-encoded -- see that file's header comment for the exact
   format).
3. This site decodes it and runs it through the exact same
   parse/classify/query/link pipeline the server uses
   (`backend/lib/product.js`, loaded in the browser as
   `frontend/vendor/product.js` -- one source of truth, no bundler) --
   entirely client-side. No fetch/XHR back to this site is involved in
   that step (McMaster's own CSP forbids it from the product page anyway);
   the only network activity is the `window.open` navigation, plus a
   fire-and-forget POST afterwards so the server's cache learns the
   record too (its failure changes nothing you see).

Because the bookmarklet runs in your real browser on your real connection,
it sees exactly what you see -- there is no anonymous-view budget, no bot
score, nothing to be blocked by.

**Paste-the-spec-block and manual entry still work** as further fallbacks
below the bookmarklet on the page, and both still go through the backend
(so they need `BACKEND_URL` reachable, unlike the bookmarklet path).
Pasting the spec block McMaster shows on the page is the fastest of the
two; manual entry is there for anything neither path resolves.

Supplier "results" are pre-filled search links, not scraped listings --
those sites block bots as hard as McMaster does, so this hands you their
native search instead of unreliable scraped results. The search phrase is
shown and is editable, and clicking an alternate phrasing swaps it, since
nothing here can promise the results on the far end are good.

Which suppliers get asked depends on what the part is, classified from its
breadcrumbs/spec fields (`classifyProduct` in `backend/lib/product.js`):
screws, nuts and washers go to the fastener houses (Fastenal, Grainger,
MSC, Bolt Depot, Amazon, AliExpress, Banggood), metal stock to the metal
suppliers (Speedy Metals, Metal Supermarkets, MSC, Grainger, Online
Metals), and everything else -- o-rings, gaskets, bearings, fittings -- to
the general MRO distributors (Grainger, MSC, Zoro, Amazon).

For parts with login-gated specs (an actual account-gated field, not the
server-blocking issue above), `scripts/mcmaster_scrape.py` is a separate,
optional local tool that drives a real logged-in browser on your own
machine instead -- see `scripts/README.md`.

## Architecture

- `frontend/` -- static site on **GitHub Pages**. Renders results from
  either the backend or a bookmarklet-decoded record, client-side, using
  the same `backend/lib/product.js` logic in both cases (synced into
  `frontend/vendor/product.js` -- see `scripts/sync-frontend.sh`).
- `frontend/bookmarklet.js` -- the bookmarklet's readable source. Built
  into a `javascript:` URL and embedded as the draggable links' `href` in
  `frontend/index.html` by `scripts/build-bookmarklet.js` (one source of
  truth; no hand-minified duplicate). Tested directly in
  `backend/test/bookmarklet.test.js`.
- `backend/` -- small Node/Express service on **Render** (free, no card
  required): launches headless Chrome to attempt a live render of the
  McMaster page, parses McMaster's structured product record when it gets
  one, and generates supplier links. See `backend/README.md`.

## Setup

The backend is already deployed and wired up:
`frontend/config.js` points at `https://mcmaster-xref-api.onrender.com`
(see [backend/README.md](backend/README.md) for details, or to redeploy
elsewhere). Only thing left:

### Enable GitHub Pages

Repo Settings -> Pages -> Source: **GitHub Actions**. The included workflow
(`.github/workflows/deploy-pages.yml`) publishes `frontend/` on every push
to `main`, after syncing `backend/lib/product.js` into
`frontend/vendor/product.js` and rebuilding the bookmarklet's URL (a no-op
when both are already committed up to date, which they normally are).

## Local development

Run `scripts/sync-frontend.sh` once after cloning (and again any time
`backend/lib/product.js` or `frontend/bookmarklet.js` change) -- it copies
`backend/lib/product.js` into `frontend/vendor/product.js` and rebuilds the
bookmarklet's `javascript:` URL into `frontend/index.html`. Then open
`frontend/index.html` directly in a browser (the bookmarklet path needs
nothing further; the server lookup and paste/manual paths need
`BACKEND_URL` reachable -- see `backend/README.md`).
