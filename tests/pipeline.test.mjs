import test from "node:test";
import assert from "node:assert/strict";
import { load, plain } from "./load.mjs";

/* A fake fetch that answers from a script of responses and counts calls. */
function fakeFetch(script) {
  const calls = [];
  const fn = async url => {
    calls.push(url);
    const next = script.length > 1 ? script.shift() : script[0];
    return {
      ok: next.status < 400, status: next.status,
      headers: { get: k => (k === "Retry-After" ? next.retryAfter ?? null : null) },
      text: async () => JSON.stringify(next.body ?? []),
      json: async () => next.body ?? {}
    };
  };
  fn.calls = calls;
  return fn;
}

test("pipeline: retries a 429 and returns the data", async () => {
  const fetch = fakeFetch([{ status: 429, retryAfter: "0" }, { status: 200, body: [{ a: 1 }] }]);
  const { Pipeline: P } = load(["js/pipeline.js"], { fetch });
  const data = await P.request("openf1", "sessions?year=2026");
  assert.deepEqual(plain(data), [{ a: 1 }]);
  assert.equal(fetch.calls.length, 2);
  assert.equal(P.stats.retries, 1);
});

test("pipeline: identical requests in flight share one network call", async () => {
  const fetch = fakeFetch([{ status: 200, body: [1, 2, 3] }]);
  const { Pipeline: P } = load(["js/pipeline.js"], { fetch });
  const [a, b] = await Promise.all([P.request("openf1", "laps?session_key=1"), P.request("openf1", "laps?session_key=1")]);
  assert.equal(a, b, "both callers get the very same response object");
  assert.equal(fetch.calls.length, 1);
  assert.equal(P.stats.deduped, 1);
});

test("pipeline: a second request within the cache window never hits the network", async () => {
  const fetch = fakeFetch([{ status: 200, body: [7] }]);
  const { Pipeline: P } = load(["js/pipeline.js"], { fetch });
  await P.request("openf1", "stints?session_key=1");
  await P.request("openf1", "stints?session_key=1");
  assert.equal(fetch.calls.length, 1);
  assert.equal(P.stats.cacheHits, 1);
});

test("pipeline: OpenF1's 404 for an empty filter means no rows, not an error", async () => {
  const fetch = fakeFetch([{ status: 404 }]);
  const { Pipeline: P } = load(["js/pipeline.js"], { fetch });
  assert.deepEqual(plain(await P.request("openf1", "pit?session_key=9")), []);
});

test("pipeline: a 400 is not retried and surfaces as an error", async () => {
  const fetch = fakeFetch([{ status: 400, body: { detail: "bad filter" } }]);
  const { Pipeline: P } = load(["js/pipeline.js"], { fetch });
  await assert.rejects(P.request("openf1", "laps?nope=1", { noStale: true }), /bad filter/);
  assert.equal(fetch.calls.length, 1);
});
