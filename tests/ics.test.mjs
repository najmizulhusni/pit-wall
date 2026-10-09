import test from "node:test";
import assert from "node:assert/strict";
import { load } from "./load.mjs";

const { ICS } = load(["js/ics.js"]);
const race = {
  season: "2026", round: 17, name: "Singapore Grand Prix", circuit: "Marina Bay Street Circuit", locality: "Marina Bay",
  sessions: [["Qualifying", new Date("2026-10-10T13:00:00Z")], ["Race", new Date("2026-10-11T12:00:00Z")]]
};

test("ics: one event per session, in UTC, with stable ids and the right length", () => {
  const { text, count } = ICS.build([race], { now: new Date("2026-10-01T00:00:00Z") });
  assert.equal(count, 2);
  assert.match(text, /DTSTART:20261010T130000Z\r\nDTEND:20261010T140000Z/);
  assert.match(text, /DTSTART:20261011T120000Z\r\nDTEND:20261011T140000Z/, "races are booked for two hours");
  assert.match(text, /UID:2026-r17-race@pitwall/);
  assert.match(text, /LOCATION:Marina Bay Street Circuit\\, Marina Bay/, "commas are escaped");
  assert.ok(text.endsWith("END:VCALENDAR\r\n"));
  assert.ok(text.split("\r\n").every(l => l.length <= 75), "long lines are folded");
});

test("ics: sessions before 'from' are left out", () => {
  const { count } = ICS.build([race], { from: new Date("2026-10-11T00:00:00Z").getTime() });
  assert.equal(count, 1);
});
