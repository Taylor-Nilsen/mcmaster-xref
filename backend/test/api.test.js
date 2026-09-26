/**
 * Endpoint tests for POST /api/xref and GET /api/health, on the
 * record/pastedText/partNumber/specs pipeline described in server.js's own
 * header comment.
 *
 * These never launch a real browser: the `record` and `pastedText` inputs
 * skip lib/mcmaster.js's fetchProductRecord entirely (that's the point of
 * those input shapes), and every test that exercises the `partNumber` ->
 * McMaster path builds its own app via `buildApp({ fetchProductRecord })`
 * with a stub, so Chromium is never touched regardless of whether
 * XREF_NO_BROWSER is set in the environment running the suite.
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

const { app, buildApp } = require("../server");
const { parseFragment } = require("../lib/mcmaster");

const FIXTURE_PATH = path.join(__dirname, "fixtures", "mcmaster", "91251A540.raw");
const FIXTURE_RAW = fs.readFileSync(FIXTURE_PATH, "utf8");

function withServer(theApp, fn) {
  return async () => {
    const server = theApp.listen(0);
    await new Promise((resolve) => server.once("listening", resolve));
    const base = `http://127.0.0.1:${server.address().port}`;
    const post = async (body) => {
      const res = await fetch(`${base}/api/xref`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      return { status: res.status, body: await res.json() };
    };
    const get = async (p) => {
      const res = await fetch(`${base}${p}`);
      return { status: res.status, body: await res.json() };
    };
    try {
      await fn({ base, post, get });
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  };
}

test("GET / reports ok", withServer(app, async ({ get }) => {
  const { status, body } = await get("/");
  assert.equal(status, 200);
  assert.deepEqual(body, { status: "ok" });
}));

test("GET /api/health reports a well-formed shape", withServer(app, async ({ get }) => {
  const { status, body } = await get("/api/health");
  assert.equal(status, 200);
  assert.equal(body.status, "ok");
  assert.equal(typeof body.uptimeSec, "number");
  assert.equal(typeof body.cacheSize, "number");
  assert.equal(typeof body.browserWarm, "boolean");
}));

test("an empty request answers with nothing rather than failing", withServer(app, async ({ post }) => {
  const { status, body } = await post({});
  assert.equal(status, 200);
  assert.equal(body.source, "none");
  assert.equal(body.product, null);
  assert.equal(body.error, null);
  assert.deepEqual(body.links, []);
  assert.deepEqual(body.classification, { noun: null, kind: null });
  assert.deepEqual(body.queries, { primary: null, alternates: [] });
}));

// ---------------------------------------------------------------------------
// record input: the full pipeline, driven by a real captured fixture
// ---------------------------------------------------------------------------

test("record input (raw fixture string): 91251A540 classifies as a socket head cap screw with the right links", withServer(app, async ({ post }) => {
  const { status, body } = await post({ record: FIXTURE_RAW });
  assert.equal(status, 200);
  assert.equal(body.source, "record");
  assert.equal(body.partNumber, "91251A540");
  assert.equal(body.error, null);
  assert.equal(body.classification.noun, "socket head cap screw");
  assert.equal(body.classification.kind, "fastener");

  assert.match(body.queries.primary, /1\/4"-20 x 3\/4" socket head cap screw/i);
  // The screw HEAD's own diameter (3/8") must never leak into the query --
  // this is the exact bug the old innerText parser had.
  assert.doesNotMatch(body.queries.primary, /3\/8"/);

  const supplierNames = body.links.map((l) => l.supplier);
  assert.ok(supplierNames.includes("Fastenal"));
  assert.ok(supplierNames.includes("Grainger"));
  assert.ok(supplierNames.includes("Bolt Depot"));
  for (const link of body.links) assert.match(link.url, /^https:\/\//);

  assert.ok(body.product);
  assert.equal(body.product.partNumber, "91251A540");
  assert.ok(body.product.attributes.length > 0);
}));

test("record input (already-parsed JSON object) works the same as the raw string", withServer(app, async ({ post }) => {
  const json = parseFragment(FIXTURE_RAW);
  const { body } = await post({ record: json });
  assert.equal(body.source, "record");
  assert.equal(body.classification.noun, "socket head cap screw");
}));

test("an unparseable record reports BAD_RECORD instead of crashing", withServer(app, async ({ post }) => {
  const { status, body } = await post({ record: "not json at all, no braces here" });
  assert.equal(status, 200);
  assert.equal(body.source, "none");
  assert.equal(body.product, null);
  assert.equal(body.error.code, "BAD_RECORD");
  assert.equal(typeof body.error.message, "string");
  assert.ok(body.error.message.length > 0);
}));

// ---------------------------------------------------------------------------
// pastedText input
// ---------------------------------------------------------------------------

test("pastedText is turned into a synthetic record and runs the same pipeline", withServer(app, async ({ post }) => {
  const pastedText = [
    'Black-Oxide Alloy Steel Socket Head Screw, US Origin, 1/4"-20 Thread Size, 3/4" Long',
    "Material",
    "Black-Oxide Alloy Steel",
    "Thread Size",
    '1/4"-20',
    "Length",
    '3/4"',
    "Fastener Head Type",
    "Socket",
    "Drive Style",
    "Hex",
  ].join("\n");

  const { status, body } = await post({ partNumber: "91251A540", pastedText });
  assert.equal(status, 200);
  assert.equal(body.source, "pasted");
  assert.equal(body.partNumber, "91251A540");
  assert.equal(body.error, null);
  assert.equal(body.classification.noun, "socket head cap screw");
  // lib/product.js now emits the finish in plain lowercase words rather
  // than McMaster's own hyphenated/capitalized form -- see product.test.js
  // for the regression this covers (a supplier search box expects "black
  // oxide", never "Black-Oxide").
  assert.equal(body.queries.primary, '1/4"-20 x 3/4" socket head cap screw Alloy Steel black oxide');
  const material = body.product.attributes.find((a) => a.name === "Material");
  assert.equal(material.value, "Black-Oxide Alloy Steel");
}));

// ---------------------------------------------------------------------------
// specs (manual entry): both as the sole input and as an override
// ---------------------------------------------------------------------------

test("manual specs alone synthesize a product and produce a query", withServer(app, async ({ post }) => {
  const { status, body } = await post({
    specs: { material: "Black-Oxide Alloy Steel", threadSize: '1/4"-20', length: '3/4"', headType: "Socket", driveType: "Hex" },
  });
  assert.equal(status, 200);
  assert.equal(body.source, "manual");
  assert.equal(body.error, null);
  assert.equal(body.classification.noun, "socket head cap screw");
  assert.equal(body.queries.primary, '1/4"-20 x 3/4" socket head cap screw Alloy Steel black oxide');
  assert.ok(body.links.length > 0);
}));

test("manual specs override a resolved record's attributes by name, without changing source", withServer(app, async ({ post }) => {
  const { body } = await post({ record: FIXTURE_RAW, specs: { material: "Titanium" } });
  assert.equal(body.source, "record");
  const material = body.product.attributes.find((a) => a.name === "Material");
  assert.equal(material.value, "Titanium");
  assert.match(body.queries.primary, /titanium/i);
  assert.doesNotMatch(body.queries.primary, /alloy steel/i);
}));

test("unknown spec fields are dropped rather than injected as attributes", withServer(app, async ({ post }) => {
  const { body } = await post({ specs: { material: "Brass", sneaky: "<script>" } });
  assert.ok(body.product.attributes.every((a) => a.name !== "sneaky"));
  const material = body.product.attributes.find((a) => a.name === "Material");
  assert.equal(material.value, "Brass");
}));

// ---------------------------------------------------------------------------
// partNumber -> McMaster path, stubbed so no browser is ever launched
// ---------------------------------------------------------------------------

test("a stubbed McMaster success resolves via the mcmaster source", withServer(
  buildApp({
    fetchProductRecord: async () => ({ raw: FIXTURE_RAW, json: parseFragment(FIXTURE_RAW) }),
  }),
  async ({ post }) => {
    const { body } = await post({ partNumber: "91251A540" });
    assert.equal(body.source, "mcmaster");
    assert.equal(body.classification.noun, "socket head cap screw");
    assert.equal(body.error, null);
  }
));

test("a known McMaster error code comes back with a machine-readable code and a factual, non-lecturing message", withServer(
  buildApp({
    fetchProductRecord: async () => {
      const err = new Error("hit the McMaster login wall");
      err.code = "LOGIN_WALL";
      throw err;
    },
  }),
  async ({ post }) => {
    const { status, body } = await post({ partNumber: "91251A051" });
    assert.equal(status, 200);
    assert.equal(body.source, "none");
    assert.equal(body.product, null);
    assert.deepEqual(body.classification, { noun: null, kind: null });
    assert.deepEqual(body.queries, { primary: null, alternates: [] });
    assert.deepEqual(body.links, []);
    assert.equal(body.error.code, "LOGIN_WALL");
    assert.match(body.error.message, /bookmarklet/i);
  }
));

test("an unrecognized error code from the fetch layer still produces a well-formed response", withServer(
  buildApp({
    fetchProductRecord: async () => {
      const err = new Error("something nobody has seen before");
      err.code = "SOMETHING_WEIRD";
      throw err;
    },
  }),
  async ({ post }) => {
    const { status, body } = await post({ partNumber: "91251A051" });
    assert.equal(status, 200);
    assert.equal(body.source, "none");
    assert.equal(body.product, null);
    assert.deepEqual(body.classification, { noun: null, kind: null });
    assert.deepEqual(body.queries, { primary: null, alternates: [] });
    assert.deepEqual(body.links, []);
    assert.equal(body.error.code, "SOMETHING_WEIRD");
    assert.equal(typeof body.error.message, "string");
    assert.ok(body.error.message.length > 0);
  }
));

test("a McMaster fetch failure still lets manual specs produce a usable product, alongside the error", withServer(
  buildApp({
    fetchProductRecord: async () => {
      const err = new Error("hit the McMaster login wall");
      err.code = "LOGIN_WALL";
      throw err;
    },
  }),
  async ({ post }) => {
    const { body } = await post({ partNumber: "91251A051", specs: { material: "Steel", threadSize: '1/4"-20' } });
    assert.equal(body.source, "manual");
    assert.equal(body.error.code, "LOGIN_WALL");
    assert.ok(body.product);
  }
));

test("requests queued past the queue depth get a 503 with error code BUSY", async () => {
  const queueApp = buildApp(
    {
      fetchProductRecord: async (partNumber) => {
        await new Promise((r) => setTimeout(r, 60));
        const err = new Error(`no data for ${partNumber}`);
        err.code = "NO_DATA";
        throw err;
      },
    },
    { queueMaxDepth: 2, queueSpacingMs: 10 }
  );
  const server = queueApp.listen(0);
  await new Promise((resolve) => server.once("listening", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const post = (partNumber) =>
    fetch(`${base}/api/xref`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ partNumber }),
    }).then(async (res) => ({ status: res.status, body: await res.json() }));

  try {
    // Distinct part numbers, so none of these hit the cache and every one
    // has to actually queue behind the stub's 60ms delay.
    const results = await Promise.all(
      ["P1", "P2", "P3", "P4", "P5", "P6", "P7"].map((p) => post(p))
    );
    const busy = results.filter((r) => r.status === 503);
    assert.ok(busy.length > 0, "expected at least one 503 BUSY response under a burst of 7 against a depth-2 queue");
    for (const r of busy) {
      assert.equal(r.body.error.code, "BUSY");
      assert.equal(r.body.product, null);
      assert.deepEqual(r.body.links, []);
    }
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test("a request queued too long without starting is rejected with BUSY rather than waiting out the hard timeout", async () => {
  const queueApp = buildApp(
    {
      fetchProductRecord: async (partNumber) => {
        await new Promise((r) => setTimeout(r, 200));
        const err = new Error(`no data for ${partNumber}`);
        err.code = "NO_DATA";
        throw err;
      },
    },
    // First job occupies the queue for ~200ms; second job's queue wait
    // (spacingMs) alone already exceeds this tiny queueMaxWaitMs, so it
    // must be rejected BUSY without its fetch ever starting.
    { queueMaxDepth: 5, queueSpacingMs: 50, queueMaxWaitMs: 30 }
  );
  const server = queueApp.listen(0);
  await new Promise((resolve) => server.once("listening", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const post = (partNumber) =>
    fetch(`${base}/api/xref`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ partNumber }),
    }).then(async (res) => ({ status: res.status, body: await res.json() }));

  try {
    const results = await Promise.all([post("Q1"), post("Q2")]);
    // Whichever of the two reaches the queue first starts immediately (no
    // wait to exceed yet) and fails with the stub's NO_DATA; the other
    // sits behind it, its queue wait exceeds queueMaxWaitMs, and it comes
    // back BUSY -- assert on that pairing rather than request order, since
    // which of Q1/Q2 the server happens to process first isn't guaranteed.
    const busy = results.filter((r) => r.status === 503);
    const notBusy = results.filter((r) => r.status !== 503);
    assert.equal(busy.length, 1, "expected exactly one of the two requests to be rejected for waiting too long in queue");
    assert.equal(busy[0].body.error.code, "BUSY");
    assert.equal(notBusy.length, 1);
    assert.equal(notBusy[0].body.error.code, "NO_DATA");
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test("two concurrent requests for the same uncached part number share one in-flight McMaster fetch", async () => {
  let calls = 0;
  const dedupeApp = buildApp({
    fetchProductRecord: async () => {
      calls++;
      await new Promise((r) => setTimeout(r, 50));
      return { raw: FIXTURE_RAW, json: parseFragment(FIXTURE_RAW) };
    },
  });
  const server = dedupeApp.listen(0);
  await new Promise((resolve) => server.once("listening", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const post = () =>
    fetch(`${base}/api/xref`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ partNumber: "91251A540" }),
    }).then(async (res) => ({ status: res.status, body: await res.json() }));

  try {
    const [a, b] = await Promise.all([post(), post()]);
    assert.equal(calls, 1, "expected the second concurrent request to join the first's in-flight fetch, not start its own");
    assert.equal(a.status, 200);
    assert.equal(b.status, 200);
    assert.deepEqual(a.body, b.body);
    assert.equal(a.body.source, "mcmaster");
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

// ---------------------------------------------------------------------------
// validateProductRecord wiring: a record with no spec rows must never be
// reported as a success, and must never be cached.
// ---------------------------------------------------------------------------

test("a McMaster record with no TableEntries is reported as NO_DATA, not a false success, and is never cached", async () => {
  let calls = 0;
  const noDataApp = buildApp({
    fetchProductRecord: async () => {
      calls++;
      return {
        raw: "irrelevant",
        json: { PartNbrTxt: "90286A118", TitleTxt: "", ReactData: { TableEntries: [] } },
      };
    },
  });
  const server = noDataApp.listen(0);
  await new Promise((resolve) => server.once("listening", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const post = (body) =>
    fetch(`${base}/api/xref`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }).then(async (res) => ({ status: res.status, body: await res.json() }));

  try {
    const first = await post({ partNumber: "90286A118" });
    assert.equal(first.status, 200);
    assert.equal(first.body.source, "none");
    assert.equal(first.body.product, null);
    assert.equal(first.body.error.code, "NO_DATA");

    // Not cached: a second request for the same part must call the stub
    // again rather than being answered from a (nonexistent) positive cache
    // entry.
    const second = await post({ partNumber: "90286A118" });
    assert.equal(second.body.error.code, "NO_DATA");
    assert.equal(calls, 2, "expected the stub to be called again on the second request");
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

// ---------------------------------------------------------------------------
// debug: true -> `raw` field
// ---------------------------------------------------------------------------

test("debug: true adds a raw field with the full parsed record on a record input", withServer(app, async ({ post }) => {
  const withDebug = await post({ record: FIXTURE_RAW, debug: true });
  assert.equal(withDebug.status, 200);
  assert.ok(withDebug.body.raw, "expected a raw field when debug: true");
  assert.equal(typeof withDebug.body.raw.TitleTxt, "string");
  assert.ok(withDebug.body.raw.TitleTxt.length > 0);

  const withoutDebug = await post({ record: FIXTURE_RAW });
  assert.equal(withoutDebug.status, 200);
  assert.ok(!("raw" in withoutDebug.body), "raw must be absent entirely when debug is not set");
}));

test("debug: true adds a raw field on a successful mcmaster partNumber lookup", withServer(
  buildApp({
    fetchProductRecord: async () => ({ raw: FIXTURE_RAW, json: parseFragment(FIXTURE_RAW) }),
  }),
  async ({ post }) => {
    const { body } = await post({ partNumber: "91251A540", debug: true });
    assert.equal(body.source, "mcmaster");
    assert.ok(body.raw);
    assert.equal(typeof body.raw.TitleTxt, "string");
    assert.ok(body.raw.TitleTxt.length > 0);
  }
));

test("debug: true adds the failing record as raw on a NO_DATA validation failure", withServer(
  buildApp({
    fetchProductRecord: async () => ({
      raw: "irrelevant",
      json: { NewStyleIndicator: true, TargetPageMetadata: { Type: "product_family" } },
    }),
  }),
  async ({ post }) => {
    const { body } = await post({ partNumber: "90286A118", debug: true });
    assert.equal(body.error.code, "NO_DATA");
    assert.ok(body.raw);
    assert.equal(body.raw.TargetPageMetadata.Type, "product_family");
  }
));

test("a malformed JSON body reports 400 BAD_REQUEST with the full documented response shape", withServer(app, async ({ base }) => {
  const res = await fetch(`${base}/api/xref`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{not valid json",
  });
  const body = await res.json();
  assert.equal(res.status, 400);
  assert.deepEqual(body, {
    partNumber: null,
    source: "none",
    product: null,
    classification: null,
    queries: null,
    links: [],
    error: { code: "BAD_REQUEST", message: "Request body must be valid JSON." },
  });
}));
