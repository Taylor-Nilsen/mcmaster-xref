# Personal McMaster scraper (local only)

The web app's worker deliberately doesn't try to scrape McMaster server-side
-- it's a JS-rendered SPA with active bot detection and a plain `fetch()`
never sees real spec data. This script sidesteps that the only way that
actually works: it drives a real Chromium browser through Playwright on
*your* machine, using *your* logged-in McMaster session, and reads the page
exactly as your browser rendered it. That's not scraping in the sense
McMaster blocks -- it's automating what you'd do by hand.

This is a personal lookup tool, separate from the deployed web app. It
doesn't call the worker or need any deployment -- just run it locally.

## Setup

```
cd scripts
pip install -r requirements.txt
playwright install chromium
```

## Use

```
python mcmaster_scrape.py 91251A540
python mcmaster_scrape.py 91251A540 91251A541 92196A106   # multiple parts
```

First run opens a visible browser window and pauses so you can log into
mcmaster.com yourself. That session is saved to a persistent profile
(`~/.mcmaster-xref-profile`), so later runs reuse it -- add `--headless`
once you've logged in at least once.

Each lookup prints extracted specs and supplier search links to the
terminal, and saves the full result (including the raw scraped text, useful
if spec extraction misses something) to `scripts/results/<part>.json`.

This is meant for the handful of parts you're actively cross-referencing,
not for crawling McMaster's catalog -- it adds a short delay between parts
and isn't built for volume.
