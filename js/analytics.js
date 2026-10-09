/*
  Championship analytics. Pure functions, no DOM, so they run in the browser and in tests alike.

  The rule behind all of it: the leader is champion once their lead over every rival who can
  still catch them is bigger than the points left to score. Grands Prix pay 25 to the winner,
  sprints 8. Ties on points are ignored here; the FIA splits them on wins.
*/
(function (root) {
  "use strict";
  const RACE = 25, SPRINT = 8;
  const worth = r => RACE + (r.sprint ? SPRINT : 0);

  /*
    standings: { round, rows: [{ points, driver: { id }, ... }] } sorted by position
    schedule:  [{ round, sprint, ... }]
    rounds:    season results by round, [{ rows: [{ driver: { id }, points }], sprint: [...] }], optional
  */
  function title({ standings, schedule, rounds = null }) {
    if (!standings?.rows?.length || !schedule) return null;
    const rows = standings.rows, lead = rows[0];
    const left = schedule.filter(r => r.round > standings.round);
    const max = left.reduce((n, r) => n + worth(r), 0);
    const rivals = rows.slice(1).filter(r => lead.points - r.points <= max);

    // For each remaining round: how much the leader must outscore each rival by, from now until then.
    let remaining = max, gain = 0;
    const steps = left.map(r => {
      remaining -= worth(r);
      gain += worth(r);
      const needs = rivals.map(rv => ({ rv, need: Math.max(0, remaining - (lead.points - rv.points) + 1) }));
      const top = Math.max(0, ...needs.map(n => n.need));
      return { r, remaining, gain, needs, decided: top === 0, possible: top <= gain };
    });
    const earliest = steps.find(s => s.possible) || null;

    // Projection: each live contender's last-five race average plus season sprint average, replayed.
    const recent = (rounds || []).slice(-5), sprints = (rounds || []).filter(r => r.sprint.length);
    const avg = (list, key, id) => list.length ? list.reduce((t, r) => t + (r[key].find(x => x.driver.id === id)?.points || 0), 0) / list.length : 0;
    const field = [lead, ...rivals].map(r => ({ row: r, race: avg(recent, "rows", r.driver.id), sprint: avg(sprints, "sprint", r.driver.id), pts: r.points }));
    let projClinch = null;
    if (rounds) steps.forEach(s => {
      field.forEach(f => { f.pts += f.race + (s.r.sprint ? f.sprint : 0); });
      if (projClinch) return;
      const order = [...field].sort((a, b) => b.pts - a.pts);
      if (!order[1] || order[0].pts - order[1].pts > s.remaining) projClinch = { step: s, who: order[0].row };
    });
    field.sort((a, b) => b.pts - a.pts);
    return { rows, lead, rivals, left, max, steps, earliest, field, projClinch, hasForm: Boolean(rounds) };
  }

  /* Where one driver stands in the title fight: leading, still in it (and by how much), or out. */
  function chances(model, driverId) {
    if (!model) return null;
    const row = model.rows.find(r => r.driver.id === driverId);
    if (!row) return null;
    const pos = model.rows.indexOf(row) + 1;
    if (row === model.lead) {
      const next = model.rows[1];
      return { kind: "leader", row, pos, lead: next ? model.lead.points - next.points : 0, decided: !model.rivals.length };
    }
    const gap = model.lead.points - row.points;
    if (gap > model.max) return { kind: "out", row, pos, gap, max: model.max };
    // Passing the leader outright needs one point more than the gap; equal points only ties.
    return { kind: "alive", row, pos, gap, need: gap + 1, max: model.max, rounds: model.left.length, tieOnly: gap + 1 > model.max };
  }

  root.Analytics = { title, chances, RACE, SPRINT, worth };
})(typeof window !== "undefined" ? window : globalThis);
