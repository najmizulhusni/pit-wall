/*
  Learn F1. Each chapter is one idea, one moving picture, and a tie-in to this season's real data.
  Animations run only while they're on screen, and every one has a still fallback for reduced motion.
*/
(function () {
  "use strict";
  const S = window.Sources, A = window.Analytics, Shell = window.Shell;
  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
  const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const reduced = Shell.reduced;
  const dateShort = d => new Date(d).toLocaleDateString(undefined, { day: "numeric", month: "short" });
  const monthName = d => new Date(d).toLocaleDateString(undefined, { month: "long" });
  const whenLocal = d => d.toLocaleString(undefined, { weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
  const plural = (n, one, many = one + "s") => `${n} ${n === 1 ? one : many}`;
  const fmtPts = v => Number.isInteger(v) ? String(v) : v.toFixed(1);
  const RACE_PTS = [25, 18, 15, 12, 10, 8, 6, 4, 2, 1], SPRINT_PTS = [8, 7, 6, 5, 4, 3, 2, 1];
  const COMPOUND = { SOFT: "var(--soft)", MEDIUM: "var(--medium)", HARD: "var(--hard)", INTERMEDIATE: "var(--inter)", WET: "var(--wet)" };
  let colourFor = S.colourIndex(null);          // team colours by constructor id until OpenF1 has answered
  const data = { mode: null, upcoming: null, standings: null, teams: null };

  /* Hook a segmented control: sets aria-selected, slides the pill, calls fn(button). */
  function seg(root, fn) {
    $$("button", root).forEach(b => b.addEventListener("click", () => {
      $$("button", root).forEach(x => x.setAttribute("aria-selected", String(x === b)));
      Shell.segInk(root);
      fn(b);
    }));
  }

  /* ---------- intro: the start lights run once ---------- */
  function introLights() {
    const pods = $$("#intro-lights i");
    if (reduced()) return;
    pods.forEach((p, i) => setTimeout(() => p.classList.add("on"), 300 + i * 240));
    setTimeout(() => pods.forEach(p => p.classList.remove("on")), 300 + 5 * 240 + 650);
  }

  /* ---------- quick checks ---------- */
  function quizzes() {
    const all = $$(".quiz");
    let right = 0, answered = 0;
    const score = () => {
      $("#quiz-score").textContent = answered ? `Quick checks: ${right} of ${answered} right` : `Quick checks: 0 of ${all.length} done`;
      if (answered === all.length) $("#done-title").textContent = `You got ${right} of ${all.length} right. You know how F1 works.`;
    };
    all.forEach(q => {
      const answer = Number(q.dataset.answer), btns = $$(".opts button", q);
      btns.forEach((b, i) => b.addEventListener("click", () => {
        if (q.classList.contains("answered")) return;
        q.classList.add("answered", i === answer ? "got" : "missed");
        b.classList.add(i === answer ? "right" : "wrong");
        btns[answer].classList.add("right");
        btns.forEach(x => x.setAttribute("aria-disabled", "true"));
        answered++;
        if (i === answer) right++;
        score();
      }));
    });
    score();
  }

  /* ---------- 01 the season ---------- */
  function renderTour(schedule) {
    const host = $("#tour");
    if (!schedule?.length) return;
    const t0 = schedule[0].start.getTime(), t1 = schedule.at(-1).start.getTime(), span = t1 - t0 || 1;
    const now = Date.now();
    const isDone = r => r.start.getTime() + 3 * 36e5 <= now;
    const next = schedule.find(r => !isDone(r));
    const done = schedule.filter(isDone).length;
    const fill = next ? Math.max(0, Math.min(1, (now - t0) / span)) : 1;
    const months = [];
    for (let d = new Date(schedule[0].start.getFullYear(), schedule[0].start.getMonth() + 1, 1); d.getTime() < t1; d.setMonth(d.getMonth() + 1)) {
      months.push(`<span class="mo" style="--x:${(d.getTime() - t0) / span}">${d.toLocaleDateString(undefined, { month: "short" })}</span>`);
    }
    host.innerHTML = `<div class="tour-line"><i style="--f:${fill.toFixed(4)}"></i></div>` +
      schedule.map((r, i) => {
        const cls = isDone(r) ? "done" : r === next ? "next" : "";
        return `<button type="button" class="stop ${cls}" style="--x:${((r.start.getTime() - t0) / span).toFixed(4)};--i:${i}" data-i="${i}"
          aria-label="Round ${r.round}, ${esc(r.name)}, ${dateShort(r.start)}"></button>`;
      }).join("") + `<div class="months">${months.join("")}</div>`;
    const cap = $("#tour-cap"), base = cap.textContent;
    const show = i => {
      const r = schedule[i];
      cap.innerHTML = `<b>Round ${r.round}</b> · ${esc(r.name)} · ${esc(r.locality)} · ${dateShort(r.start)}${isDone(r) ? "" : r === next ? " · next up" : ""}${r.sprint ? " · sprint weekend" : ""}`;
    };
    host.addEventListener("pointerover", e => { const b = e.target.closest(".stop"); if (b) show(Number(b.dataset.i)); });
    host.addEventListener("focusin", e => { const b = e.target.closest(".stop"); if (b) show(Number(b.dataset.i)); });
    host.addEventListener("pointerleave", () => { cap.textContent = base; });
    const countries = new Set(schedule.map(r => r.country)).size;
    const first = schedule[0], last = schedule.at(-1);
    $("#season-live").innerHTML = `This season has <b>${schedule.length} rounds</b> in ${countries} countries, from ${esc(first.locality)} in ${monthName(first.start)} to ${esc(last.locality)} in ${monthName(last.start)}. ` +
      (next ? `${done ? `${plural(done, "round")} done so far; next` : "First"} up is the ${esc(next.name)} on ${dateShort(next.start)}.` : "Every round has been run.");
  }

  function renderStack(ds, cs) {
    const host = $("#team-stack");
    if (!cs?.rows.length || !ds?.rows.length) { host.closest(".fig").hidden = true; return; }
    const top = cs.rows.slice(0, 3), max = top[0].points || 1;
    host.innerHTML = top.map((t, i) => {
      const ds2 = ds.rows.filter(r => r.teamId === t.teamId);
      const sum = ds2.reduce((n, d) => n + d.points, 0) || 1;
      const colour = colourFor(ds2[0]?.driver.code, t.teamId);
      const adds = Math.abs(sum - t.points) < 0.01;
      return `<div class="team" style="--i:${i};--c:${colour}">
        <div class="team-l"><b>${esc(t.team)}</b><em>${fmtPts(t.points)}</em></div>
        <div class="segs" style="--w:${(t.points / max).toFixed(4)}">${ds2.map((d, j) => `<i class="${j % 2 ? "b" : "a"}" style="flex-grow:${d.points}"></i>`).join("")}</div>
        <p class="team-sum">${ds2.map(d => `${esc(d.driver.family)} ${fmtPts(d.points)}`).join(adds ? " + " : ", ")}${adds ? ` = ${fmtPts(t.points)}` : ""}</p>
      </div>`;
    }).join("");
  }

  /* ---------- 02 the race weekend ---------- */
  const FORMATS = {
    standard: [["Friday", "Practice 1", "practice"], ["Friday", "Practice 2", "practice"], ["Saturday", "Practice 3", "practice"], ["Saturday", "Qualifying", "quali"], ["Sunday", "Race", "race"]],
    sprint: [["Friday", "Practice 1", "practice"], ["Friday", "Sprint qualifying", "squali"], ["Saturday", "Sprint", "sprint"], ["Saturday", "Qualifying", "quali"], ["Sunday", "Race", "race"]]
  };
  const INFO = {
    practice: { len: "60 minutes", stake: "Nothing at stake", text: "Free practice. Teams try set-ups and tyres, and drivers learn the track. Times don't count, but long runs on full fuel hint at race pace, and short fast runs hint at qualifying pace." },
    quali: { len: "About an hour: Q1, Q2, Q3", stake: "Sets the race grid", text: "A knockout in three parts. The slowest cars drop out after Q1 and Q2, and the last ten fight for pole position. Chapter 3 replays a real one." },
    squali: { len: "About 45 minutes: SQ1, SQ2, SQ3", stake: "Sets the sprint grid", text: "The same knockout, shorter, and it only decides the starting order for the sprint." },
    sprint: { len: "100 km, about 30 minutes", stake: "Points for the top 8", text: "A short race with no compulsory pit stop. The winner scores 8 points, down to 1 for eighth." },
    race: { len: "About 305 km, up to two hours", stake: "Points for the top 10", text: "The Grand Prix. At least one pit stop in the dry, 25 points for the win, down to 1 for tenth." }
  };
  const weekend = { format: "standard", sel: 0, timer: 0, touched: false, visible: false, next: null };

  function renderWeekend() {
    const list = FORMATS[weekend.format];
    const days = ["Friday", "Saturday", "Sunday"];
    $("#days").innerHTML = days.map(d => `<div class="day"><p>${d}</p>${list.map((s, i) => s[0] === d
      ? `<button type="button" class="sess k-${s[2]}${i === weekend.sel ? " on" : ""}" data-i="${i}">${s[1]}</button>` : "").join("")}</div>`).join("");
    const [day, name, kind] = list[weekend.sel], info = INFO[kind];
    const real = weekend.next && weekend.next.sprint === (weekend.format === "sprint") ? weekend.next.sessions.find(x => x[0] === name) : null;
    $("#session-card").innerHTML = `<p class="sc-k">${day} · ${info.len}</p><h3>${name}</h3><p>${info.text}</p>
      <span class="stake k-${kind}">${info.stake}</span>
      ${real ? `<p class="sc-local">At ${esc(weekend.next.locality)} this time: <b>${whenLocal(real[1])}</b> your time.</p>` : ""}`;
  }
  function stepWeekend() {
    weekend.sel = (weekend.sel + 1) % FORMATS[weekend.format].length;
    renderWeekend();
  }
  function setupWeekend() {
    const fig = $(".weekend-fig");
    seg($(".seg", fig), b => { weekend.format = b.dataset.format; weekend.sel = 0; weekend.touched = true; renderWeekend(); });
    $("#days").addEventListener("click", e => {
      const b = e.target.closest(".sess");
      if (!b) return;
      weekend.touched = true;
      weekend.sel = Number(b.dataset.i);
      renderWeekend();
    });
    // Walk through the sessions on its own until the reader takes over.
    Shell.watch(fig, v => {
      clearInterval(weekend.timer);
      if (v && !weekend.touched && !reduced()) weekend.timer = setInterval(() => (weekend.touched ? clearInterval(weekend.timer) : stepWeekend()), 2400);
    });
    renderWeekend();
  }
  function weekendLive(upcoming) {
    const now = Date.now();
    const next = upcoming?.find(r => r.start.getTime() + 3 * 36e5 > now);
    if (!next) return;
    weekend.next = next;
    if (!weekend.touched) {
      weekend.format = next.sprint ? "sprint" : "standard";
      $$(".weekend-fig .seg button").forEach(b => b.setAttribute("aria-selected", String(b.dataset.format === weekend.format)));
      Shell.segInk($(".weekend-fig .seg"));
      renderWeekend();
    }
    const first = next.sessions[0];
    $("#weekend-live").innerHTML = `<b>Up next:</b> the ${esc(next.name)} in ${esc(next.locality)} is a <b>${next.sprint ? "sprint" : "standard"} weekend</b>. ` +
      `${esc(first[0])} starts ${whenLocal(first[1])} your time; the race is ${whenLocal(next.start)}.`;
  }

  /* ---------- 03 qualifying knockout ---------- */
  const ROW = 30;
  const lapStr = s => s == null ? "No time" : `${Math.floor(s / 60)}:${(s % 60).toFixed(3).padStart(6, "0")}`;
  const quali = { q: null, phase: -1, els: [], timer: 0, played: false };

  function renderQualiPhase(k) {
    const q = quali.q;
    if (!q) return;
    quali.phase = k;
    const n = q.rows.length;
    const out1 = q.rows.filter(r => r.reached === 1), out2 = q.rows.filter(r => r.reached === 2);
    const byFinal = (a, b) => a.pos - b.pos;
    const byTime = i => (a, b) => (a.q[i] ?? Infinity) - (b.q[i] ?? Infinity) || a.pos - b.pos;
    let alive, gone, cutAt, outNow;
    if (k === 0) { alive = q.rows.slice().sort(byTime(0)); gone = []; outNow = out1; cutAt = n - out1.length; }
    else if (k === 1) { alive = q.rows.filter(r => r.reached >= 2).sort(byTime(1)); gone = out1.slice().sort(byFinal); outNow = out2; cutAt = alive.length - out2.length; }
    else { alive = q.rows.filter(r => r.reached === 3).sort(byTime(2)); gone = [...out2, ...out1].sort(byFinal); outNow = []; cutAt = alive.length; }
    const order = [...alive, ...gone];
    const outSet = new Set(outNow);
    order.forEach((r, i) => {
      const el = quali.els[q.rows.indexOf(r)];
      const isGone = gone.includes(r);
      const t = isGone ? r.q[r.reached - 1] : r.q[k];
      el.style.transform = `translate3d(0, ${i * ROW}px, 0)`;
      el.classList.toggle("out", isGone);
      el.classList.toggle("danger", outSet.has(r));
      el.classList.toggle("pole", k === 2 && i === 0);
      $(".qp", el).textContent = i + 1;
      $(".qtime", el).textContent = lapStr(t);
      $(".qtag", el).textContent = isGone ? `Out in Q${r.reached}` : outSet.has(r) ? "Knocked out" : k === 2 && i === 0 ? "Pole" : "";
    });
    const cut = $("#qcut");
    cut.style.transform = `translate3d(0, ${cutAt * ROW - 1}px, 0)`;
    cut.hidden = k === 2;
    $("span", cut).textContent = k === 0 ? `Q1 cut-off: the slowest ${out1.length} are out` : `Q2 cut-off: ${out2.length} more are out`;
    $("#quali-state").textContent = k === 0
      ? `Q1, 18 minutes: all ${n} cars. The slowest ${out1.length} are knocked out and fill the back of the grid.`
      : k === 1 ? `Q2, 15 minutes: ${n - out1.length} cars left. Another ${out2.length} drop out.`
      : `Q3, 12 minutes: the final ${alive.length} fight for pole. This is the front of the grid.`;
    $$("#quali-steps button").forEach(b => b.setAttribute("aria-selected", String(Number(b.dataset.q) === k)));
    Shell.segInk($("#quali-steps"));
  }
  function playQuali() {
    clearTimeout(quali.timer);
    if (reduced()) return renderQualiPhase(2);
    let k = 0;
    const step = () => { renderQualiPhase(k); if (k++ < 2) quali.timer = setTimeout(step, 2600); };
    step();
  }
  function setupQuali(q) {
    const host = $("#quali");
    if (!q || !q.rows.length) { $("#quali-cap").textContent = "The latest qualifying session isn't available right now."; return; }
    quali.q = q;
    host.style.height = `${q.rows.length * ROW}px`;
    host.innerHTML = q.rows.map(r => `<div class="qr" style="--c:${colourFor(r.driver.code, r.teamId)}">
        <span class="qp"></span><i></i><b>${esc(r.driver.code)}</b><span class="qn">${esc(r.driver.family)}</span><span class="qtag"></span><em class="qtime"></em></div>`).join("") +
      `<div class="qcut" id="qcut"><span></span></div>`;
    quali.els = $$(".qr", host);
    renderQualiPhase(0);
    const pole = q.rows.find(r => r.pos === 1), p2 = q.rows.find(r => r.pos === 2);
    const gap = pole?.q[2] != null && p2?.q[2] != null ? ` by ${(p2.q[2] - pole.q[2]).toFixed(3)} seconds` : "";
    $("#quali-cap").innerHTML = `Real data: qualifying for the ${esc(q.name)}, round ${q.round}. ${esc(pole?.driver.family || "")} took pole${gap}${p2 ? ` from ${esc(p2.driver.family)}` : ""}.`;
    $("#quali-play").addEventListener("click", playQuali);
    seg($("#quali-steps"), b => { clearTimeout(quali.timer); renderQualiPhase(Number(b.dataset.q)); });
    Shell.whenVisible(host, () => { if (!quali.played) { quali.played = true; setTimeout(playQuali, 500); } }, 0.3);
  }

  /* ---------- 04 lights out: a reaction game ---------- */
  function setupStart() {
    const pods = $$("#gantry i"), btn = $("#react"), out = $("#react-out"), fig = $(".start-fig");
    let phase = "idle", timers = [], t0 = 0, visible = false;
    const clear = () => { timers.forEach(clearTimeout); timers = []; };
    const best = () => Number(Shell.store.get("pitwall-react")) || null;
    function arm() {
      clear();
      phase = "arming";
      pods.forEach(p => p.classList.remove("on", "jump"));
      btn.textContent = "Wait for the lights to go out";
      btn.classList.add("armed");
      out.textContent = "Five lights, one a second…";
      pods.forEach((p, i) => timers.push(setTimeout(() => p.classList.add("on"), 700 + i * 1000)));
      const hold = 200 + Math.random() * 2800;          // the pause nobody can predict
      timers.push(setTimeout(() => {
        pods.forEach(p => p.classList.remove("on"));
        phase = "go";
        t0 = performance.now();
        btn.textContent = "Go!";
      }, 700 + 4 * 1000 + hold));
    }
    function press() {
      if (phase === "idle" || phase === "done") return arm();
      if (phase === "arming") {
        clear();
        phase = "done";
        pods.forEach(p => { p.classList.remove("on"); p.classList.add("jump"); });
        btn.textContent = "Try again";
        btn.classList.remove("armed");
        out.innerHTML = "<b>Jump start.</b> You moved before the lights went out. In a race that's a penalty.";
        return;
      }
      if (phase === "go") {
        const s = (performance.now() - t0) / 1000;
        phase = "done";
        btn.textContent = "Try again";
        btn.classList.remove("armed");
        const prev = best();
        if (!prev || s < prev) Shell.store.set("pitwall-react", s.toFixed(3));
        const verdict = s < 0.2 ? "Faster than most F1 drivers." : s < 0.3 ? "That's F1 pace." : s < 0.45 ? "Not bad. Drivers react in about 0.2 seconds." : "A slow getaway. Drivers react in about 0.2 seconds.";
        out.innerHTML = `<b>${s.toFixed(3)} s.</b> ${verdict}${prev && s >= prev ? ` Your best: ${prev.toFixed(3)} s.` : prev ? " A new best." : ""}`;
      }
    }
    // pointerdown, not click: a click waits for the finger to lift, which would add time.
    btn.addEventListener("pointerdown", e => { e.preventDefault(); press(); });
    btn.addEventListener("click", e => { if (e.detail === 0) press(); });          // keyboard activation
    Shell.watch(fig, v => { visible = v; if (!v && phase === "arming") { clear(); phase = "idle"; pods.forEach(p => p.classList.remove("on")); btn.textContent = "Start"; btn.classList.remove("armed"); } });
    document.addEventListener("keydown", e => {
      if (e.code !== "Space" || !visible || e.target.closest("input, select, textarea, button")) return;
      e.preventDefault();
      press();
    });
    const b = best();
    if (b) out.textContent += ` Your best so far: ${b.toFixed(3)} s.`;
  }

  /* ---------- 05 tyres ---------- */
  // One tyre model drives the degradation chart and the strategy simulator, so they agree.
  const MODEL = {
    LAPS: 56, BASE: 95, PIT: 22, FUEL: 0.055,
    OFF: { S: 0, M: 0.45, H: 0.9 },
    WEAR: { low: { S: 0.07, M: 0.04, H: 0.022 }, high: { S: 0.14, M: 0.085, H: 0.05 } },
    CLIFF: { low: { S: 20, M: 32, H: 46 }, high: { S: 13, M: 19, H: 27 } }
  };
  const tyreLap = (c, age, n, w) => {
    const over = Math.max(0, age - MODEL.CLIFF[w][c]);
    return MODEL.BASE + MODEL.OFF[c] + MODEL.WEAR[w][c] * age + 0.09 * over * over - MODEL.FUEL * n;
  };
  const COMP = { S: { name: "Soft", c: "var(--soft)" }, M: { name: "Medium", c: "var(--medium)" }, H: { name: "Hard", c: "var(--hard)" } };

  function drawDeg() {
    const svg = $("#deg"), W = 640, H = 260, m = { l: 46, r: 64, t: 14, b: 34 }, ages = 34;
    const val = (c, a) => tyreLap(c, a, 0, "low") - tyreLap("S", 1, 0, "low");
    const ys = ["S", "M", "H"].flatMap(c => Array.from({ length: ages }, (_, i) => val(c, i + 1)));
    const yMax = Math.min(4, Math.max(...ys)), yMin = Math.min(...ys);
    const x = a => m.l + (a - 1) / (ages - 1) * (W - m.l - m.r);
    const y = v => m.t + (Math.min(v, yMax) - yMin) / (yMax - yMin) * (H - m.t - m.b);
    let g = "";
    for (let v = 0; v <= yMax; v += 1) g += `<line x1="${m.l}" x2="${W - m.r}" y1="${y(v)}" y2="${y(v)}" class="gl"/><text x="${m.l - 8}" y="${y(v) + 4}" text-anchor="end">+${v}s</text>`;
    for (let a = 5; a <= ages; a += 5) g += `<text x="${x(a)}" y="${H - 12}" text-anchor="middle">${a}</text>`;
    g += `<text x="${W - m.r}" y="${H - 1}" text-anchor="end" class="axl">Laps on the tyre</text>`;
    const lines = ["S", "M", "H"].map(c => {
      // Stop the line where it leaves the chart, so the cliff reads as a cliff rather than a floor.
      const pts = [];
      for (let a = 1; a <= ages; a++) {
        const v = val(c, a);
        if (v > yMax) {
          const prev = val(c, a - 1), k = (yMax - prev) / (v - prev);
          pts.push([x(a - 1 + k), y(yMax)]);
          break;
        }
        pts.push([x(a), y(v)]);
      }
      const d = pts.map((p, i) => `${i ? "L" : "M"}${p[0].toFixed(1)} ${p[1].toFixed(1)}`).join("");
      const [ex, ey] = pts.at(-1), atEdge = ex < W - m.r - 1;
      return `<path d="${d}" class="dl ${c === "H" ? "hard" : ""}" style="--tc:${COMP[c].c}"/>` +
        `<text x="${atEdge ? ex + 6 : W - m.r + 8}" y="${atEdge ? ey - 6 : ey + 4}" class="dlab" style="fill:${COMP[c].c}">${COMP[c].name}${atEdge ? ": the cliff" : ""}</text>`;
    }).join("");
    svg.innerHTML = `<g class="dg">${g}</g>${lines}`;
    const paths = $$(".dl", svg);
    if (reduced()) return;
    paths.forEach(p => { const len = p.getTotalLength(); p.style.strokeDasharray = `${len} ${len}`; p.style.strokeDashoffset = len; });
    Shell.whenVisible(svg, () => {
      svg.getBoundingClientRect();
      paths.forEach((p, i) => { p.style.transition = `stroke-dashoffset 1400ms cubic-bezier(.65,0,.35,1) ${i * 200}ms`; p.style.strokeDashoffset = 0; });
    }, 0.4);
  }

  /* ---------- 06 strategy simulator ---------- */
  const sim = { wear: "low", pit: 26, plans: null, raf: 0, t: 0, playing: false, els: null };
  const PLAN_DEFS = pit => [
    { id: "A", desc: `One stop: medium, then hard from lap ${pit + 1}`, stints: [["M", pit], ["H", MODEL.LAPS - pit]] },
    { id: "B", desc: "One stop: soft, then hard from lap 15", stints: [["S", 14], ["H", MODEL.LAPS - 14]] },
    { id: "C", desc: "Two stops: soft, hard from lap 14, medium from lap 38", stints: [["S", 13], ["H", 24], ["M", MODEL.LAPS - 37]] }
  ];
  /* Turn a plan into timed segments: laps on track and stops in the pit lane. */
  const WINDOW = 40;                         // seconds of gap the track view shows
  function runPlan(def, w) {
    const segs = [];
    let t = 0, n = 0;
    def.stints.forEach(([c, len], si) => {
      if (si) { segs.push({ kind: "pit", s: t, e: t + MODEL.PIT, lap: n, c }); t += MODEL.PIT; }
      for (let a = 1; a <= len; a++) {
        const d = tyreLap(c, a, n + 1, w);
        segs.push({ kind: "lap", s: t, e: t + d, lap: n, c });
        t += d;
        n++;
      }
    });
    return { ...def, segs, laps: segs.filter(g => g.kind === "lap"), total: t };
  }
  /* When did this car reach a given distance (in laps)? Used to time the gap to the leader at the same spot. */
  function timeAtProgress(plan, p) {
    if (p >= MODEL.LAPS) return plan.total;
    const g = plan.laps[Math.floor(p)];
    return g.s + (p - Math.floor(p)) * (g.e - g.s);
  }
  function bestPit(w) {
    let best = [26, Infinity];
    for (let p = 10; p <= 46; p++) { const t = runPlan(PLAN_DEFS(p)[0], w).total; if (t < best[1]) best = [p, t]; }
    return best[0];
  }
  function at(plan, t) {
    if (t >= plan.total) return { x: 1, pit: false, c: plan.segs.at(-1).c, lap: MODEL.LAPS, done: true };
    let lo = 0, hi = plan.segs.length - 1;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (plan.segs[mid].e <= t) lo = mid + 1; else hi = mid; }
    const g = plan.segs[lo];
    if (g.kind === "pit") return { x: g.lap / MODEL.LAPS, pit: true, c: g.c, lap: g.lap };
    return { x: (g.lap + (t - g.s) / (g.e - g.s)) / MODEL.LAPS, pit: false, c: g.c, lap: g.lap + 1 };
  }
  function buildSim() {
    sim.plans = PLAN_DEFS(sim.pit).map(d => runPlan(d, sim.wear));
    const ticks = [40, 30, 20, 10, 0].map(v => `<span style="--x:${1 - v / WINDOW}">${v ? `${v} s` : "Leader"}</span>`).join("");
    $("#sim").innerHTML = `<div class="sim-axis" aria-hidden="true"><span></span><span class="ticks">${ticks}</span><span></span></div>` +
      sim.plans.map(p => `<div class="lane" data-id="${p.id}">
        <div class="lane-l"><b>Car ${p.id}</b><span>${esc(p.desc)}</span></div>
        <div class="lane-track"><span class="road"></span><span class="pitlane"></span><span class="flagline"></span>
          <span class="car-wrap"><i class="car"></i></span></div>
        <div class="lane-r"><b class="pos">–</b><span class="info"></span></div>
      </div>`).join("");
    sim.els = sim.plans.map(p => {
      const lane = $(`.lane[data-id="${p.id}"]`);
      return { wrap: $(".car-wrap", lane), car: $(".car", lane), pos: $(".pos", lane), info: $(".info", lane), lane };
    });
    sim.t = 0;
    paintSim();
    $("#sim-result").textContent = "";
    $("#sim-play").innerHTML = `<span class="tri" aria-hidden="true"></span>Play race`;
  }
  function paintSim() {
    const states = sim.plans.map(p => at(p, sim.t));
    const prog = states.map(s => s.x * MODEL.LAPS);
    const allDone = states.every(s => s.done);
    const order = sim.plans.map((p, i) => i).sort((a, b) =>
      (states[a].done && states[b].done) ? sim.plans[a].total - sim.plans[b].total : prog[b] - prog[a] || sim.plans[a].total - sim.plans[b].total);
    const lead = order[0], best = Math.min(...sim.plans.map(p => p.total));
    states.forEach((st, i) => {
      const e = sim.els[i];
      // Gap: how long ago the leader passed the spot this car is at now.
      const gap = allDone ? sim.plans[i].total - best : i === lead ? 0 : Math.max(0, sim.t - timeAtProgress(sim.plans[lead], Math.min(prog[i], MODEL.LAPS)));
      const x = 1 - Math.min(gap, WINDOW) / WINDOW;
      e.wrap.style.transform = `translate3d(${(x * 100).toFixed(3)}%, ${st.pit ? 13 : 0}px, 0)`;
      e.car.style.setProperty("--tc", COMP[st.c].c);
      const rank = order.indexOf(i) + 1;
      if (e.pos.textContent !== `P${rank}`) e.pos.textContent = `P${rank}`;
      const info = st.pit ? "In the pits" : `${rank === 1 ? "Leader" : `+${gap.toFixed(1)} s`} · ${COMP[st.c].name}`;
      if (e.info.textContent !== info) e.info.textContent = info;
      e.lane.classList.toggle("lead", rank === 1);
    });
    const lap = `Lap ${Math.min(MODEL.LAPS, Math.floor(prog[lead]) + (allDone ? 0 : 1))} of ${MODEL.LAPS}`;
    const lapEl = $("#sim-lap");
    if (lapEl.textContent !== lap) lapEl.textContent = sim.t === 0 ? `Lights out: ${MODEL.LAPS} laps to go` : lap;
    return { states, order };
  }
  function finishSim() {
    const order = sim.plans.map((p, i) => i).sort((a, b) => sim.plans[a].total - sim.plans[b].total);
    const win = sim.plans[order[0]];
    order.forEach((i, r) => { sim.els[i].info.textContent = r ? `+${(sim.plans[i].total - win.total).toFixed(1)} s` : "Winner"; });
    const second = sim.plans[order[1]];
    const margin = (second.total - win.total).toFixed(1);
    const best = bestPit(sim.wear);
    let why;
    if (win.id === "C") why = "With high wear, fresh tyres were worth more than the extra 22 seconds in the pit lane.";
    else if (win.id === "A") why = "The tyres lasted, so saving a pit stop paid off.";
    else why = "An early stop for hard tyres got the soft's speed at the start without stopping twice.";
    const hint = Math.abs(best - sim.pit) > 3 ? ` For car A, the quickest pit lap with this wear is around lap ${best}.` : "";
    $("#sim-result").innerHTML = `<b>Car ${win.id} wins by ${margin} seconds.</b> ${why}${hint}`;
    $("#sim-play").innerHTML = `<span class="tri" aria-hidden="true"></span>Race again`;
  }
  function playSim() {
    cancelAnimationFrame(sim.raf);
    buildSim();
    const end = Math.max(...sim.plans.map(p => p.total));
    if (reduced()) { sim.t = end; paintSim(); return finishSim(); }
    const DUR = 9000;                      // the whole race in nine seconds
    let t0 = null;
    sim.playing = true;
    $("#sim-play").innerHTML = `<span class="tri" aria-hidden="true"></span>Racing…`;
    const frame = now => {
      if (t0 == null) t0 = now;
      sim.t = Math.min(end, ((now - t0) / DUR) * end);
      paintSim();
      if (sim.t < end) sim.raf = requestAnimationFrame(frame);
      else { sim.playing = false; finishSim(); }
    };
    sim.raf = requestAnimationFrame(frame);
  }
  function setupSim() {
    const fig = $(".sim-fig");
    seg($(".seg", fig), b => { sim.wear = b.dataset.wear; cancelAnimationFrame(sim.raf); buildSim(); });
    const slider = $("#pit-lap");
    slider.addEventListener("input", () => {
      sim.pit = Number(slider.value);
      $("#pit-val").textContent = sim.pit;
      cancelAnimationFrame(sim.raf);
      buildSim();
    });
    $("#sim-play").addEventListener("click", playSim);
    buildSim();
  }

  /* ---------- 07 safety car ---------- */
  const sc = { mode: "green", cars: [], sc: null, raf: 0, last: 0, visible: false, scPos: null };
  const TRACK = { cx: 320, cy: 150, half: 190, r: 100 };            // a stadium: two straights, two hairpins
  const LAP_SEC = 95, LAP_MS = 9000, MIN_GAP = 0.011;
  const PER = 4 * TRACK.half + 2 * Math.PI * TRACK.r;
  function trackXY(f) {
    let s = ((f % 1) + 1) % 1 * PER;
    const { cx, cy, half, r } = TRACK;
    if (s < 2 * half) return [cx + half - s, cy + r];                                   // bottom straight, right to left
    s -= 2 * half;
    if (s < Math.PI * r) { const a = Math.PI / 2 + s / r; return [cx - half + r * Math.cos(a), cy + r * Math.sin(a)]; }
    s -= Math.PI * r;
    if (s < 2 * half) return [cx - half + s, cy - r];                                   // top straight
    s -= 2 * half;
    const a = -Math.PI / 2 + s / r;
    return [cx + half + r * Math.cos(a), cy + r * Math.sin(a)];
  }
  function setupSC(standings) {
    const svg = $("#sc-track");
    const { cx, cy, half, r } = TRACK;
    const path = `M${cx + half} ${cy + r}H${cx - half}A${r} ${r} 0 0 1 ${cx - half} ${cy - r}H${cx + half}A${r} ${r} 0 0 1 ${cx + half} ${cy + r}Z`;
    const rows = standings?.rows.slice(0, 12) || [];
    const colours = rows.length ? rows.map(x => colourFor(x.driver.code, x.teamId)) : Array.from({ length: 12 }, (_, i) => `hsl(${i * 30} 60% 55%)`);
    // Spread the field over about half a lap, as it would be mid-race.
    let f = 0.25;
    sc.cars = colours.map((c, i) => { if (i) f -= 0.018 + ((i * 37) % 11) / 11 * 0.03; return { f, c, code: rows[i]?.driver.code || "" }; });
    svg.innerHTML = `<path d="${path}" class="sc-road"/><path d="${path}" class="sc-edge"/>
      <line x1="${cx + 40}" y1="${cy + r - 16}" x2="${cx + 40}" y2="${cy + r + 16}" class="sc-sf"/>
      <g class="sc-sc" id="sc-car"><rect x="-13" y="-8" width="26" height="16" rx="4"/><text y="4" text-anchor="middle">SC</text></g>
      ${sc.cars.map((c, i) => `<g class="sc-c" style="--c:${c.c}"><circle r="8.5"/>${i === 0 ? `<text y="-14" text-anchor="middle">P1</text>` : ""}</g>`).join("")}`;
    sc.els = $$(".sc-c", svg);
    sc.scEl = $("#sc-car");
    paintSC();
    seg($("#sc-mode"), b => setSCMode(b.dataset.mode));
    Shell.watch($(".sc-fig"), v => { sc.visible = v; if (v) runSC(); else cancelAnimationFrame(sc.raf); });
  }
  function setSCMode(mode) {
    sc.mode = mode;
    if (mode === "sc") sc.scPos = sc.cars[0].f + 0.06;
    $("#sc-pass").textContent = mode === "green" ? "Allowed" : mode === "sc" ? "No: queue behind the safety car" : "No: everyone holds a set slower pace";
    if (reduced()) {
      // No motion: jump straight to where each state ends up.
      if (mode === "sc") { sc.cars.forEach((c, i) => { c.f = sc.cars[0].f - i * MIN_GAP; }); sc.scPos = sc.cars[0].f + 0.03; }
      paintSC();
    } else runSC();
  }
  function stepSC(dt) {
    const base = dt / LAP_MS;                                  // fraction of a lap at racing speed this frame
    const cars = sc.cars;
    if (sc.mode === "green") cars.forEach(c => { c.f += base; });
    else if (sc.mode === "vsc") cars.forEach(c => { c.f += base * 0.55; });
    else {
      sc.scPos += base * 0.45;
      cars.forEach((c, i) => {
        const ahead = i ? cars[i - 1].f : sc.scPos - 0.02;     // the leader tucks in behind the safety car
        const room = ahead - MIN_GAP - c.f;
        c.f += Math.max(0, Math.min(room, base * (room > 0.004 ? 1 : 0.45)));     // catch the queue at racing speed
      });
    }
  }
  function paintSC() {
    sc.cars.forEach((c, i) => { const [x, y] = trackXY(c.f); sc.els[i].setAttribute("transform", `translate(${x.toFixed(1)} ${y.toFixed(1)})`); });
    const show = sc.mode === "sc";
    sc.scEl.classList.toggle("on", show);
    if (sc.scPos != null) { const [x, y] = trackXY(sc.scPos); sc.scEl.setAttribute("transform", `translate(${x.toFixed(1)} ${y.toFixed(1)})`); }
    const spread = (sc.cars[0].f - sc.cars.at(-1).f) * LAP_SEC;
    const txt = `${spread.toFixed(1)} seconds`;
    const dd = $("#sc-spread");
    if (dd.textContent !== txt) dd.textContent = txt;
  }
  function runSC() {
    cancelAnimationFrame(sc.raf);
    if (!sc.visible || reduced()) return;
    sc.last = 0;
    const frame = now => {
      const dt = sc.last ? Math.min(50, now - sc.last) : 16;
      sc.last = now;
      stepSC(dt);
      paintSC();
      sc.raf = requestAnimationFrame(frame);
    };
    sc.raf = requestAnimationFrame(frame);
  }

  /* ---------- 08 points ---------- */
  function ladders() {
    const row = (pts, i, max) => `<div class="rung" style="--w:${(pts / max).toFixed(3)};--i:${i}"><span>P${i + 1}</span><i></i><b>${pts}</b></div>`;
    $("#ladder-race").innerHTML = `<p>Grand Prix</p>` + RACE_PTS.map((p, i) => row(p, i, 25)).join("");
    $("#ladder-sprint").innerHTML = `<p>Sprint</p>` + SPRINT_PTS.map((p, i) => row(p, i, 25)).join("");
  }
  function pointsLive(model) {
    const out = $("#points-live");
    if (!model) { $("#whatif-fig").hidden = true; return; }
    const lead = model.lead, p2 = model.rows[1];
    if (!model.rivals.length) {
      out.innerHTML = `In ${data.mode?.year ?? "this"} season, <b>${esc(lead.driver.given)} ${esc(lead.driver.family)}</b> ${model.left.length ? "has already won it: nobody can catch up any more." : "took the title."}`;
      $("#whatif-fig").hidden = true;
      return;
    }
    out.innerHTML = `Right now, <b>${esc(lead.driver.family)}</b> leads <b>${esc(p2.driver.family)}</b> by ${fmtPts(lead.points - p2.points)} points with ${model.max} still to be won, so ${plural(model.rivals.length, "driver")} can still take the title. ` +
      (model.earliest ? `The earliest it can be settled is ${esc(model.earliest.r.locality)}, round ${model.earliest.r.round}.` : "");
    whatIf(model);
  }
  function whatIf(model) {
    const lead = model.lead;
    const followId = Shell.store.get("pitwall-driver");
    const rival = model.rows.find(r => r.driver.id === followId && r !== lead) || model.rows[1];
    const next = model.left[0];
    const opts = sel => `${RACE_PTS.map((p, i) => `<option value="${i}"${i === sel ? " selected" : ""}>Finishes P${i + 1}</option>`).join("")}<option value="10">Outside the points</option>`;
    $("#wi-a-name").textContent = lead.driver.family;
    $("#wi-b-name").textContent = rival.driver.family;
    $("#wi-a").innerHTML = opts(1);
    $("#wi-b").innerHTML = opts(0);
    $("#whatif-q").textContent = `What if the ${next.name} finished like this?`;
    const update = () => {
      const pa = RACE_PTS[Number($("#wi-a").value)] || 0, pb = RACE_PTS[Number($("#wi-b").value)] || 0;
      const gap = lead.points + pa - (rival.points + pb);
      const leftAfter = model.max - A.worth(next);
      const name = esc(lead.driver.family), rn = esc(rival.driver.family);
      const state = gap > leftAfter ? `<b>${rn} could no longer catch ${name}.</b>`
        : gap < 0 ? `<b>${rn} would take the lead.</b>` : `<b>${rn} would still be in the fight.</b>`;
      $("#whatif-out").innerHTML = `${name} would ${gap >= 0 ? `lead ${rn} by ${fmtPts(gap)}` : `trail ${rn} by ${fmtPts(-gap)}`} points, with ${leftAfter} points left after that weekend. ${state}` +
        (next.sprint ? ` <span class="muted">Sprint points that weekend are left out.</span>` : "");
    };
    $("#wi-a").onchange = update;
    $("#wi-b").onchange = update;
    update();
  }

  /* ---------- 09 timing glossary ---------- */
  const GLOSSARY = [
    ["Pole position", "First place on the starting grid, earned with the fastest lap in qualifying."],
    ["Grid", "The starting order, set by qualifying. Cars line up two by two."],
    ["Formation lap", "A slow lap before the start to warm the tyres and brakes. No overtaking."],
    ["Lights out", "The start. Five red lights go out together and the race begins."],
    ["Parc fermé", "Once qualifying starts, teams can't change most of the car's set-up until the race."],
    ["Stint", "The run of laps a driver does on one set of tyres."],
    ["Compound", "The type of tyre: soft, medium or hard for the dry, intermediate or wet for rain."],
    ["Degradation", "How quickly a tyre loses grip, and lap time, as it wears."],
    ["Undercut", "Pitting before a rival and using fresh tyres to come out ahead of them."],
    ["Overcut", "Staying out longer than a rival and gaining while they warm up new tyres."],
    ["Box, box", "Team radio for \"come into the pits this lap\"."],
    ["In-lap and out-lap", "The lap into the pits and the first lap out of them. Both are slower than normal."],
    ["Dirty air", "Turbulent air behind a car. It costs the car following grip in the corners."],
    ["Slipstream", "The low-drag pocket behind a car, which helps the car behind gain speed on a straight. Also called a tow."],
    ["DRS", "A rear-wing flap that opened on straights to help overtaking, used until 2025. From 2026 the wings on every car adjust instead, and a driver close behind another gets extra electric power to attack."],
    ["Safety car", "A car that leads the field at reduced speed after an incident. No overtaking, and the gaps close up."],
    ["Virtual safety car (VSC)", "Every driver slows to a set slower pace, with no car on track. Gaps stay roughly the same."],
    ["Red flag", "The session is stopped and the cars return to the pit lane."],
    ["Blue flag", "Shown to a car about to be lapped: let the faster car through."],
    ["Track limits", "Cars must stay within the white lines. Repeat offences bring penalties."],
    ["Time penalty", "Seconds added to a driver's race, usually 5 or 10, served at a pit stop or added at the end."],
    ["Drive-through", "A penalty: drive through the pit lane at the speed limit without stopping."],
    ["Grid penalty", "Places dropped on the starting grid, often for using too many engine parts."],
    ["DNF, DNS, DSQ", "Did not finish, did not start, disqualified."],
    ["Lapped car", "A car the leader has caught and passed a full lap ahead."],
    ["Gap and interval", "Gap is the time to the leader; interval is the time to the car directly ahead."],
    ["Sector", "One of three timed parts of a lap. Mini-sectors split them further."],
    ["Purple, green, yellow", "On timing screens: fastest of anyone, a driver's own best, slower than their best."],
    ["Ideal lap", "A driver's three best sectors added together: their best possible lap."],
    ["Speed trap", "The point on a fast straight where each car's top speed is measured."],
    ["Constructor", "A team. The constructors' championship adds up both drivers' points."],
    ["Sprint", "A 100 km race on Saturday at some weekends. The top eight score."],
    ["Delta", "A difference in time. Under a VSC, the target lap time drivers must stay above."]
  ];
  function glossary() {
    const dl = $("#gloss");
    dl.innerHTML = GLOSSARY.map(([t, d]) => `<div data-k="${esc((t + " " + d).toLowerCase())}"><dt>${esc(t)}</dt><dd>${esc(d)}</dd></div>`).join("");
    const rows = $$("div", dl);
    $("#gloss-q").addEventListener("input", e => {
      const q = e.target.value.trim().toLowerCase();
      rows.forEach(r => { r.hidden = Boolean(q) && !r.dataset.k.includes(q); });
    });
    Shell.watch($("#lapbar"), v => $("#lapbar").classList.toggle("run", v));
  }

  /* ---------- live data from the latest race ---------- */
  async function latestRace(year) {
    let sessions;
    try { sessions = await S.sessions(year); } catch { return; }
    const race = sessions.completed.find(s => s.session_name === "Race");
    if (!race) return;
    const key = race.session_key;
    const [drv, st, cls, rc, pits] = await Promise.allSettled([S.drivers(key), S.stints(key), S.classification(key, []), S.raceControl(key), S.pits(key)]);
    const drivers = drv.status === "fulfilled" ? drv.value : new Map();
    if (drivers.size) colourFor = S.colourIndex(drivers);
    const code = n => drivers.get(n)?.code || `#${n}`;
    const order = cls.status === "fulfilled" ? cls.value.order : [];
    const where = esc(race.location);

    // Tyres: how the top five actually ran their stints.
    if (st.status === "fulfilled" && st.value.length && order.length) {
      const stints = st.value, maxLap = Math.max(...stints.map(s => s.lap_end || 0), 1);
      const top = order.slice(0, 5);
      $("#tyres-live").innerHTML = `<b>From the ${where} race:</b> the top five's tyres, lap by lap. Every change of colour is a pit stop.`;
      $("#mini-stints").innerHTML = top.map((n, i) => {
        const own = stints.filter(s => s.driver_number === n).sort((a, b) => a.stint_number - b.stint_number);
        return `<div class="ms" style="--i:${i}"><b>P${i + 1} ${esc(code(n))}</b><div class="ms-lane">${own.map(s => {
          const c = (s.compound || "").toUpperCase(), a = s.lap_start || 1, z = s.lap_end || a;
          return `<i data-c="${c}" style="--tc:${COMPOUND[c] || "var(--dust)"};left:${((a - 1) / maxLap) * 100}%;width:${((z - a + 1) / maxLap) * 100}%" title="${c.charAt(0) + c.slice(1).toLowerCase()}, laps ${a} to ${z}"></i>`;
        }).join("")}</div></div>`;
      }).join("");
    }

    // Pit stops: the quickest real trip through the pit lane.
    if (pits.status === "fulfilled") {
      const list = pits.value.map(p => ({ n: p.driver_number, lap: p.lap_number, t: p.lane_duration ?? p.pit_duration })).filter(p => p.t > 5 && p.t < 60).sort((a, b) => a.t - b.t);
      if (list.length) $("#pits-live").innerHTML = `<b>From the ${where} race:</b> ${list.length} trips through the pit lane. The quickest took ${list[0].t.toFixed(1)} seconds, by ${esc(code(list[0].n))} on lap ${list[0].lap}.`;
    }

    // Safety cars: the real neutralised periods.
    if (rc.status === "fulfilled") {
      const bands = S.neutralised(rc.value, Math.max(0, ...rc.value.map(m => m.lap_number || 0)));
      const sc = bands.filter(b => b.kind === "SC"), vsc = bands.filter(b => b.kind === "VSC");
      const laps = b => b.from === b.to ? `lap ${b.from}` : `laps ${b.from} to ${b.to}`;
      $("#sc-live").innerHTML = !bands.length
        ? `<b>From the ${where} race:</b> no safety car at all, green flag from start to finish.`
        : `<b>From the ${where} race:</b> ${sc.length ? `the safety car came out on ${sc.map(laps).join(" and ")}` : "no full safety car"}${vsc.length ? `, and a virtual safety car ran on ${vsc.map(laps).join(" and ")}` : ""}.`;
    }
  }

  async function load() {
    try { data.mode = await S.resolveSeason(null); } catch { data.mode = { year: new Date().getUTCFullYear(), mode: "live" }; }
    const [up, ds, cs, q] = await Promise.allSettled([S.upcoming(), S.driverStandings(), S.constructorStandings(), S.lastQualifying()]);
    const v = r => (r.status === "fulfilled" ? r.value : null);
    data.upcoming = v(up); data.standings = v(ds); data.teams = v(cs);
    renderTour(data.upcoming?.length ? data.upcoming : null);
    weekendLive(data.upcoming);
    renderStack(data.standings, data.teams);
    setupQuali(v(q));
    setupSC(data.standings);
    const schedule = data.mode.mode === "live" ? data.upcoming : await S.schedule().catch(() => null);
    pointsLive(A.title({ standings: data.standings, schedule }));
    latestRace(data.mode.year).then(() => renderStack(data.standings, data.teams));
  }

  introLights();
  quizzes();
  setupWeekend();
  setupStart();
  drawDeg();
  setupSim();
  ladders();
  glossary();
  load();
  Shell.watch($("#tyres-row"), v => $("#tyres-row").classList.toggle("spin", v));
  addEventListener("pw:width", () => { if (quali.q) renderQualiPhase(Math.max(0, quali.phase)); });
})();
