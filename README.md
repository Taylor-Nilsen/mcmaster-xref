# McMaster-Carr Cross-Reference

Given a McMaster-Carr part number, extract its specs and get direct search
links to equivalent parts at other suppliers. See [spec.md](spec.md) for the
full design.

## Status

McMaster is a JS-only SPA (a plain HTTP fetch never sees real spec data),
so the backend uses a real headless Chrome instance (Playwright) to render
the live product page and read it after JS has run. It re-renders fresh on
every lookup -- no caching.

This can't be done purely client-side, and GitHub Pages (static-only)
can't run a server itself -- hence the split: a static frontend on Pages,
and a small backend elsewhere that does the actual rendering. The frontend
calls it cross-origin.

Limits that are inherent to the site, not this implementation:
- It can't see anything McMaster gates behind account login -- the backend
  doesn't store or use McMaster credentials (storing a real login for an
  automated bot to reuse is a security/ToS risk not worth taking).
- First request after the backend has been idle a while is slower (cold
  start -- see `backend/README.md`). Free, just not instant every time.

Manual spec entry in the UI is always available as a fallback and overrides
whatever the live render found.

The parser and query builder (`backend/lib/specs.js`) also run in the
browser: `frontend/specs.js` is a copy of it (`npm run sync-frontend`
after editing; a test fails if the two differ). A pasted spec block or hand-entered specs are answered on
the device with no backend call, so that path is instant, skips the cold
start, and works offline. Only a bare part number goes to the backend.

**The bookmarklet is the path that works for every part.** McMaster walls
lookups from datacenter addresses: a 19-lookup sweep of non-hardware parts
(valves, wire, fuses, switches, sensors, motors, PPE, adhesives) through the
Render backend on 23 Sep 2026 came back LOGIN_WALL or FETCH_FAILED on every
one. The bookmarklet reads the part page in the person's own browser,
where McMaster serves it normally (in full, when logged in), and sends the
text to this page in the URL hash, which never leaves the device. The page
parses it locally. Setup steps for desktop, iPhone and Android are on the
page itself.

On a phone: the page installs to the home screen (manifest + service
worker), has a "Paste from clipboard and look up" button for gated parts,
links straight to the part on mcmaster.com, and `?pn=91251A540` in the URL
runs that lookup on open.

A headless browser can't be dropped from the backend. McMaster's spec
table comes from `/WebParts/Navigate/ItmPrsnttnWebPart.aspx`, which sits
behind Akamai Bot Manager and returns 403 without the `_abck` cookie that
only its in-page sensor script sets. The backend keeps one Chromium
running between lookups (a new context per lookup) and skips images, fonts
and media to cut render time.

Parts the noun table doesn't know (valves, fuses, motors, casters, PPE,
cutting tools, framing) are searched by the product title from the page,
plus the size-type values a buyer would search on (pipe size, voltage,
wire gauge, flutes, series), and go to the general distributors.

Supplier "results" are pre-filled search links, not scraped listings -- those sites block bots as hard as
McMaster does, so this hands you their native search instead of unreliable
scraped results.

Which suppliers get asked depends on what the part is, read from the
product name on the page: screws, nuts and washers go to the fastener
houses (Fastenal, Grainger, MSC, Bolt Depot, Amazon, AliExpress), metal
stock to the metal suppliers (Speedy Metals, Metal Supermarkets, MSC,
Grainger), and everything else -- o-rings, gaskets, bearings -- to the
general MRO distributors. The "Part type" box under manual entry
overrides that when the page name is wrong or unavailable.

For parts with login-gated specs, `scripts/mcmaster_scrape.py` is a
separate, optional local tool that drives a real logged-in browser on your
own machine instead -- see `scripts/README.md`.

## Architecture

- `frontend/` -- static site on **GitHub Pages** (matches your GitHub Pro
  account)
- `backend/` -- small Node/Express service on **Render** (free, no card
  required): launches headless Chrome to render the McMaster page live,
  parses specs, generates supplier links

## Setup

The backend is already deployed and wired up:
`frontend/config.js` points at `https://mcmaster-xref-api.onrender.com`
(see [backend/README.md](backend/README.md) for details, or to redeploy
elsewhere). Only thing left:

### Enable GitHub Pages

Repo Settings -> Pages -> Source: **GitHub Actions**. The included workflow
(`.github/workflows/deploy-pages.yml`) publishes `frontend/` on every push
to `main`.

## Local development

Open `frontend/index.html` directly in a browser -- it just needs
`BACKEND_URL` reachable. See `backend/README.md` for backend notes.
