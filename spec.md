# McMaster-Carr Cross-Reference Tool — Spec

## Purpose
Given a McMaster-Carr part number, extract its specs and find equivalent parts on other retailers, across McMaster's full catalog (not limited to hardware/stock). McMaster's own price is not needed — the user already knows it and just wants to know if a cheaper equivalent exists elsewhere.

## Scope
All McMaster-Carr categories: raw stock (aluminum, brass, steel, carbon fiber tube/sheet, hex bar, round bar, tube stock), fasteners (bolts, nuts, screws, ball plungers, quarter-turn fasteners), keys and keystock, and any other category as it comes up. No category is out of scope — matching logic just needs to be robust enough to degrade gracefully on non-standardized items (e.g., PPE, branded parts).

## Architecture
- **One service** (`app/`), deployed on Render's free tier: a Node app that serves the static frontend and handles the fetching/matching logic from the same origin. A pure client-side (browser-only) version isn't possible — a browser blocks cross-origin responses via CORS unless the target server opts in, and McMaster doesn't, so no frontend-only JS can read McMaster's page directly. Some server-side piece is unavoidable; keeping it in the same service as the frontend (rather than a separately-deployed backend) avoids a second deploy, a config file, and CORS setup.

## Workflow
1. User submits a McMaster part number.
2. Worker fetches/parses the McMaster spec page for that part (material, dimensions, thread size, finish, grade, drive type, etc.).
3. Worker searches other suppliers for matching specs:
   - Raw stock: Speedy Metals, MSC Direct, Online Metals, Fastenal
   - Fasteners/hardware: Fastenal, Grainger, Bolt Depot, Amazon, AliExpress, Banggood
4. Worker returns a list of candidate equivalent listings with links (no price scraping from McMaster itself).
5. Frontend displays results for the user to manually judge fit/worth.

## Known constraints
- McMaster actively blocks scraping and gates full spec detail behind login — this is the hardest part of the build and may require creative workarounds (e.g., manual paste of spec fields as a fallback input mode if live scraping isn't reliable).
- Matching confidence will vary: raw stock and standard fasteners (DIN/ANSI specs) cross-reference cleanly; less standardized items will need fuzzier matching or manual review.
- No cost target beyond $0 — GitHub Pages + Cloudflare Workers free tier only.

## Open questions for next session
- Fallback approach if direct McMaster scraping proves unreliable/blocked (manual spec entry vs. browser-extension-assisted lookup)
- Whether to cache/store spec lookups to avoid repeat scraping of the same part number
