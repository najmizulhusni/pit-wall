import test from "node:test";
import assert from "node:assert/strict";
import { load, plain } from "./load.mjs";

const { Sources: S } = load(["js/pipeline.js", "js/sources.js"]);
const iso = s => new Date(Date.UTC(2026, 9, 4, 8, 0, 0) + s * 1000).toISOString();

test("neutralised: safety car, VSC that turns into a safety car, closed at the flag", () => {
  const rc = [
    { date: iso(10), lap_number: 9, category: "SafetyCar", message: "SAFETY CAR DEPLOYED" },
    { date: iso(20), lap_number: 12, category: "SafetyCar", message: "SAFETY CAR IN THIS LAP" },
    { date: iso(30), lap_number: 43, category: "SafetyCar", message: "VSC DEPLOYED" },
    { date: iso(40), lap_number: 45, category: "SafetyCar", message: "SAFETY CAR DEPLOYED" },
    { date: iso(50), lap_number: 51, category: "SafetyCar", message: "SAFETY CAR IN THIS LAP" },
    { date: iso(60), lap_number: 30, category: "Flag", flag: "RED", message: "RED FLAG" }
  ];
  const bands = S.neutralised(rc, 55).map(b => `${b.kind} ${b.from}-${b.to}`);
  assert.deepEqual(plain(bands), ["SC 9-12", "VSC 43-44", "SC 45-51", "RED 30-30"]);
});

test("neutralised: a period still open at the end is closed on the last lap", () => {
  const rc = [{ date: iso(1), lap_number: 50, category: "SafetyCar", message: "SAFETY CAR DEPLOYED" }];
  assert.deepEqual(plain(S.neutralised(rc, 53).map(b => [b.from, b.to])), [[50, 53]]);
});

/*
  Three cars, three laps. Car 3 is third on the road but pits at the end of lap 1 under a safety car,
  and its line crossing is logged in the pit lane, 28 s before the leader's.
*/
function lapsFixture() {
  const rows = [];
  const lap = (n, k, start, dur, out = false) => rows.push({ driver_number: n, lap_number: k, date_start: iso(start), lap_duration: dur, is_pit_out_lap: out });
  // car 1 leads, car 2 is 1 s behind, car 3 is 2 s behind on track
  lap(1, 1, 0, 100); lap(1, 2, 100, 100); lap(1, 3, 200, 100);
  lap(2, 1, 0, 101); lap(2, 2, 101, 100); lap(2, 3, 201, 100);
  // car 3's lap-2 start (its line crossing) is logged 30 s early because it went through the pit lane
  lap(3, 1, 0, 72); lap(3, 2, 72, 150, true); lap(3, 3, 222, 100);
  return rows;
}

const orderAt = (tr, k) => [...tr.pos.entries()]
  .filter(([, p]) => p.some(x => x[0] === k))
  .sort((a, b) => a[1].find(x => x[0] === k)[1] - b[1].find(x => x[0] === k)[1])
  .map(([n]) => n);

test("raceTrace: an early pit-lane crossing on lap 1 never shows as the lead", () => {
  const tr = S.raceTrace(lapsFixture());
  assert.deepEqual(plain(orderAt(tr, 1)), [1, 2], "car 3's lap-1 position is unknown, so it's left out rather than shown leading");
  assert.deepEqual(plain(orderAt(tr, 2)), [1, 2, 3]);
  assert.deepEqual(plain(orderAt(tr, 3)), [1, 2, 3]);
  assert.equal(tr.laps, 3);
  assert.equal(tr.leadChanges, 0);
});

test("raceTrace: a later in-lap through the pit lane is held at its previous gap", () => {
  const rows = [];
  const lap = (n, k, start, dur, out = false) => rows.push({ driver_number: n, lap_number: k, date_start: iso(start), lap_duration: dur, is_pit_out_lap: out });
  lap(1, 1, 0, 100); lap(1, 2, 100, 100); lap(1, 3, 200, 100); lap(1, 4, 300, 100);
  lap(2, 1, 0, 102); lap(2, 2, 102, 70); lap(2, 3, 172, 160, true); lap(2, 4, 332, 100);   // pits on lap 2, crosses early
  const tr = S.raceTrace(rows);
  assert.deepEqual(plain(orderAt(tr, 2)), [1, 2], "held at its 2 s gap from lap 1 instead of leading");
  assert.equal(tr.pos.get(2).find(x => x[0] === 2)[1], 2);
  assert.equal(tr.leadChanges, 0);
});

test("raceTrace: gap to the winner is zero for the winner and negative behind", () => {
  const tr = S.raceTrace(lapsFixture());
  assert.ok(tr.trace.get(1).every(([, g]) => g === 0));
  assert.ok(tr.trace.get(2).every(([, g]) => g <= 0));
  assert.equal(tr.trace.get(2).at(-1)[1], -1);
});

test("pace: best lap, best sectors, ideal lap, and timing glitches ignored", () => {
  const L = (n, k, dur, s1, s2, s3, trap, out = false) => ({ driver_number: n, lap_number: k, lap_duration: dur, duration_sector_1: s1, duration_sector_2: s2, duration_sector_3: s3, st_speed: trap, is_pit_out_lap: out });
  const rows = [
    L(1, 1, 92, 30, 31, 31, 320), L(1, 2, 91, 30.5, 30, 30.5, 325), L(1, 3, 60, 2, 29, 29, 330, true),   // 2 s sector is a glitch; lap 3 is a pit-out lap
    L(2, 1, 93, 30.2, 31.2, 31.6, 318), L(2, 2, 92.5, 30.1, 31, 31.4, 321)
  ];
  const [a, b] = S.pace(rows);
  assert.equal(a.n, 1);
  assert.equal(a.best, 91, "the pit-out lap doesn't count as a best lap");
  assert.deepEqual(plain(a.s), [30, 29, 29]);
  assert.equal(a.ideal, 88);
  assert.equal(a.trap, 330);
  assert.equal(b.best, 92.5);
});

test("fastestLap ignores pit-out laps and laps without a time", () => {
  const rows = [
    { driver_number: 1, lap_number: 1, lap_duration: null },
    { driver_number: 1, lap_number: 2, lap_duration: 80, is_pit_out_lap: true },
    { driver_number: 1, lap_number: 3, lap_duration: 90 },
    { driver_number: 2, lap_number: 3, lap_duration: 89 }
  ];
  assert.equal(S.fastestLap(rows).driver_number, 2);
  assert.equal(S.fastestLap(rows, 1).lap_number, 3);
});
