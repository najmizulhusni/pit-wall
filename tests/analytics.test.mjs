import test from "node:test";
import assert from "node:assert/strict";
import { load } from "./load.mjs";

const { Analytics: A } = load(["js/analytics.js"]);
const row = (id, points) => ({ points, driver: { id, family: id } });
const standings = { round: 3, rows: [row("lead", 100), row("second", 80), row("third", 10)] };
const schedule = [1, 2, 3, 4, 5, 6].map(round => ({ round, sprint: round === 5 }));

test("title: points left count races and sprints still to run", () => {
  const m = A.title({ standings, schedule });
  assert.equal(m.max, 25 + 33 + 25);
  assert.deepEqual(m.rivals.map(r => r.driver.id), ["second"], "100 behind with 83 left is out");
});

test("title: earliest clinch is the first round where the needed swing can be made", () => {
  const m = A.title({ standings, schedule });
  const [r4, r5, r6] = m.steps;
  assert.equal(r4.needs[0].need, 39);            // 58 left after round 4: lead must exceed it, 20 + 39 = 59
  assert.equal(r4.possible, false);              // only 25 can be gained in one race
  assert.equal(r5.needs[0].need, 6);
  assert.equal(r5.possible, true);
  assert.equal(m.earliest.r.round, 5);
  assert.equal(r6.decided, true);
});

test("title: projection replays recent form and finds the clinch round", () => {
  const rounds = [1, 2, 3].map(round => ({ round, rows: [{ driver: { id: "lead" }, points: 25 }, { driver: { id: "second" }, points: 18 }], sprint: [] }));
  const m = A.title({ standings, schedule, rounds });
  assert.equal(m.field[0].row.driver.id, "lead");
  assert.equal(m.field[0].race, 25);
  assert.equal(m.projClinch.who.driver.id, "lead");
  assert.equal(m.projClinch.step.r.round, 5);    // lead 100-80 grows by 7 a race: 27 after r4, 34 after r5 > 25 left
});

test("chances: leader, still in it, and out of it", () => {
  const m = A.title({ standings, schedule });
  assert.equal(A.chances(m, "lead").kind, "leader");
  const c = A.chances(m, "second");
  assert.equal(c.kind, "alive");
  assert.equal(c.need, 21);
  assert.equal(A.chances(m, "third").kind, "out");
  assert.equal(A.chances(m, "nobody"), null);
});

test("title: a finished season has no rivals and no steps", () => {
  const m = A.title({ standings: { round: 6, rows: standings.rows }, schedule });
  assert.equal(m.max, 0);
  assert.equal(m.rivals.length, 0);
  assert.equal(m.earliest, null);
});
