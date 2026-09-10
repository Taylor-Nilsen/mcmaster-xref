# McMaster-Carr Cross-Reference Tool — Spec

## Purpose
Given a McMaster-Carr part number, extract its specs and find equivalent parts on other retailers, across McMaster's full catalog (not limited to hardware/stock). McMaster's own price is not needed — the user already knows it and just wants to know if a cheaper equivalent exists elsewhere.

## Scope
All McMaster-Carr categories: raw stock (aluminum, brass, steel, carbon fiber tube/sheet, hex bar, round bar, tube stock), fasteners (bolts, nuts, screws, ball plungers, quarter-turn fasteners), keys and keystock, and any other category as it comes up. No category is out of scope — matching logic just needs to be robust enough to degrade gracefully on non-standardized items (e.g., PPE, branded parts).

## Architecture
- **Frontend:** Static site on GitHub Pages (input box for McMaster part number, results display). Free, matches existing GitHub Pro account.
- **Backend:** Node/Express service on Render's free tier (no card required) handles the actual fetching/scraping and matching logic — needed because GitHub Pages can't run server code, and McMaster's JS-rendered pages need a real headless browser to read (Playwright). A pure client-side (browser-only) version isn't possible either: a browser blocks cross-origin responses via CORS unless the target server opts in, and McMaster doesn't, so no frontend-only JS can read McMaster's page directly regardless of where that JS is hosted.

## Workflow
1. User submits a McMaster part number.
2. Worker fetches/parses the McMaster spec page for that part (material, dimensions, thread size, finish, grade, drive type, etc.).
3. Worker searches other suppliers for matching specs:
   - Raw stock: Speedy Metals, MSC Direct, Online Metals, Fastenal
   - Fasteners/hardware: Fastenal, Grainger, Bolt Depot, Amazon, AliExpress, Banggood
4. Worker returns a list of candidate equivalent listings with links (no price scraping from McMaster itself).
5. Frontend displays results for the user to manually judge fit/worth.

## Known constraints
- McMaster gates spec detail behind an **anonymous page-view allowance**, not bot detection. Headless Chromium with light fingerprint patching renders product pages and parses all 8 spec fields reliably — until the allowance runs out, after which every URL returns a ~776-char page reading "To continue browsing, please log in." Rendering many parts in a batch exhausts it and takes the whole feature down; the app therefore caches per part number, retries once, never batch-renders, and falls back to manual entry with an honest message.
- Matching confidence will vary: raw stock and standard fasteners (DIN/ANSI specs) cross-reference cleanly; less standardized items will need fuzzier matching or manual review.
- No cost target beyond $0 — GitHub Pages + Cloudflare Workers free tier only.

## Resolved (verified against live responses, not assumed)
- **Fallback if McMaster scraping is blocked** → manual spec entry, which the UI opens automatically when nothing could be fetched. There is no automated second source: a plain HTTP fetch of a product page returns 200 and ~151KB of Angular shell with zero spec values; McMaster's own `WebSrchEng.aspx` JSON endpoint answers without a login but only validates a part number and returns its family and catalog page, not the spec table; and Bing, Google, MROSupply and MPParts were each fetched and none yields a usable spec description for a part number.
- **Whether to cache spec lookups** → yes, and not as an optimization. Page views are the scarce resource, so caching is what keeps the feature alive.
- **Verifying supplier links from the server** → not possible. Every supplier refuses a datacenter client: Fastenal 403, MSC "Pardon Our Interruption", Bolt Depot a Cloudflare challenge, Amazon 503, and Grainger a byte-identical "Whoops, we couldn't find that." for nine different queries including a bare "socket head cap screw". Its no-results page is a bot wall, not a verdict on the query. Since the links open in the user's own browser, where these sites behave normally, the UI exposes the search phrase as an editable field instead of asserting the results are good.
