/*
  Page chrome shared by every page: theme, scroll reveal, reading progress, the section spy
  that slides the nav underline, and a few helpers for running work only when it's on screen.
  Pages listen for "pw:theme" and "pw:width" instead of wiring their own handlers.
*/
(function () {
  "use strict";
  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
  const io = "IntersectionObserver" in window;
  const reduced = () => matchMedia("(prefers-reduced-motion: reduce)").matches;

  /* localStorage that never throws (private mode, blocked storage) */
  const store = {
    get(k) { try { return localStorage.getItem(k); } catch { return null; } },
    set(k, v) { try { v == null ? localStorage.removeItem(k) : localStorage.setItem(k, v); } catch { /* blocked */ } }
  };

  /* ---------- reveal on scroll ---------- */
  const revealer = io && new IntersectionObserver(entries => entries.forEach(e => {
    if (!e.isIntersecting) return;
    e.target.classList.add("in");
    revealer.unobserve(e.target);
  }), { rootMargin: "0px 0px -6% 0px", threshold: 0.06 });
  function reveal(root = document) {
    $$("[data-reveal]:not(.in)", root).forEach(n => (revealer ? revealer.observe(n) : n.classList.add("in")));
  }

  /*
    Run fn once the element is on screen, so entrance animations aren't spent off-screen.
    Only the latest fn per element runs, however many renders happened while it waited.
  */
  const pending = new WeakMap();
  function whenVisible(node, fn, threshold = 0.1) {
    if (!io) return fn();
    const waiting = pending.has(node);
    pending.set(node, fn);
    if (waiting) return;
    const ob = new IntersectionObserver(([e]) => {
      if (!e.isIntersecting) return;
      ob.disconnect();
      const f = pending.get(node);
      pending.delete(node);
      if (f) f();
    }, { threshold });
    ob.observe(node);
  }
  const inView = node => { const r = node.getBoundingClientRect(); return r.width > 0 && r.bottom > 0 && r.top < innerHeight; };

  /* Draw now; animate in now if on screen, otherwise when it arrives. */
  function animateIn(host, draw) {
    pending.delete(host);
    if (reduced()) return draw(false);
    if (inView(host)) { host.classList.remove("pending"); return draw(true); }
    draw(false);
    host.classList.add("pending");
    whenVisible(host, () => { host.classList.remove("pending"); draw(true); });
  }

  /* Keep calling fn(visible) as the element enters and leaves the screen: for loops that should pause. */
  function watch(node, fn, rootMargin = "0px") {
    if (!io) return fn(true);
    new IntersectionObserver(([e]) => fn(e.isIntersecting), { rootMargin }).observe(node);
  }

  /* Sliding pill behind the selected tab of a segmented control. */
  function segInk(seg) {
    const on = $('[aria-selected="true"]', seg), ink = $(".seg-ink", seg);
    if (!on || !ink || !on.offsetWidth) return;
    ink.style.width = `${on.offsetWidth}px`;
    ink.style.transform = `translateX(${on.offsetLeft - 3}px)`;
  }

  /* ---------- theme ---------- */
  const theme = () => (document.documentElement.dataset.theme === "light" ? "light" : "dark");
  function applyTheme(t) {
    document.documentElement.dataset.theme = t;
    const meta = $("#theme-color");
    if (meta) meta.content = t === "light" ? "#f3f4f6" : "#14171b";
    $("#theme")?.setAttribute("aria-label", t === "light" ? "Switch to dark mode" : "Switch to light mode");
    dispatchEvent(new CustomEvent("pw:theme", { detail: t }));
  }
  /* A circular wipe from the button, via the View Transitions API where it exists. */
  function toggleTheme(evt) {
    const next = theme() === "light" ? "dark" : "light";
    store.set("pitwall-theme", next);
    if (!document.startViewTransition || reduced()) return applyTheme(next);
    const r = evt.currentTarget.getBoundingClientRect();
    const x = r.left + r.width / 2, y = r.top + r.height / 2;
    const end = Math.hypot(Math.max(x, innerWidth - x), Math.max(y, innerHeight - y));
    document.startViewTransition(() => applyTheme(next)).ready.then(() => {
      document.documentElement.animate(
        { clipPath: [`circle(0px at ${x}px ${y}px)`, `circle(${end}px at ${x}px ${y}px)`] },
        { duration: 520, easing: "cubic-bezier(.65,0,.35,1)", pseudoElement: "::view-transition-new(root)" }
      );
    }).catch(() => {});
  }

  /* ---------- section spy: mark the link for the section in view, slide an underline to it ---------- */
  function spy(nav, { inkSel = ".ink", sections } = {}) {
    if (!nav || !io) return () => {};
    const links = $$("a[href^='#']", nav), ink = $(inkSel, nav);
    const targets = sections || links.map(a => document.getElementById(a.hash.slice(1))).filter(Boolean);
    let active = null;
    const move = () => {
      if (!ink) return;
      if (!active) { ink.style.opacity = 0; return; }
      ink.style.opacity = 1;
      if (nav.dataset.axis === "y") {
        ink.style.height = `${active.offsetHeight}px`;
        ink.style.transform = `translateY(${active.offsetTop}px)`;
      } else {
        ink.style.width = `${active.offsetWidth}px`;
        ink.style.transform = `translateX(${active.offsetLeft}px)`;
      }
    };
    const ob = new IntersectionObserver(entries => entries.forEach(en => {
      if (!en.isIntersecting) return;
      active = links.find(a => a.hash === "#" + en.target.id) || null;
      links.forEach(a => a.setAttribute("aria-current", String(a === active)));
      move();
    }), { rootMargin: "-45% 0px -50% 0px" });
    targets.forEach(t => ob.observe(t));
    return move;
  }

  /* ---------- boot ---------- */
  const spies = [];
  function boot() {
    applyTheme(theme());
    $("#theme")?.addEventListener("click", toggleTheme);
    // Follow the system theme until the visitor picks one.
    matchMedia("(prefers-color-scheme: light)").addEventListener?.("change", e => {
      if (!store.get("pitwall-theme")) applyTheme(e.matches ? "light" : "dark");
    });

    $$("[data-spy]").forEach(nav => spies.push(spy(nav)));

    // Reading progress along the bottom of the top bar; page height is re-measured as content lands.
    const bar = $(".topbar .progress"), topbar = $(".topbar");
    let ticking = false, scrolled = null, docH = 0;
    const measure = () => { docH = document.documentElement.scrollHeight - innerHeight; };
    const progress = () => {
      ticking = false;
      if (!docH) measure();
      if (bar) bar.style.transform = `scaleX(${docH > 0 ? Math.min(1, scrollY / docH).toFixed(4) : 0})`;
      const now = scrollY > 8;
      if (now !== scrolled && topbar) { scrolled = now; topbar.classList.toggle("scrolled", now); }
    };
    addEventListener("scroll", () => { if (!ticking) { ticking = true; requestAnimationFrame(progress); } }, { passive: true });
    if ("ResizeObserver" in window) new ResizeObserver(measure).observe(document.body);
    progress();

    // iOS fires resize while scrolling as the toolbar slides; only a width change matters to layout.
    let rt, lastW = innerWidth;
    addEventListener("resize", () => {
      clearTimeout(rt);
      rt = setTimeout(() => {
        measure();
        if (innerWidth === lastW) return;
        lastW = innerWidth;
        spies.forEach(fn => fn());
        $$(".seg").forEach(segInk);
        dispatchEvent(new CustomEvent("pw:width"));
      }, 180);
    });
    $$(".seg").forEach(segInk);
    document.fonts?.ready.then(() => { $$(".seg").forEach(segInk); spies.forEach(fn => fn()); });
    reveal();
  }

  window.Shell = { store, reveal, whenVisible, inView, animateIn, watch, segInk, theme, applyTheme, spy, reduced };
  boot();
})();
