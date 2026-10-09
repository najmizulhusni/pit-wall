/* View helpers. Plain SVG, no chart library, so every mark is deliberate. */
(function () {
  "use strict";
  const NS = "http://www.w3.org/2000/svg";
  const reduced = () => window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  const theme = () => (document.documentElement.dataset.theme === "light" ? "light" : "dark");
  let uid = 0;
  const nextId = p => `${p}${++uid}`;
  const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const EASE = "cubic-bezier(.65,0,.35,1)";

  function el(tag, attrs = {}, parent) {
    const n = document.createElementNS(NS, tag);
    for (const k in attrs) if (attrs[k] != null) n.setAttribute(k, attrs[k]);
    if (parent) parent.appendChild(n);
    return n;
  }

  function scale(d0, d1, r0, r1) {
    const k = d1 === d0 ? 0 : (r1 - r0) / (d1 - d0);
    const f = v => r0 + (v - d0) * k;
    f.invert = p => d0 + (p - r0) / (k || 1);
    return f;
  }

  function niceTicks(min, max, count = 5) {
    const span = max - min || 1;
    const step0 = span / count;
    const mag = 10 ** Math.floor(Math.log10(step0));
    const step = [1, 2, 2.5, 5, 10].map(m => m * mag).find(s => s >= step0) || mag * 10;
    const out = [];
    for (let v = Math.ceil(min / step) * step; v <= max + 1e-9; v += step) out.push(+v.toFixed(6));
    return out;
  }

  /*
    Speed ramp: slow corners cool, straights hot. Colour encodes the data, nothing else.
    The light theme ends on amber instead of pale yellow so the fast sections stay visible on white.
  */
  const RAMPS = {
    dark: [[0, [70, 76, 160]], [0.45, [181, 72, 122]], [0.75, [240, 138, 75]], [1, [249, 224, 127]]],
    light: [[0, [62, 70, 168]], [0.45, [178, 46, 118]], [0.75, [226, 104, 36]], [1, [214, 150, 0]]]
  };
  function ramp(t) {
    const R = RAMPS[theme()];
    t = Math.max(0, Math.min(1, t));
    for (let i = 1; i < R.length; i++) {
      if (t <= R[i][0]) {
        const [a, ca] = R[i - 1], [b, cb] = R[i];
        const k = (t - a) / (b - a);
        const c = ca.map((v, j) => Math.round(v + (cb[j] - v) * k));
        return `rgb(${c[0]} ${c[1]} ${c[2]})`;
      }
    }
    return `rgb(${R.at(-1)[1].join(" ")})`;
  }
  function rampCss() {
    return `linear-gradient(90deg, ${RAMPS[theme()].map(([s, c]) => `rgb(${c.join(" ")}) ${s * 100}%`).join(", ")})`;
  }

  /*
    Track map from OpenF1 x/y. Returns a projector so callers can place a car marker.
    keyOf(i) buckets the segment that starts at point i; paint(key) colours a bucket.
    Segments are merged into one path per bucket, so a lap is ~24 elements, not ~400,
    and a theme change recolours the buckets without rebuilding anything.
    With draw, a mask traces the lap once from the start line, then gets out of the way.
  */
  function trackMap(svg, points, { keyOf, paint, width = 1000, height = 700, pad = 40, stroke = 9, draw = false, drawMs = 1600 } = {}) {
    svg.innerHTML = "";
    svg.setAttribute("viewBox", `0 0 ${width} ${height}`);
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    for (const p of points) {
      if (p.x < minX) minX = p.x; if (p.x > maxX) maxX = p.x;
      if (p.y < minY) minY = p.y; if (p.y > maxY) maxY = p.y;
    }
    const k = Math.min((width - pad * 2) / (maxX - minX || 1), (height - pad * 2) / (maxY - minY || 1));
    const ox = (width - (maxX - minX) * k) / 2, oy = (height - (maxY - minY) * k) / 2;
    const px = p => [ox + (p.x - minX) * k, height - (oy + (p.y - minY) * k)];
    const xy = points.map(px);
    const f1 = v => v.toFixed(1);

    // Underlay: the circuit as tarmac, slightly wider than the data line.
    const d = xy.map((p, i) => (i ? "L" : "M") + f1(p[0]) + " " + f1(p[1])).join("") + "Z";
    el("path", { d, class: "tarmac", fill: "none", "stroke-width": stroke + 8, "stroke-linejoin": "round", "stroke-linecap": "round" }, svg);

    const g = el("g", { fill: "none", "stroke-linecap": "round", "stroke-linejoin": "round", "stroke-width": stroke }, svg);
    const groups = new Map();
    let prevKey = null;
    for (let i = 0; i < xy.length - 1; i++) {
      const key = keyOf(i);
      const run = key === prevKey ? "" : `M${f1(xy[i][0])} ${f1(xy[i][1])}`;
      groups.set(key, (groups.get(key) || "") + run + `L${f1(xy[i + 1][0])} ${f1(xy[i + 1][1])}`);
      prevKey = key;
    }
    const paths = [...groups].map(([key, dd]) => [key, el("path", { d: dd, stroke: paint(key) }, g)]);

    // Start/finish: a short perpendicular tick at the first sample.
    const [sx, sy] = xy[0], [nx, ny] = xy[Math.min(3, xy.length - 1)];
    const ang = Math.atan2(ny - sy, nx - sx) + Math.PI / 2;
    const L = stroke * 1.6;
    el("line", { x1: sx - Math.cos(ang) * L, y1: sy - Math.sin(ang) * L, x2: sx + Math.cos(ang) * L, y2: sy + Math.sin(ang) * L, class: "sf", "stroke-width": 3 }, svg);

    const animated = draw && !reduced();
    if (animated) {
      const id = nextId("trace");
      const mask = el("mask", { id, maskUnits: "userSpaceOnUse", x: 0, y: 0, width, height }, el("defs", {}, svg));
      const mp = el("path", { d, fill: "none", stroke: "#fff", "stroke-width": stroke + 14, "stroke-linecap": "round", "stroke-linejoin": "round" }, mask);
      let len = 2;
      for (let i = 1; i <= xy.length; i++) {
        const a = xy[i - 1], b = xy[i % xy.length];
        len += Math.hypot(b[0] - a[0], b[1] - a[1]);
      }
      mp.style.strokeDasharray = `${len} ${len}`;
      mp.style.strokeDashoffset = len;
      g.setAttribute("mask", `url(#${id})`);
      requestAnimationFrame(() => requestAnimationFrame(() => {
        mp.style.transition = `stroke-dashoffset ${drawMs}ms ${EASE}`;
        mp.style.strokeDashoffset = 0;
      }));
      setTimeout(() => g.removeAttribute("mask"), drawMs + 120);
    }
    return {
      project: px,
      xy,
      viewBox: `0 0 ${width} ${height}`,
      drawMs: animated ? drawMs : 0,
      recolour(fn = paint) { paths.forEach(([key, p]) => p.setAttribute("stroke", fn(key))); }
    };
  }

  /*
    Multi-series line chart with a shared crosshair.
    series: [{ id, label, colour, dashed, points: [[x, y], ...] }]
    Options of note:
      bands      [{ from, to, kind }] shaded x ranges (safety car periods)
      yTicks     explicit ticks instead of nice ones
      endLabels  print each series' label at its last point
      clip       keep lines inside the plot when yMin/yMax cut the data
    The crosshair lives in a separate overlay SVG, so hovering repaints a few marks
    instead of every line. Returns { setFocus(ids) }: dims series without redrawing.
  */
  function lineChart(host, opts) {
    const {
      series, xFmt = v => v, yFmt = v => v, invertY = false, height = 320, xLabel = "",
      animate = false, step = false, bands = [], endLabels = false, clip = false, tipMax = 10
    } = opts;
    host.innerHTML = "";
    const W = Math.max(320, host.clientWidth || 640);
    const H = height;
    const m = { t: bands.length ? 26 : 16, r: endLabels ? 46 : 16, b: 34, l: 52 };
    const viewBox = `0 0 ${W} ${H}`;
    const svg = el("svg", { viewBox, class: "chart", role: "img", "aria-label": opts.aria || "" }, host);

    const all = series.flatMap(s => s.points);
    if (!all.length) return { setFocus() {} };
    let xMin = opts.xMin, xMax = opts.xMax, yMin = opts.yMin, yMax = opts.yMax;
    if (xMin == null || xMax == null || yMin == null || yMax == null) {
      let a = Infinity, b = -Infinity, c = Infinity, d = -Infinity;
      for (const p of all) { if (p[0] < a) a = p[0]; if (p[0] > b) b = p[0]; if (p[1] < c) c = p[1]; if (p[1] > d) d = p[1]; }
      xMin ??= a; xMax ??= b; yMin ??= c; yMax ??= d;
    }
    if (opts.yPad) { const pad = (yMax - yMin) * opts.yPad; yMin -= pad; yMax += pad; }
    const x = scale(xMin, xMax, m.l, W - m.r);
    const y = invertY ? scale(yMin, yMax, m.t, H - m.b) : scale(yMin, yMax, H - m.b, m.t);

    // Neutralised periods sit behind everything, widened half a lap each side to cover the laps they name.
    if (bands.length) {
      const bg = el("g", { class: "bands" }, svg);
      let labelEnd = -Infinity;
      bands.forEach(b => {
        const x0 = x(Math.max(xMin, b.from - 0.5)), x1 = x(Math.min(xMax, b.to + 0.5));
        if (x1 <= x0) return;
        el("rect", { x: x0, y: m.t, width: x1 - x0, height: H - m.t - m.b, class: `band ${b.kind.toLowerCase()}` }, bg);
        if (x0 + 4 < labelEnd + 6) return;          // adjacent periods: one label is enough
        el("text", { x: x0 + 4, y: m.t - 8, class: "band-label" }, bg).textContent = b.kind;
        labelEnd = x0 + 4 + b.kind.length * 7.5;
      });
    }

    const grid = el("g", { class: "grid" }, svg);
    (opts.yTicks || niceTicks(yMin, yMax, 5)).forEach(v => {
      el("line", { x1: m.l, x2: W - m.r, y1: y(v), y2: y(v) }, grid);
      el("text", { x: m.l - 8, y: y(v) + 4, "text-anchor": "end" }, grid).textContent = yFmt(v);
    });
    (opts.xTicks || niceTicks(xMin, xMax, Math.min(10, Math.floor(W / 80)))).forEach(v => {
      el("text", { x: x(v), y: H - m.b + 20, "text-anchor": "middle" }, grid).textContent = xFmt(v);
    });
    if (xLabel) el("text", { x: W - m.r, y: H - 2, "text-anchor": "end", class: "axis-label" }, svg).textContent = xLabel;

    let clipAttr = null;
    if (clip) {
      const id = nextId("clip");
      el("rect", { x: m.l, y: m.t - 3, width: W - m.l - m.r, height: H - m.t - m.b + 6 }, el("clipPath", { id }, el("defs", {}, svg)));
      clipAttr = `url(#${id})`;
    }
    const lines = el("g", { "clip-path": clipAttr }, svg);
    const labels = el("g", { class: "end-labels" }, svg);
    const paths = [], tags = [];
    const anim = animate && !reduced();

    series.forEach((s, i) => {
      let d = "";
      s.points.forEach((p, j) => {
        const px = x(p[0]).toFixed(1), py = y(p[1]).toFixed(1);
        if (!j) d += `M${px} ${py}`;
        else if (step) d += `H${px}V${py}`;
        else d += `L${px} ${py}`;
      });
      const path = el("path", {
        d, class: "series", fill: "none", stroke: s.colour, "stroke-width": s.width || 2.25,
        "stroke-dasharray": s.dashed ? "6 5" : null, "stroke-linejoin": "round"
      }, lines);
      paths.push(path);
      // Draw-on only for lines in focus: animating 20 dimmed lines costs paint and shows nothing.
      const drawn = !opts.focus || !opts.focus.size || opts.focus.has(s.id);
      if (anim && drawn && !s.dashed && s.points.length > 1) {
        const len = path.getTotalLength();
        path.style.strokeDasharray = `${len} ${len}`;
        path.style.strokeDashoffset = len;
        path.style.transition = `stroke-dashoffset 900ms ${EASE} ${Math.min(i * 28, 500)}ms, opacity 300ms, stroke-width 300ms`;
      }
      if (endLabels && s.points.length) {
        const p = s.points.at(-1);
        const t = el("text", { x: x(p[0]) + 6, y: y(p[1]) + 4, fill: s.colour }, labels);
        t.textContent = s.label;
        tags.push(t);
      } else tags.push(null);
    });
    // One style flush for all series, then start every draw-on together.
    if (anim) {
      lines.getBoundingClientRect();
      paths.forEach(p => { if (p.style.strokeDashoffset) p.style.strokeDashoffset = 0; });
    }

    // Crosshair + readout, on their own layer.
    const over = el("svg", { viewBox, class: "chart-over", "aria-hidden": "true" }, host);
    const cross = el("line", { y1: m.t, y2: H - m.b, class: "cross", visibility: "hidden" }, over);
    const dots = series.map(s => el("circle", { r: 4, fill: s.colour, visibility: "hidden" }, over));
    const tip = document.createElement("div");
    tip.className = "tip";
    host.appendChild(tip);

    let focus = null;
    const shown = i => !focus || !focus.size || focus.has(series[i].id);

    function setFocus(ids) {
      focus = ids && ids.size ? new Set(ids) : null;
      series.forEach((s, i) => {
        const on = shown(i);
        paths[i].classList.toggle("dim", !on);
        paths[i].classList.toggle("hi", Boolean(focus) && on);
        if (tags[i]) tags[i].classList.toggle("dim", !on);
        if (focus && on) lines.appendChild(paths[i]);      // focused lines draw on top
      });
    }

    const nearest = (pts, xv) => {
      let best = null, bd = Infinity;
      for (const p of pts) { const dd = Math.abs(p[0] - xv); if (dd < bd) { bd = dd; best = p; } }
      return best;
    };

    let shownTip = false;
    function move(evt) {
      const r = svg.getBoundingClientRect();
      const sx = ((evt.clientX - r.left) / r.width) * W;
      if (sx < m.l || sx > W - m.r) return hide();
      const xv = x.invert(sx);
      const rows = [];
      let snapX = null;
      series.forEach((s, i) => {
        const p = shown(i) ? nearest(s.points, xv) : null;
        if (!p || Math.abs(p[0] - xv) > (xMax - xMin) / 8) { dots[i].setAttribute("visibility", "hidden"); return; }
        snapX = snapX ?? p[0];
        dots[i].setAttribute("cx", x(p[0]));
        dots[i].setAttribute("cy", Math.max(m.t, Math.min(H - m.b, y(p[1]))));
        dots[i].setAttribute("visibility", "visible");
        rows.push({ s, v: p[1] });
      });
      if (snapX == null) return hide();
      cross.setAttribute("x1", x(snapX)); cross.setAttribute("x2", x(snapX));
      cross.setAttribute("visibility", "visible");
      rows.sort((a, b) => invertY ? a.v - b.v : b.v - a.v);
      const extra = rows.length - tipMax;
      tip.innerHTML = `<b>${xFmt(snapX, true)}</b>` + rows.slice(0, tipMax).map(r =>
        `<span><i style="background:${r.s.colour}"></i>${esc(r.s.label)}<em>${yFmt(r.v, true)}</em></span>`).join("") +
        (extra > 0 ? `<small>and ${extra} more</small>` : "");
      const tw = tip.offsetWidth, tx = (x(snapX) / W) * r.width;
      const left = tx + 14 + tw > r.width ? Math.max(0, tx - tw - 14) : tx + 14;
      tip.style.transform = `translate3d(${left.toFixed(0)}px,0,0)`;
      if (!shownTip) { tip.style.opacity = 1; shownTip = true; }
    }
    function hide() {
      if (!shownTip) return;
      shownTip = false;
      cross.setAttribute("visibility", "hidden");
      dots.forEach(d => d.setAttribute("visibility", "hidden"));
      tip.style.opacity = 0;
    }
    // At most one crosshair update per frame, however fast the pointer reports.
    let pendingEvt = null, raf = 0;
    svg.addEventListener("pointermove", e => {
      pendingEvt = e;
      if (!raf) raf = requestAnimationFrame(() => { raf = 0; move(pendingEvt); });
    }, { passive: true });
    svg.addEventListener("pointerleave", () => { cancelAnimationFrame(raf); raf = 0; hide(); });
    if (opts.focus) setFocus(opts.focus);
    return { setFocus };
  }

  window.Charts = { el, scale, ramp, rampCss, trackMap, lineChart, niceTicks, reduced, theme };
})();
