# Backend: Render (free)

Renders the live McMaster page with real headless Chrome (Playwright) on
every request -- no caching. Separate from the frontend because GitHub
Pages (static-only) can't run this; the frontend calls it cross-origin
(CORS is handled in `server.js`).

**Live at: `https://mcmaster-xref-api.onrender.com`** -- already deployed,
already wired up in `frontend/config.js`. Nothing left to do here unless
you're redeploying after a code change (pushing to this branch does that
automatically) or setting it up fresh elsewhere.

Runs on [Render](https://render.com)'s free Web Service tier: no credit
card required to create one, so there's no way to rack up a surprise bill
even if the URL gets hit by something other than you -- worst case Render
just throttles or sleeps it.

## Deploy (only needed for a fresh setup)

- Root directory: `backend`
- Environment: **Node**
- Build command: `npm install && npx playwright install chromium`
- Start command: `node server.js`
- Instance type: **Free**

Don't add `--with-deps` to the build command -- it tries to `apt-get`
system packages as root via `su`, which Render's build container refuses
("Authentication failure"). Plain `chromium` (no flag) just downloads the
browser binary, which is all that's needed; Render's Node image already
has the shared libraries Chromium wants at runtime.

## McMaster blocking headless Chrome

McMaster is known to detect and block plain headless Chromium (confirmed
by [mjbraun/mcmaster-agent](https://github.com/mjbraun/mcmaster-agent),
which had to solve this exact problem). `server.js` currently tries the
cheap fixes first: launch args and an init script that patch the common
automation fingerprints (`navigator.webdriver`, missing `window.chrome`,
etc.), no infra change needed.

If that's not enough, the fix that's actually proven to work is a
genuinely **headed** browser (not headless at all) via a virtual display
(Xvfb) -- but installing Xvfb needs root at build time, which Render's
native Node buildpack refuses (same wall as the `--with-deps` issue
above). That means switching this service to a **Docker** deploy, since
Docker builds run as root in your own image:

1. Add a `backend/Dockerfile`:
   ```dockerfile
   FROM mcr.microsoft.com/playwright:v1.55.0-jammy
   WORKDIR /app
   COPY package*.json ./
   RUN npm ci
   COPY server.js ./
   ENV PORT=3000
   CMD ["xvfb-run", "--auto-servernum", "node", "server.js"]
   ```
   (pin the image tag to match whatever `playwright` version is in
   `package.json` -- check with `npm ls playwright`)
2. In `server.js`, change `chromium.launch({...})` to add `headless: false`.
3. In the Render dashboard: New → Web Service → this repo → Render
   auto-detects the Dockerfile. Same free plan, same repo, new service
   (the existing Node-runtime service can't be converted in place).

This is a real, if small, dashboard step -- flagging it here rather than
doing it silently, since the current cheap-fix attempt might turn out to
be enough on its own.

## Notes

- **Cold starts**: the free tier sleeps after 15 minutes with no traffic
  and takes ~30-60 seconds to wake on the next request (spinning the
  service back up, then launching Chromium for that request). Free, just
  not instant if it's been idle.
- **Redeploying after code changes**: push to the connected branch --
  Render rebuilds and redeploys automatically.
- **Local run**: `cd backend && npm install && npx playwright install chromium && npm start`, then it's listening on `http://localhost:3000`.
- There's a second, broken Render service left over from getting this
  working (`mcmaster-xref-backend`, the one with `--with-deps` in its
  build command). It's inert and free -- safe to delete whenever you're in
  the Render dashboard for something else, no rush.
