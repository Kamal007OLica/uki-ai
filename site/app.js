// Uki AI website. A character-grid sky drawn on a 2D canvas, the gold sparkle and the serif "Uki"
// as sharp vectors on top. The page opens on a dark canvas with the sparkle dim. Scrolling the
// first screen lights it: the gold dust in the sky brightens and the sparkle flares. Next the plugin
// panel pins, and the scroll plays its six steps sideways. The cursor parts the dust as it moves.
(() => {
  "use strict";

  const MONO = 'ui-monospace, "SF Mono", SFMono-Regular, Menlo, Consolas, monospace';
  const motionQuery = matchMedia("(prefers-reduced-motion: reduce)");
  const root = document.documentElement;

  // ---- Easing and timeline helpers -----------------------------------------------------------------

  const lerp = (a, b, t) => a + (b - a) * t;
  const clamp01 = (v) => Math.min(1, Math.max(0, v));

  function cubicBezier(x1, y1, x2, y2) {
    const bx = (t) => 3 * x1 * t * (1 - t) ** 2 + 3 * x2 * t * t * (1 - t) + t ** 3;
    const by = (t) => 3 * y1 * t * (1 - t) ** 2 + 3 * y2 * t * t * (1 - t) + t ** 3;
    return (x) => {
      if (x <= 0) return 0;
      if (x >= 1) return 1;
      let lo = 0;
      let hi = 1;
      for (let i = 0; i < 24; i++) {
        const mid = (lo + hi) / 2;
        if (bx(mid) < x) lo = mid;
        else hi = mid;
      }
      return by((lo + hi) / 2);
    };
  }

  const linear = (x) => x;
  const inOut = cubicBezier(0.7, 0, 0.3, 1);
  const softOut = cubicBezier(0.2, 0.8, 0.3, 1);
  const span = (t, a, b, ease = inOut) => ease(clamp01((t - a) / (b - a)));

  // ---- Palettes: a dark canvas at the top of the page, lit gold once the sparkle is on -----------

  const hex = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
  const STOPS = [
    { at: 0, top: hex("#0c0e0b"), bottom: hex("#070806"), cloud: hex("#3b3521"), ink: hex("#e9d9a6"), accent: hex("#f0c75e"), glow: [240, 199, 94, 0.18] },
    { at: 0.5, top: hex("#17120a"), bottom: hex("#090806"), cloud: hex("#8c6f2e"), ink: hex("#f6e5b0"), accent: hex("#f6d27a"), glow: [240, 199, 94, 0.42] },
    { at: 1, top: hex("#1f180a"), bottom: hex("#0a0906"), cloud: hex("#e2b44c"), ink: hex("#fff1c2"), accent: hex("#ffd770"), glow: [255, 210, 90, 0.6] },
  ];
  const mixC = (a, b, t) => a.map((v, i) => lerp(v, b[i], t));
  function mixPalette(k) {
    let i = 0;
    while (i < STOPS.length - 2 && k > STOPS[i + 1].at) i++;
    const a = STOPS[i];
    const b = STOPS[i + 1];
    const t = clamp01((k - a.at) / (b.at - a.at));
    const out = {};
    for (const key of ["top", "bottom", "cloud", "ink", "accent", "glow"]) out[key] = mixC(a[key], b[key], t);
    return out;
  }
  const css = (c) => `rgb(${Math.round(c[0])},${Math.round(c[1])},${Math.round(c[2])})`;
  const cssA = (c) => `rgba(${Math.round(c[0])},${Math.round(c[1])},${Math.round(c[2])},${(c[3] ?? 1).toFixed(3)})`;
  const hexOf = (c) => "#" + c.slice(0, 3).map((v) => Math.round(v).toString(16).padStart(2, "0")).join("");

  // ---- The sparkle: one geometry for the hero and the small copies in the bars and the panel ----
  // A four-point star with concave sides, a lighter upper-left facet so it reads as bevelled gold,
  // and two small companions that only show once it is lit.

  const STAR = "M0 -1 Q0.16 -0.16 1 0 Q0.16 0.16 0 1 Q-0.16 0.16 -1 0 Q-0.16 -0.16 0 -1 Z";
  const FACET = "M0 -1 Q-0.16 -0.16 -1 0 L0 0 Z";

  function mountSparkle(svg, opts = {}) {
    const ns = "http://www.w3.org/2000/svg";
    const id = "sp" + Math.random().toString(36).slice(2, 8);
    const el = (name, attrs) => {
      const n = document.createElementNS(ns, name);
      for (const k in attrs) n.setAttribute(k, attrs[k]);
      return n;
    };
    const defs = el("defs", {});
    const grad = el("linearGradient", { id: id + "g", x1: "0", y1: "0", x2: "1", y2: "1" });
    for (const [o, c] of [
      ["0", "#fff6d0"],
      ["0.42", "#f3cf6c"],
      ["1", "#b07a1a"],
    ])
      grad.appendChild(el("stop", { offset: o, "stop-color": c }));
    const hl = el("linearGradient", { id: id + "h", x1: "0", y1: "0", x2: "1", y2: "1" });
    hl.appendChild(el("stop", { offset: "0", "stop-color": "#ffffff", "stop-opacity": "0.85" }));
    hl.appendChild(el("stop", { offset: "1", "stop-color": "#ffffff", "stop-opacity": "0" }));
    defs.appendChild(grad);
    defs.appendChild(hl);
    const g = el("g", {});
    const big = el("g", {});
    big.appendChild(el("path", { d: STAR, fill: `url(#${id}g)` }));
    big.appendChild(el("path", { d: FACET, fill: `url(#${id}h)` }));
    const small1 = el("path", { d: STAR, fill: `url(#${id}g)` });
    const small2 = el("path", { d: STAR, fill: `url(#${id}g)` });
    g.appendChild(big);
    g.appendChild(small1);
    g.appendChild(small2);
    const host = opts.group || svg;
    host.appendChild(defs);
    host.appendChild(g);
    if (!opts.group) svg.setAttribute("viewBox", "0 0 100 100");

    let geo = { cx: 50, cy: 50, s: 100 };
    let glowPx = 0;
    function draw(lit, now = 0) {
      const { cx, cy, s } = geo;
      const r = s / 2;
      const spin = (1 - lit) * -28;
      const k = 0.78 + 0.22 * lit;
      big.setAttribute("transform", `translate(${cx} ${cy}) rotate(${spin.toFixed(2)}) scale(${(r * 0.78 * k).toFixed(3)})`);
      big.setAttribute("opacity", (0.42 + 0.58 * lit).toFixed(3));
      const tw1 = 0.85 + 0.15 * Math.sin(now / 420);
      const tw2 = 0.85 + 0.15 * Math.sin(now / 560 + 2);
      small1.setAttribute("transform", `translate(${cx + r * 0.66} ${cy - r * 0.62}) scale(${(r * 0.2 * tw1).toFixed(3)})`);
      small2.setAttribute("transform", `translate(${cx - r * 0.66} ${cy + r * 0.56}) scale(${(r * 0.15 * tw2).toFixed(3)})`);
      small1.setAttribute("opacity", span(lit, 0.45, 0.9, linear).toFixed(3));
      small2.setAttribute("opacity", span(lit, 0.6, 1, linear).toFixed(3));
      const gp = Math.round(lit * r * 0.22);
      if (gp !== glowPx && opts.glow !== false) {
        glowPx = gp;
        g.style.filter = gp ? `drop-shadow(0 0 ${gp}px rgba(255, 205, 80, ${(0.75 * lit).toFixed(2)}))` : "";
      }
    }
    draw(0);
    return {
      set: draw,
      layout(cx, cy, s) {
        geo = { cx, cy, s };
      },
    };
  }

  // ---- The character grid sky ----------------------------------------------------------------------

  const canvas = document.getElementById("sky");
  const ctx = canvas.getContext("2d", { alpha: false });
  const CHARS = " ··:•+*✧✦";
  let dpr = 1;
  let W = innerWidth;
  let H = innerHeight;
  let cols = 0;
  let rows = 0;
  let cellW = 10;
  let cellH = 18;
  const fontPx = 12;

  function sizeSky() {
    dpr = Math.min(2, devicePixelRatio || 1);
    W = innerWidth;
    H = innerHeight;
    canvas.width = Math.round(W * dpr);
    canvas.height = Math.round(H * dpr);
    canvas.style.width = W + "px";
    canvas.style.height = H + "px";
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.font = `${fontPx}px ${MONO}`;
    ctx.textBaseline = "top";
    cellW = Math.max(8, ctx.measureText("M").width * 1.25);
    cellH = fontPx * 1.45;
    cols = Math.ceil(W / cellW);
    rows = Math.ceil(H / cellH);
  }

  // Value noise on a small lattice: cheap enough for every cell every frame.
  const LAT = 64;
  const lattice = new Float32Array(LAT * LAT);
  for (let i = 0; i < lattice.length; i++) lattice[i] = Math.random();
  function noise(x, y) {
    const xi = Math.floor(x);
    const yi = Math.floor(y);
    const xf = x - xi;
    const yf = y - yi;
    const u = xf * xf * (3 - 2 * xf);
    const v = yf * yf * (3 - 2 * yf);
    const at = (ix, iy) => lattice[(((iy % LAT) + LAT) % LAT) * LAT + (((ix % LAT) + LAT) % LAT)];
    const a = at(xi, yi);
    const b = at(xi + 1, yi);
    const c = at(xi, yi + 1);
    const d = at(xi + 1, yi + 1);
    return lerp(lerp(a, b, u), lerp(c, d, u), v);
  }
  function clouds(x, y, t) {
    return 0.6 * noise(x * 0.07 + t * 0.03, y * 0.14 + t * 0.01) + 0.3 * noise(x * 0.2 - t * 0.02, y * 0.4) + 0.1 * noise(x * 0.5, y * 0.9 + t * 0.05);
  }

  // ---- The cursor parts the dust -------------------------------------------------------------------

  const wake = [];
  addEventListener("pointermove", (e) => {
    if (e.pointerType !== "mouse" && e.pointerType !== "pen") return;
    wake.push({ x: e.clientX, y: e.clientY, t: performance.now() });
    if (wake.length > 28) wake.shift();
  });

  function clearing(px, py, now) {
    let k = 0;
    for (const w of wake) {
      const age = (now - w.t) / 1400;
      if (age > 1) continue;
      const dx = (px - w.x) / 70;
      const dy = (py - w.y) / 70;
      const d2 = dx * dx + dy * dy;
      if (d2 > 4) continue;
      k += Math.exp(-d2 * 1.6) * (1 - age);
    }
    return Math.min(1, k);
  }

  // ---- The sparkle and wordmark --------------------------------------------------------------------

  const heroArt = document.getElementById("hero-art");
  const heroSpark = mountSparkle(heroArt, { group: document.getElementById("hero-spark") });
  const heroWord = document.getElementById("hero-word");

  function layoutHero() {
    heroArt.setAttribute("viewBox", `0 0 ${W} ${H}`);
    const fs = Math.min(W * 0.3, H * 0.4, 440);
    heroWord.setAttribute("x", W / 2);
    heroWord.setAttribute("y", H * 0.5 + fs * 0.36);
    heroWord.setAttribute("font-size", fs);
    const s = fs * 0.7;
    heroSpark.layout(W / 2, H * 0.5 - fs * 0.66, s);
    root.style.setProperty("--tag-top", `${Math.round(H * 0.5 + fs * 0.36 + fs * 0.16)}px`);
  }

  // ---- Page state driven by the scroll -------------------------------------------------------------

  const pathEl = document.getElementById("path");
  const statusEl = document.getElementById("status");
  const themeMeta = document.querySelector('meta[name="theme-color"]');
  const mirrors = [...document.querySelectorAll('[data-spark="mirror"]')].map((svg) => mountSparkle(svg, { glow: false }));
  const pathSections = [...document.querySelectorAll("[data-path]")];
  const stage = document.getElementById("top");
  let lastVars = "";
  let lastCue = "";
  let lit = 0;
  let scoreShown = null;

  function updateStatus() {
    let text;
    if (scoreShown !== null) text = `score ${scoreShown}/100`;
    else if (lit < 0.03) text = "dim";
    else if (lit < 0.97) text = `lighting ${Math.round(lit * 100)}%`;
    else text = "lit · select a frame";
    if (statusEl.textContent !== text) statusEl.textContent = text;
  }

  function currentPath(p) {
    let label = p < 0.3 ? "~/dark" : p < 0.75 ? "~/ember" : "~/lit";
    for (const s of pathSections) if (s.getBoundingClientRect().top < H * 0.45) label = s.dataset.path;
    return label;
  }

  // ---- The pinned panel section --------------------------------------------------------------------
  // The captions scroll sideways with the page and slow down around each one as it reaches the
  // centre. The panel plays step i while caption i is the nearest: t runs 0..1 from halfway after
  // the previous caption to halfway before the next, 0.5 when centred.

  const pillStage = document.getElementById("panel");
  const track = document.getElementById("pill-track");
  const steps = [...track.children];
  const dots = [...document.querySelectorAll("#pill-dots button")];
  const STEPS = steps.length;
  const DWELL = 0.7;
  let pitch = 0;
  let stepW = 0;
  let lastPos = NaN;
  let activeDot = -1;

  function pillProgress(q) {
    const u = q * (STEPS - 1);
    const pos = u - (DWELL * Math.sin(2 * Math.PI * u)) / (2 * Math.PI);
    const i = Math.min(STEPS - 1, Math.round(u));
    return { i, t: clamp01(u - i + 0.5), pos };
  }

  function measureTrack() {
    stepW = steps[0].getBoundingClientRect().width;
    pitch = stepW + parseFloat(getComputedStyle(track).gap || "56");
  }

  const panelEl = document.getElementById("uki-panel");
  const pinEl = pillStage.querySelector(".pill-pin");
  let lastTrackTop = -1;

  function updatePill(pp) {
    panel.update(pp.i, pp.t);
    // Keep the captions just under the panel, whose height changes with the step.
    const top = Math.round(panelEl.getBoundingClientRect().bottom - pinEl.getBoundingClientRect().top + 22);
    if (top !== lastTrackTop) {
      lastTrackTop = top;
      pinEl.style.setProperty("--track-top", `${top}px`);
    }
    if (pp.pos === lastPos) return;
    lastPos = pp.pos;
    track.style.transform = `translate3d(${(W / 2 - stepW / 2 - pp.pos * pitch).toFixed(2)}px, 0, 0)`;
    steps.forEach((el, k) => (el.style.opacity = (1 - 0.82 * Math.min(1, Math.abs(k - pp.pos))).toFixed(3)));
    const active = Math.round(pp.pos);
    if (active === activeDot) return;
    activeDot = active;
    dots.forEach((d, k) => (k === active ? d.setAttribute("aria-current", "step") : d.removeAttribute("aria-current")));
  }

  function stepTop(k) {
    const r = pillStage.getBoundingClientRect();
    return r.top + window.scrollY + ((r.height - H) * k) / (STEPS - 1);
  }

  dots.forEach((d, k) => d.addEventListener("click", () => window.scrollTo({ top: stepTop(k), behavior: motionQuery.matches ? "auto" : "smooth" })));

  // ---- The panel itself ----------------------------------------------------------------------------

  const panel = (() => {
    const el = panelEl;
    const targets = [...el.querySelectorAll("[data-target]")];
    const runLabel = document.getElementById("pn-run-label");
    const scoreEl = document.getElementById("pn-score");
    const gradeEl = document.getElementById("pn-grade");
    const headline = document.getElementById("pn-headline");
    const sub = document.getElementById("pn-sub");
    const count = document.getElementById("pn-count");
    const cats = [...document.querySelectorAll("#pn-cats li")];
    const issue0 = el.querySelector("#pn-issues li");
    const aiBody = document.getElementById("pn-ai-body");
    const FINAL = { score: 72, after: 78 };
    const CAT_AFTER = [75, 84, 70, 92, 77, 58];
    let last = "";

    const colorFor = (s) => (s >= 80 ? "#35d58c" : s >= 60 ? "#f0c75e" : "#ff4d6a");

    function target(name, tag) {
      for (const t of targets) {
        const on = t.dataset.target === name;
        t.classList.toggle("is-target", on);
        if (on) t.dataset.tag = tag || "";
      }
    }

    function setScore(n, cat) {
      scoreEl.textContent = n === null ? "✦" : n;
      scoreEl.classList.toggle("idle", n === null);
      gradeEl.textContent = n === null ? "score" : `grade ${n >= 90 ? "A" : n >= 80 ? "B" : n >= 70 ? "C" : "D"}`;
      el.style.setProperty("--pn-ring", n === null ? 100 : 100 - n);
      el.style.setProperty("--pn-ring-color", colorFor(n || 0));
      cats.forEach((li, k) => {
        const v = cat ? cat[k] : null;
        const bar = li.querySelector("i");
        bar.style.width = v === null ? "0%" : v + "%";
        bar.style.background = colorFor(v || 0);
        li.querySelector("b").textContent = v === null ? "" : v;
      });
    }

    function update(i, t) {
      const key = `${i}:${t.toFixed(3)}`;
      if (key === last) return;
      last = key;

      // The first caption starts centred (t = 0.5) and the last one ends centred, so the first and
      // last steps do their work before and after 0.5 respectively.
      const done = (k) => (i > k ? 1 : i < k ? 0 : t);
      const sel = done(0) > 0.62;
      const press = i === 1 ? t > 0.25 && t < 0.55 : false;
      const progress = done(1) > 0.25 ? span(done(1), 0.25, 0.8, linear) : 0;
      const scoreT = span(done(2), 0.05, 0.6, softOut);
      const fixT = done(4);
      const fixed = fixT > 0.5;
      const aiT = done(5);

      el.classList.toggle("selected", sel);
      el.classList.toggle("pressed", press);
      el.classList.toggle("running", i === 1 && t > 0.25 && t < 0.85);
      el.classList.toggle("scored", done(2) > 0.05);
      el.classList.toggle("fixing", i === 4 && t > 0.3 && t < 0.55);
      el.classList.toggle("ai", aiT > 0.08);
      el.style.setProperty("--pn-progress", `${Math.round(progress * 100)}%`);
      runLabel.textContent = i === 1 && t > 0.25 && t < 0.85 ? "Auditing…" : done(2) > 0 ? "Audit again" : "Audit";
      issue0.classList.toggle("gone", fixed);
      aiBody.style.setProperty("--reveal", span(aiT, 0.1, 0.48, linear).toFixed(3));

      if (done(2) > 0.05) {
        const base = Math.round(FINAL.score * scoreT);
        const bump = fixed ? Math.round((FINAL.after - FINAL.score) * span(fixT, 0.5, 0.9, softOut)) : 0;
        const cat = cats.map((_, k) => {
          const v = Number(cats[k].querySelector("i").dataset.score);
          const after = CAT_AFTER[k];
          return Math.round(v * scoreT + (fixed ? (after - v) * span(fixT, 0.5, 0.9, softOut) : 0));
        });
        setScore(base + bump, cat);
        scoreShown = base + bump;
        headline.textContent = base + bump >= 78 ? "Nearly there." : "Solid, with rough edges.";
        sub.textContent = `Checkout / Payment · 184 layers · accessibility ${fixed ? 74 : 64}/100`;
        count.textContent = fixed ? 18 : 19;
      } else {
        setScore(null, null);
        scoreShown = null;
        headline.textContent = "Audit any frame in one click.";
        sub.textContent = "Six scores, one number, every issue on its layer.";
        count.textContent = 0;
      }

      if (i === 0) target("sel", sel ? "selected in Figma" : "select a frame");
      else if (i === 1) target("run", t < 0.85 ? "one click" : "");
      else if (i === 2) target("score", "weighted out of 100");
      else if (i === 3) target("issue", "click: Figma zooms to the layer");
      else if (i === 4) target(fixed ? "score" : "fix", fixed ? "+6 after the fix" : "fix contrast");
      else target("ai", aiT > 0.45 ? "" : "your own key");
    }

    return { update };
  })();

  // ---- Page vars -----------------------------------------------------------------------------------

  function updatePage(p, pal, label, now) {
    const vars = [css(pal.top), css(pal.bottom), css(pal.ink), css(pal.accent), cssA(pal.glow)];
    const key = vars.join("|");
    if (key !== lastVars) {
      lastVars = key;
      ["--sky-top", "--sky-bottom", "--ink", "--accent", "--glow"].forEach((name, i) => root.style.setProperty(name, vars[i]));
      themeMeta.content = hexOf(pal.top);
    }
    const cue = (1 - span(p, 0, 0.12, linear)).toFixed(3);
    if (cue !== lastCue) {
      lastCue = cue;
      root.style.setProperty("--cue", cue);
    }
    heroSpark.set(lit, now);
    for (const m of mirrors) m.set(lit, now);
    if (pathEl.textContent !== label) pathEl.textContent = label;
    updateStatus();
  }

  // ---- Drawing -------------------------------------------------------------------------------------

  let skyK = 0;
  let lastFrame = 0;
  let paused = false;

  function drawSky(pal, now, dim) {
    const t = now / 1000;
    ctx.fillStyle = css(pal.top);
    ctx.fillRect(0, 0, W, H);
    const shadeCache = [];
    for (let y = 0; y < rows; y++) {
      const ky = y / Math.max(1, rows - 1);
      const sky = mixC(pal.top, pal.bottom, ky);
      const shades = [];
      for (let q = 0; q < 6; q++) shades.push(css(mixC(sky, pal.cloud, (q / 5) * 0.9)));
      shadeCache.push(shades);
    }
    for (let y = 0; y < rows; y++) {
      const yy = y * cellH;
      for (let x = 0; x < cols; x++) {
        let b = clouds(x, y, t);
        b = clamp01((b - 0.4) * 1.9);
        // Brighter dust near the mark, calmer at the edges, calmer still once the page is past the hero.
        const dx = (x * cellW - W / 2) / W;
        const dy = (yy - H * 0.42) / H;
        b *= (0.45 + 0.75 * Math.exp(-(dx * dx * 5 + dy * dy * 7))) * dim;
        if (wake.length) b *= 1 - clearing(x * cellW, yy, now);
        if (b < 0.08) continue;
        const q = Math.min(5, Math.floor(b * 6));
        ctx.fillStyle = shadeCache[y][q];
        ctx.fillText(CHARS[Math.min(CHARS.length - 1, Math.floor(b * (CHARS.length - 1)) + 1)], x * cellW, yy);
      }
    }
  }

  function frame(now) {
    requestAnimationFrame(frame);
    const sc = window.scrollY;
    const p = clamp01(sc / Math.max(1, stage.offsetHeight - H));
    lit = span(p, 0.15, 0.85, softOut);
    skyK += (p - skyK) * 0.18;
    const pal = mixPalette(skyK);
    updatePage(p, pal, currentPath(p), now);

    const q = clamp01((sc - pillStage.offsetTop) / Math.max(1, pillStage.offsetHeight - H));
    updatePill(pillProgress(q));

    // Past the hero the sky still breathes, at a lower rate, unless motion is reduced.
    const fps = motionQuery.matches ? 1 : sc < stage.offsetHeight ? 24 : 8;
    if (now - lastFrame < 1000 / fps) return;
    lastFrame = now;
    if (!paused) drawSky(pal, now, 1 - 0.45 * clamp01((sc - stage.offsetHeight + H) / H));
  }

  document.addEventListener("visibilitychange", () => (paused = document.hidden));

  // Shrink the panel until its tallest state, the caption under it and the step buttons all fit
  // between the bars. The stylesheet's --pill-scale is the ceiling.
  const foot = pillStage.querySelector(".pill-foot");
  const zone = pillStage.querySelector(".pill-zone");
  function fitPanel() {
    pinEl.style.removeProperty("--pill-scale");
    const ceiling = parseFloat(getComputedStyle(pinEl).getPropertyValue("--pill-scale")) || 1;
    const had = panelEl.className;
    panelEl.className = "panel selected scored";
    const tallest = panelEl.offsetHeight;
    panelEl.className = had;
    const captionH = steps[0].offsetHeight + 22;
    const room = foot.offsetTop - 12 - zone.offsetTop - captionH;
    const scale = Math.max(0.5, Math.min(ceiling, room / tallest));
    pinEl.style.setProperty("--pill-scale", scale.toFixed(3));
  }

  function relayout() {
    sizeSky();
    layoutHero();
    fitPanel();
    measureTrack();
    lastPos = NaN;
    lastTrackTop = -1;
  }
  addEventListener("resize", relayout);
  relayout();
  requestAnimationFrame(frame);

  // ---- Reveal lists as they scroll in, copy the share text, key shortcuts --------------------------

  for (const list of document.querySelectorAll(".reveal")) [...list.children].forEach((li, i) => li.style.setProperty("--i", i));
  const io = new IntersectionObserver(
    (entries) => {
      for (const e of entries) {
        if (e.isIntersecting) {
          e.target.classList.add("on");
          io.unobserve(e.target);
        }
      }
    },
    { threshold: 0.35 },
  );
  document.querySelectorAll(".reveal").forEach((el) => {
    el.classList.add("armed");
    io.observe(el);
  });

  const copyBtn = document.getElementById("copy");
  copyBtn?.addEventListener("click", async () => {
    const text = document.getElementById("prompt-text").textContent;
    try {
      await navigator.clipboard.writeText(text);
      copyBtn.textContent = "copied";
    } catch {
      const range = document.createRange();
      range.selectNodeContents(document.getElementById("prompt-text"));
      getSelection().removeAllRanges();
      getSelection().addRange(range);
      copyBtn.textContent = "selected";
    }
    setTimeout(() => (copyBtn.textContent = "copy"), 1600);
  });

  const KEYS = { h: "top", p: "panel", c: "checks", s: "scoring", f: "fixes", i: "install" };
  addEventListener("keydown", (e) => {
    if (e.metaKey || e.ctrlKey || e.altKey || e.repeat) return;
    if (e.target.closest?.("input, textarea, select, [contenteditable]")) return;
    const id = KEYS[e.key.toLowerCase()];
    if (!id) return;
    e.preventDefault();
    document.getElementById(id).scrollIntoView({ behavior: motionQuery.matches ? "auto" : "smooth" });
  });
})();
