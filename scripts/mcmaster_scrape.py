#!/usr/bin/env python3
"""
Personal McMaster-Carr part lookup, run locally.

Uses Playwright to drive a real Chromium browser through a persistent
profile on this machine. The first run opens a visible window so you can
log into mcmaster.com yourself; after that the session cookies are reused
automatically. Because it's your own real browser session doing exactly
what you'd do by hand, none of McMaster's bot detection applies -- this
is not the blocked server-side scraping the web app's worker tried and
gave up on.

This is a personal single/few-part lookup tool, not a bulk crawler: it
adds a delay between parts and is meant for the handful of part numbers
you're actively cross-referencing, not for mirroring McMaster's catalog.

Usage:
    pip install -r requirements.txt
    playwright install chromium
    python mcmaster_scrape.py 91251A540 [91251A541 ...]
"""

import argparse
import json
import re
import sys
import time
from pathlib import Path
from urllib.parse import quote

PROFILE_DIR = Path.home() / ".mcmaster-xref-profile"
RESULTS_DIR = Path(__file__).resolve().parent / "results"
DELAY_BETWEEN_PARTS_SECONDS = 2.5

KEY_MAP = {
    "material": "material",
    "shape": "shape",
    "thread size": "threadSize",
    "thread pitch": "threadSize",
    "length": "length",
    "diameter": "diameter",
    "outside diameter": "diameter",
    "od": "diameter",
    "thickness": "thickness",
    "width": "width",
    "drive style": "driveType",
    "drive type": "driveType",
    "head type": "headType",
    "finish": "finish",
    "grade": "grade",
    "class": "grade",
}

MATERIALS = [
    "18-8 stainless steel", "316 stainless steel", "stainless steel",
    "carbon fiber", "aluminum", "brass", "bronze", "copper", "titanium",
    "alloy steel", "carbon steel", "steel", "nylon", "polycarbonate",
    "acetal", "delrin", "pvc", "rubber",
]
DRIVE_TYPES = ["hex", "phillips", "slotted", "torx", "socket", "square", "combination"]
FINISHES = ["zinc plated", "black oxide", "galvanized", "chrome plated", "plain", "anodized", "powder coated"]

# Verified against real responses (see backend/server.js's checkSupplierUrls
# diagnostic) -- most originally-guessed internal search URLs turned out
# wrong (404s, or a right-looking param landing on a "no results" page).
# Only Grainger, AliExpress, and Banggood get a direct site search link;
# everything else routes through a site-scoped Google search instead of an
# undocumented internal URL scheme that can silently break on a redesign.
RAW_STOCK_SUPPLIERS = [
    ("Speedy Metals", "https://www.google.com/search?q={gq}"),
    ("MSC Direct", "https://www.google.com/search?q={gq}"),
    ("Online Metals", "https://www.google.com/search?q={gq}"),
]
FASTENER_SUPPLIERS = [
    ("Fastenal", "https://www.google.com/search?q={gq}"),
    ("Grainger", "https://www.grainger.com/search?searchQuery={q}&searchBar=true"),
    ("Bolt Depot", "https://www.google.com/search?q={gq}"),
    ("Amazon", "https://www.google.com/search?q={gq}"),
    ("AliExpress", "https://www.aliexpress.com/wholesale?SearchText={q}"),
    ("Banggood", "https://www.banggood.com/search/{q}-products.html"),
]
SUPPLIER_DOMAINS = {
    "Speedy Metals": "speedymetals.com",
    "MSC Direct": "mscdirect.com",
    "Online Metals": "onlinemetals.com",
    "Fastenal": "fastenal.com",
    "Bolt Depot": "boltdepot.com",
    "Amazon": "amazon.com",
}


def parse_key_value(text):
    specs = {}
    for line in text.splitlines():
        m = re.match(r"^\s*([A-Za-z][A-Za-z /]{1,40}?)\s*[:\-]\s*(.{1,80}?)\s*$", line)
        if not m:
            continue
        key = KEY_MAP.get(m.group(1).strip().lower())
        if key and key not in specs:
            specs[key] = m.group(2).strip()
    return specs


def parse_fuzzy(text):
    lower = text.lower()
    specs = {}

    material = next((m for m in MATERIALS if m in lower), None)
    if material:
        specs.setdefault("material", material)

    drive = next((d for d in DRIVE_TYPES if d in lower), None)
    if drive:
        specs.setdefault("driveType", drive)

    finish = next((f for f in FINISHES if f in lower), None)
    if finish:
        specs.setdefault("finish", finish)

    thread = re.search(r'(#\d{1,2}-\d{2,3}|\d{1,2}/\d{1,2}"?-\d{1,2}|M\d{1,2}(?:\.\d)?\s*x\s*\d(?:\.\d+)?)', text, re.I)
    if thread:
        specs.setdefault("threadSize", thread.group(1).replace(" ", ""))

    length = re.search(r'(\d+(?:\.\d+)?\s?(?:/\s?\d+)?)"?\s*(?:long|length)', text, re.I)
    if length:
        specs.setdefault("length", f'{length.group(1).strip()}"')

    diameter = re.search(r'(\d+(?:\.\d+)?(?:/\d+)?)"?\s*(?:dia(?:meter)?|od|o\.d\.)', text, re.I)
    if diameter:
        specs.setdefault("diameter", f'{diameter.group(1).strip()}"')

    grade = re.search(r"(grade\s?\d+|class\s?\d+(?:\.\d+)?)", text, re.I)
    if grade:
        specs.setdefault("grade", grade.group(1))

    return specs


def build_supplier_links(specs):
    query = " ".join(
        specs[k] for k in ("material", "shape", "threadSize", "diameter", "thickness", "width", "length", "driveType", "finish", "grade")
        if specs.get(k)
    )
    if not query:
        return []

    q = quote(query)
    if specs.get("threadSize") or specs.get("driveType"):
        suppliers = FASTENER_SUPPLIERS
    elif specs.get("shape"):
        suppliers = RAW_STOCK_SUPPLIERS
    else:
        suppliers = RAW_STOCK_SUPPLIERS + FASTENER_SUPPLIERS

    links = []
    for name, url in suppliers:
        gq = quote(f"site:{SUPPLIER_DOMAINS[name]} {query}") if name in SUPPLIER_DOMAINS else ""
        links.append({"name": name, "url": url.format(q=q, gq=gq), "query": query})
    return links


def scrape_part(page, part_number):
    url = f"https://www.mcmaster.com/{part_number}/"
    page.goto(url, wait_until="networkidle", timeout=45000)
    page.wait_for_timeout(1500)  # let any late client-side render settle

    title = page.title()
    body_text = page.inner_text("body")
    full_text = f"{title}\n{body_text}"

    specs = {**parse_fuzzy(full_text), **parse_key_value(full_text)}
    return {
        "partNumber": part_number,
        "sourceUrl": url,
        "title": title,
        "specs": specs,
        "links": build_supplier_links(specs),
        "rawText": full_text[:20000],
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("part_numbers", nargs="+", help="McMaster part number(s), e.g. 91251A540")
    parser.add_argument("--headless", action="store_true", help="Run headless (only works after you've logged in once)")
    args = parser.parse_args()

    try:
        from playwright.sync_api import sync_playwright
    except ImportError:
        sys.exit("Missing dependency. Run: pip install -r requirements.txt && playwright install chromium")

    RESULTS_DIR.mkdir(exist_ok=True)
    PROFILE_DIR.mkdir(exist_ok=True)

    with sync_playwright() as p:
        context = p.chromium.launch_persistent_context(
            str(PROFILE_DIR),
            headless=args.headless,
            viewport={"width": 1280, "height": 900},
        )
        page = context.new_page()

        if not args.headless and not any(PROFILE_DIR.glob("**/Cookies*")):
            page.goto("https://www.mcmaster.com/login/")
            print("Log into McMaster in the opened browser window, then press Enter here...")
            input()

        for i, part in enumerate(args.part_numbers):
            print(f"\nLooking up {part} ...")
            try:
                result = scrape_part(page, part)
            except Exception as err:
                print(f"  Failed: {err}")
                continue

            out_path = RESULTS_DIR / f"{part}.json"
            out_path.write_text(json.dumps(result, indent=2))

            if result["specs"]:
                print(f"  Specs: {result['specs']}")
            else:
                print(f"  No specs extracted -- check {out_path} for the raw scraped text")
            for link in result["links"]:
                print(f"  -> {link['name']}: {link['url']}")
            print(f"  Saved: {out_path}")

            if i < len(args.part_numbers) - 1:
                time.sleep(DELAY_BETWEEN_PARTS_SECONDS)

        context.close()


if __name__ == "__main__":
    main()
