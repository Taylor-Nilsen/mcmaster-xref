#!/usr/bin/env bash
# Keeps frontend/ in sync with the files it borrows from elsewhere in the
# repo, so there is one source of truth instead of a hand-copied fork:
#
#   - backend/lib/product.js -> frontend/vendor/product.js
#     Same file, loaded two ways: `require()` in Node (backend/test), and a
#     plain <script> tag in the browser (see the window.McmXref attachment
#     at the bottom of product.js). No bundler, no build step -- just a
#     copy, because the frontend is served as plain static files.
#
# Run this after editing backend/lib/product.js and before opening
# frontend/index.html locally. CI runs the same copy in
# .github/workflows/deploy-pages.yml before publishing to Pages, so a
# forgotten local run never ships a stale vendor copy.
#
# Also (re)builds the bookmarklet's javascript: URL and embeds it as the
# href of every draggable "McMaster -> Xref" link in frontend/index.html --
# see scripts/build-bookmarklet.js for why that is a build step and not a
# runtime fetch.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."

mkdir -p frontend/vendor
cp backend/lib/product.js frontend/vendor/product.js
echo "synced backend/lib/product.js -> frontend/vendor/product.js"

node scripts/build-bookmarklet.js
