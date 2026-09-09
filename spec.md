# McMaster-Carr Cross-Reference Tool — Spec

## Purpose
Given a McMaster-Carr part number, extract its specs and find equivalent parts on other retailers, across McMaster's full catalog (not limited to hardware/stock). McMaster's own price is not needed — the user already knows it and just wants to know if a cheaper equivalent exists elsewhere.

## Scope
All McMaster-Carr categories: raw stock (aluminum, brass, steel, carbon fiber tube/sheet, hex bar, round bar, tube stock), fasteners (bolts, nuts, screws, ball plungers, quarter-turn fasteners), keys and keystock, and any other category as it comes up. No category is out of scope — matching logic just needs to be robust enough to degrade gracefully on non-standardized items (e.g., PPE, branded parts).

## Architecture
- **Frontend:** Static site on GitHub Pages (input box for McMaster part number, results display). Free, matches existing GitHub Pro account.
- **Backend:** Cloudflare Worker (free tier) handles the actual fetching/scraping and matching logic — needed because GitHub Pages can't do server-side requests or dodge CORS/bot-blocking on its own.

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
