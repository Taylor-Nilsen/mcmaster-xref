# App: one service, Render (free)

`server.js` serves the static frontend (`public/`) *and* handles
`POST /api/xref` from the same origin -- no CORS to configure, no separate
backend URL to paste into a config file. One repo, one deploy.

Runs on [Render](https://render.com)'s free Web Service tier: no credit
card required to create one, so there's no way to rack up a surprise bill
even if the URL gets hit by something other than you -- worst case Render
just throttles or sleeps it.

## Deploy

**Easiest**: connect this repo in the Render dashboard and use the
included `render.yaml` (repo root) -- Render reads it as a Blueprint and
sets everything up (build command, start command, root directory) in one
go. New → Blueprint → pick this repo → Apply.

**If the Blueprint doesn't pick up cleanly**, set these manually when
creating the Web Service instead:

- Root directory: `app`
- Environment: **Node**
- Build command: `npm install && npx playwright install --with-deps chromium`
- Start command: `node server.js`
- Instance type: **Free**

Render gives you a public URL immediately
(`https://mcmaster-xref.onrender.com` or similar) -- that's it, nothing
else to configure. Open it and use the app.

## Notes

- **Cold starts**: the free tier sleeps after 15 minutes with no traffic
  and takes ~30-60 seconds to wake on the next request (spinning the
  service back up, then launching Chromium for that request). Free, just
  not instant if it's been idle.
- **Redeploying after code changes**: push to the connected branch --
  Render rebuilds and redeploys automatically.
- **Local run**: `cd app && npm install && npx playwright install --with-deps chromium && npm start`, then open `http://localhost:3000`.
