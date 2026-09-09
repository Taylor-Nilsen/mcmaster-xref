# McMaster-Carr Cross-Reference

Given a McMaster-Carr part number, extract its specs and get direct search
links to equivalent parts at other suppliers. See [spec.md](spec.md) for the
full design.

## Status

McMaster is a JS-only SPA (a plain HTTP fetch never sees real spec data),
so the backend uses a real headless Chrome instance to render the live
product page and read it after JS has run. Nothing to install, nothing to
click outside the app: type a part number, get a live result. It re-renders
the page fresh on every lookup, no caching.

Runs on **AWS Lambda's Always Free tier** (1,000,000 requests + 400,000
GB-seconds of compute per month, permanently -- not a 12-month trial),
which is what makes headless-Chrome rendering possible at $0. Cloudflare
Workers can't do this on their free tier -- their equivalent, Browser
Rendering, requires the Workers Paid plan.

Limits that are inherent to the site, not this implementation:
- It can't see anything McMaster gates behind account login -- the backend
  doesn't store or use McMaster credentials (storing a real login for an
  automated bot to reuse is a security/ToS risk not worth taking).
- First request after the Lambda has been idle a while is a few seconds
  slower (cold start). Free, just not instant every time.

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

- `frontend/` -- static site (GitHub Pages)
- `backend/` -- AWS Lambda function: launches headless Chrome to render
  the McMaster page live, parses specs, generates supplier links

## Setup

### 1. Deploy the backend

See [backend/README.md](backend/README.md) -- package the Lambda function,
create it in the AWS console, and turn on a public Function URL.

### 2. Point the frontend at it

Edit `frontend/config.js`:

```js
const BACKEND_URL = "https://<your-function-id>.lambda-url.<region>.on.aws/";
```

Commit that change.

### 3. Enable GitHub Pages

Repo Settings -> Pages -> Source: **GitHub Actions**. The included workflow
(`.github/workflows/deploy-pages.yml`) publishes `frontend/` on every push
to `main`.

## Local development

Open `frontend/index.html` directly in a browser -- it just needs
`BACKEND_URL` reachable. See `backend/README.md` for notes on the backend.
