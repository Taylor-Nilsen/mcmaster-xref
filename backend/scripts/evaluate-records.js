#!/usr/bin/env node
/**
 * Runs every captured McMaster record (both this run's
 * backend/test/fixtures/mcmaster/remote/*.json and the pre-existing
 * backend/test/fixtures/mcmaster/sweep/*.json) through
 * lib/product.js's parseProductRecord / classifyProduct / buildQueries /
 * buildSupplierLinks, and prints a markdown table for REPORT.md.
 *
 * Two input shapes are handled:
 *   - sweep/*.json: already a raw McMaster page record (PartNbrTxt,
 *     TitleTxt, ReactData.TableEntries, ...) -- parseProductRecord's native
 *     input shape, fed straight in.
 *   - remote/*.json: this app's own POST /api/xref RESPONSE shape (source,
 *     product: {partNumber, title, family, categoryPath, attributes:
 *     [{group, name, value}]}), since remote-sweep.js talks to the deployed
 *     API, not McMaster directly, and never sees a raw page record. Each
 *     one is rebuilt into a McMaster-shaped record here:
 *       { PartNbrTxt, TitleTxt,
 *         TargetPageMetadata: { ProductFamily },
 *         ReactData: { Breadcrumbs: categoryPath.map(n => ({Name:n})),
 *                       TableEntries: [...] } }
 *     TableEntries is reconstructed from the flat `attributes` list: a
 *     group header row ({Name: group, Value: "", IsIndented: false}) is
 *     inserted right before the first attribute of each group, and every
 *     attribute row under a group gets IsIndented: true -- the exact shape
 *     parseProductRecord's own TableEntries walk expects (see lib/product.js).
 *
 * Usage: node backend/scripts/evaluate-records.js [--json]
 *   --json prints one JSON object per record instead of the markdown table
 *   (useful for scripting), otherwise prints the markdown table to stdout.
 */

"use strict";

const fs = require("fs");
const path = require("path");
const { parseProductRecord, classifyProduct, buildQueries, buildSupplierLinks } = require("../lib/product");

const REMOTE_DIR = path.join(__dirname, "..", "test", "fixtures", "mcmaster", "remote");
const SWEEP_DIR = path.join(__dirname, "..", "test", "fixtures", "mcmaster", "sweep");

function listJsonFiles(dir) {
  try {
    return fs
      .readdirSync(dir)
      .filter((f) => f.endsWith(".json"))
      .map((f) => path.join(dir, f));
  } catch {
    return [];
  }
}

/** Rebuilds a McMaster-shaped record from a POST /api/xref response's
 * `product` field (see file header for the exact shape contract). */
function recordFromApiProduct(product) {
  const tableEntries = [];
  let openGroup = null;
  for (const attr of product.attributes || []) {
    const group = attr.group || null;
    if (group && group !== openGroup) {
      tableEntries.push({ Name: group, Value: "", IsIndented: false, Type: "TableEntrySpec" });
      openGroup = group;
    } else if (!group) {
      openGroup = null;
    }
    tableEntries.push({
      Name: attr.name,
      Value: attr.value,
      IsIndented: Boolean(group),
      Type: "TableEntrySpec",
    });
  }
  return {
    PartNbrTxt: product.partNumber || "",
    TitleTxt: product.title || "",
    TargetPageMetadata: { ProductFamily: product.family || null },
    ReactData: {
      Breadcrumbs: (product.categoryPath || []).map((name) => ({ Name: name })),
      TableEntries: tableEntries,
      Copies: [],
    },
    CtlgPgNbrs: [],
  };
}

/** Loads one input file and returns { part, record, sourceFile, sourceKind }
 * or null if the file cannot supply a usable record (e.g. a failed/blocked
 * capture that has no `product`, which should not happen for a file that
 * made it to disk, since remote-sweep.js only writes successful captures --
 * defensive here anyway). */
function loadRecord(filePath, kind) {
  const part = path.basename(filePath, ".json");
  const raw = JSON.parse(fs.readFileSync(filePath, "utf8"));
  if (kind === "remote") {
    if (!raw.product) return null;
    return { part, record: recordFromApiProduct(raw.product), sourceFile: filePath, sourceKind: kind };
  }
  // sweep/*.json is already a raw McMaster record.
  return { part, record: raw, sourceFile: filePath, sourceKind: kind };
}

function collectRecords() {
  const remoteFiles = listJsonFiles(REMOTE_DIR);
  const sweepFiles = listJsonFiles(SWEEP_DIR).filter((f) => path.basename(f) !== "REPORT.md");
  const byPart = new Map();
  // sweep/ first, then remote/ -- if somehow both exist for the same part
  // (shouldn't, given remote-sweep.js's own skip logic), remote/ (this
  // run's own fresh capture) wins as the more recent one.
  for (const f of sweepFiles) {
    const entry = loadRecord(f, "sweep");
    if (entry) byPart.set(entry.part, entry);
  }
  for (const f of remoteFiles) {
    const entry = loadRecord(f, "remote");
    if (entry) byPart.set(entry.part, entry);
  }
  return [...byPart.values()].sort((a, b) => a.part.localeCompare(b.part));
}

function mdEscape(s) {
  return String(s == null ? "" : s).replace(/\|/g, "\\|").replace(/\n/g, " ");
}

function evaluateOne({ part, record, sourceKind }) {
  const product = parseProductRecord(record);
  const classification = classifyProduct(product);
  const queries = buildQueries(product);
  const links = buildSupplierLinks(product);
  return {
    part,
    sourceKind,
    title: product.title,
    family: product.family,
    categoryPath: product.categoryPath,
    kind: classification.kind,
    noun: classification.noun,
    primary: queries.primary,
    alternates: queries.alternates,
    terms: queries.terms,
    suppliers: links.map((l) => l.supplier),
    product,
  };
}

function toMarkdownTable(rows) {
  const header = "| Part | Title | Family | Category path | Kind | Noun | Primary query | Suppliers |";
  const sep = "| --- | --- | --- | --- | --- | --- | --- | --- |";
  const lines = rows.map((r) => {
    const path = r.categoryPath.length ? r.categoryPath.join(" > ") : "_(none)_";
    return `| ${r.part} | ${mdEscape(r.title)} | ${mdEscape(r.family)} | ${mdEscape(path)} | ${r.kind} | ${mdEscape(r.noun)} | ${mdEscape(r.primary)} | ${r.suppliers.join(", ")} |`;
  });
  return [header, sep, ...lines].join("\n");
}

function main() {
  const jsonMode = process.argv.includes("--json");
  const records = collectRecords();
  const rows = records.map(evaluateOne);
  if (jsonMode) {
    for (const r of rows) console.log(JSON.stringify(r));
  } else {
    console.log(`<!-- ${rows.length} captured records evaluated (sweep/: ${rows.filter((r) => r.sourceKind === "sweep").length}, remote/: ${rows.filter((r) => r.sourceKind === "remote").length}) -->`);
    console.log(toMarkdownTable(rows));
  }
}

if (require.main === module) main();

module.exports = { collectRecords, evaluateOne, recordFromApiProduct, toMarkdownTable };
