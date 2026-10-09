/*
  Transform layer.
  Raw API shapes stop here. Everything the views receive is normalised and joined.
*/
(function () {
  "use strict";
  const P = window.Pipeline;

  /* Fallback team colours, used only when OpenF1 has not supplied one. */
  const TEAM_FALLBACK = {
    mclaren: "#FF8000", ferrari: "#E8002D", red_bull: "#3671C6", mercedes: "#27F4D2",
    aston_martin: "#229971", alpine: "#0093CC", williams: "#64C4FF", rb: "#6692FF",
    racing_bulls: "#6692FF", sauber: "#52E252", audi: "#BB0A30", haas: "#B6BABD", cadillac: "#C9A54A"
  };

  function hashColour(s) {
    let h = 0;
    for (const c of s) h = (h * 31 + c.charCodeAt(0)) >>> 0;
    return `hsl(${h % 360} 55% 60%)`;
  }

  const FINISHED = /^(Finished|Lapped|\+\d+ Laps?)$/;
  const day = 24 * 3600e3;

  /*
    Which season the page shows. "current" follows Jolpica's idea of the current season;
    a year pins an archive season. Past seasons never change, so they cache for a week.
  */
  let SEASON = "current";
  const seasonOpts = label => (SEASON === "current" ? { label } : { label: `${label} ${SEASON}`, ttl: 7 * day });

  /*
    Off-season guard: between the final race and the first race of the next year,
    Jolpica's current season has no standings. Fall back to the season that just ended.
  */
  async function resolveSeason(requested) {
    if (requested) {
      SEASON = String(requested);
      return { year: Number(requested), mode: "archive" };
    }
    const raw = await P.request("jolpica", "current/driverstandings/", { label: "driver standings" });
    const table = raw.MRData.StandingsTable;
    const year = Number(table.season) || new Date().getUTCFullYear();
    if (table.StandingsLists.length) {
      SEASON = "current";
      return { year, mode: "live" };
    }
    SEASON = String(year - 1);
    return { year: year - 1, mode: "offseason", upcomingYear: year };
  }

  /* ---------------- Jolpica (history, standings, schedule) ---------------- */

  function normDriver(d) {
    return {
      id: d.driverId,
      code: d.code || d.familyName.slice(0, 3).toUpperCase(),
      number: d.permanentNumber || "",
      given: d.givenName,
      family: d.familyName,
      nationality: d.nationality
    };
  }

  /* The schedule of the season on show; upcoming() is always the real current one, for countdowns. */
  const schedule = () => readSchedule(SEASON);
  const upcoming = () => readSchedule("current");
  async function readSchedule(which) {
    const raw = await P.request("jolpica", `${which}/races/?limit=100`,
      which === "current" ? { label: "season schedule" } : { label: `schedule ${which}`, ttl: 7 * day });
    const races = raw.MRData.RaceTable.Races || [];
    const when = s => s ? new Date(`${s.date}T${s.time || "12:00:00Z"}`) : null;
    return races.map(r => ({
      season: r.season,
      round: Number(r.round),
      name: r.raceName,
      circuit: r.Circuit.circuitName,
      locality: r.Circuit.Location.locality,
      country: r.Circuit.Location.country,
      start: when(r),
      sprint: Boolean(r.Sprint),
      sessions: [
        ["Practice 1", when(r.FirstPractice)],
        ["Practice 2", when(r.SecondPractice)],
        ["Practice 3", when(r.ThirdPractice)],
        ["Sprint qualifying", when(r.SprintQualifying || r.SprintShootout)],
        ["Sprint", when(r.Sprint)],
        ["Qualifying", when(r.Qualifying)],
        ["Race", when(r)]
      ].filter(s => s[1])
    }));
  }

  async function driverStandings() {
    const raw = await P.request("jolpica", `${SEASON}/driverstandings/`, seasonOpts("driver standings"));
    const list = raw.MRData.StandingsTable.StandingsLists[0];
    if (!list) return { round: 0, rows: [] };
    return {
      season: list.season,
      round: Number(list.round),
      rows: list.DriverStandings.map(s => ({
        pos: Number(s.position || s.positionText) || null,
        points: Number(s.points),
        wins: Number(s.wins),
        driver: normDriver(s.Driver),
        teamId: s.Constructors.at(-1)?.constructorId || "",
        team: s.Constructors.at(-1)?.name || ""
      }))
    };
  }

  async function constructorStandings() {
    const raw = await P.request("jolpica", `${SEASON}/constructorstandings/`, seasonOpts("constructor standings"));
    const list = raw.MRData.StandingsTable.StandingsLists[0];
    if (!list) return { rows: [] };
    return {
      rows: list.ConstructorStandings.map(s => ({
        pos: Number(s.position || s.positionText) || null,
        points: Number(s.points),
        wins: Number(s.wins),
        teamId: s.Constructor.constructorId,
        team: s.Constructor.name
      }))
    };
  }

  async function lastRace() {
    const raw = await P.request("jolpica", `${SEASON}/last/results/`, seasonOpts("last race result"));
    const race = raw.MRData.RaceTable.Races[0];
    if (!race) return null;
    return {
      round: Number(race.round),
      name: race.raceName,
      circuit: race.Circuit.circuitName,
      locality: race.Circuit.Location.locality,
      country: race.Circuit.Location.country,
      date: new Date(`${race.date}T${race.time || "12:00:00Z"}`),
      results: race.Results.map(normResult)
    };
  }

  function normResult(r) {
    return {
      pos: Number(r.position),
      grid: Number(r.grid) || null,
      points: Number(r.points),
      status: r.status,
      finished: FINISHED.test(r.status),
      time: r.Time?.time || null,
      fastestRank: Number(r.FastestLap?.rank) || null,
      fastestTime: r.FastestLap?.Time?.time || null,
      driver: normDriver(r.Driver),
      teamId: r.Constructor.constructorId,
      team: r.Constructor.name
    };
  }

  /* Pages can split one race's results across two responses, so merge by round. */
  function mergeRounds(pages, key) {
    const byRound = new Map();
    pages.forEach(pg => (pg.MRData.RaceTable.Races || []).forEach(r => {
      const round = Number(r.round);
      if (!byRound.has(round)) byRound.set(round, { round, name: r.raceName, rows: [] });
      byRound.get(round).rows.push(...(r[key] || []).map(normResult));
    }));
    return byRound;
  }

  async function seasonResults() {
    const [racePages, sprintPages] = await Promise.all([
      P.paginate("jolpica", `${SEASON}/results/`, "race results", 100, seasonOpts().ttl),
      P.paginate("jolpica", `${SEASON}/sprint/`, "sprint results", 100, seasonOpts().ttl).catch(() => [])
    ]);
    const races = mergeRounds(racePages, "Results");
    const sprints = mergeRounds(sprintPages, "SprintResults");
    return [...races.values()]
      .sort((a, b) => a.round - b.round)
      .map(r => ({ ...r, sprint: sprints.get(r.round)?.rows || [] }));
  }

  /*
    The most recent qualifying of the season on show, with each driver's Q1/Q2/Q3 laps.
    A driver who reached Q2 has a Q2 entry even without a time, so "reached" comes from the keys.
  */
  const lapSecs = t => {
    if (!t) return null;
    const m = /^(?:(\d+):)?(\d+(?:\.\d+)?)$/.exec(t.trim());
    return m ? Number(m[1] || 0) * 60 + Number(m[2]) : null;
  };
  async function lastQualifying() {
    const raw = await P.request("jolpica", `${SEASON}/last/qualifying/`, seasonOpts("last qualifying"));
    const race = raw.MRData.RaceTable.Races[0];
    if (!race) return null;
    return {
      round: Number(race.round),
      name: race.raceName,
      locality: race.Circuit.Location.locality,
      rows: race.QualifyingResults.map(q => ({
        pos: Number(q.position),
        driver: normDriver(q.Driver),
        teamId: q.Constructor.constructorId,
        team: q.Constructor.name,
        q: [lapSecs(q.Q1), lapSecs(q.Q2), lapSecs(q.Q3)],
        reached: "Q3" in q ? 3 : "Q2" in q ? 2 : 1
      }))
    };
  }

  /* ---------------- OpenF1 (sessions, laps, telemetry) ---------------- */

  async function sessions(year = new Date().getUTCFullYear()) {
    const now = Date.now();
    // Cancelled sessions keep their slot in the calendar but never produce data; testing days aren't races.
    const held = rows => rows.filter(s => !s.is_cancelled && !/^Day \d/.test(s.session_name));
    let list = held(await P.request("openf1", `sessions?year=${year}`, { label: `sessions ${year}`, ttl: 15 * 60 * 1000 }));
    let done = list.filter(s => new Date(s.date_end).getTime() < now - 20 * 60 * 1000);
    if (!done.length) {
      list = held(await P.request("openf1", `sessions?year=${year - 1}`, { label: `sessions ${year - 1}` }));
      done = list.filter(s => new Date(s.date_end).getTime() < now);
    }
    const live = list.find(s => new Date(s.date_start).getTime() <= now && new Date(s.date_end).getTime() >= now) || null;
    done.sort((a, b) => new Date(b.date_start) - new Date(a.date_start));
    return { completed: done, live };
  }

  async function drivers(sessionKey) {
    const list = await P.request("openf1", `drivers?session_key=${sessionKey}`, { label: "drivers", ttl: 24 * 3600e3 });
    const map = new Map();
    list.forEach(d => map.set(d.driver_number, {
      number: d.driver_number,
      code: d.name_acronym,
      name: d.first_name && d.last_name ? `${d.first_name} ${d.last_name}` : (d.full_name || d.broadcast_name),
      family: d.last_name || (d.broadcast_name || "").split(" ").slice(-1)[0],
      team: d.team_name,
      colour: d.team_colour ? `#${d.team_colour}` : null
    }));
    return map;
  }

  const laps = key => P.request("openf1", `laps?session_key=${key}`, { label: "laps", ttl: day });
  const stints = key => P.request("openf1", `stints?session_key=${key}`, { label: "stints", ttl: day });
  const pits = key => P.request("openf1", `pit?session_key=${key}`, { label: "pit stops", ttl: day });
  const raceControl = key => P.request("openf1", `race_control?session_key=${key}`, { label: "race control", ttl: day });

  async function weather(key) {
    const list = await P.request("openf1", `weather?session_key=${key}`, { label: "weather", ttl: 24 * 3600e3 });
    return list.at(-1) || null;
  }

  /*
    Prefer the official classification; fall back to ordering by laps completed and total time.
    Returns { order: [driver numbers], result: Map(number -> official row) or null }.
  */
  async function classification(key, lapRows) {
    try {
      const res = await P.request("openf1", `session_result?session_key=${key}`, { label: "classification", ttl: 24 * 3600e3, noStale: true });
      if (Array.isArray(res) && res.length) {
        const rows = res.slice().sort((a, b) => (a.position || 99) - (b.position || 99));
        return { order: rows.map(r => r.driver_number), result: new Map(rows.map(r => [r.driver_number, r])) };
      }
    } catch { /* endpoint missing or empty; use the fallback below */ }
    const agg = new Map();
    lapRows.forEach(l => {
      const a = agg.get(l.driver_number) || { n: 0, t: 0 };
      a.n = Math.max(a.n, l.lap_number);
      a.t += l.lap_duration || 0;
      agg.set(l.driver_number, a);
    });
    return { order: [...agg.entries()].sort((a, b) => b[1].n - a[1].n || a[1].t - b[1].t).map(e => e[0]), result: null };
  }

  const ts = v => (v ? Date.parse(v) : NaN);

  /*
    Lap chart without a position feed: every lap row says when the car started the lap,
    so the next row's start is when it crossed the line. Order the crossings of each lap
    and you have the running order. Subtract the eventual winner's crossing of the same lap
    and you have a race trace with one fixed reference, so a lead change doesn't make it jump.
  */
  function raceTrace(lapRows) {
    const by = new Map();
    lapRows.forEach(l => {
      if (!by.has(l.driver_number)) by.set(l.driver_number, new Map());
      by.get(l.driver_number).set(l.lap_number, l);
    });
    const crossings = new Map();
    by.forEach((own, n) => own.forEach((l, k) => {
      const next = own.get(k + 1);
      let t = ts(next?.date_start);
      if (isNaN(t) && l.lap_duration) t = ts(l.date_start) + l.lap_duration * 1000;
      if (isNaN(t)) return;
      if (!crossings.has(k)) crossings.set(k, []);
      crossings.get(k).push([n, t, Boolean(next?.is_pit_out_lap)]);
    }));

    /*
      A car on its in-lap crosses the timing line in the pit lane. Under a safety car or red flag
      that can be far earlier than the field reaches the line on track, which would put it in
      the lead for one lap. Hold such a car at its previous gap instead; real pit losses still show.
    */
    const laps = [...crossings.keys()].sort((a, b) => a - b);
    const prev = new Map();
    laps.forEach(k => {
      const row = crossings.get(k);
      const clean = row.filter(r => !r[2]).map(r => r[1]);
      const ref = clean.length ? Math.min(...clean) : null;
      const last = prev.get("ref");
      row.forEach(r => {
        const before = prev.get(r[0]);
        if (!r[2] || ref == null) return;
        if (last != null && before != null) r[1] = Math.max(r[1], before + (ref - last));
        else if (r[1] < ref) r[3] = true;           // first lap, no earlier gap to hold: position unknown
      });
      crossings.set(k, row.filter(r => !r[3]));
      row.forEach(r => { if (!r[3]) prev.set(r[0], r[1]); });
      if (ref != null) prev.set("ref", ref);
    });

    const pos = new Map(), cross = new Map(), leaders = [];
    laps.forEach(k => {
      const row = crossings.get(k).sort((a, b) => a[1] - b[1]);
      leaders.push([k, row[0][0], row[0][1]]);
      row.forEach(([n, t], i) => {
        if (!pos.has(n)) { pos.set(n, []); cross.set(n, []); }
        pos.get(n).push([k, i + 1]);
        cross.get(n).push([k, t]);
      });
    });

    const trace = new Map();
    const winner = leaders.length ? new Map(cross.get(leaders.at(-1)[1])) : new Map();
    cross.forEach((rows, n) => trace.set(n, rows.filter(([k]) => winner.has(k)).map(([k, t]) => [k, (winner.get(k) - t) / 1000])));

    let changes = 0;
    leaders.forEach((l, i) => { if (i && l[1] !== leaders[i - 1][1]) changes++; });
    return { pos, trace, leaders: leaders.map(l => [l[0], l[1]]), leadChanges: changes, laps: leaders.length ? leaders.at(-1)[0] : 0 };
  }

  /* Safety car, virtual safety car and red flag periods as lap ranges, from race control. */
  function neutralised(rc, lastLap) {
    const out = [];
    let open = null;
    const close = lap => { if (open) { open.to = Math.max(open.from, lap); out.push(open); open = null; } };
    (rc || []).slice().sort((a, b) => ts(a.date) - ts(b.date)).forEach(m => {
      const msg = (m.message || "").toUpperCase(), lap = m.lap_number || 1;
      if (m.category === "SafetyCar") {
        const vsc = /VSC|VIRTUAL/.test(msg);
        if (/DEPLOYED/.test(msg)) { close(lap - 1); open = { kind: vsc ? "VSC" : "SC", from: lap }; }
        else if (/ENDING|IN THIS LAP/.test(msg)) close(lap);
      } else if (m.flag === "RED") {
        close(lap);
        out.push({ kind: "RED", from: lap, to: lap });
      }
    });
    close(lastLap || open?.from || 1);
    return out;
  }

  /*
    Timing-screen view of a session: each driver's best lap, best sectors, the ideal lap
    those sectors add up to, and the fastest speed-trap reading.
    Sector values far below the field's median are timing glitches and are ignored.
  */
  function pace(lapRows) {
    const keys = ["duration_sector_1", "duration_sector_2", "duration_sector_3"];
    const floor = keys.map(k => {
      const v = lapRows.map(l => l[k]).filter(Boolean).sort((a, b) => a - b);
      return v.length ? v[Math.floor(v.length / 2)] * 0.6 : 0;
    });
    const by = new Map();
    lapRows.forEach(l => {
      const a = by.get(l.driver_number) || { n: l.driver_number, best: null, bestLap: null, s: [null, null, null], trap: null, laps: 0 };
      if (l.lap_duration) a.laps++;
      if (l.lap_duration && !l.is_pit_out_lap && (a.best == null || l.lap_duration < a.best)) { a.best = l.lap_duration; a.bestLap = l.lap_number; }
      keys.forEach((k, i) => { const v = l[k]; if (v && v > floor[i] && (a.s[i] == null || v < a.s[i])) a.s[i] = v; });
      if (l.st_speed && (a.trap == null || l.st_speed > a.trap)) a.trap = l.st_speed;
      by.set(l.driver_number, a);
    });
    return [...by.values()]
      .map(a => ({ ...a, ideal: a.s.every(v => v != null) ? a.s[0] + a.s[1] + a.s[2] : null }))
      .sort((a, b) => (a.best ?? Infinity) - (b.best ?? Infinity));
  }

  function cleanLaps(lapRows) {
    return lapRows.filter(l => l.lap_duration && !l.is_pit_out_lap);
  }

  function fastestLap(lapRows, driverNumber) {
    let best = null;
    cleanLaps(lapRows).forEach(l => {
      if ((driverNumber == null || l.driver_number === driverNumber) && (!best || l.lap_duration < best.lap_duration)) best = l;
    });
    return best;
  }

  const iso = ms => new Date(ms).toISOString();
  const q = v => encodeURIComponent(v);

  /*
    Location (~4 Hz) and car data (~4 Hz) arrive on different clocks.
    Align each position sample with the nearest car sample, then express
    progress as a 0..1 fraction of lap distance so two laps can be compared.
  */
  async function lapTelemetry(sessionKey, lap) {
    const t0 = new Date(lap.date_start).getTime();
    const t1 = t0 + lap.lap_duration * 1000;
    const win = `session_key=${sessionKey}&driver_number=${lap.driver_number}&date>${q(iso(t0 - 250))}&date<${q(iso(t1 + 250))}`;
    const [loc, car] = await Promise.all([
      P.request("openf1", `location?${win}`, { label: `location #${lap.driver_number}`, ttl: 24 * 3600e3 }),
      P.request("openf1", `car_data?${win}`, { label: `car data #${lap.driver_number}`, ttl: 24 * 3600e3 })
    ]);

    const carT = car.map(c => ({ ...c, t: new Date(c.date).getTime() })).sort((a, b) => a.t - b.t);
    const pts = loc
      .filter(p => p.x !== 0 || p.y !== 0)
      .map(p => ({ x: p.x, y: p.y, t: new Date(p.date).getTime() }))
      .sort((a, b) => a.t - b.t);

    if (pts.length < 20) return null;

    let j = 0, dist = 0;
    pts.forEach((p, i) => {
      if (i) dist += Math.hypot(p.x - pts[i - 1].x, p.y - pts[i - 1].y);
      p.d = dist;
      while (j < carT.length - 1 && Math.abs(carT[j + 1].t - p.t) <= Math.abs(carT[j].t - p.t)) j++;
      const c = carT[j] || {};
      p.speed = c.speed ?? null;
      p.gear = c.n_gear ?? null;
      p.throttle = c.throttle ?? null;
      p.brake = c.brake ?? null;
    });
    pts.forEach(p => { p.f = dist ? p.d / dist : 0; p.ms = p.t - pts[0].t; });

    return { driver: lap.driver_number, lapNumber: lap.lap_number, duration: lap.lap_duration, points: pts };
  }

  /* Time at a given lap fraction, linearly interpolated. */
  function timeAt(tel, f) {
    const p = tel.points;
    let lo = 0, hi = p.length - 1;
    while (hi - lo > 1) { const m = (lo + hi) >> 1; if (p[m].f < f) lo = m; else hi = m; }
    const a = p[lo], b = p[hi];
    const k = b.f === a.f ? 0 : (f - a.f) / (b.f - a.f);
    return a.ms + (b.ms - a.ms) * k;
  }

  /* Split the lap into mini-sectors and mark who was quicker through each. */
  function dominance(telA, telB, sectors = 24) {
    const out = [];
    for (let i = 0; i < sectors; i++) {
      const f0 = i / sectors, f1 = (i + 1) / sectors;
      const da = timeAt(telA, f1) - timeAt(telA, f0);
      const db = timeAt(telB, f1) - timeAt(telB, f0);
      out.push({ f0, f1, winner: da <= db ? "a" : "b", gap: Math.abs(da - db) });
    }
    return out;
  }

  /* The join: Jolpica speaks in driver codes, OpenF1 in car numbers and acronyms. */
  function colourIndex(openf1Drivers) {
    const byCode = new Map();
    openf1Drivers && openf1Drivers.forEach(d => d.colour && byCode.set(d.code, d.colour));
    return function colourFor(code, teamId) {
      return byCode.get(code) || TEAM_FALLBACK[teamId] || hashColour(teamId || code || "x");
    };
  }

  function numberForCode(openf1Drivers, code) {
    for (const d of openf1Drivers.values()) if (d.code === code) return d.number;
    return null;
  }

  window.Sources = {
    resolveSeason, season: () => SEASON,
    schedule, upcoming, driverStandings, constructorStandings, lastRace, seasonResults, lastQualifying,
    sessions, drivers, laps, stints, pits, raceControl, weather, classification,
    raceTrace, neutralised, pace,
    cleanLaps, fastestLap, lapTelemetry, dominance, colourIndex, numberForCode, TEAM_FALLBACK
  };
})();
