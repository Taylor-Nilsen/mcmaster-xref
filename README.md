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

Supplier "results" are pre-filled search links (Speedy Metals, MSC Direct,
Online Metals, Fastenal, Grainger, Bolt Depot, Amazon, AliExpress,
Banggood), not scraped listings -- those sites block bots as hard as
McMaster does, so this hands you their native search instead of unreliable
scraped results.

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

### 1. Deploy the backend

See [backend/README.md](backend/README.md) -- connect the repo on Render
(one Blueprint apply via `render.yaml`, or a few manual fields) and get a
public URL back.

### 2. Point the frontend at it

Edit `frontend/config.js`:

```js
const BACKEND_URL = "https://mcmaster-xref-backend.onrender.com";
```

Commit and push.

### 3. Enable GitHub Pages

Repo Settings -> Pages -> Source: **GitHub Actions**. The included workflow
(`.github/workflows/deploy-pages.yml`) publishes `frontend/` on every push
to `main`.

## Local development

Open `frontend/index.html` directly in a browser -- it just needs
`BACKEND_URL` reachable. See `backend/README.md` for backend notes.
