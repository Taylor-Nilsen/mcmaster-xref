# McMaster-Carr Cross-Reference

Given a McMaster-Carr part number, extract its specs and get direct search
links to equivalent parts at other suppliers. See [spec.md](spec.md) for the
full design.

## Status

McMaster is a JS-only SPA (a plain `fetch()` never sees real spec data), so
the worker uses **Cloudflare Browser Rendering** — a real headless Chrome
instance that runs server-side, loads the actual McMaster product page, and
reads it after JS has rendered. Nothing to install, nothing to click
outside the app: type a part number, get a live result. It re-renders the
page fresh on every lookup, no caching.

Limits that are inherent to the site, not this implementation:
- It can't see anything McMaster gates behind account login — the worker
  doesn't store or use McMaster credentials (storing a real login for an
  automated bot to reuse is a security/ToS risk not worth taking).
- **Requires the Cloudflare Workers Paid plan ($5/mo)** — Browser
  Rendering isn't on the free tier, so this misses spec.md's original $0
  target. Everything else (Workers requests, GitHub Pages) is still free.

Manual spec entry in the UI is always available as a fallback and overrides
whatever the live render found.

Supplier "results" are pre-filled search links (Speedy Metals, MSC Direct,
Online Metals, Fastenal, Grainger, Bolt Depot, Amazon, AliExpress,
Banggood), not scraped listings — those sites block bots as hard as
McMaster does, so this hands you their native search instead of unreliable
scraped results.

For parts with login-gated specs, `scripts/mcmaster_scrape.py` is a
separate, optional local tool that drives a real logged-in browser on your
own machine instead — see `scripts/README.md`.

## Architecture

- `frontend/` — static site (GitHub Pages)
- `worker/` — Cloudflare Worker: launches a headless browser to render the
  McMaster page live, parses specs, generates supplier links

## Setup

### 1. Enable Browser Rendering and deploy the worker

Browser Rendering requires a Workers Paid plan. In the Cloudflare
dashboard: Workers & Pages → Plans → upgrade, then:

```
cd worker
npm install
npx wrangler login
npx wrangler deploy
```

Copy the deployed URL (`https://mcmaster-xref.<subdomain>.workers.dev`).

### 2. Point the frontend at it

Edit `frontend/config.js`:

```js
const WORKER_URL = "https://mcmaster-xref.<subdomain>.workers.dev";
```

Commit that change.

### 3. Enable GitHub Pages

Repo Settings → Pages → Source: **GitHub Actions**. The included workflow
(`.github/workflows/deploy-pages.yml`) publishes `frontend/` on every push
to `main`.

## Local development

Open `frontend/index.html` directly in a browser (it just needs
`WORKER_URL` reachable), or run `npx wrangler dev` in `worker/` for local
worker testing (Browser Rendering also works in `wrangler dev`, proxied
through your Cloudflare account).
