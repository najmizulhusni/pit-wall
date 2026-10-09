(function () {
  "use strict";
  const S = window.Sources, C = window.Charts, P = window.Pipeline, A = window.Analytics, Shell = window.Shell;
  const { whenVisible, animateIn, segInk, store } = Shell;
  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
  const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

  const state = {
    standings: null, teams: null, last: null, schedule: null, rounds: null,
    sessions: null, session: null, drivers: null, laps: null, order: [], result: null,
    pits: null, rc: null, trace: null, bands: [],
    colourFor: S.colourIndex(null),
    a: null, b: null, picked: false, focus: new Set(), table: "drivers", showAll: false, traceMode: "pos",
    tel: new Map(),
    mode: null, upcoming: null,
    follow: store.get("pitwall-driver") || ""
  };
  const resizers = new Map();
  const charts = {};

  /* ---------- format ---------- */
  function lapTime(sec) {
    if (sec == null) return "–";
    const m = Math.floor(sec / 60), s = sec - m * 60;
    return m ? `${m}:${s.toFixed(3).padStart(6, "0")}` : s.toFixed(3);
  }
  function raceTime(sec) {
    const hr = Math.floor(sec / 3600), m = Math.floor(sec / 60) % 60, s = sec - hr * 3600 - m * 60;
    return `${hr}:${String(m).padStart(2, "0")}:${s.toFixed(3).padStart(6, "0")}`;
  }
  const lapShort = sec => { const m = Math.floor(sec / 60), s = sec - m * 60; return `${m}:${s.toFixed(1).padStart(4, "0")}`; };
  const isRace = s => Boolean(s) && /^(Race|Sprint)$/.test(s.session_name);
  const sessionName = s => `${s.location} ${s.session_name.toLowerCase()}`;
  const dateShort = d => new Date(d).toLocaleDateString(undefined, { day: "numeric", month: "short" });
  const dateLong = d => new Date(d).toLocaleDateString(undefined, { weekday: "short", day: "numeric", month: "short" });
  const whenLocal = d => d.toLocaleString(undefined, { weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
  const two = n => String(n).padStart(2, "0");
  const plural = (n, one, many = one + "s") => `${n} ${n === 1 ? one : many}`;
  const fmtPts = v => Number.isInteger(v) ? String(v) : v.toFixed(1);

  function emptyState(host, title, detail) {
    host.innerHTML = `<div class="empty"><b>${esc(title)}</b>${esc(detail || "")}</div>`;
  }
  const skeleton = (host, px = 220) => { host.innerHTML = `<div class="skeleton" style="height:${px}px"></div>`; };
  const errText = e => {
    if (!e) return "Unknown error.";
    const msg = (e.message || "").replace(/\.+$/, "");
    if (!e.source) return msg ? msg + "." : "Unknown error.";
    return `${e.source} answered ${e.status ? "HTTP " + e.status : "with an error"}${msg && !/^HTTP/.test(msg) ? ": " + msg : ""}.`;
  };

  function hexRgb(c) {
    const m = /^#?([0-9a-f]{6})$/i.exec(c || "");
    return m ? [0, 2, 4].map(i => parseInt(m[1].slice(i, i + 2), 16)) : null;
  }
  function similar(c1, c2) {
    if (c1 === c2) return true;
    const a = hexRgb(c1), b = hexRgb(c2);
    return a && b ? Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]) < 70 : false;
  }

  /* ---------- motion ---------- */
  const io = "IntersectionObserver" in window;

  function countUp(node, to, ms = 900) {
    if (C.reduced()) { node.textContent = fmtPts(to); return; }
    const t0 = performance.now();
    const tick = now => {
      const k = Math.min(1, (now - t0) / ms), e = 1 - (1 - k) ** 3;
      node.textContent = k < 1 ? Math.round(to * e) : fmtPts(to);
      if (k < 1) requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }

  /* ---------- data feed ---------- */
  function statusOf(e) {
    if (e.status === "cache") return ["cache", "Cache"];
    if (e.fallback) return ["stale", `${e.status}, used ${e.fallback === "snapshot" ? "nightly snapshot" : "older cached copy"}`];
    if (e.status === "queued" || e.status === "sending") return ["", e.status === "queued" ? "Queued" : "Sending"];
    if (typeof e.status === "number" && e.status < 400) return [e.retried ? "retry" : "ok", e.retried ? `${e.status} after ${plural(e.retried, "retry", "retries")}` : String(e.status)];
    return ["error", `${e.status}${e.error ? ", " + e.error : ""}`];
  }
  /* The full log is only built while someone has it open. */
  function renderLog() {
    if (!$("#log-details").open) return;
    $("#log").innerHTML = P.log.slice(0, 40).map(e => {
      const [cls, txt] = statusOf(e);
      const t = new Date(e.at).toLocaleTimeString(undefined, { hour12: false });
      return `<tr><td>${t}</td><td>${esc(e.source)}</td><td>${esc(e.label)}</td>
        <td><span class="st ${cls}" title="${esc(txt)}">${esc(txt)}</span></td><td class="num">${e.ms ?? ""}</td><td class="num">${e.rows ?? ""}</td></tr>`;
    }).join("");
  }
  let feedTimer = 0;
  function renderFeed() {
    feedTimer = 0;
    const st = P.stats;
    const tiles = [
      ["Requests", st.requests],
      ["Served from cache", st.cacheHits],
      ["Average response", P.avgMs() ? `${P.avgMs()}<small> ms</small>` : "–"],
      ["Rows processed", st.rows.toLocaleString()]
    ];
    $("#counters").innerHTML = tiles.map(([k, v]) => `<div><dt>${k}</dt><dd>${v}</dd></div>`).join("");
    renderLog();
    setFeed();
  }
  const health = {};   // per source: ok | down | fallback
  function setFeed() {
    const btn = $("#feed"), label = $("span", btn);
    const busy = Object.values(P.lanes()).some(n => n > 0);
    const down = Object.keys(health).filter(k => health[k] === "down");
    const fallback = Object.keys(health).filter(k => health[k] === "fallback");
    const name = k => (k === "openf1" ? "OpenF1" : "Jolpica");
    let st = "", txt = "Connecting";
    if (busy) { st = "busy"; txt = "Fetching"; }
    else if (down.length) { st = "down"; txt = `${down.map(name).join(" and ")} offline`; }
    else if (fallback.length) { st = "stale"; txt = "Using fallback data"; }
    else if (P.stats.network) { st = "live"; txt = "Live data"; }
    else if (P.stats.cacheHits) { st = "live"; txt = "Cached data"; }
    if (btn.dataset.state !== st) btn.dataset.state = st;
    if (label.textContent !== txt) label.textContent = txt;
  }
  P.on((entry, phase) => {
    if (phase === "done" && (entry.status !== "cache" || !health[entry.sourceKey])) health[entry.sourceKey] = "ok";
    if (phase === "error") health[entry.sourceKey] = "down";
    if (phase === "fallback") health[entry.sourceKey] = "fallback";
    // Requests arrive in bursts; repaint the feed a few times a second at most.
    if (!feedTimer) feedTimer = setTimeout(renderFeed, 250);
  });

  /* ---------- hero: latest race ---------- */
  function renderHeroRace() {
    const r = state.last;
    const kick = $("#hero-kicker"), title = $("#hero-title");
    if (!r) {
      kick.textContent = "Formula 1";
      title.textContent = state.standings ? "No race classified yet" : "Results unavailable";
      return;
    }
    const finale = state.schedule && r.round === state.schedule.length;
    kick.innerHTML = `<span>${finale ? "Season finale" : "Latest race"}</span><span>${state.mode?.mode === "live" ? `Round ${r.round}` : `${state.mode?.year ?? ""} round ${r.round}`}</span><span>${esc(dateShort(r.date))}</span><span>${esc(r.locality)}</span>`;
    if (title.dataset.round !== String(r.round)) {
      title.dataset.round = r.round;
      title.innerHTML = r.name.split(" ").map((w, i) => `<span class="w" style="--i:${i}"><span>${esc(w)}</span></span>`).join(" ");
    }
    // A podium you can read at a glance: P2, P1, P3 left to right, steps rising in that order.
    $("#hero-podium").innerHTML = r.results.slice(0, 3).map(x => `
      <li class="step s${x.pos}" style="--c:${state.colourFor(x.driver.code, x.teamId)}">
        <div class="pdr"><b>${esc(x.driver.code)}</b><span>${esc(shortName(x.driver))}</span><small>${esc(x.team)}</small></div>
        <div class="block"><span class="n">${x.pos}</span><span class="t">${esc(x.time || x.status)}</span></div>
      </li>`).join("");

    const gain = r.results.filter(x => x.grid && x.finished).map(x => ({ ...x, gain: x.grid - x.pos })).sort((a, b) => b.gain - a.gain)[0];
    const fl = r.results.find(x => x.fastestRank === 1);
    const out = r.results.filter(x => !x.finished).length;
    const tm = titleModel();
    const titleNote = !tm ? "" : !tm.rivals.length
      ? `<li><span>Title</span><b>${esc(shortName(tm.lead.driver))} is champion</b></li>`
      : tm.earliest ? `<li><span>Title</span><b>${esc(shortName(tm.lead.driver))} can clinch in ${esc(tm.earliest.r.locality)} at the earliest</b></li>` : "";
    $("#hero-notes").innerHTML = [
      titleNote,
      gain && gain.gain > 0 ? `<li><span>Biggest climb</span><b>${esc(gain.driver.family)}, P${gain.grid} to P${gain.pos}</b></li>` : "",
      fl ? `<li><span>Fastest lap</span><b>${esc(fl.driver.family)}${fl.fastestTime ? `, ${esc(fl.fastestTime)}` : ""}</b></li>` : "",
      `<li><span>Not classified as finishing</span><b>${out}</b></li>`
    ].join("");
  }

  /* Countdown to the next session. Markup is rebuilt only when the target changes; digits tick every second. */
  const SESSION_LEN = { Race: 2.2, Sprint: 1.1 };
  let nextKey = "";
  function renderNext() {
    const host = $("#next-race");
    if (!state.upcoming || state.mode?.mode === "archive") { host.hidden = true; return; }
    const now = Date.now();
    const race = state.upcoming.find(r => r.start && r.start.getTime() + 3 * 36e5 > now);
    if (!race) { host.hidden = true; return; }
    const running = race.sessions.find(s => s[1].getTime() <= now && s[1].getTime() + (SESSION_LEN[s[0]] || 1) * 36e5 > now);
    const next = race.sessions.find(s => s[1].getTime() > now) || ["Race", race.start];
    const key = `${race.round}:${running ? "live:" + running[0] : next[0]}`;
    host.hidden = false;
    if (key !== nextKey) {
      nextKey = key;
      host.innerHTML = running
        ? `<p class="next-k"><span class="live-dot"></span>On track now, round ${race.round}</p>
           <p class="next-name">${esc(race.name)}</p>
           <p class="next-when">${esc(running[0])} in ${esc(race.locality)}${next[0] !== running[0] ? `. ${esc(next[0])} next, ${whenLocal(next[1])}` : ""}</p>`
        : `<p class="next-k">Next up, round ${race.round}</p>
           <p class="next-name">${esc(race.name)}</p>
           <div class="count" role="timer" aria-live="off">
             <span><b data-u="d">0</b><small>days</small></span><span><b data-u="h">00</b><small>hrs</small></span>
             <span><b data-u="m">00</b><small>min</small></span><span><b data-u="s">00</b><small>sec</small></span>
           </div>
           <p class="next-when">${esc(next[0])}, ${whenLocal(next[1])} your time</p>
           <button class="ics" type="button" data-ics="weekend" data-round="${race.round}">${ICON_CAL}Add this weekend to your calendar</button>`;
    }
    if (running) return;
    const ms = Math.max(0, next[1].getTime() - now);
    const parts = { d: Math.floor(ms / 864e5), h: two(Math.floor(ms / 36e5) % 24), m: two(Math.floor(ms / 6e4) % 60), s: two(Math.floor(ms / 1e3) % 60) };
    $$("[data-u]", host).forEach(b => { const v = String(parts[b.dataset.u]); if (b.textContent !== v) b.textContent = v; });
  }

  /* ---------- season ---------- */
  function teamColour(teamId) {
    const d = state.standings?.rows.find(r => r.teamId === teamId);
    return d ? state.colourFor(d.driver.code, teamId) : state.colourFor(null, teamId);
  }

  function formCells(driverId) {
    return (state.rounds || []).slice(-5).map(r => {
      const x = r.rows.find(v => v.driver.id === driverId);
      if (!x) return `<i class="f none" title="Round ${r.round}: did not start">–</i>`;
      const cls = !x.finished ? "out" : x.pos === 1 ? "win" : x.pos <= 3 ? "pod" : x.points > 0 ? "scored" : "";
      const label = x.finished ? x.pos : "×";
      return `<i class="f ${cls}" title="Round ${r.round}, ${esc(r.name)}: ${x.finished ? "P" + x.pos : esc(x.status)}">${label}</i>`;
    }).join("");
  }

  function renderStandings(fresh) {
    const host = $("#standings");
    const drivers = state.table === "drivers";
    const rows = drivers ? state.standings?.rows : state.teams?.rows;
    if (!rows || !rows.length) return emptyState(host, "No standings yet", "The season may not have started. Standings appear after round one.");
    const max = rows[0].points || 1;
    const animate = !C.reduced() && (fresh || !host.dataset.played);
    const more = $("#more");
    const cut = drivers && !state.showAll && rows.length > 12;
    more.hidden = !drivers || rows.length <= 12;
    more.textContent = state.showAll ? "Show top 10" : `Show all ${rows.length} drivers`;
    const showForm = drivers && state.rounds;
    host.classList.toggle("has-form", Boolean(showForm));
    $("#standings-head").innerHTML = `<span>Pos</span><span></span><span>${drivers ? "Driver" : "Team"}</span>${showForm ? `<span class="h-form">Last five</span>` : ""}<span class="h-bar"></span><span>Pts</span>`;
    $("#standings-head").classList.toggle("has-form", Boolean(showForm));

    host.innerHTML = (cut ? rows.slice(0, 10) : rows).map((r, i) => {
      const colour = drivers ? state.colourFor(r.driver.code, r.teamId) : teamColour(r.teamId);
      const who = drivers
        ? `<b>${esc(shortName(r.driver))}</b><span>${esc(r.team)}</span>`
        : `<b>${esc(r.team)}</b><span>${r.wins ? plural(r.wins, "win") : ""}</span>`;
      const mine = drivers && state.follow && r.driver.id === state.follow;
      const gap = rows[0].points - r.points;
      return `<li class="${animate ? "anim" : ""}${mine ? " mine" : ""}${i === 0 ? " lead" : ""}" style="--c:${colour};--i:${i}"><span class="pos"><b>${r.pos ?? "–"}</b></span><span class="tc"></span>
        <span class="nm">${who}</span>${showForm ? `<span class="form">${formCells(r.driver.id)}</span>` : ""}
        <span class="bar"><i data-w="${(r.points / max).toFixed(4)}"></i></span>
        <span class="pts"><b data-v="${r.points}">${animate ? 0 : fmtPts(r.points)}</b><small>${i ? `−${fmtPts(gap)}` : "Leader"}</small></span></li>`;
    }).join("");

    const play = () => {
      host.dataset.played = "1";
      host.classList.add("play");
      $$(".bar i", host).forEach(b => b.style.setProperty("--w", b.dataset.w));
      if (animate) $$(".pts b", host).forEach(n => countUp(n, Number(n.dataset.v)));
    };
    if (!animate) return play();
    host.classList.remove("play");
    if (host.dataset.played) requestAnimationFrame(() => requestAnimationFrame(play));
    else whenVisible(host, play);
  }

  function seasonKicker() {
    if (!state.standings) return;
    const total = state.schedule?.length;
    $("#season-kicker").textContent = `${state.standings.season} season, after round ${state.standings.round}${total ? ` of ${total}` : ""}`;
  }

  /*
    Title maths. Assumes the leader scores nothing from here on and a rival wins everything,
    which is the only question that matters for "still in it".
  */
  function renderTitle() {
    const host = $("#title-fight");
    const drivers = state.table === "drivers";
    const rows = drivers ? state.standings?.rows : state.teams?.rows;
    if (!rows?.length || !state.schedule) { host.innerHTML = ""; return; }
    const left = state.schedule.filter(r => r.round > state.standings.round);
    const perRace = drivers ? 25 : 43, perSprint = drivers ? 8 : 15;
    const worth = r => perRace + (r.sprint ? perSprint : 0);
    const max = left.reduce((n, r) => n + worth(r), 0);
    const lead = rows[0];
    const leadName = drivers ? lead.driver.family : lead.team;
    const nameOf = r => drivers ? r.driver.family : r.team;
    const alive = rows.filter(r => lead.points - r.points <= max);
    const rivals = alive.length - 1;
    const sprints = left.filter(r => r.sprint).length;

    // Earliest round the leader could seal it: they win everything, the nearest rival scores nothing.
    let clinch = null;
    if (rivals && rows[1]) {
      let margin = lead.points - rows[1].points, remaining = max;
      for (const r of left) {
        margin += worth(r); remaining -= worth(r);
        if (margin > remaining) { clinch = r; break; }
      }
    }

    host.innerHTML = `
      <p class="kicker">${drivers ? "Drivers'" : "Constructors'"} title</p>
      <p class="big"><b data-v="${max}">${max}</b> points still on the table</p>
      <p class="sub">${left.length ? `${plural(left.length, "round")} left${sprints ? `, ${plural(sprints, "sprint")} among them` : ""}. ` : "Season complete. "}
        ${!left.length ? `${esc(leadName)} ${drivers ? "is" : "are"} champion${drivers ? "" : "s"}.`
          : rivals ? `${plural(rivals, drivers ? "driver" : "team")} can still catch ${esc(leadName)}.`
          : `${esc(leadName)} cannot be caught.`}</p>
      ${max ? `<ol class="reach">${alive.slice(0, 6).map((r, i) => {
        const gap = lead.points - r.points;
        const colour = drivers ? state.colourFor(r.driver.code, r.teamId) : teamColour(r.teamId);
        return `<li style="--c:${colour};--i:${i}">
          <span class="nm">${esc(nameOf(r))}</span>
          <span class="track-bar"><i style="--w:${Math.max(0.015, Math.min(1, gap / max)).toFixed(4)}"></i></span>
          <span class="gap">${i ? `−${fmtPts(gap)}` : "Leader"}</span></li>`;
      }).join("")}</ol>
      <p class="note">Bar length is the deficit as a share of the points left. Past the end, the title is gone.</p>` : ""}
      ${clinch && !drivers ? `<p class="clinch"><span>Earliest clinch</span><b>Round ${clinch.round}, ${esc(clinch.locality)}</b><small>If ${esc(leadName)} ${drivers ? "wins" : "finish one-two in"} every race until then and ${esc(nameOf(rows[1]))} ${drivers ? "scores" : "score"} nothing.</small></p>` : ""}`;
  }

  /* ---------- title analytics ---------- */
  const shortName = d => `${d.given.split(" ").at(-1)} ${d.family}`;

  const titleModel = () => A.title({ standings: state.standings, schedule: state.schedule, rounds: state.rounds });

  function renderTitleRace() {
    const panel = $("#title-race");
    const tm = titleModel();
    if (!tm || !tm.left.length) { panel.hidden = true; return; }
    panel.hidden = false;
    const { lead, rivals, steps, earliest, field, projClinch, max } = tm;
    const who = shortName(lead.driver), fam = lead.driver.family;
    const colour = r => state.colourFor(r.driver.code, r.teamId);
    const when = r => r.start ? dateShort(r.start) : "";
    const span = n => n === 1 ? "in the next round" : `over the next ${n} rounds`;

    $("#tr-q").textContent = rivals.length ? `When can ${who} win the title?` : `${who} is champion`;
    if (!rivals.length) {
      $("#tr-answers").innerHTML = `<div class="ans"><span>Decided</span><b>${esc(fam)} cannot be caught</b><small>No one is within ${max} points, the most still available.</small></div>`;
      $("#tr-clinch").innerHTML = ""; $("#tr-proj").innerHTML = ""; $("#tr-note").textContent = "";
      return;
    }

    const binding = earliest ? earliest.needs.filter(n => n.need > 0) : [];
    const k = earliest ? steps.indexOf(earliest) + 1 : 0;
    const p2 = rivals[0], p2f = field.find(f => f.row === p2), lf = field.find(f => f.row === lead);
    let form;
    if (!tm.hasForm || !projClinch) form = `<span>On current form</span><b>Loading results</b>`;
    else if (projClinch.who !== lead) form = `<span>On current form</span><b>${esc(projClinch.who.driver.family)} takes it</b><small>Recent form says the lead does not hold. ${esc(projClinch.who.driver.family)} would seal it in ${esc(projClinch.step.r.locality)}.</small>`;
    else if (projClinch.step === steps.at(-1)) form = `<span>On current form</span><b>The final round</b><small>${esc(fam)} stays ahead, but not clear until ${esc(projClinch.step.r.locality)}.</small>`;
    else form = `<span>On current form</span><b>${esc(projClinch.step.r.locality)}, ${when(projClinch.step.r)}</b><small>${esc(fam)} averages ${lf.race.toFixed(1)} points a race over the last five, ${esc(p2.driver.family)} ${p2f.race.toFixed(1)}.</small>`;

    $("#tr-answers").innerHTML = `
      <div class="ans"><span>Earliest possible</span>${earliest
        ? `<b>${esc(earliest.r.locality)}, ${when(earliest.r)}</b><small>Round ${earliest.r.round}. ${binding.length ? `${esc(fam)} must outscore ${binding.map(n => `${esc(n.rv.driver.family)} by ${n.need}`).join(" and ")} ${span(k)}.` : "Any result will do."}</small>`
        : `<b>Not this season</b><small>The gap can't be closed in time.</small>`}</div>
      <div class="ans">${form}</div>
      <div class="ans"><span>Lead today</span><b>${fmtPts(lead.points - p2.points)} points</b><small>Over ${esc(p2.driver.family)}, with ${max} still available.</small></div>`;

    const shown = rivals.slice(0, 2);
    $("#tr-clinch").innerHTML = `<thead><tr><th>Round</th><th class="num" title="Points still available after this round">Left</th>${shown.map(r => `<th class="num" title="Points ${esc(fam)} must outscore ${esc(r.driver.family)} by, from now to this round">vs ${esc(r.driver.code)}</th>`).join("")}<th>Status</th></tr></thead>
      <tbody>${steps.map(s => {
        const status = projClinch?.step === s && projClinch.who === lead ? ["proj", "On form"] : s.decided ? ["done", "Lead enough"] : s.possible ? ["ok", "Possible"] : ["no", "Too soon"];
        return `<tr class="${s === earliest ? "first" : ""}"><td><b>${esc(s.r.locality)}</b><small>R${s.r.round}${s.r.sprint ? ", sprint" : ""} · ${when(s.r)}</small></td>
          <td class="num">${s.remaining}</td>
          ${shown.map(r => { const n = s.needs.find(x => x.rv === r).need; return `<td class="num">${n ? n : "–"}</td>`; }).join("")}
          <td><span class="pill ${status[0]}">${status[1]}</span></td></tr>`;
      }).join("")}</tbody>`;

    const topF = field.slice(0, 5);
    const maxProj = Math.max(...topF.map(f => f.pts), 1);
    $("#tr-proj").innerHTML = `<thead><tr><th>Driver</th><th class="num">Now</th><th class="num">Avg / race</th><th>Projected</th></tr></thead>
      <tbody>${topF.map((f, i) => `<tr style="--c:${colour(f.row)};--i:${i}">
        <td><span class="tc"></span><b>${esc(f.row.driver.family)}</b></td>
        <td class="num">${fmtPts(f.row.points)}</td>
        <td class="num">${f.race.toFixed(1)}</td>
        <td><span class="proj"><i style="--w:${(f.pts / maxProj).toFixed(4)}"></i><b>${Math.round(f.pts)}</b></span></td></tr>`).join("")}</tbody>`;
    const mineC = A.chances(tm, state.follow);
    const mineLine = $("#tr-mine");
    mineLine.hidden = !mineC || mineC.kind === "leader";
    if (!mineLine.hidden) mineLine.innerHTML = `<span>Your driver</span>${followSentence(mineC, tm)}`;
    $("#tr-note").textContent = `"Left" is the points still available after that round. The "vs" columns are how many more points ${fam} must score than that driver, from now until that round, to make the title safe there. "Lead enough" means the current lead already covers it, as long as ${fam} matches that driver from here. Grands Prix are worth 25, sprints 8; ties are ignored.`;
  }

  /* ---------- calendar ---------- */
  function raceSessionFor(r) {
    if (!state.sessions || !r.start) return null;
    return state.sessions.completed.find(s => s.session_name === "Race" && Math.abs(Date.parse(s.date_start) - r.start.getTime()) < 30 * 36e5) || null;
  }
  function weekend(r) {
    const a = r.sessions[0]?.[1] || r.start, b = r.start;
    const same = a.getMonth() === b.getMonth();
    const mon = d => d.toLocaleDateString(undefined, { month: "short" });
    return same ? `${a.getDate()}–${b.getDate()} ${mon(b)}` : `${a.getDate()} ${mon(a)} – ${b.getDate()} ${mon(b)}`;
  }

  let calPlaced = false;
  function renderCalendar() {
    const host = $("#cal");
    if (!state.schedule) return;
    const now = Date.now();
    const next = state.schedule.find(r => r.start && r.start.getTime() + 3 * 36e5 > now);
    const done = state.schedule.filter(r => r.start && r.start.getTime() + 3 * 36e5 <= now).length;
    $("#cal-progress").innerHTML = `<span><b>${done}</b> of ${state.schedule.length} rounds run</span><span class="cal-bar"><i style="--w:${(done / state.schedule.length) * 100}%"></i></span>`;
    $("#cal-kicker").textContent = `${state.schedule[0]?.season || ""} calendar`;
    const remaining = (state.upcoming || []).some(r => r.sessions.some(x => x[1].getTime() > now));
    $("#cal-ics").hidden = state.mode?.mode === "archive" || !remaining;

    host.innerHTML = state.schedule.map(r => {
      const isDone = r.start && r.start.getTime() + 3 * 36e5 <= now, isNext = r === next;
      const res = state.rounds?.find(x => x.round === r.round)?.rows.find(x => x.pos === 1)
        || (state.last?.round === r.round ? state.last.results[0] : null);
      const colour = res ? state.colourFor(res.driver.code, res.teamId) : "transparent";
      const sess = isDone && raceSessionFor(r);
      const body = `
        <span class="rn">R${r.round}${r.sprint ? `<em>Sprint</em>` : ""}</span>
        <b class="loc">${esc(r.locality)}</b>
        <span class="gp">${esc(r.name)}</span>
        <time>${weekend(r)}</time>
        ${res ? `<span class="won"><i></i>${esc(res.driver.family)}</span>` : isDone ? `<span class="won muted">Result pending</span>` : ""}
        ${isNext ? `<ul class="sched">${r.sessions.map(s => `<li class="${s[1].getTime() < now ? "past" : ""}"><span>${esc(s[0])}</span><time>${whenLocal(s[1])}</time></li>`).join("")}</ul>` : ""}
        ${sess ? `<span class="go">Race data</span>` : ""}`;
      const cls = `rd${isDone ? " is-done" : ""}${isNext ? " is-next" : ""}`;
      return `<li class="${cls}" style="--c:${colour}">${sess
        ? `<button type="button" data-session="${sess.session_key}" aria-label="Open race data for round ${r.round}, ${esc(r.name)}">${body}</button>`
        : `<div>${body}</div>`}</li>`;
    }).join("");

    // Open the strip on the latest result and the next round. Set scrollLeft directly so the page never jumps.
    if (!calPlaced) {
      const wrap = host.parentElement;
      const next = $(".rd.is-next", host), target = next?.previousElementSibling || next || $$(".rd.is-done", host).at(-1);
      if (target) {
        wrap.scrollLeft = Math.max(0, target.getBoundingClientRect().left - wrap.getBoundingClientRect().left + wrap.scrollLeft - parseFloat(getComputedStyle(wrap).paddingLeft));
        calPlaced = true;
      }
    }
  }

  /* ---------- head to head ---------- */
  function fillPicks() {
    const rows = state.standings?.rows || [];
    if (!rows.length) return;
    const opts = rows.map(r => `<option value="${esc(r.driver.id)}">${r.pos ?? ""}. ${esc(r.driver.given)} ${esc(r.driver.family)}, ${esc(r.team)}</option>`).join("");
    $("#pick-a").innerHTML = opts;
    $("#pick-b").innerHTML = opts;
    if (!state.picked) {
      const i = Math.max(0, rows.findIndex(r => r.driver.id === state.follow));
      const mine = rows[i];
      state.a = mine.driver.id;
      state.b = (i === 0 ? rows[1] : rows[i - 1] || rows[0]).driver.id;
    }
    $("#pick-a").value = state.a;
    $("#pick-b").value = state.b;
  }

  function pair() {
    const rows = state.standings?.rows || [];
    const A = rows.find(r => r.driver.id === state.a), B = rows.find(r => r.driver.id === state.b);
    if (!A || !B) return null;
    const ca = state.colourFor(A.driver.code, A.teamId);
    let cb = state.colourFor(B.driver.code, B.teamId), dashB = false;
    if (similar(ca, cb)) { cb = "var(--chalk)"; dashB = true; }
    document.documentElement.style.setProperty("--a", ca);
    document.documentElement.style.setProperty("--b", cb);
    return { A, B, ca, cb, dashB };
  }

  function seasonLine(driverId) {
    let total = 0;
    const pts = [[0, 0]];
    (state.rounds || []).forEach(r => {
      const race = r.rows.find(x => x.driver.id === driverId);
      const spr = r.sprint.find(x => x.driver.id === driverId);
      total += (race?.points || 0) + (spr?.points || 0);
      pts.push([r.round, total]);
    });
    return pts;
  }

  function duelStats(idA, idB) {
    const s = id => ({ id, wins: 0, podiums: 0, best: null, finSum: 0, finN: 0, dnf: 0, ahead: 0, startAhead: 0 });
    const a = s(idA), b = s(idB);
    (state.rounds || []).forEach(r => {
      const ra = r.rows.find(x => x.driver.id === idA), rb = r.rows.find(x => x.driver.id === idB);
      [[a, ra], [b, rb]].forEach(([acc, x]) => {
        if (!x) return;
        if (x.pos === 1) acc.wins++;
        if (x.pos <= 3) acc.podiums++;
        if (x.finished) { acc.finSum += x.pos; acc.finN++; acc.best = acc.best ? Math.min(acc.best, x.pos) : x.pos; } else acc.dnf++;
      });
      if (ra && rb) {
        if (ra.pos < rb.pos) a.ahead++; else b.ahead++;
        const ga = ra.grid || 99, gb = rb.grid || 99;
        if (ga < gb) a.startAhead++; else if (gb < ga) b.startAhead++;
      }
    });
    const avg = x => x.finN ? x.finSum / x.finN : null;
    return [
      ["Finished ahead", a.ahead, b.ahead, "high"],
      ["Started ahead", a.startAhead, b.startAhead, "high"],
      ["Wins", a.wins, b.wins, "high"],
      ["Podiums", a.podiums, b.podiums, "high"],
      ["Average finish", avg(a), avg(b), "low", v => v == null ? "–" : v.toFixed(1)],
      ["Best finish", a.best, b.best, "low", v => v == null ? "–" : `P${v}`],
      ["Did not finish", a.dnf, b.dnf, "low"]
    ];
  }

  function renderH2H(animate) {
    const p = pair();
    if (!p) return;
    const { A, B, ca, cb, dashB } = p;

    const pointsHost = $("#points-chart");
    if (!state.rounds) skeleton(pointsHost, 300);
    else {
      const draw = anim => C.lineChart(pointsHost, {
        series: [
          { id: "a", label: A.driver.family, colour: ca, points: seasonLine(A.driver.id) },
          { id: "b", label: B.driver.family, colour: cb, dashed: dashB, points: seasonLine(B.driver.id) }
        ],
        xMin: 0, yMin: 0, height: 300, animate: anim, aria: "Cumulative points by round",
        xFmt: (v, tip) => tip ? (v ? `After round ${v}` : "Season start") : (v === 0 ? "Start" : Number.isInteger(v) ? `R${v}` : ""),
        yFmt: (v, tip) => tip ? `${fmtPts(v)} pts` : v,
        xLabel: "Round"
      });
      if (animate) animateIn(pointsHost, draw); else draw(false);
      resizers.set("points", () => draw(false));
    }

    const duel = $("#duel");
    if (!state.rounds) { skeleton(duel, 260); return; }
    const rows = [["Points", A.points, B.points, "high", fmtPts], ...duelStats(A.driver.id, B.driver.id)];
    $("#duel-key").innerHTML = `<b style="color:${ca}">${esc(A.driver.given)} ${esc(A.driver.family)}</b><b style="color:${cb}">${esc(B.driver.given)} ${esc(B.driver.family)}</b>`;
    duel.innerHTML = rows.map(([label, va, vb, better, fmt]) => {
      const f = fmt || (v => v ?? "–");
      const na = va ?? 0, nb = vb ?? 0;
      let wa = na, wb = nb;
      if (better === "low") { wa = nb; wb = na; }
      if (wa + wb === 0) { wa = 1; wb = 1; }
      const aWins = better === "high" ? na > nb : (va != null && (vb == null || na < nb));
      const bWins = better === "high" ? nb > na : (vb != null && (va == null || nb < na));
      return `<div><dt>${label}</dt>
        <dd class="${aWins ? "win" : bWins ? "lose" : ""}">${f(va)}</dd>
        <span class="split"><i style="flex-grow:${wa};background:${ca}"></i><i style="flex-grow:${wb};background:${cb}"></i></span>
        <dd class="vb ${bWins ? "win" : aWins ? "lose" : ""}">${f(vb)}</dd></div>`;
    }).join("");
  }

  async function telemetryFor(lap) {
    const key = `${state.session.session_key}:${lap.driver_number}:${lap.lap_number}`;
    if (!state.tel.has(key)) state.tel.set(key, S.lapTelemetry(state.session.session_key, lap));
    return state.tel.get(key);
  }

  let compareSeq = 0;
  async function renderCompare() {
    const my = ++compareSeq;
    const p = pair();
    const note = $("#cmp-note"), gap = $("#cmp-gap"), svg = $("#dom-track"), chart = $("#speed-chart");
    if (!p || !state.session || !state.laps || !state.drivers) return;
    const { A, B, ca, cb, dashB } = p;
    $("#cmp-title").textContent = `Fastest laps compared, ${sessionName(state.session)}`;
    note.textContent = "Change the session in the Race section.";
    const na = S.numberForCode(state.drivers, A.driver.code), nb = S.numberForCode(state.drivers, B.driver.code);
    const la = na != null && S.fastestLap(state.laps, na), lb = nb != null && S.fastestLap(state.laps, nb);
    if (!la || !lb) {
      svg.innerHTML = "";
      gap.textContent = "";
      return emptyState(chart, "No lap to compare", `${!la ? A.driver.family : B.driver.family} has no timed lap in this session. Pick another session or driver.`);
    }
    skeleton(chart, 280);
    let ta, tb;
    try { [ta, tb] = await Promise.all([telemetryFor(la), telemetryFor(lb)]); }
    catch (e) { if (my === compareSeq) emptyState(chart, "Telemetry unavailable", errText(e)); return; }
    if (my !== compareSeq) return;
    if (!ta || !tb) return emptyState(chart, "Telemetry incomplete", "OpenF1 returned too few position samples for one of these laps.");

    const dom = S.dominance(ta, tb, 24);
    const sectorOf = f => dom[Math.min(dom.length - 1, Math.floor(f * dom.length))];
    const drawMap = anim => C.trackMap(svg, ta.points, { keyOf: i => sectorOf(ta.points[i].f).winner, paint: w => (w === "a" ? ca : cb), stroke: 11, draw: anim, drawMs: 1200 });

    const toSeries = t => t.points.filter(pt => pt.speed != null).map(pt => [pt.f * 100, pt.speed]);
    const draw = anim => C.lineChart(chart, {
      series: [
        { label: A.driver.family, colour: ca, points: toSeries(ta) },
        { label: B.driver.family, colour: cb, dashed: dashB, points: toSeries(tb) }
      ],
      xMin: 0, xMax: 100, height: 280, animate: anim, aria: "Speed through the lap",
      xFmt: (v, tip) => tip ? `${v.toFixed(0)}% through the lap` : `${v}%`,
      yFmt: (v, tip) => tip ? `${Math.round(v)} km/h` : v,
      xLabel: "Lap distance"
    });
    animateIn(chart, anim => { if (my !== compareSeq) return; draw(anim); drawMap(anim); });
    resizers.set("speed", () => draw(false));

    const wonA = dom.filter(d => d.winner === "a").length;
    const diff = la.lap_duration - lb.lap_duration;
    const faster = diff <= 0 ? A.driver.family : B.driver.family;
    gap.textContent = `${A.driver.family} ${lapTime(la.lap_duration)} on lap ${la.lap_number}, ${B.driver.family} ${lapTime(lb.lap_duration)} on lap ${lb.lap_number}. ` +
      `${faster} was ${Math.abs(diff).toFixed(3)}s quicker overall; ${A.driver.family} took ${wonA} of ${dom.length} mini-sectors.`;
  }

  /* ---------- hero lap replay ---------- */
  /*
    The track is drawn once into one SVG; the car and its trail live in a second SVG on its own
    compositor layer. Each frame touches only that small layer, and the readout text is written
    only when its value changes (the telemetry is 4 Hz, the screen 60-120 Hz).
  */
  const TRAIL_MS = 1400;
  const SPEED_STEPS = 24;
  const LOOK_MS = 240;                       // the car points at where it will be a quarter-second from now
  const hero = { tel: null, xy: null, map: null, car: null, trail: null, raf: 0, t0: 0, paused: C.reduced(), visible: true, offset: 0, idx: 0, shown: {}, sample: -1, angle: null, rpm: null, revN: -1 };
  const readout = { speed: $("#r-speed"), gear: $("#r-gear"), thr: $("#r-thr"), brk: $("#r-brk"), clock: $("#r-clock"), prog: $("#r-prog"), leds: $$("#revs i") };

  /*
    A top-down F1 car, nose along +x, about 75 units long in the track's 1000-unit space.
    The body and wing endplates take the team colour from --car; carbon, tyres and halo stay dark.
  */
  const CAR = `
    <ellipse class="c-shadow" cx="3" cy="4" rx="38" ry="15"/>
    <rect class="c-carbon" x="-38" y="-11.5" width="7" height="23" rx="1.5"/>
    <rect class="c-accent" x="-38" y="-11.5" width="7" height="2.6" rx="1"/><rect class="c-accent" x="-38" y="8.9" width="7" height="2.6" rx="1"/>
    <path class="c-arm" d="M-24 -8V-13M-24 8V13M16.5 -3.4V-12M16.5 3.4V12"/>
    <rect class="c-tyre" x="-31" y="-17.5" width="13" height="7" rx="2.6"/><rect class="c-tyre" x="-31" y="10.5" width="13" height="7" rx="2.6"/>
    <rect class="c-tyre" x="11" y="-15.5" width="11" height="6" rx="2.3"/><rect class="c-tyre" x="11" y="9.5" width="11" height="6" rx="2.3"/>
    <rect class="c-carbon" x="31" y="-15.5" width="6" height="31" rx="1.6"/>
    <rect class="c-accent" x="31" y="-15.5" width="6" height="3" rx="1"/><rect class="c-accent" x="31" y="12.5" width="6" height="3" rx="1"/>
    <path class="c-floor" d="M-29 -7L-14 -12.3H3L9 -6V6L3 12.3H-14L-29 7Z"/>
    <path class="c-body" d="M-31 -3.4C-25 -4.2 -19 -9.6 -12 -9.8H1C6 -9.8 8 -5.2 12.5 -3.3L31 -1.8C33.5 -1.6 35 -.9 35 0C35 .9 33.5 1.6 31 1.8L12.5 3.3C8 5.2 6 9.8 1 9.8H-12C-19 9.6 -25 4.2 -31 3.4Z"/>
    <rect class="c-stripe" x="-27" y="-1.1" width="58" height="2.2" rx="1.1"/>
    <ellipse class="c-cockpit" cx="3.5" cy="0" rx="5.2" ry="3.3"/>
    <circle class="c-helmet" cx="2.4" cy="0" r="2.2"/>
    <path class="c-halo" d="M-1.6 -3.9Q9.6 -4.4 10.6 0Q9.6 4.4 -1.6 3.9"/>`;

  async function renderHeroLap(session, laps, drivers, liveSession) {
    const best = S.fastestLap(laps);
    if (!best) return heroEmpty("No timed laps", "OpenF1 has no lap times for this session yet.");
    const d = drivers.get(best.driver_number) || { name: `Car ${best.driver_number}` };
    $("#lap-title").textContent = sessionName(session);
    $("#lap-sub").textContent = `${d.name}${d.team ? `, ${d.team}` : ""}. Lap ${best.lap_number}, ${lapTime(best.lap_duration)}` +
      (liveSession ? `. A session is running now; OpenF1 limits live data on its free tier, so this is the last completed one.` : "");
    let tel;
    try { tel = await S.lapTelemetry(session.session_key, best); }
    catch (e) { return heroEmpty("Telemetry for this lap is unavailable", errText(e)); }
    if (!tel) return heroEmpty("Telemetry incomplete", "OpenF1 returned too few position samples for this lap.");
    let lo = Infinity, hi = -Infinity;
    for (const p of tel.points) if (p.speed != null) { if (p.speed < lo) lo = p.speed; if (p.speed > hi) hi = p.speed; }
    const bucket = i => Math.round((((tel.points[i].speed ?? lo) - lo) / (hi - lo || 1)) * (SPEED_STEPS - 1));
    const map = C.trackMap($("#hero-track"), tel.points, { keyOf: bucket, paint: k => C.ramp(k / (SPEED_STEPS - 1)), draw: true, drawMs: 1800 });
    const over = $("#hero-car");
    over.setAttribute("viewBox", map.viewBox);
    over.innerHTML = "";
    // Rev lights span this lap's own RPM range, so they sweep fully on every straight.
    const rpms = tel.points.map(p => p.rpm).filter(v => v > 0).sort((a, b) => a - b);
    const rpm = rpms.length > 20 ? [rpms[Math.floor(rpms.length * 0.05)], rpms[Math.floor(rpms.length * 0.98)]] : null;
    Object.assign(hero, { tel, map, xy: map.xy, idx: 0, offset: 0, shown: {}, sample: -1, angle: null, rpm, revN: -1 });
    $("#revs").hidden = !rpm;
    $("#lap").classList.add("ready");
    $("#lap-empty").hidden = true;
    over.style.setProperty("--car", d.colour || "var(--chalk)");
    hero.trail = C.el("path", { class: "trail", fill: "none" }, over);
    hero.car = C.el("g", { class: "racecar" }, over);
    hero.car.innerHTML = CAR;
    place(0, 0);
    $("#replay").textContent = hero.paused ? "Play replay" : "Pause replay";
    setTimeout(() => { hero.car.classList.add("on"); hero.t0 = performance.now(); loop(); }, map.drawMs);
  }

  function heroEmpty(title, detail) {
    const n = $("#lap-empty");
    n.hidden = false;
    n.innerHTML = `<b>${esc(title)}</b>${esc(detail)} Standings, calendar and head to head still load from Jolpica.`;
  }

  const setText = (key, node, v) => { if (hero.shown[key] !== v) { hero.shown[key] = v; node.textContent = v; } };

  /* Where the car is at lap time t, searching forward from sample i. */
  function pointAt(t, i = 0) {
    const pts = hero.tel.points, xy = hero.xy, dur = pts.at(-1).ms;
    if (t > dur) { t -= dur; i = 0; }
    if (t < pts[i].ms) i = 0;
    while (i < pts.length - 2 && pts[i + 1].ms <= t) i++;
    const k = Math.min(1, Math.max(0, (t - pts[i].ms) / (pts[i + 1].ms - pts[i].ms || 1)));
    return [xy[i][0] + (xy[i + 1][0] - xy[i][0]) * k, xy[i][1] + (xy[i + 1][1] - xy[i][1]) * k];
  }

  /* Place the car k of the way from sample i to i+1, at lap time t (ms). */
  function place(i, k, t = 0) {
    const pts = hero.tel.points, xy = hero.xy;
    const a = xy[i], b = xy[Math.min(i + 1, xy.length - 1)];
    const xn = a[0] + (b[0] - a[0]) * k, yn = a[1] + (b[1] - a[1]) * k;
    const x = xn.toFixed(1), y = yn.toFixed(1);

    // Heading: aim at a point slightly ahead, then ease towards it so the 4 Hz samples don't make it twitch.
    const [ax, ay] = pointAt(t + LOOK_MS, i);
    if (Math.hypot(ax - xn, ay - yn) > 0.5) {
      const target = Math.atan2(ay - yn, ax - xn);
      if (hero.angle == null) hero.angle = target;
      else {
        let d = target - hero.angle;
        d = Math.atan2(Math.sin(d), Math.cos(d));
        hero.angle += d * 0.22;
      }
    }
    hero.car.setAttribute("transform", `translate(${x} ${y}) rotate(${((hero.angle || 0) * 180 / Math.PI).toFixed(1)}) scale(1.3)`);

    let j = i, d = "";
    while (j > 0 && t - pts[j].ms < TRAIL_MS) j--;
    for (let n = j; n <= i; n++) d += (n === j ? "M" : "L") + xy[n][0].toFixed(1) + " " + xy[n][1].toFixed(1);
    hero.trail.setAttribute("d", d + `L${x} ${y}`);

    if (hero.sample !== i) {
      hero.sample = i;
      const p = pts[i];
      setText("speed", readout.speed, String(p.speed ?? "–"));
      setText("gear", readout.gear, p.gear ? String(p.gear) : "N");
      readout.thr.style.transform = `scaleY(${(p.throttle ?? 0) / 100})`;
      readout.brk.style.transform = `scaleY(${p.brake ? 1 : 0})`;
      if (hero.rpm && p.rpm) {
        const [lo, hiR] = hero.rpm;
        const n = Math.max(0, Math.min(15, Math.round(((p.rpm - lo) / (hiR - lo || 1)) * 15)));
        if (n !== hero.revN) {
          const from = Math.min(n, Math.max(0, hero.revN)), to = Math.max(n, hero.revN);
          for (let j = from; j < to; j++) readout.leds[j].classList.toggle("on", j < n);
          hero.revN = n;
        }
      }
    }
    const s = t / 1000;
    setText("clock", readout.clock, `${Math.floor(s / 60)}:${(s % 60).toFixed(1).padStart(4, "0")}`);
    const p = pts[i], f = p.f + ((pts[Math.min(i + 1, pts.length - 1)].f - p.f) * k);
    readout.prog.style.transform = `scaleX(${f.toFixed(3)})`;
  }

  function loop() {
    cancelAnimationFrame(hero.raf);
    if (!hero.tel || hero.paused || !hero.visible || document.hidden) return;
    hero.raf = requestAnimationFrame(now => {
      const pts = hero.tel.points, dur = pts.at(-1).ms;
      const t = (now - hero.t0 + hero.offset) % dur;
      if (t < pts[hero.idx].ms) hero.idx = 0;
      while (hero.idx < pts.length - 2 && pts[hero.idx + 1].ms <= t) hero.idx++;
      const a = pts[hero.idx], b = pts[hero.idx + 1];
      place(hero.idx, Math.min(1, (t - a.ms) / (b.ms - a.ms || 1)), t);
      loop();
    });
  }

  /* ---------- race ---------- */
  function fillSessions() {
    const sel = $("#session");
    const all = state.sessions.completed;
    const races = all.filter(isRace);
    const others = all.filter(s => !isRace(s)).slice(0, 30);
    const opt = s => `<option value="${s.session_key}">${esc(sessionName(s))}, ${dateShort(s.date_start)}</option>`;
    sel.innerHTML = `<optgroup label="Races and sprints">${races.map(opt).join("")}</optgroup>` +
      (others.length ? `<optgroup label="Practice and qualifying">${others.map(opt).join("")}</optgroup>` : "");
    sel.value = state.session.session_key;
  }

  function renderConditions(w) {
    $("#conditions").textContent = w
      ? `Last weather reading: air ${Math.round(w.air_temperature)}°C, track ${Math.round(w.track_temperature)}°C, humidity ${Math.round(w.humidity)}%, ${w.rainfall ? "rain falling" : "dry"}.`
      : "";
  }

  const code = n => state.drivers?.get(n)?.code || `#${n}`;
  const colourOf = n => { const d = state.drivers?.get(n); return d?.colour || state.colourFor(d?.code); };

  function renderFacts() {
    const host = $("#facts");
    const s = state.session, laps = state.laps || [];
    const race = isRace(s);
    const pace = S.pace(laps).filter(r => r.best);
    const out = [];
    if (race && state.order.length) {
      const w = state.order[0], r = state.result?.get(w);
      out.push(["Winner", esc(code(w)), r?.duration ? raceTime(r.duration) : r?.number_of_laps ? `${r.number_of_laps} laps` : "", colourOf(w)]);
    } else if (pace[0]) out.push(["Quickest", esc(code(pace[0].n)), lapTime(pace[0].best), colourOf(pace[0].n)]);
    const best = S.fastestLap(laps);
    if (best) out.push(["Fastest lap", lapTime(best.lap_duration), `${code(best.driver_number)}, lap ${best.lap_number}`]);
    const trap = pace.reduce((m, r) => (r.trap && (!m || r.trap > m.trap) ? r : m), null);
    if (trap) out.push(["Top speed", `${trap.trap}<small> km/h</small>`, `${code(trap.n)}, speed trap`]);
    if (race && state.trace?.leaders.length) {
      out.push(["Lead changes", state.trace.leadChanges, plural(new Set(state.trace.leaders.map(l => l[1])).size, "driver") + " led"]);
    }
    if (state.rc) {
      const sc = state.bands.filter(b => b.kind === "SC"), vsc = state.bands.filter(b => b.kind === "VSC");
      const n = [...sc, ...vsc].reduce((t, b) => t + b.to - b.from + 1, 0);
      const red = state.bands.some(b => b.kind === "RED");
      out.push(["Neutralised", `${n}<small> ${n === 1 ? "lap" : "laps"}</small>`,
        sc.length || vsc.length || red ? [sc.length && plural(sc.length, "safety car"), vsc.length && `${vsc.length} VSC`, red && "red flag"].filter(Boolean).join(", ") : "Green all the way"]);
    }
    if (race && state.pits) {
      const stops = state.pits.filter(p => (p.lane_duration ?? p.pit_duration) > 5);
      out.push(["Pit stops", stops.length, `${plural(new Set(stops.map(p => p.driver_number)).size, "driver")}`]);
    }
    if (race && state.result) {
      const dnf = [...state.result.values()].filter(r => r.dnf || r.dns || r.dsq).length;
      out.push(["Retirements", dnf, dnf ? "DNF, DNS or DSQ" : "Everyone finished"]);
    }
    if (!race) out.push(["Laps run", laps.filter(l => l.lap_duration).length, plural(pace.length, "driver")]);
    host.innerHTML = out.map(([k, v, sub, c], i) => `<div style="--i:${i}${c ? `;--c:${c}` : ""}"${c ? ' class="tinted"' : ""}><dt>${k}</dt><dd><b>${v}</b><small>${esc(sub)}</small></dd></div>`).join("");
  }

  function renderChips() {
    $("#chips").innerHTML = state.order.map(n => {
      const d = state.drivers.get(n);
      if (!d || !state.laps.some(l => l.driver_number === n)) return "";
      return `<button type="button" class="chip" style="--c:${colourOf(n)}" data-n="${n}" aria-pressed="${state.focus.has(n)}"><i></i>${esc(d.code)}</button>`;
    }).join("");
  }

  function applyFocus() {
    $$("#chips .chip").forEach(b => b.setAttribute("aria-pressed", String(state.focus.has(Number(b.dataset.n)))));
    $$("#pace tbody tr").forEach(tr => tr.classList.toggle("hi", state.focus.has(Number(tr.dataset.n))));
    $$("#pits li").forEach(li => li.classList.toggle("hi", state.focus.has(Number(li.dataset.n))));
    $$("#stints .stint-row").forEach(r => r.classList.toggle("dim", state.focus.size > 0 && !state.focus.has(Number(r.dataset.n))));
    $("#clear-focus").hidden = !state.focus.size;
    $("#focus-label").textContent = state.focus.size ? `Highlighting ${state.focus.size}` : "Highlight";
    charts.trace?.setFocus(state.focus);
    charts.laps?.setFocus(state.focus);
  }
  function toggleFocus(n) {
    state.focus.has(n) ? state.focus.delete(n) : state.focus.add(n);
    applyFocus();
  }

  /* Teammates share a colour, so the second car of a pair is drawn dashed. */
  function seriesStyle(numbers) {
    const used = [];
    return numbers.map(n => {
      const colour = colourOf(n);
      const dashed = used.some(c => similar(c, colour));
      used.push(colour);
      return { id: n, label: code(n), colour, dashed };
    });
  }

  function renderTrace(animate) {
    const panel = $("#trace-panel"), host = $("#trace-chart");
    panel.hidden = !isRace(state.session);
    charts.trace = null;
    if (panel.hidden) return;
    segInk($(".seg", panel));
    const traceMode = state.traceMode === "trace";
    $("#trace-title").textContent = traceMode ? "Gap to the winner" : "Running order";
    $("#trace-note").textContent = traceMode
      ? "Seconds behind the eventual winner at the end of each lap. Pit stops show as steps: when the winner stops, the rest jump up until they stop too. Safety cars close the gaps. Cars more than a lap down run off the bottom."
      : "Order on track at the end of each lap, worked out from when each car crossed the line. The official result can differ after penalties.";
    if (state.loading) return;
    const tr = state.trace;
    if (!tr || !tr.pos.size) return emptyState(host, "No lap chart for this session", "OpenF1 has no line crossing times for it.");
    const src = traceMode ? tr.trace : tr.pos;
    const nums = state.order.filter(n => src.has(n));
    const series = seriesStyle(nums).map(s => ({ ...s, points: src.get(s.id) }));
    const W = host.clientWidth || 800;
    const clean = S.cleanLaps(state.laps).map(l => l.lap_duration).sort((a, b) => a - b);
    const lapMed = clean[Math.floor(clean.length / 2)] || 90;
    const ys = series.flatMap(s => s.points.map(p => p[1]));
    const draw = anim => {
      charts.trace = C.lineChart(host, {
        series, animate: anim, height: W < 600 ? 360 : 460, xMin: 1, xMax: tr.laps,
        bands: state.bands, focus: state.focus, aria: traceMode ? "Gap to the winner by lap" : "Position by lap",
        xFmt: (v, tip) => tip ? `Lap ${v}` : v, xLabel: "Lap",
        ...(traceMode
          ? { yMin: Math.max(Math.min(...ys), -lapMed), yMax: Math.max(...ys, 0), yPad: 0.04, clip: true,
              yFmt: (v, tip) => tip ? (v > 0.05 ? `${v.toFixed(1)}s ahead` : `${Math.abs(v).toFixed(1)}s`) : `${Math.round(v)}s` }
          : { invertY: true, yMin: 1, yMax: nums.length, endLabels: true, yTicks: [1, 5, 10, 15, 20].filter(v => v <= nums.length), yFmt: v => `P${v}` })
      });
    };
    if (animate) animateIn(host, draw); else draw(false);
    resizers.set("trace", () => draw(false));
  }

  function renderLapChart(animate) {
    const host = $("#lap-chart");
    if (state.loading) return;
    const clean = S.cleanLaps(state.laps);
    const nums = state.order.filter(n => clean.some(l => l.driver_number === n));
    const series = seriesStyle(nums).map(s => {
      const own = clean.filter(l => l.driver_number === s.id).sort((a, b) => a.lap_number - b.lap_number);
      const sorted = own.map(l => l.lap_duration).sort((a, b) => a - b);
      const med = sorted[Math.floor(sorted.length / 2)];
      return { ...s, width: 1.75, points: own.filter(l => l.lap_duration <= med * 1.08).map(l => [l.lap_number, l.lap_duration]) };
    }).filter(s => s.points.length);
    charts.laps = null;
    if (!series.length) return emptyState(host, "No lap times", "OpenF1 has no timed laps for this session.");
    const draw = anim => {
      charts.laps = C.lineChart(host, {
        series, height: 340, animate: anim, yPad: 0.05, aria: "Lap times by lap", bands: state.bands, focus: state.focus,
        xFmt: (v, tip) => tip ? `Lap ${v}` : v, yFmt: (v, tip) => tip ? lapTime(v) : lapShort(v), xLabel: "Lap"
      });
    };
    if (animate) animateIn(host, draw); else draw(false);
    resizers.set("laps", () => draw(false));
  }

  function renderPace() {
    const host = $("#pace");
    const rows = S.pace(state.laps).filter(r => r.best);
    if (!rows.length) return emptyState(host, "No timed laps", "");
    const min = f => Math.min(...rows.map(f).filter(v => v != null));
    const top = { best: min(r => r.best), s0: min(r => r.s[0]), s1: min(r => r.s[1]), s2: min(r => r.s[2]), ideal: min(r => r.ideal), trap: Math.max(...rows.map(r => r.trap || 0)) };
    const cell = (v, best, fmt) => `<td class="num${v != null && v === best ? " pb" : ""}">${v == null ? "–" : fmt(v)}</td>`;
    const sec = v => v.toFixed(3);
    host.innerHTML = `<thead><tr><th class="num">#</th><th>Driver</th><th class="num">Best</th><th class="num">Gap</th><th class="num">S1</th><th class="num">S2</th><th class="num">S3</th><th class="num">Ideal</th><th class="num">Trap</th></tr></thead>
      <tbody>${rows.map((r, i) => `<tr data-n="${r.n}" class="${state.focus.has(r.n) ? "hi" : ""}" title="Best on lap ${r.bestLap}">
        <td class="num">${i + 1}</td>
        <td><span class="tc" style="background:${colourOf(r.n)}"></span>${esc(code(r.n))}</td>
        ${cell(r.best, top.best, lapTime)}
        <td class="num">${i ? `+${(r.best - top.best).toFixed(3)}` : ""}</td>
        ${cell(r.s[0], top.s0, sec)}${cell(r.s[1], top.s1, sec)}${cell(r.s[2], top.s2, sec)}
        ${cell(r.ideal, top.ideal, lapTime)}
        ${cell(r.trap, top.trap, v => v)}
      </tr>`).join("")}</tbody>`;
  }

  function renderPits() {
    const host = $("#pits");
    const list = (state.pits || [])
      .map(p => ({ n: p.driver_number, lap: p.lap_number, t: p.lane_duration ?? p.pit_duration, stop: p.stop_duration }))
      .filter(p => p.t > 5 && p.t < 60)
      .sort((a, b) => a.t - b.t)
      .slice(0, 10);
    if (!list.length) return emptyState(host, "No pit stops recorded", isRace(state.session) ? "OpenF1 has no pit data for this session." : "Pit stops are only timed in races and sprints.");
    const lo = list[0].t, hi = list.at(-1).t;
    host.innerHTML = list.map((p, i) => `
      <li data-n="${p.n}" style="--c:${colourOf(p.n)};--w:${30 + ((p.t - lo) / (hi - lo || 1)) * 70}%;--i:${i}" class="${state.focus.has(p.n) ? "hi" : ""}">
        <span class="code">${esc(code(p.n))}</span><span class="bar"><i></i></span><b>${p.t.toFixed(1)}s</b><small>lap ${p.lap}${p.stop ? `, ${p.stop.toFixed(1)}s stopped` : ""}</small>
      </li>`).join("");
  }

  const COMPOUND = { SOFT: "var(--soft)", MEDIUM: "var(--medium)", HARD: "var(--hard)", INTERMEDIATE: "var(--inter)", WET: "var(--wet)" };
  function renderStints(stints) {
    const host = $("#stints");
    if (!stints.length) {
      $("#lap-axis").innerHTML = ""; $("#compounds").innerHTML = "";
      return emptyState(host, "No tyre data for this session", "OpenF1 publishes stints for most sessions shortly after they end.");
    }
    const maxLap = Math.max(...stints.map(s => s.lap_end || s.lap_start || 0), 1);
    const by = new Map();
    stints.forEach(s => { if (!by.has(s.driver_number)) by.set(s.driver_number, []); by.get(s.driver_number).push(s); });
    const order = state.order.filter(n => by.has(n));
    host.innerHTML = order.map((n, row) => {
      const segs = by.get(n).sort((a, b) => a.stint_number - b.stint_number).map(s => {
        const st = s.lap_start || 1, en = s.lap_end || st;
        const c = (s.compound || "UNKNOWN").toUpperCase();
        const name = c.charAt(0) + c.slice(1).toLowerCase();
        return `<i data-c="${c}" style="--tc:${COMPOUND[c] || "var(--dust)"};left:${((st - 1) / maxLap) * 100}%;width:${((en - st + 1) / maxLap) * 100}%" title="${name}, laps ${st} to ${en}${s.tyre_age_at_start ? `, ${s.tyre_age_at_start} laps old at fitting` : ""}"></i>`;
      }).join("");
      return `<div class="stint-row${state.focus.size && !state.focus.has(n) ? " dim" : ""}" data-n="${n}" style="--i:${row}"><b>${esc(code(n))}</b><div class="lane">${segs}</div></div>`;
    }).join("");
    const step = maxLap > 40 ? 10 : 5;
    const ticks = [1]; for (let l = step; l <= maxLap; l += step) ticks.push(l);
    $("#lap-axis").innerHTML = `<span>Lap</span><div>${ticks.map(l => `<span style="left:${((l - 0.5) / maxLap) * 100}%">${l}</span>`).join("")}</div>`;
    const present = [...new Set(stints.map(s => (s.compound || "").toUpperCase()))].filter(c => COMPOUND[c]);
    $("#compounds").innerHTML = present.map(c => `<span><i data-c="${c}" style="--tc:${COMPOUND[c]}"></i>${c.charAt(0) + c.slice(1).toLowerCase()}</span>`).join("");
    host.classList.remove("play");
    whenVisible(host, () => host.classList.add("play"));
  }

  let sessionSeq = 0;
  async function loadSession(key, { hero: withHero = false, live = null } = {}) {
    const my = ++sessionSeq;
    key = Number(key);
    state.session = state.sessions.completed.find(s => s.session_key === key);
    if (!state.session) return;
    // Until the new session lands, nothing may redraw from the previous one.
    state.loading = true;
    charts.trace = charts.laps = null;
    $("#chips").innerHTML = "";
    $("#session").value = key;
    $("#race-kicker").textContent = `${state.session.session_name}, ${dateLong(state.session.date_start)}`;
    $("#race-title").textContent = state.session.location;
    $("#trace-panel").hidden = !isRace(state.session);
    $("#facts").innerHTML = "";
    $("#conditions").textContent = "";
    skeleton($("#trace-chart"), 400);
    skeleton($("#lap-chart"), 320);
    skeleton($("#stints"), 160);
    $("#pace").innerHTML = `<tbody><tr><td><div class="skeleton" style="height:200px"></div></td></tr></tbody>`;
    $("#pits").innerHTML = "";
    try {
      const [drivers, laps] = await Promise.all([S.drivers(key), S.laps(key)]);
      if (my !== sessionSeq) return;
      state.drivers = drivers; state.laps = laps;
      state.colourFor = S.colourIndex(drivers);
      // Queue the hero telemetry first: the lanes are FIFO and the hero is what people see.
      if (withHero) renderHeroLap(state.session, laps, drivers, live);

      const [cls, rc, pits] = await Promise.allSettled([S.classification(key, laps), S.raceControl(key), S.pits(key)]);
      if (my !== sessionSeq) return;
      state.loading = false;
      state.order = cls.status === "fulfilled" ? cls.value.order : [];
      state.result = cls.status === "fulfilled" ? cls.value.result : null;
      drivers.forEach((_, n) => { if (!state.order.includes(n)) state.order.push(n); });
      state.rc = rc.status === "fulfilled" ? rc.value : null;
      state.pits = pits.status === "fulfilled" ? pits.value : null;
      state.trace = isRace(state.session) ? S.raceTrace(laps) : null;
      const lastLap = Math.max(0, ...laps.map(l => l.lap_number || 0));
      state.bands = state.rc ? S.neutralised(state.rc, lastLap) : [];

      // Default highlight: your driver and the head-to-head pair if they ran here, else the top three.
      state.focus = new Set();
      const p = state.standings && pair();
      const mine = state.standings?.rows.find(r => r.driver.id === state.follow);
      [mine && S.numberForCode(drivers, mine.driver.code), p && S.numberForCode(drivers, p.A.driver.code), p && S.numberForCode(drivers, p.B.driver.code)]
        .filter(n => n != null && laps.some(l => l.driver_number === n)).forEach(n => state.focus.add(n));
      if (!state.focus.size) state.order.slice(0, 3).forEach(n => state.focus.add(n));

      renderChips();
      renderFacts();
      renderTrace(true);
      renderLapChart(true);
      renderPace();
      renderPits();
      applyFocus();
      if (withHero) { renderStandings(false); renderTitle(); renderTitleRace(); renderHeroRace(); renderCalendar(); renderH2H(false); }
      renderCompare();
      S.stints(key).then(st => my === sessionSeq && renderStints(st)).catch(e => emptyState($("#stints"), "Tyre data unavailable", errText(e)));
      S.weather(key).then(w => my === sessionSeq && renderConditions(w)).catch(() => renderConditions(null));
    } catch (e) {
      if (my !== sessionSeq) return;
      state.loading = false;
      state.trace = null;
      emptyState($("#lap-chart"), "Couldn't load this session", errText(e) + " Try another session, or refresh in a minute.");
      ["#trace-chart", "#stints", "#pace"].forEach(s => { $(s).innerHTML = ""; });
      if (withHero) { $("#lap-title").textContent = "Live telemetry is unavailable right now"; heroEmpty("Couldn't load the session", errText(e)); }
    }
  }

  /* ---------- boot ---------- */
  async function loadSeason() {
    const live = state.mode.mode === "live";
    const results = await Promise.allSettled([S.driverStandings(), S.constructorStandings(), S.lastRace(), S.schedule(), live ? null : S.upcoming()]);
    const [ds, cs, lr, sc, up] = results.map(r => r.status === "fulfilled" ? r.value : null);
    state.standings = ds; state.teams = cs; state.last = lr; state.schedule = sc;
    state.upcoming = live ? sc : up;
    renderNotice();
    renderFollow();
    if (!ds) emptyState($("#standings"), "Couldn't load standings", errText(results[0].reason));
    else renderStandings(false);
    seasonKicker();
    renderHeroRace();
    if (!lr && results[2].status === "rejected") $("#hero-notes").innerHTML = `<li><span>${esc(errText(results[2].reason))}</span></li>`;
    renderTitle();
    renderTitleRace();
    renderNext();
    if (sc) renderCalendar(); else emptyState($("#cal"), "Couldn't load the calendar", errText(results[3].reason));
    fillPicks();
    renderH2H(false);
    try {
      state.rounds = await S.seasonResults();
      renderStandings(false);
      renderTitleRace();
      renderFollow();
      renderCalendar();
      renderH2H(true);
    } catch (e) {
      emptyState($("#points-chart"), "Couldn't load season results", errText(e));
      $("#duel").innerHTML = "";
    }
    renderCompare();
  }

  async function loadLive() {
    try {
      state.sessions = await S.sessions(state.mode.year);
    } catch (e) {
      $("#lap-title").textContent = "Live telemetry is unavailable right now";
      $("#lap-sub").textContent = "";
      heroEmpty("OpenF1 didn't answer", errText(e) + " During a live session its free tier is limited to subscribers, so try again after the session.");
      emptyState($("#lap-chart"), "Couldn't reach OpenF1", errText(e));
      ["#trace-chart", "#stints"].forEach(s => { $(s).innerHTML = ""; });
      return;
    }
    const done = state.sessions.completed;
    if (!done.length) return;
    const race = done.find(s => s.session_name === "Race") || done[0];
    state.session = race;
    fillSessions();
    renderCalendar();
    await loadSession(race.session_key, { hero: true, live: state.sessions.live });
  }

  /* ---------- fan features ---------- */
  const ICON_CAL = `<svg class="i" viewBox="0 0 24 24" aria-hidden="true"><rect x="3.5" y="5" width="17" height="15" rx="2.5"/><path d="M3.5 10h17M8 3v4M16 3v4"/></svg>`;

  /* One sentence on where a driver stands in the title fight. Names only, no pronouns. */
  function followSentence(c, model) {
    if (!c) return "";
    const fam = esc(c.row.driver.family), lead = esc(model.lead.driver.family);
    const ahead = c.pos > 2 ? model.rows[c.pos - 2] : null;      // P2's next target is the leader, already named
    const next = ahead ? ` Next up the table: ${esc(ahead.driver.family)}, ${fmtPts(ahead.points - c.row.points)} points ahead.` : "";
    if (c.kind === "leader") {
      return c.decided
        ? `${fam} is the ${state.mode.year} champion.`
        : `${fam} leads the championship by ${fmtPts(c.lead)} points over ${esc(model.rows[1].driver.family)}, with ${model.max} still available.`;
    }
    if (c.kind === "out") return `${fam} is P${c.pos} with ${fmtPts(c.row.points)} points, ${fmtPts(c.gap)} behind ${lead}. With ${model.max} points left, the title is out of reach.${next}`;
    if (c.tieOnly) return `${fam} is P${c.pos}, ${fmtPts(c.gap)} behind ${lead} with ${model.max} left: only a tie on points is still possible.${next}`;
    return `${fam} is P${c.pos}, ${fmtPts(c.gap)} behind ${lead}. To win the title, ${fam} must outscore ${lead} by at least ${c.need} points over the last ${plural(c.rounds, "round")}.${next}`;
  }

  function renderFollow() {
    const host = $("#follow"), rows = state.standings?.rows || [];
    if (!rows.length) { host.hidden = true; return; }
    host.hidden = false;
    $("#follow-pick").innerHTML = `<option value="">Choose a driver</option>` +
      rows.map(r => `<option value="${esc(r.driver.id)}"${r.driver.id === state.follow ? " selected" : ""}>${esc(r.driver.given)} ${esc(r.driver.family)}</option>`).join("");
    const model = titleModel(), c = A.chances(model, state.follow);
    const row = c?.row;
    host.style.setProperty("--c", row ? state.colourFor(row.driver.code, row.teamId) : "var(--line)");
    host.classList.toggle("set", Boolean(c));
    if (!c) {
      $("#follow-stats").innerHTML = "";
      $("#follow-line").textContent = "Pick a driver and the page follows them: highlighted in the standings, in the head to head, and on every race chart.";
      $("#follow-chips").innerHTML = rows.slice(0, 8).map(r =>
        `<button type="button" class="fchip" data-id="${esc(r.driver.id)}" style="--c:${state.colourFor(r.driver.code, r.teamId)}" title="${esc(shortName(r.driver))}"><i></i>${esc(r.driver.code)}</button>`).join("");
      return;
    }
    $("#follow-chips").innerHTML = "";
    $("#follow-stats").innerHTML = `
      <div class="fs-name"><b>${esc(shortName(row.driver))}</b><span>${esc(row.team)}</span></div>
      <dl class="fs-nums">
        <div><dt>Position</dt><dd>P${c.pos}</dd></div>
        <div><dt>Points</dt><dd>${fmtPts(row.points)}</dd></div>
        <div><dt>Wins</dt><dd>${row.wins}</dd></div>
        ${state.rounds ? `<div class="fs-form"><dt>Last five</dt><dd class="form">${formCells(row.driver.id)}</dd></div>` : ""}
      </dl>`;
    $("#follow-line").innerHTML = followSentence(c, model);
  }

  function setFollow(id) {
    state.follow = id;
    store.set("pitwall-driver", id || null);
    state.picked = false;                 // the duel re-centres on the new driver
    fillPicks();
    renderStandings(false);
    renderFollow();
    renderTitleRace();
    renderH2H(true);
    renderCompare();
    const mine = state.standings?.rows.find(r => r.driver.id === id);
    const n = mine && state.drivers && S.numberForCode(state.drivers, mine.driver.code);
    if (n != null && state.laps?.some(l => l.driver_number === n)) { state.focus.add(n); applyFocus(); }
  }

  /* Every session of one weekend, or the rest of the season, as a calendar file in local time. */
  function exportCalendar(kind, round) {
    const races = state.upcoming || [];
    const now = Date.now();
    const pick = kind === "weekend" ? races.filter(r => r.round === round) : races;
    if (!pick.length) return;
    const { text, count } = ICS.build(pick, { from: kind === "weekend" ? now - 3 * 36e5 : now });
    if (!count) return;
    const r = pick[0];
    ICS.download(kind === "weekend" ? `f1-${r.season}-round-${r.round}.ics` : `f1-${r.season}-season.ics`, text);
    const b = document.querySelector(`[data-ics="${kind}"]`);
    if (!b) return;
    const was = b.innerHTML;
    b.innerHTML = `${ICON_CAL}Saved ${plural(count, "session")} to a calendar file`;
    b.disabled = true;
    setTimeout(() => { b.innerHTML = was; b.disabled = false; }, 2600);
  }

  function fillSeasonPicker() {
    const sel = $("#season-pick"), now = new Date().getUTCFullYear(), m = state.mode;
    const years = [];
    for (let y = now - 1; y >= 2023; y--) if (m.mode === "archive" || y !== m.year) years.push(y);
    sel.innerHTML = `<option value="">${m.mode === "archive" ? "Latest season" : `${m.year} season`}</option>` +
      years.map(y => `<option value="${y}">${y} season</option>`).join("");
    sel.value = m.mode === "archive" ? String(m.year) : "";
  }

  function renderNotice() {
    const n = $("#notice"), m = state.mode;
    if (!m || m.mode === "live") { n.hidden = true; return; }
    if (m.mode === "archive") {
      n.innerHTML = `<span>You're looking back at the <b>${m.year} season</b>. Standings and results are final.</span><a href="${esc(location.pathname)}">Back to the latest season</a>`;
    } else {
      const first = state.upcoming?.[0];
      n.innerHTML = `<span>The ${m.upcomingYear} season hasn't started yet${first ? `. It opens in ${esc(first.locality)} on ${dateShort(first.start)}` : ""}. Until then, this is how <b>${m.year}</b> finished.</span>`;
    }
    n.hidden = false;
  }

  async function boot() {
    const want = new URLSearchParams(location.search).get("season");
    const year = Number(want);
    const requested = /^\d{4}$/.test(want || "") && year >= 2023 && year < new Date().getUTCFullYear() ? want : null;
    try { state.mode = await S.resolveSeason(requested); }
    catch { state.mode = { year: new Date().getUTCFullYear(), mode: "live" }; }
    fillSeasonPicker();
    loadSeason();
    loadLive();
  }

  function wire() {
    $$("#season .seg button").forEach(b => b.addEventListener("click", () => {
      if (state.table === b.dataset.table) return;
      state.table = b.dataset.table;
      $$("#season .seg button").forEach(x => x.setAttribute("aria-selected", String(x === b)));
      segInk(b.parentElement);
      renderStandings(true);
      renderTitle();
    }));
    $$("#trace-panel .seg button").forEach(b => b.addEventListener("click", () => {
      if (state.traceMode === b.dataset.trace) return;
      state.traceMode = b.dataset.trace;
      $$("#trace-panel .seg button").forEach(x => x.setAttribute("aria-selected", String(x === b)));
      segInk(b.parentElement);
      renderTrace(true);
    }));
    $("#more").addEventListener("click", () => { state.showAll = !state.showAll; renderStandings(false); });
    $("#pick-a").addEventListener("change", e => { state.a = e.target.value; state.picked = true; renderH2H(true); renderCompare(); });
    $("#pick-b").addEventListener("change", e => { state.b = e.target.value; state.picked = true; renderH2H(true); renderCompare(); });
    $("#session").addEventListener("change", e => { loadSession(e.target.value); });
    $("#chips").addEventListener("click", e => {
      const b = e.target.closest(".chip");
      if (b) toggleFocus(Number(b.dataset.n));
    });
    $("#pace").addEventListener("click", e => {
      const tr = e.target.closest("tbody tr[data-n]");
      if (tr) toggleFocus(Number(tr.dataset.n));
    });
    $("#clear-focus").addEventListener("click", () => { state.focus.clear(); applyFocus(); });
    $("#cal").addEventListener("click", e => {
      const b = e.target.closest("button[data-session]");
      if (!b || !state.sessions) return;
      loadSession(b.dataset.session);
      $("#race").scrollIntoView({ behavior: C.reduced() ? "auto" : "smooth" });
    });
    $("#replay").addEventListener("click", () => {
      if (!hero.tel) return;
      hero.paused = !hero.paused;
      if (hero.paused) { hero.offset += performance.now() - hero.t0; cancelAnimationFrame(hero.raf); }
      else { hero.t0 = performance.now(); loop(); }
      $("#replay").textContent = hero.paused ? "Play replay" : "Pause replay";
    });
    $("#log-details").addEventListener("toggle", renderLog);
    addEventListener("pw:theme", () => { $("#ramp").style.background = C.rampCss(); hero.map?.recolour(); });
    addEventListener("pw:width", () => { resizers.forEach(fn => fn()); applyFocus(); });
    document.addEventListener("click", e => {
      const b = e.target.closest("[data-ics]");
      if (b) exportCalendar(b.dataset.ics, Number(b.dataset.round));
    });
    $("#follow").addEventListener("change", e => {
      if (e.target.id !== "follow-pick") return;
      setFollow(e.target.value);
    });
    $("#follow").addEventListener("click", e => {
      const b = e.target.closest(".fchip");
      if (b) setFollow(b.dataset.id);
    });
    $("#season-pick").addEventListener("change", e => {
      const url = new URL(location.href);
      if (e.target.value) url.searchParams.set("season", e.target.value); else url.searchParams.delete("season");
      location.href = url.toString();
    });
    document.addEventListener("visibilitychange", () => {
      if (!hero.tel || hero.paused) return;
      if (document.hidden) { hero.offset += performance.now() - hero.t0; cancelAnimationFrame(hero.raf); }
      else if (hero.visible) { hero.t0 = performance.now(); loop(); }
    });
    $("#feed").addEventListener("click", async () => {
      P.setBypass(true);
      Object.keys(health).forEach(k => delete health[k]);
      state.tel.clear();
      try { await Promise.all([loadSeason(), state.session ? loadSession(state.session.session_key) : loadLive()]); }
      finally { P.setBypass(false); setFeed(); }
    });

    // Stop the replay clock while the lap is scrolled out of view.
    if (io) new IntersectionObserver(([e]) => {
      const was = hero.visible;
      hero.visible = e.isIntersecting;
      if (hero.paused || !hero.tel || was === hero.visible) return;
      if (hero.visible) { hero.t0 = performance.now(); loop(); }
      else { hero.offset += performance.now() - hero.t0; cancelAnimationFrame(hero.raf); }
    }).observe($("#lap"));

  }

  P.snapshotMeta().then(meta => {
    $("#snap-when").textContent = meta && meta.generatedAt
      ? `Fallback snapshot from ${new Date(meta.generatedAt).toLocaleString(undefined, { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" })}`
      : "";
  });

  $("#ramp").style.background = C.rampCss();
  renderFeed();
  wire();
  boot();
  setInterval(renderNext, 1000);
  setInterval(setFeed, 15e3);
})();
