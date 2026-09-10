# McMaster-Carr Cross-Reference

Given a McMaster-Carr part number, extract its specs and get direct search
links to equivalent parts at other suppliers. See [spec.md](spec.md) for the
full design.

## Status

McMaster is a JS-only SPA (a plain HTTP fetch never sees real spec data),
so the app uses a real headless Chrome instance (Playwright) to render the
live product page and read it after JS has run. It re-renders fresh on
every lookup -- no caching.

This can't be done purely client-side: a browser blocks cross-origin
responses via CORS unless the target server opts in, and McMaster doesn't,
so no amount of frontend-only JS can read McMaster's page directly. A
server-side piece is unavoidable -- but it's now the *same* service as the
frontend (see Architecture below), not a separate deploy.

Limits that are inherent to the site, not this implementation:
- It can't see anything McMaster gates behind account login -- the app
  doesn't store or use McMaster credentials (storing a real login for an
  automated bot to reuse is a security/ToS risk not worth taking).
- First request after the service has been idle a while is slower (cold
  start -- see `app/README.md`). Free, just not instant every time.

Manual spec entry in the UI is always available as a fallback and overrides
whatever the live render found.

Supplier "results" are pre-filled search links (Speedy Metals, MSC Direct,
Online Metals, Fastenal, Grainger, Bolt Depot, Amazon, AliExpress,
Banggood), not scraped listings -- those sites block bots as hard as
McMaster does, so this hands you their native search instead of unreliable
scraped results.

For parts with login-gated specs, `scripts/mcmaster_scrape.py` is a
separate, optional local tool that drives a real logged-in browser on your
own machine instead -- see `scripts/README.md`. That one's necessarily
separate: it needs *your* browser session, which nothing running on a
public server can have.

## Architecture

One service, `app/`:
- `app/server.js` serves the static frontend (`app/public/`) and handles
  `POST /api/xref` (headless-render + parse + supplier-link generation)
  from the same origin. No CORS setup, no config file pointing the
  frontend at a separately-deployed backend -- there isn't one.

Runs on [Render](https://render.com)'s free tier (no credit card
required). See [app/README.md](app/README.md) for deploy steps.

## Setup

1. Push this repo to GitHub (already done if you're reading this from the
   repo).
2. Follow [app/README.md](app/README.md) to deploy on Render -- one
   Blueprint apply, or a few fields filled in by hand. You get a URL back
   and that's the whole app, frontend and live lookup together.

## Local development

```
cd app
npm install
npx playwright install --with-deps chromium
npm start
```

Then open `http://localhost:3000`.
