# McMaster-Carr Cross-Reference

Given a McMaster-Carr part number, extract its specs and get direct search
links to equivalent parts at other suppliers. See [spec.md](spec.md) for the
full design.

## Status

McMaster is a JS-rendered SPA with active anti-bot protection, so a
server-side fetch from the worker only ever sees `<title>`/meta description
and will miss most of the time — that's not a bug to fix, it's how McMaster
is built. Three lookup paths, in order of reliability:

1. **Bookmarklet** (best) — the page renders a "Scrape this McMaster page"
   link built from `frontend/bookmarklet.js`. Drag it to your bookmarks bar,
   open the part on mcmaster.com, click it there. It reads the *rendered*
   DOM in your own logged-in browser — not automation McMaster's bot
   detection would flag, since it's a user script you trigger yourself —
   and opens this app with the real specs pre-filled.
2. **Paste specs** — copy the specifications block off the McMaster page
   into the "Paste specs" box in manual entry; the worker parses `Key:
   Value` lines directly.
3. **Manual field entry** — always available, always wins (highest priority
   in the merge: mcmaster fetch < pasted/scraped text < manual fields).

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
