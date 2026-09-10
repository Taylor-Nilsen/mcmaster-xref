# Backend: Render (free)

Renders the live McMaster page with real headless Chrome (Playwright) on
every request -- no caching. Separate from the frontend because GitHub
Pages (static-only) can't run this; the frontend calls it cross-origin
(CORS is handled in `server.js`).

Runs on [Render](https://render.com)'s free Web Service tier: no credit
card required to create one, so there's no way to rack up a surprise bill
even if the URL gets hit by something other than you -- worst case Render
just throttles or sleeps it.

## Deploy

**Easiest**: connect this repo in the Render dashboard and use the
included `render.yaml` (repo root) -- Render reads it as a Blueprint and
sets everything up in one go. New → Blueprint → pick this repo → Apply.

**If the Blueprint doesn't pick up cleanly**, set these manually when
creating the Web Service instead:

- Root directory: `backend`
- Environment: **Node**
- Build command: `npm install && npx playwright install --with-deps chromium`
- Start command: `node server.js`
- Instance type: **Free**

Render gives you a public URL (e.g.
`https://mcmaster-xref-backend.onrender.com`) -- copy it.

## Point the frontend at it

Edit `frontend/config.js`:

```js
const BACKEND_URL = "https://mcmaster-xref-backend.onrender.com";
```

Commit and push -- the GitHub Pages workflow picks it up automatically
(see main [README](../README.md)).

## Notes

- **Cold starts**: the free tier sleeps after 15 minutes with no traffic
  and takes ~30-60 seconds to wake on the next request (spinning the
  service back up, then launching Chromium for that request). Free, just
  not instant if it's been idle.
- **Redeploying after code changes**: push to the connected branch --
  Render rebuilds and redeploys automatically.
- **Local run**: `cd backend && npm install && npx playwright install --with-deps chromium && npm start`, then it's listening on `http://localhost:3000`.
