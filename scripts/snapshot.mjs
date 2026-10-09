/*
  Nightly snapshot.
  Runs the page's own pipeline and source code in Node, records every response,
  and writes data/snapshot.json. The browser falls back to this file when an API is down,
  and because the same code builds the request paths, the keys always line up.

  Usage: node scripts/snapshot.mjs
*/
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const out = path.join(root, "data", "snapshot.json");
const metaOut = path.join(root, "data", "snapshot.meta.json");   // tiny file the page reads on every visit

globalThis.window = globalThis;
for (const f of ["js/pipeline.js", "js/sources.js"]) {
  vm.runInThisContext(fs.readFileSync(path.join(root, f), "utf8"), { filename: f });
}
const { Pipeline: P, Sources: S } = window;

/* Keep only the fields the page reads, so the file stays small. */
const pick = (rows, keys) => rows.map(r => Object.fromEntries(keys.filter(k => k in r).map(k => [k, r[k]])));
function slim(p, data) {
  if (!Array.isArray(data)) return data;
  if (p.startsWith("location?")) return pick(data, ["date", "x", "y"]);
  if (p.startsWith("car_data?")) return pick(data, ["date", "speed", "rpm", "n_gear", "throttle", "brake"]);
  if (p.startsWith("laps?")) return pick(data, ["driver_number", "lap_number", "lap_duration", "is_pit_out_lap", "date_start",
    "duration_sector_1", "duration_sector_2", "duration_sector_3", "st_speed"]);
  if (p.startsWith("weather?")) return data.slice(-1);
  if (p.startsWith("race_control?")) return pick(data.filter(m => m.category === "SafetyCar" || m.flag === "RED"),
    ["date", "lap_number", "category", "flag", "message"]);
  if (p.startsWith("pit?")) return pick(data, ["driver_number", "lap_number", "lane_duration", "pit_duration", "stop_duration"]);
  return data;
}

const data = {};
P.tap((source, p, body) => { data[`${source}:${p}`] = slim(p, body); });

const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

async function main() {
  // Resolve the season the way the page does, so off-season fallback paths are recorded too.
  const mode = await S.resolveSeason(null);
  log(`Jolpica: ${mode.year} season (${mode.mode}): schedule, standings, results, qualifying`);
  const [, standings] = await Promise.all([
    S.schedule(), S.driverStandings(), S.constructorStandings(), S.lastRace(), S.seasonResults(), S.lastQualifying(), S.upcoming()
  ]);

  log("OpenF1: sessions");
  const { completed } = await S.sessions(mode.year);
  const race = completed.find(s => s.session_name === "Race") || completed[0];
  if (!race) throw new Error("No completed OpenF1 session found");
  const key = race.session_key;
  log(`OpenF1: ${race.country_name} ${race.session_name} (${key})`);

  const [drivers, laps] = await Promise.all([S.drivers(key), S.laps(key)]);
  const { order } = await S.classification(key, laps);
  await Promise.all([S.stints(key), S.weather(key), S.pits(key), S.raceControl(key)]);

  // Telemetry for the overall fastest lap, the top ten finishers and the championship top two.
  const targets = new Set(order.slice(0, 10));
  const best = S.fastestLap(laps);
  if (best) targets.add(best.driver_number);
  standings.rows.slice(0, 2).forEach(r => {
    const n = S.numberForCode(drivers, r.driver.code);
    if (n != null) targets.add(n);
  });
  for (const n of targets) {
    const lap = S.fastestLap(laps, n);
    if (!lap) continue;
    try { await S.lapTelemetry(key, lap); log(`telemetry #${n}`); }
    catch (e) { log(`telemetry #${n} skipped: ${e.message}`); }
  }

  const body = JSON.stringify(data);
  if (fs.existsSync(out)) {
    try {
      if (JSON.stringify(JSON.parse(fs.readFileSync(out, "utf8")).data) === body) {
        log("No change since the last snapshot");
        return;
      }
    } catch { /* unreadable old file, overwrite it */ }
  }
  fs.mkdirSync(path.dirname(out), { recursive: true });
  const generatedAt = new Date().toISOString();
  fs.writeFileSync(out, `{"generatedAt":"${generatedAt}","session":${key},"data":${body}}`);
  fs.writeFileSync(metaOut, JSON.stringify({ generatedAt, session: key }));
  log(`Wrote ${Object.keys(data).length} responses, ${(fs.statSync(out).size / 1024).toFixed(0)} KB, ${P.stats.retries} retries`);
}

main().catch(e => { console.error(e); process.exit(1); });
