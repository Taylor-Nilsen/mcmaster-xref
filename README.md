# McMaster-Carr Cross-Reference

Given a McMaster-Carr part number, extract its specs and get direct search
links to equivalent parts at other suppliers. See [spec.md](spec.md) for the
full design.

## Status

McMaster gates most spec detail behind login/client-side rendering, so
automatic parsing only works when the part's `<title>`/meta description
happen to carry enough detail (fasteners and simple stock tend to; unusual
parts often won't). Manual spec entry in the UI always works as a fallback
and is merged on top of anything auto-parsed.

Supplier "results" are pre-filled search links (Speedy Metals, MSC Direct,
Online Metals, Fastenal, Grainger, Bolt Depot, Amazon, AliExpress,
Banggood), not scraped listings — those sites block bots as hard as
McMaster does, so this hands you their native search instead of unreliable
scraped results.

## Architecture

- `frontend/` — static site (GitHub Pages)
- `worker/` — Cloudflare Worker (fetch/parse + supplier link generation)

## Setup

### 1. Deploy the worker

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
worker testing.
