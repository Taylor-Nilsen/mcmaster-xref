#!/usr/bin/env python3
"""
Ingest a McMaster-Carr catalog PDF into a part-number -> specs JSON index.

Runs entirely on your own machine against your own copy of the PDF --
nothing gets uploaded anywhere. The file is too big to hand to Claude
directly (347MB, blocked by both network policy and Drive API limits in
that environment), but the JSON this produces is small enough to just
paste/commit.

Usage:
    pip install pymupdf

    # Test on a small slice first -- catalog layout varies by section,
    # so check the output looks right before running the whole thing.
    python ingest_catalog_pdf.py "McMaster-Carr Catalog 123.pdf" --start-page 500 --end-page 510 --out sample.json

    # Once the sample looks right, run the full catalog (will take a
    # while for several thousand pages):
    python ingest_catalog_pdf.py "McMaster-Carr Catalog 123.pdf" --out catalog_index.json

Extraction approach: for each page, find part-number-shaped tokens
(McMaster's format, e.g. 91251A540) in the page text. Specs stated once
for the whole page/table (material, standard, etc.) get attached to every
part number found on that page; specs found in the specific line(s)
mentioning a given part number (its row in a size/length table) override
those page-level ones. This is a heuristic, not a real table parser --
catalog page layouts vary, which is exactly why the small-range test
first matters. Send me a sample.json from a test run and I'll tune the
patterns against real output instead of guessing blind.

Pricing is not extracted -- catalog 123 is an old edition (per Taylor),
prices in it are stale and this project doesn't need McMaster's own
price anyway (see spec.md).
"""

import argparse
import json
import re
import sys

# McMaster's part number format: digits, one letter, digits (e.g. 91251A540)
PART_NUMBER_RE = re.compile(r"\b\d{2,6}[A-Z]\d{2,4}\b")

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
    "system of measurement": "measurementSystem",
}

PRICE_LINE_RE = re.compile(r"\$\s?\d")


def parse_key_value(text):
    specs = {}
    for line in text.splitlines():
        if PRICE_LINE_RE.search(line):
            continue  # skip pricing lines entirely -- old/stale data, not used
        m = re.match(r"^\s*([A-Za-z][A-Za-z /]{1,40}?)\s*[:\-]\s*(.{1,80}?)\s*$", line)
        if not m:
            continue
        key = KEY_MAP.get(m.group(1).strip().lower())
        if key and key not in specs:
            specs[key] = m.group(2).strip()
    return specs


def extract_page(text, page_num):
    part_numbers = set(PART_NUMBER_RE.findall(text))
    if not part_numbers:
        return {}

    page_specs = parse_key_value(text)
    lines = text.splitlines()
    results = {}

    for pn in part_numbers:
        row_context = []
        for i, line in enumerate(lines):
            if pn in line:
                row_context.extend(lines[max(0, i - 1) : i + 2])
        row_specs = parse_key_value("\n".join(row_context))

        specs = {**page_specs, **row_specs}
        if specs:
            results[pn] = {**specs, "sourcePage": page_num}

    return results


def main():
    parser = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter
    )
    parser.add_argument("pdf_path")
    parser.add_argument("--start-page", type=int, default=1, help="1-indexed, inclusive")
    parser.add_argument("--end-page", type=int, default=None, help="1-indexed, inclusive; default = last page")
    parser.add_argument("--out", default="catalog_index.json")
    args = parser.parse_args()

    try:
        import fitz  # PyMuPDF
    except ImportError:
        sys.exit("Missing dependency. Run: pip install pymupdf")

    doc = fitz.open(args.pdf_path)
    total_pages = len(doc)
    start_page = max(1, args.start_page)
    end_page = min(total_pages, args.end_page or total_pages)

    print(f"Processing pages {start_page}-{end_page} of {total_pages}...")

    index = {}
    for page_num in range(start_page, end_page + 1):
        text = doc[page_num - 1].get_text()
        index.update(extract_page(text, page_num))
        if page_num % 100 == 0:
            print(f"  ...page {page_num}, {len(index)} parts so far")

    doc.close()

    with open(args.out, "w") as f:
        json.dump(index, f, indent=2)

    print(f"Done. {len(index)} part numbers indexed -> {args.out}")


if __name__ == "__main__":
    main()
