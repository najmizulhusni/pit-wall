/*
  Ingest layer.
  Every call to an external API goes through here, the same way a middleware flow would:
  in-flight dedupe -> TTL cache -> per-source rate-limited lane -> retry with backoff -> log.
  The cache is memory first, then the browser's Cache API. Both are async, so a large
  response is never stringified or parsed on the main thread just to be stored.
*/
(function () {
  "use strict";

  class Lane {
    constructor(gapMs, concurrency) {
      this.gap = gapMs;
      this.conc = concurrency;
      this.queue = [];
      this.active = 0;
      this.lastStart = 0;
      this.timer = null;
    }
    push(fn) {
      return new Promise((resolve, reject) => {
        this.queue.push({ fn, resolve, reject });
        this.pump();
      });
    }
    pump() {
      if (this.timer) return;
      while (this.active < this.conc && this.queue.length) {
        const wait = this.lastStart + this.gap - Date.now();
        if (wait > 0) {
          this.timer = setTimeout(() => { this.timer = null; this.pump(); }, wait);
          return;
        }
        const job = this.queue.shift();
        this.active++;
        this.lastStart = Date.now();
        Promise.resolve()
          .then(job.fn)
          .then(job.resolve, job.reject)
          .finally(() => { this.active--; this.pump(); });
      }
    }
    get depth() { return this.queue.length + this.active; }
  }

  const SOURCES = {
    jolpica: {
      label: "Jolpica",
      base: "https://api.jolpi.ca/ergast/f1/",
      lane: new Lane(300, 2),          // documented burst limit is 4 req/s
      ttl: 10 * 60 * 1000,
      emptyOn404: false,
      count(d) {
        const m = d && d.MRData;
        if (!m) return 0;
        const t = m.RaceTable || m.StandingsTable || {};
        const list = t.Races || t.StandingsLists || [];
        return list.reduce((n, r) =>
          n + (r.Results || r.SprintResults || r.DriverStandings || r.ConstructorStandings || [1]).length, 0);
      }
    },
    openf1: {
      label: "OpenF1",
      base: "https://api.openf1.org/v1/",
      lane: new Lane(360, 2),          // free tier allows 3 requests a second; stay under it
      ttl: 30 * 60 * 1000,
      emptyOn404: true,                // OpenF1 answers 404 when a filter matches nothing
      count(d) { return Array.isArray(d) ? d.length : 0; }
    }
  };

  const CACHE_NAME = "pitwall-v1";
  const SNAPSHOT_URL = "data/snapshot.json";
  const SNAPSHOT_META_URL = "data/snapshot.meta.json";
  const MAX_ATTEMPTS = 4;
  const TIMEOUT_MS = 20000;
  const KEEP_MS = 7 * 864e5;

  const listeners = new Set();
  const log = [];
  const inflight = new Map();
  let seq = 0;
  let bypassCache = false;
  let snapshotLoad = null;
  const taps = new Set();

  /*
    Last line of defence: a copy of the latest race written nightly by a scheduled job.
    It is about a megabyte, so it is only downloaded once something has actually failed.
  */
  const canFetchLocal = () => typeof fetch === "function" && typeof location !== "undefined" && location.protocol !== "file:";
  function loadSnapshot() {
    if (!snapshotLoad) {
      snapshotLoad = (canFetchLocal()
        ? fetch(SNAPSHOT_URL, { cache: "no-cache" }).then(r => (r.ok ? r.json() : null))
        : Promise.resolve(null)
      ).catch(() => null);
    }
    return snapshotLoad;
  }
  function snapshotMeta() {
    return (canFetchLocal() ? fetch(SNAPSHOT_META_URL, { cache: "no-cache" }).then(r => (r.ok ? r.json() : null)) : Promise.resolve(null)).catch(() => null);
  }

  const stats = {
    requests: 0, network: 0, cacheHits: 0, deduped: 0,
    retries: 0, failures: 0, rows: 0, totalMs: 0,
    lastOkAt: 0
  };

  class PipelineError extends Error {
    constructor(message, status, source) {
      super(message);
      this.status = status;
      this.source = source;
    }
  }

  function emit(entry, phase) {
    listeners.forEach(fn => { try { fn(entry, phase); } catch (e) { console.error(e); } });
  }

  function record(entry) {
    log.unshift(entry);
    if (log.length > 80) log.pop();
  }

  /* ---------- cache: memory, then the Cache API ---------- */
  const mem = new Map();
  let store = null;
  function openStore() {
    if (!store) {
      store = (typeof caches !== "undefined" && globalThis.isSecureContext ? caches.open(CACHE_NAME) : Promise.resolve(null)).catch(() => null);
    }
    return store;
  }
  async function cacheRead(url) {
    if (mem.has(url)) return mem.get(url);
    const c = await openStore();
    if (!c) return null;
    try {
      const res = await c.match(url);
      if (!res) return null;
      const hit = { t: Number(res.headers.get("x-saved")) || 0, d: await res.json() };
      mem.set(url, hit);
      return hit;
    } catch { return null; }
  }
  /* Store the response text as received: no JSON.stringify of a parsed copy. */
  function cacheWrite(url, text, data) {
    const t = Date.now();
    mem.set(url, { t, d: data });
    openStore()
      .then(c => c && c.put(url, new Response(text, { headers: { "content-type": "application/json", "x-saved": String(t) } })))
      .catch(() => { /* quota or private mode: memory cache still works */ });
  }
  /* When the browser is idle: drop week-old entries, and the cache this page used to keep in localStorage. */
  function prune() {
    try {
      for (let i = localStorage.length - 1; i >= 0; i--) {
        const k = localStorage.key(i);
        if (k && k.startsWith("f1p:")) localStorage.removeItem(k);
      }
    } catch { /* storage blocked */ }
    openStore().then(async c => {
      if (!c) return;
      for (const req of await c.keys()) {
        const res = await c.match(req);
        if (!res || Date.now() - Number(res.headers.get("x-saved") || 0) > KEEP_MS) await c.delete(req);
      }
    }).catch(() => {});
  }
  if (typeof requestIdleCallback === "function") requestIdleCallback(prune, { timeout: 10000 });

  /* ---------- network ---------- */
  const sleep = ms => new Promise(r => setTimeout(r, ms));

  async function attempt(src, url, entry) {
    for (let n = 1; n <= MAX_ATTEMPTS; n++) {
      entry.attempts = n;
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
      const t0 = performance.now();
      let res;
      try {
        res = await fetch(url, { signal: ctrl.signal, headers: { Accept: "application/json" } });
      } catch (err) {
        clearTimeout(timer);
        if (n === MAX_ATTEMPTS) throw new PipelineError(err.name === "AbortError" ? "Timed out" : "Network error", 0, src.label);
        await backoff(n, null, entry);
        continue;
      }
      clearTimeout(timer);
      entry.ms = Math.round(performance.now() - t0);
      entry.status = res.status;

      if (res.ok) return res.text();
      if (res.status === 404 && src.emptyOn404) return "[]";

      const retryable = res.status === 429 || res.status >= 500;
      if (!retryable || n === MAX_ATTEMPTS) {
        let detail = "";
        try { const b = await res.json(); detail = b.detail || b.message || ""; } catch { /* no body */ }
        throw new PipelineError(detail || `HTTP ${res.status}`, res.status, src.label);
      }
      await backoff(n, res.headers.get("Retry-After"), entry);
    }
  }

  async function backoff(n, retryAfter, entry) {
    stats.retries++;
    entry.retried = (entry.retried || 0) + 1;
    emit(entry, "retry");
    const hinted = retryAfter ? Number(retryAfter) * 1000 : 0;
    const wait = Math.max(hinted, 500 * 2 ** (n - 1)) + Math.random() * 250;
    await sleep(Math.min(wait, 12000));
  }

  /* ---------- public request ---------- */
  function request(sourceKey, path, opts = {}) {
    const src = SOURCES[sourceKey];
    const url = src.base + path;
    const ttl = opts.ttl != null ? opts.ttl : src.ttl;
    stats.requests++;

    if (inflight.has(url)) {
      stats.deduped++;
      return inflight.get(url);
    }

    const entry = {
      id: ++seq, source: src.label, sourceKey, label: opts.label || path,
      status: "queued", ms: null, rows: null, attempts: 0, at: Date.now()
    };

    const p = (async () => {
      const hit = bypassCache ? null : await cacheRead(url);
      if (hit && Date.now() - hit.t < ttl) {
        stats.cacheHits++;
        Object.assign(entry, { status: "cache", ms: 0, rows: src.count(hit.d) });
        stats.rows += entry.rows;
        record(entry);
        emit(entry, "done");
        return hit.d;
      }

      record(entry);
      emit(entry, "queued");
      try {
        return await src.lane.push(async () => {
          entry.status = "sending";
          emit(entry, "sending");
          const text = await attempt(src, url, entry);
          const data = JSON.parse(text);
          stats.network++;
          stats.totalMs += entry.ms || 0;
          entry.rows = src.count(data);
          stats.rows += entry.rows;
          stats.lastOkAt = Date.now();
          cacheWrite(url, text, data);
          taps.forEach(fn => fn(sourceKey, path, data));
          emit(entry, "done");
          return data;
        });
      } catch (err) {
        return fallback(err, hit);
      }
    })().finally(() => inflight.delete(url));

    async function fallback(err, hit) {
      stats.failures++;
      entry.status = err.status || "error";
      entry.error = err.message;
      if (!opts.noStale) {
        // Serve an older copy rather than an empty panel when the source is down.
        const stale = (hit || await cacheRead(url))?.d;
        if (stale) {
          entry.fallback = "cache";
          entry.rows = src.count(stale);
          emit(entry, "fallback");
          return stale;
        }
        const snap = await loadSnapshot();
        const saved = snap && snap.data && snap.data[`${sourceKey}:${path}`];
        if (saved) {
          entry.fallback = "snapshot";
          entry.rows = src.count(saved);
          emit(entry, "fallback");
          return saved;
        }
      }
      emit(entry, "error");
      throw err;
    }

    inflight.set(url, p);
    return p;
  }

  /* Jolpica pages results at 100 rows; walk the offsets until total is reached. */
  async function paginate(sourceKey, path, label, limit = 100, ttl) {
    const sep = path.includes("?") ? "&" : "?";
    const first = await request(sourceKey, `${path}${sep}limit=${limit}&offset=0`, { label: `${label} p1`, ttl });
    const total = Number(first.MRData.total) || 0;
    const pages = [first];
    const rest = [];
    for (let off = limit, i = 2; off < total; off += limit, i++) {
      rest.push(request(sourceKey, `${path}${sep}limit=${limit}&offset=${off}`, { label: `${label} p${i}`, ttl }));
    }
    return pages.concat(await Promise.all(rest));
  }

  window.Pipeline = {
    request, paginate, stats, log, PipelineError,
    on(fn) { listeners.add(fn); return () => listeners.delete(fn); },
    lanes() { return Object.fromEntries(Object.entries(SOURCES).map(([k, s]) => [k, s.lane.depth])); },
    setBypass(v) { bypassCache = v; },
    tap(fn) { taps.add(fn); },
    snapshot: loadSnapshot,
    snapshotMeta,
    avgMs() { return stats.network ? Math.round(stats.totalMs / stats.network) : 0; }
  };
})();
