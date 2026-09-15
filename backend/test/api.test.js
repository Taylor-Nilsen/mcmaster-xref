/**
 * Endpoint tests for POST /api/xref. These exercise the real express app,
 * but only the paths that never touch McMaster: with no partNumber (or
 * with pasted text, which deliberately skips the fetch) no browser is
 * launched, so the route is testable without spending a page view or
 * needing Chromium installed.
 */

const test = require("node:test");
const assert = require("node:assert/strict");

const { app } = require("../server");

let server;
let base;

test.before(async () => {
  server = app.listen(0);
  await new Promise((resolve) => server.once("listening", resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});

test.after(() => server.close());

const post = async (body) => {
  const res = await fetch(`${base}/api/xref`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() };
};

test("GET / reports ok", async () => {
  const res = await fetch(`${base}/`);
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { status: "ok" });
});

test("manual specs alone produce a query and links", async () => {
  const { status, body } = await post({
    specs: { material: "Black-Oxide Alloy Steel", threadSize: '1/4"-20', length: '3/4"', headType: "Socket", driveType: "Hex", diameter: '3/8"' },
  });
  assert.equal(status, 200);
  assert.equal(body.source, "manual");
  assert.equal(body.query, '1/4"-20 x 3/4" socket head cap screw Alloy Steel Black-Oxide');
  assert.equal(body.mcmasterErrorCode, null);
  assert.ok(body.links.length > 0);
  assert.ok(body.links.every((l) => /^https:\/\//.test(l.url)));
});

test("pasted page text is parsed and skips the McMaster fetch", async () => {
  const { body } = await post({
    partNumber: "91251A540",
    pastedText: 'Material\nBlack-Oxide Alloy Steel\nThread\nSize\n1/4"-20\nLength\n3/4"\nFastener Head Type\nSocket\n',
  });
  assert.equal(body.source, "pasted");
  assert.equal(body.partNumber, "91251A540");
  // No fetch was attempted, so there is no error to report either.
  assert.equal(body.mcmasterFetchError, null);
  assert.equal(body.specs.threadSize, '1/4"-20');
  assert.equal(body.query, '1/4"-20 x 3/4" socket head cap screw Alloy Steel Black-Oxide');
});

test("manual specs override pasted ones", async () => {
  const { body } = await post({
    pastedText: "Material\n18-8 Stainless Steel\n",
    specs: { material: "Titanium" },
  });
  assert.equal(body.specs.material, "Titanium");
  assert.equal(body.source, "pasted+manual");
});

test("an empty request answers with nothing rather than failing", async () => {
  const { status, body } = await post({});
  assert.equal(status, 200);
  assert.equal(body.source, "none");
  assert.equal(body.query, null);
  assert.deepEqual(body.links, []);
  assert.deepEqual(body.specs, {});
});

test("unknown spec fields are dropped", async () => {
  const { body } = await post({ specs: { material: "Brass", sneaky: "<script>" } });
  assert.deepEqual(body.specs, { material: "Brass" });
});
