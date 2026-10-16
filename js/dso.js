/* ================= DSO Explorer =================
   Catalogue of 2936 deep-sky objects (Messier, Caldwell, Best NGC, Herschel 400 flagged), tonight's best targets,
   a per-object screen with DSS2 photo and a finding chart. Sun/Moon/object positions are computed here with the
   helpers of js/astro.js; cloud comes from api/astro.php (mean of ECMWF IFS / GFS / ICON). The visibility class is a
   heuristic and is labelled as an estimate in the UI. */
const Dso = (() => {
  const RAD = Math.PI / 180, MOON_ARCMIN = 31;
  const clamp = (x, a, b) => Math.min(b, Math.max(a, x));
  const S = { tab: 'tonight', cat: 'all', night: null, nightKey: null, shown: 60, view: null };
  let D = null, loading = null;

  /* ---------- data ---------- */
  const catOf = (type) => (/^Γαλαξίας/.test(type) ? 'galaxy' : /νεφέλωμα|Υπόλειμμα/i.test(type) ? 'nebula' : /σμήνος/i.test(type) ? 'cluster' : 'other');
  const TYPE_EN = {
    'Γαλαξίας': 'Galaxy', 'Ανοικτό σμήνος': 'Open cluster', 'Πλανητικό νεφέλωμα': 'Planetary nebula', 'Αστρικό σμήνος': 'Globular cluster', 'Φωτεινό νεφέλωμα': 'Bright nebula',
    'Νεφέλωμα + Σμήνος': 'Nebula + cluster', 'Σκοτεινό νεφέλωμα': 'Dark nebula', 'Υπόλειμμα υπερκαινοφανούς': 'Supernova remnant', 'Γαλαξίας + Σκοτεινό νεφέλωμα': 'Galaxy + dark nebula',
    'Κβάζαρ': 'Quasar', 'Γαλαξίας + Αστρικό σμήνος': 'Galaxy + star cluster', 'Νεφέλωμα εκπομπής': 'Emission nebula', 'Διπλός αστέρας': 'Double star', 'Σχηματισμός': 'Asterism',
    'G+C+N': 'Galaxy + cluster + nebula', 'LMCCN': 'LMC cluster + nebula',
  };
  const CON_EN = {
    AND: 'Andromeda', ANT: 'Antlia', APS: 'Apus', AQR: 'Aquarius', AQL: 'Aquila', ARA: 'Ara', ARI: 'Aries', AUR: 'Auriga', BOO: 'Boötes', CAE: 'Caelum', CAM: 'Camelopardalis', CNC: 'Cancer',
    CVN: 'Canes Venatici', CMA: 'Canis Major', CMI: 'Canis Minor', CAP: 'Capricornus', CAR: 'Carina', CAS: 'Cassiopeia', CEN: 'Centaurus', CEP: 'Cepheus', CET: 'Cetus', CHA: 'Chamaeleon',
    CIR: 'Circinus', COL: 'Columba', COM: 'Coma Berenices', CRA: 'Corona Australis', CRB: 'Corona Borealis', CRV: 'Corvus', CRT: 'Crater', CRU: 'Crux', CYG: 'Cygnus', DEL: 'Delphinus',
    DOR: 'Dorado', DRA: 'Draco', EQU: 'Equuleus', ERI: 'Eridanus', FOR: 'Fornax', GEM: 'Gemini', GRU: 'Grus', HER: 'Hercules', HOR: 'Horologium', HYA: 'Hydra', HYI: 'Hydrus', IND: 'Indus',
    LAC: 'Lacerta', LEO: 'Leo', LMI: 'Leo Minor', LEP: 'Lepus', LIB: 'Libra', LUP: 'Lupus', LYN: 'Lynx', LYR: 'Lyra', MEN: 'Mensa', MIC: 'Microscopium', MON: 'Monoceros', MUS: 'Musca',
    NOR: 'Norma', OCT: 'Octans', OPH: 'Ophiuchus', ORI: 'Orion', PAV: 'Pavo', PEG: 'Pegasus', PER: 'Perseus', PHE: 'Phoenix', PIC: 'Pictor', PSC: 'Pisces', PSA: 'Piscis Austrinus',
    PUP: 'Puppis', PYX: 'Pyxis', RET: 'Reticulum', SGE: 'Sagitta', SGR: 'Sagittarius', SCO: 'Scorpius', SCL: 'Sculptor', SCT: 'Scutum', SER: 'Serpens', SEX: 'Sextans', TAU: 'Taurus',
    TEL: 'Telescopium', TRI: 'Triangulum', TRA: 'Triangulum Australe', TUC: 'Tucana', UMA: 'Ursa Major', UMI: 'Ursa Minor', VEL: 'Vela', VIR: 'Virgo', VOL: 'Volans', VUL: 'Vulpecula',
  };
  const conName = (o) => (LANG === 'el' ? o.conGr : (CON_EN[o.abbr] || o.conGr));
  const typeName = (o) => (LANG === 'el' ? o.type : (TYPE_EN[o.type] || o.type));
  const sizeOf = (v) => { if (!v || v === '-') return null; const n = parseFloat(v); if (!isFinite(n)) return null; return /s\s*$/.test(v) ? n / 60 : n; };   // arcmin ("14.0 m") or arcsec ("45 s")

  function prep(raw) {
    return raw.map((r) => {
      // M/C number sits in otherName ("M 31", "C 20"); "M1-32" and the like are other catalogues
      const mm = /^([MC])\s*(\d+)(?![\d-])/.exec(r.otherName || '');
      const label = mm && ((mm[1] === 'M' && r.messier) || (mm[1] === 'C' && r.caldwell)) ? `${mm[1]} ${mm[2]}` : null;
      const a = sizeOf(r.sizeMax), b = sizeOf(r.sizeMin) ?? a;
      const other = r.otherName && r.otherName !== '-' ? r.otherName : '';
      const o = {
        id: r.id, abbr: String(r.constellationAbbr || '').toUpperCase(), conGr: r.constellation, name: r.name, other, label, title: label ? `${label} · ${r.name}` : r.name,
        main: label || r.name, second: label ? r.name : other, mag: r.mag >= 99 ? null : r.mag, type: r.type, cat: catOf(r.type),
        raH: r.raDeg, raDeg: r.raDeg * 15, ra: r.raDeg * 15 * RAD, decDeg: r.decDeg, dec: r.decDeg * RAD,
        m: !!r.messier, c: !!r.caldwell, best: !!r.bestNGC, h4: !!r.herschel400, a, b, inCat: !!(r.messier || r.caldwell || r.bestNGC || r.herschel400),
      };
      o.hay = (o.title + ' ' + o.other + ' ' + o.conGr + ' ' + (CON_EN[o.abbr] || '') + ' ' + o.abbr).toLowerCase().replace(/\s+/g, ' ');
      return o;
    });
  }
  function loadData() {
    if (!loading) {
      loading = Promise.all(['assets/dso.json', 'assets/sky_stars.json', 'assets/sky_constellations.json'].map((u) => fetch(u).then((r) => { if (!r.ok) throw new Error(u); return r.json(); })))
        .then(([dso, stars, cons]) => { D = { dso: prep(dso), stars, cons }; D.byId = new Map(D.dso.map((o) => [o.id, o])); return D; })
        .catch((e) => { loading = null; throw e; });
    }
    return loading;
  }

  /* ---------- visibility heuristic (an estimate: dark sky, no Moon) ---------- */
  function vis(o) {
    if (o._v !== undefined) return o._v;
    if (o.mag == null) return (o._v = null);
    const sb = o.a ? o.mag + 2.5 * Math.log10((Math.PI / 4) * o.a * o.b * 3600) : o.mag;      // surface brightness, mag per arcsec²
    const eff = o.mag + 0.5 * Math.max(0, sb - 20.5);
    return (o._v = { sb, eff, cls: eff <= 5.5 ? 'eye' : eff <= 8.5 ? 'bino' : eff <= 14 ? 'scope' : 'hard' });
  }
  const fovDegOf = (o) => clamp(2.4 * (o.a || 0), 15, 240) / 60;          // photo / ring field, degrees

  /* ---------- helpers ---------- */
  const off = () => (S.night ? S.night.off : -new Date().getTimezoneOffset() * 60);
  const hm = (ms) => new Date(ms + off() * 1000).toISOString().slice(11, 16);
  const nowAlt = (o, loc) => Astro.eq2hor(o.ra, o.dec, Date.now(), loc.lat, loc.lon);
  const fmtRa = (h) => { const hh = Math.floor(h), mm = (h - hh) * 60; return `${String(hh).padStart(2, '0')}h ${mm.toFixed(1).padStart(4, '0')}m`; };
  const fmtDec = (d) => { const s = d < 0 ? '−' : '+', a = Math.abs(d), dd = Math.floor(a), mm = Math.round((a - dd) * 60); return `${s}${String(dd).padStart(2, '0')}° ${String(mm).padStart(2, '0')}′`; };
  const sepDeg = (r1, d1, r2, d2) => Math.acos(clamp(Math.sin(d1) * Math.sin(d2) + Math.cos(d1) * Math.cos(d2) * Math.cos(r1 - r2), -1, 1)) / RAD;
  const photoUrl = (o, px) => `https://alasky.cds.unistra.fr/hips-image-services/hips2fits?hips=CDS/P/DSS2/color&width=${px}&height=${px}&fov=${fovDegOf(o).toFixed(4)}&projection=TAN&coordsys=icrs&ra=${o.raDeg.toFixed(5)}&dec=${o.decDeg.toFixed(5)}&format=jpg`;
  const infoBtn = (key) => `<button type="button" class="dso-i" data-info="${key}" aria-label="info">i</button>`;

  /* ---------- the night (sun, Moon, darkness) ---------- */
  /* Linear-interpolated crossing of `lim` in a sampled series; dir > 0 = rising */
  function crossings(ts, vals, lim, dir) {
    const out = [];
    for (let i = 1; i < ts.length; i++) {
      const a = vals[i - 1] - lim, b = vals[i] - lim;
      if (dir > 0 ? a < 0 && b >= 0 : a > 0 && b <= 0) out.push(ts[i - 1] + ((ts[i] - ts[i - 1]) * (0 - a)) / (b - a));
    }
    return out;
  }
  function computeNight(base, lat, lon) {
    const ts = [], sun = [], moon = [];
    for (let i = 0; i <= 96; i++) { const t = base + i * 900e3, k = Astro.sky(t, lat, lon); ts.push(t); sun.push(k.sunAlt); moon.push(k.moonAlt); }
    const sets = crossings(ts, sun, 0, -1), rises = crossings(ts, sun, 0, 1);
    if (!sets.length || !rises.length || rises[0] < sets[0]) return null;
    const sunset = sets[0], sunrise = rises.find((r) => r > sunset);
    if (!sunrise) return null;
    const dusk = crossings(ts, sun, -18, -1).find((x) => x >= sunset), dawn = dusk != null ? crossings(ts, sun, -18, 1).find((x) => x > dusk) : null;
    const partial = dusk == null || dawn == null;                                  // never dark enough: sunset+90 min … sunrise−90 min
    const darkStart = partial ? sunset + 90 * 60e3 : dusk, darkEnd = partial ? sunrise - 90 * 60e3 : dawn;
    if (darkEnd <= darkStart) return null;
    const moonrise = crossings(ts, moon, 0, 1)[0] ?? null, moonset = crossings(ts, moon, 0, -1)[0] ?? null;
    let below = 0, n = 0;
    for (let t = darkStart; t <= darkEnd; t += 300e3) { n++; const i = clamp(Math.floor((t - base) / 900e3), 0, 95), f = (t - ts[i]) / 900e3; if (moon[i] + (moon[i + 1] - moon[i]) * f < 0) below++; }
    return { base, sunset, sunrise, darkStart, darkEnd, partial, moonrise, moonset, moonBelow: n ? below / n : 0 };
  }
  /* "tonight": from today's noon, or yesterday's noon before noon – unless that night is already over */
  function pickNight(offSec, lat, lon) {
    const now = Date.now(), ln = new Date(now + offSec * 1000);
    const noon = (add) => Date.UTC(ln.getUTCFullYear(), ln.getUTCMonth(), ln.getUTCDate() + add, 12) - offSec * 1000;
    let n = null;
    if (now < noon(0)) { n = computeNight(noon(-1), lat, lon); if (n && now > n.sunrise) n = null; }
    return n || computeNight(noon(0), lat, lon);
  }

  /* ---------- load location night + cloud ---------- */
  async function ensureNight() {
    const loc = state.current;
    if (!loc) { S.night = null; return null; }
    const key = loc.lat + ',' + loc.lon;
    if (S.night && S.nightKey === key) return S.night;
    let data = null;
    try { data = await api(`api/astro.php?lat=${loc.lat}&lon=${loc.lon}`); } catch (e) { /* no forecast: clouds are reported as unavailable */ }
    const o = data ? data.utc_offset_seconds || 0 : -new Date().getTimezoneOffset() * 60;
    const night = pickNight(o, loc.lat, loc.lon);
    // hourly mean cloud cover keyed by epoch ms
    const cloud = new Map();
    if (data && data.hourly && data.hourly.cloud_cover) data.time.forEach((ts, i) => {
      const v = data.hourly.cloud_cover[i];
      if (v != null) cloud.set(Date.UTC(+ts.slice(0, 4), +ts.slice(5, 7) - 1, +ts.slice(8, 10), +ts.slice(11, 13)) - o * 1000, v);
    });
    S.night = { off: o, night, cloud, hasCloud: cloud.size > 0, cand: null, loc };
    S.nightKey = key;
    return S.night;
  }
  const cloudAt = (t) => { const c = S.night && S.night.cloud; if (!c || !c.size) return null; const h = Math.round(t / 3600e3) * 3600e3; return c.has(h) ? c.get(h) : c.has(Math.floor(t / 3600e3) * 3600e3) ? c.get(Math.floor(t / 3600e3) * 3600e3) : null; };

  /* ---------- tonight's candidates ---------- */
  function candidates() {
    const N = S.night;
    if (!N || !N.night) return [];
    if (N.cand) return N.cand;
    const { darkStart, darkEnd } = N.night, loc = N.loc, phi = loc.lat * RAD, sp = Math.sin(phi), cp = Math.cos(phi);
    const times = [];
    for (let t = darkStart; t <= darkEnd + 1; t += 1200e3) times.push(t);
    const lst = times.map((t) => Astro.lstRad(t, loc.lon));
    const out = [];
    for (const o of D.dso) {
      if (!o.inCat || o.mag == null) continue;
      const v = vis(o);
      if (!v || v.cls === 'hard') continue;
      const sd = Math.sin(o.dec), cd = Math.cos(o.dec);
      let max = -90, tBest = darkStart, above = 0;
      for (let i = 0; i < times.length; i++) {
        const alt = Math.asin(sp * sd + cp * cd * Math.cos(lst[i] - o.ra)) / RAD;
        if (alt > max) { max = alt; tBest = times[i]; }
        if (alt > 30) above++;
      }
      if (max >= 30 && above * 20 >= 60) out.push({ o, max, tBest, hours: (above * 20) / 60, score: v.eff - (max - 30) / 20, cls: v.cls });
    }
    out.sort((a, b) => a.score - b.score);
    out.slice(0, 150).forEach((c) => {                    // Moon nearby at the best hour
      const k = Astro.sky(c.tBest, loc.lat, loc.lon), m = Astro.moonEq(c.tBest);
      c.moonNear = k.moonAlt > 0 && k.lit > 0.2 && sepDeg(c.o.ra, c.o.dec, m.ra, m.dec) < 40;
    });
    return (N.cand = out);
  }

  /* ---------- views ---------- */
  const $d = (id) => document.getElementById(id);
  const clsName = (c) => (c ? t('dso.cls.' + c) : t('dso.cls.unknown'));
  const magTxt = (o) => (o.mag == null ? '–' : o.mag.toFixed(1));
  const sizeTxt = (o) => (o.a ? (o.b && Math.abs(o.b - o.a) > 0.05 ? `${o.a.toFixed(1)}′ × ${o.b.toFixed(1)}′` : `${o.a.toFixed(1)}′`) : '–');
  const natural = (a, b) => String(a).localeCompare(String(b), 'en', { numeric: true });

  /* tonight */
  const hoursTxt = (h) => (h >= 1 ? h.toFixed(1).replace(/\.0$/, '') + ' h' : Math.round(h * 60) + ' min');
  async function renderTonight() {
    const box = $d('dsoNight');
    box.innerHTML = `<div class="loading"><div class="spinner"></div></div>`;
    const N = await ensureNight();
    if (S.tab !== 'tonight') return;
    if (!N) { box.innerHTML = `<div class="notice">${esc(t('as.empty'))}</div>`; return; }
    const n = N.night;
    if (!n) { box.innerHTML = `<div class="notice">${esc(t('dso.nonight'))}</div>`; return; }
    const cl = [];
    for (let tt = n.darkStart; tt <= n.darkEnd; tt += 1800e3) { const c = cloudAt(tt); if (c != null) cl.push(c); }
    const cloudTxt = cl.length ? t('dso.cloud', { avg: Math.round(cl.reduce((a, b) => a + b, 0) / cl.length), min: Math.round(Math.min(...cl)), max: Math.round(Math.max(...cl)) }) : t('dso.nocloud');
    const moon = `${t('dso.night.moon', { a: n.moonrise ? hm(n.moonrise) : '–', b: n.moonset ? hm(n.moonset) : '–', p: Math.round(n.moonBelow * 100) })}`;
    let c = candidates();
    if (S.cat !== 'all') c = c.filter((x) => x.o.cat === S.cat);
    const cats = ['all', 'galaxy', 'cluster', 'nebula'];
    const cards = c.slice(0, S.shown).map((x) => {
      const fov = fovDegOf(x.o);
      return `<button type="button" class="dso-card" data-id="${x.o.id}" data-tonight="1" data-best="${x.tBest}">
        <img loading="lazy" alt="" src="${photoUrl(x.o, 400)}">
        <span class="cb"><b>${esc(x.o.title)}</b>
          <small>${esc(typeName(x.o))} · ${esc(conName(x.o))}</small>
          <small class="k">${t('dso.mag')} ${magTxt(x.o)} · ${esc(t('dso.card.peak', { alt: Math.round(x.max), t: hm(x.tBest) }))}</small>
          <small>${esc(t('dso.card.above30', { h: hoursTxt(x.hours) }))}</small>
          <small class="fld">${esc(t('dso.card.field2', { f: x.o.a ? `${Math.round(x.o.a)}′${x.o.b && Math.abs(x.o.b - x.o.a) > 0.5 ? ` × ${Math.round(x.o.b)}′` : ''}` : `${Math.round(fov * 60)}′` }))}</small>
          ${x.moonNear ? `<em class="mw">☾ ${esc(t('dso.moonnear'))}</em>` : ''}</span></button>`;
    }).join('');
    box.innerHTML = `<section class="card dso-sum"><div class="dso-h"><h2>${esc(t('dso.night.title'))}</h2>${infoBtn('night')}</div>
        <dl>
          <dt>${esc(t('dso.night.sunlbl'))}</dt><dd>${hm(n.sunset)} → ${hm(n.sunrise)}</dd>
          <dt>${esc(t(n.partial ? 'dso.night.darkpartial' : 'dso.night.dark'))}</dt><dd>${hm(n.darkStart)} → ${hm(n.darkEnd)} <small>(${((n.darkEnd - n.darkStart) / 3600e3).toFixed(1)} h)</small></dd>
          <dt>${esc(t('dso.night.moonlbl'))}</dt><dd>${esc(moon)}</dd>
          <dt>${esc(t('dso.cloudlbl'))}</dt><dd>${esc(cloudTxt)}</dd>
        </dl><p class="dso-note" data-note="night" hidden>${t('dso.night.note')}</p></section>
      <div class="dso-cats" id="dsoCats">${cats.map((k) => `<button type="button" class="chip${S.cat === k ? ' on' : ''}" data-cat="${k}">${esc(t('dso.cat.' + k))}</button>`).join('')}</div>
      <div class="dso-h2"><h3>${esc(t('dso.cand.title', { n: c.length }))}</h3>${infoBtn('cand')}</div>
      <p class="dso-note" data-note="cand" hidden>${t('dso.cand.note')}</p>
      ${c.length ? `<div class="dso-cards">${cards}</div>${c.length > S.shown ? `<button type="button" class="btn ghost" id="dsoMore">${esc(t('dso.more'))}</button>` : ''}` : `<div class="notice">${esc(t('dso.cand.none'))}</div>`}`;
  }

  /* detail */
  const nightFor = () => (S.night && S.night.night) || null;
  function altSeries(o, loc, t0, t1, step) {
    const out = [];
    for (let tt = t0; tt <= t1; tt += step) out.push({ t: tt, alt: Astro.eq2hor(o.ra, o.dec, tt, loc.lat, loc.lon).alt });
    return out;
  }
  function altChart(o, loc, night) {
    const base = night ? night.base : Date.now() - 6 * 3600e3, W = 640, H = 150, pl = 34, pr = 10, pt = 8, pb = 22;
    const pts = altSeries(o, loc, base, base + 86400e3, 600e3);
    const x = (tt) => pl + ((tt - base) / 86400e3) * (W - pl - pr), y = (a) => pt + (H - pt - pb) * (1 - (clamp(a, -60, 90) + 60) / 150);
    let g = '';
    if (night) g += `<rect x="${x(night.darkStart).toFixed(1)}" y="${pt}" width="${(x(night.darkEnd) - x(night.darkStart)).toFixed(1)}" height="${H - pt - pb}" class="ng"/>`;
    for (const a of [-60, -30, 0, 30, 60, 90]) g += `<line x1="${pl}" x2="${W - pr}" y1="${y(a).toFixed(1)}" y2="${y(a).toFixed(1)}" class="${a === 0 ? 'hz' : 'gl'}"/><text x="${pl - 5}" y="${(y(a) + 3).toFixed(1)}" text-anchor="end" class="lb">${a}°</text>`;
    for (let h = 0; h <= 24; h += 3) { const tt = base + h * 3600e3; g += `<text x="${x(tt).toFixed(1)}" y="${H - 7}" text-anchor="middle" class="lb">${hm(tt).slice(0, 2)}</text>`; }
    g += `<line x1="${pl}" x2="${W - pr}" y1="${y(30).toFixed(1)}" y2="${y(30).toFixed(1)}" class="t30"/>`;
    g += `<polyline points="${pts.map((p) => `${x(p.t).toFixed(1)},${y(p.alt).toFixed(1)}`).join(' ')}" class="ln" fill="none"/>`;
    const now = Date.now();
    if (now >= base && now <= base + 86400e3) g += `<line x1="${x(now).toFixed(1)}" x2="${x(now).toFixed(1)}" y1="${pt}" y2="${H - pb}" class="now"/>`;
    return `<svg viewBox="0 0 ${W} ${H}" class="dso-alt" role="img">${g}</svg>`;
  }

  /* hourly Moon / cloud strips for the longest dark spell above 20° (only when opened from "Tonight") */
  function strips(o, loc, night) {
    const pts = altSeries(o, loc, night.darkStart, night.darkEnd, 600e3);
    let best = null, cur = null;
    pts.forEach((p) => {
      if (p.alt > 20) { if (!cur) cur = { a: p.t, b: p.t }; cur.b = p.t; if (!best || cur.b - cur.a > best.b - best.a) best = cur; } else cur = null;
    });
    if (!best) return `<section class="card"><p class="dso-note">${esc(t('dso.strip.none'))}</p></section>`;
    const chunks = [];
    for (let h = Math.floor((best.a + off() * 1000) / 3600e3) * 3600e3 - off() * 1000; h < best.b; h += 3600e3) {
      const a = Math.max(h, best.a), b = Math.min(h + 3600e3, best.b);
      if (b - a >= 60e3) chunks.push({ h, a, b });
    }
    const interval = `${hm(best.a)}–${hm(best.b)}`;
    // Moon
    const mv = chunks.map((c) => {
      const mid = (c.a + c.b) / 2, k = Astro.sky(mid, loc.lat, loc.lon), m = Astro.moonEq(mid);
      const d = sepDeg(o.ra, o.dec, m.ra, m.dec), closeness = 0.3 + 0.7 * Math.max(0, 1 - d / 90), height = k.moonAlt > 0 ? Math.sin(k.moonAlt * RAD) : 0;
      return { c, v: k.lit * closeness * height };
    });
    const worst = mv.reduce((w, x) => (x.v > w.v ? x : w), mv[0]);
    const stripHtml = (arr, cls, fmtv) => `<div class="sbs">${arr.map((x) => `<div class="sb ${cls}" style="--v:${(0.08 + 0.82 * clamp(x.v, 0, 1)).toFixed(2)}"><span class="${x.v > 0.5 ? 'dk' : ''}">${fmtv(x.v)}</span><small>${hm(x.c.h).slice(0, 2)}</small></div>`).join('')}</div>`;
    const cv = chunks.map((c) => { const cc = cloudAt(c.h); return { c, v: cc == null ? null : cc / 100 }; });
    const cloudHtml = night && S.night.hasCloud
      ? stripHtml(cv.map((x) => ({ c: x.c, v: x.v == null ? 0 : x.v })), 'cl', (v) => Math.round(v * 100))
      : `<p class="dso-note">${esc(t('dso.nocloud'))}</p>`;
    const litMid = Math.round(Astro.sky((best.a + best.b) / 2, loc.lat, loc.lon).lit * 100);
    return `<section class="card"><div class="dso-h"><h3>☾ ${esc(t('dso.strip.moon', { i: interval }))}</h3>${infoBtn('moon')}<span class="r">${esc(t('dso.strip.lit', { p: litMid }))}</span></div>
        ${stripHtml(mv, 'mo', (v) => Math.round(v * 100))}
        <p class="dso-sub">${worst.v > 0.001 ? esc(t('dso.strip.worst', { t: hm(worst.c.h), v: Math.round(worst.v * 100) })) : esc(t('dso.strip.nomoon'))}</p>
        <p class="dso-note" data-note="moon" hidden>${t('dso.strip.moon.note')}</p></section>
      <section class="card"><div class="dso-h"><h3>☁ ${esc(t('dso.strip.cloud', { i: interval }))}</h3></div>${cloudHtml}</section>`;
  }

  /* photo viewer: pinch, double tap (2.5×), +/− up to 4× */
  function photoViewer(box, o) {
    const fov = fovDegOf(o);
    box.innerHTML = `<div class="ph-view"><img alt="" decoding="async" src="${photoUrl(o, 1200)}" draggable="false">
        <span class="fchip">${esc(t('dso.card.field', { fov: fov >= 1 ? fov.toFixed(1) : fov.toFixed(2) }))}</span>
        <span class="zbtns"><button type="button" data-z="-1">−</button><button type="button" data-z="1">+</button></span></div>
      <p class="credit">${esc(t('dso.credit'))}</p>`;
    const view = box.querySelector('.ph-view'), img = view.querySelector('img');
    view.querySelector('.zbtns').addEventListener('pointerdown', (e) => e.stopPropagation());
    let sc = 1, tx = 0, ty = 0;
    const apply = () => { const lim = ((sc - 1) * view.clientWidth) / 2; tx = clamp(tx, -lim, lim); ty = clamp(ty, -lim, lim); img.style.transform = `translate(${tx}px,${ty}px) scale(${sc})`; };
    const zoom = (f) => { sc = clamp(sc * f, 1, 4); if (sc === 1) { tx = 0; ty = 0; } apply(); };
    box.querySelectorAll('[data-z]').forEach((b) => b.addEventListener('click', () => zoom(+b.dataset.z > 0 ? 1.5 : 1 / 1.5)));
    view.addEventListener('dblclick', () => { sc = sc > 1 ? 1 : 2.5; if (sc === 1) { tx = 0; ty = 0; } apply(); });
    const ptrs = new Map(); let last = 0, lastTap = 0;
    view.addEventListener('pointerdown', (e) => {
      view.setPointerCapture(e.pointerId); ptrs.set(e.pointerId, [e.clientX, e.clientY]);
      if (ptrs.size === 2) { const [a, b] = [...ptrs.values()]; last = Math.hypot(a[0] - b[0], a[1] - b[1]); }
      const now = Date.now(); if (e.pointerType === 'touch' && ptrs.size === 1) { if (now - lastTap < 300) { sc = sc > 1 ? 1 : 2.5; if (sc === 1) { tx = 0; ty = 0; } apply(); } lastTap = now; }
    });
    view.addEventListener('pointermove', (e) => {
      if (!ptrs.has(e.pointerId)) return;
      const p = ptrs.get(e.pointerId);
      if (ptrs.size === 2) { ptrs.set(e.pointerId, [e.clientX, e.clientY]); const [a, b] = [...ptrs.values()], d = Math.hypot(a[0] - b[0], a[1] - b[1]); if (last) zoom(d / last); last = d; }
      else if (sc > 1) { tx += e.clientX - p[0]; ty += e.clientY - p[1]; ptrs.set(e.pointerId, [e.clientX, e.clientY]); apply(); }
    });
    const up = (e) => { ptrs.delete(e.pointerId); last = 0; };
    view.addEventListener('pointerup', up); view.addEventListener('pointercancel', up);
  }

  /* finding chart: stereographic, north up, east left */
  function finder(box, o) {
    box.innerHTML = `<div class="fc-wrap"><canvas class="fc"></canvas></div><div class="ph-ctl"><span class="fchip static" id="fcFov"></span><span class="sp"></span><button type="button" data-z="-1">−</button><button type="button" data-z="1">+</button></div>
      <p class="credit">${esc(t('dso.map.note'))}</p>`;
    const cv = box.querySelector('canvas'), wrap = box.querySelector('.fc-wrap');
    let fov = 25;
    const draw = () => {
      const size = Math.max(240, Math.round(wrap.clientWidth || 340)), dpr = window.devicePixelRatio || 1;
      cv.width = size * dpr; cv.height = size * dpr; cv.style.width = cv.style.height = size + 'px';
      const g = cv.getContext('2d'); g.setTransform(dpr, 0, 0, dpr, 0, 0);
      g.fillStyle = '#0b1226'; g.fillRect(0, 0, size, size);
      const f = fov * RAD, k = (size / 2) / (2 * Math.tan(f / 4));
      const cD = Math.cos(o.dec), c = [cD * Math.cos(o.ra), cD * Math.sin(o.ra), Math.sin(o.dec)];
      let e = [-c[1], c[0], 0]; const el = Math.hypot(e[0], e[1]) || 1; e = [e[0] / el, e[1] / el, 0];
      const n = [c[1] * e[2] - c[2] * e[1], c[2] * e[0] - c[0] * e[2], c[0] * e[1] - c[1] * e[0]];
      const proj = (raDeg, decDeg) => {
        const a = raDeg * RAD, d = decDeg * RAD, v = [Math.cos(d) * Math.cos(a), Math.cos(d) * Math.sin(a), Math.sin(d)];
        const w = v[0] * c[0] + v[1] * c[1] + v[2] * c[2];
        if (w < -0.6) return null;
        const s = (2 * k) / (1 + w);
        return [size / 2 - (v[0] * e[0] + v[1] * e[1] + v[2] * e[2]) * s, size / 2 - (v[0] * n[0] + v[1] * n[1] + v[2] * n[2]) * s];
      };
      g.lineWidth = 1; g.strokeStyle = 'rgba(120,150,220,.45)';
      D.cons.forEach((cn) => (cn[4] || []).forEach((line) => {
        g.beginPath(); let pen = false;
        line.forEach(([ra, de]) => { const p = proj(ra, de); if (!p) { pen = false; return; } if (pen) g.lineTo(p[0], p[1]); else g.moveTo(p[0], p[1]); pen = true; });
        g.stroke();
      }));
      D.stars.forEach(([ra, de, mag, bv]) => {
        if (mag > 5) return; const p = proj(ra, de); if (!p || p[0] < -5 || p[1] < -5 || p[0] > size + 5 || p[1] > size + 5) return;
        const r = Math.max(0.8, (5.7 - mag) * 0.85), t2 = clamp((bv + 0.3) / 1.9, 0, 1);
        g.fillStyle = `rgb(${Math.round(190 + 65 * t2)},${Math.round(205 - 45 * t2)},${Math.round(255 - 135 * t2)})`;
        g.beginPath(); g.arc(p[0], p[1], r, 0, 7); g.fill();
      });
      g.fillStyle = 'rgba(150,175,235,.8)'; g.font = '11px Inter, sans-serif'; g.textAlign = 'center';
      D.cons.forEach((cn) => { const p = proj(cn[2], cn[3]); if (p && p[0] > 20 && p[0] < size - 20 && p[1] > 14 && p[1] < size - 8) g.fillText(LANG === 'el' ? cn[1] : (CON_EN[String(cn[0]).toUpperCase()] || cn[1]), p[0], p[1]); });
      // ring = the field of the photo, with the M / C number
      const ringR = 2 * k * Math.tan((fovDegOf(o) * RAD) / 4);
      g.strokeStyle = '#f59e0b'; g.lineWidth = 1.6; g.beginPath(); g.arc(size / 2, size / 2, Math.max(ringR, 5), 0, 7); g.stroke();
      g.fillStyle = '#fbbf24'; g.font = '600 12px Inter, sans-serif'; g.textAlign = 'left';
      g.fillText(o.label || o.name, size / 2 + Math.max(ringR, 5) * 0.72 + 4, size / 2 - Math.max(ringR, 5) * 0.72 - 3);
      // scale bar
      const steps = [0.5, 1, 2, 5, 10, 20], want = (size / 2 / k); let bar = steps[steps.length - 1];
      for (const s of steps) { if (2 * k * Math.tan((s * RAD) / 2) >= 44) { bar = s; break; } }
      const bw = 2 * k * Math.tan((bar * RAD) / 2);
      g.strokeStyle = '#e6ecff'; g.lineWidth = 2; g.beginPath(); g.moveTo(12, size - 14); g.lineTo(12 + bw, size - 14); g.stroke();
      g.fillStyle = '#e6ecff'; g.font = '11px Inter, sans-serif'; g.fillText(bar + '°', 12, size - 20);
      g.fillStyle = '#9fb3e6'; g.textAlign = 'right'; g.fillText('N ↑  E ←', size - 10, 16);
      box.querySelector('#fcFov').textContent = t('dso.field', { fov: Math.round(fov) });
    };
    const zoom = (f) => { fov = clamp(fov * f, 10, 90); draw(); };
    box.querySelectorAll('[data-z]').forEach((b) => b.addEventListener('click', () => zoom(+b.dataset.z > 0 ? 1 / 1.25 : 1.25)));
    const ptrs = new Map(); let last = 0;
    cv.addEventListener('pointerdown', (ev) => { cv.setPointerCapture(ev.pointerId); ptrs.set(ev.pointerId, [ev.clientX, ev.clientY]); if (ptrs.size === 2) { const [a, b] = [...ptrs.values()]; last = Math.hypot(a[0] - b[0], a[1] - b[1]); } });
    cv.addEventListener('pointermove', (ev) => { if (!ptrs.has(ev.pointerId)) return; ptrs.set(ev.pointerId, [ev.clientX, ev.clientY]); if (ptrs.size === 2) { const [a, b] = [...ptrs.values()], d = Math.hypot(a[0] - b[0], a[1] - b[1]); if (last) zoom(last / d); last = d; } });
    const up = (ev) => { ptrs.delete(ev.pointerId); last = 0; };
    cv.addEventListener('pointerup', up); cv.addEventListener('pointercancel', up);
    cv.addEventListener('wheel', (ev) => { ev.preventDefault(); zoom(ev.deltaY > 0 ? 1.15 : 1 / 1.15); }, { passive: false });
    draw();
    return draw;
  }

  async function openDetail(id, fromTonight) {
    const o = D.byId.get(id), loc = state.current;
    if (!o || !loc) return;
    if (!S.view) S.scrollY = window.scrollY;           // where to come back to
    S.view = { id, fromTonight };
    $d('dsoMain').hidden = true; $d('dsoDetail').hidden = false;
    $d('dsoDetail').scrollIntoView({ block: 'start' });
    const body = $d('dsoDetailBody');
    body.innerHTML = `<div class="loading"><div class="spinner"></div></div>`;
    const N = await ensureNight();
    if (!S.view || S.view.id !== id) return;
    const v = vis(o), p = nowAlt(o, loc), night = N && N.night;
    const wide = o.a && o.a > 15 ? t('dso.d.moonw', { n: (o.a / MOON_ARCMIN).toFixed(1) }) : '';
    const flags = [o.m && t('dso.chip.m'), o.c && t('dso.chip.c'), o.best && t('dso.chip.best'), o.h4 && t('dso.chip.h4')].filter(Boolean);
    const up = p.alt > 0;
    const stripsHtml = fromTonight && night ? strips(o, loc, night) : '';
    body.innerHTML = `<h2 class="dso-title">${esc(o.title)}</h2>
      <section class="card"><div class="seg2" id="dsoPM"><button type="button" class="on" data-pm="photo">${esc(t('dso.photo'))}</button><button type="button" data-pm="map">${esc(t('dso.map'))}</button></div><div id="dsoPMBox"></div></section>
      <section class="card dso-d">
        <h3>${esc(o.main)}</h3>
        <p class="dso-sub">${esc(conName(o))} • ${esc(typeName(o))}${o.second && o.label ? '' : ''}</p>
        ${flags.length ? `<div class="dso-flags">${flags.map((f) => `<span>${esc(f)}</span>`).join('')}</div>` : ''}
        <dl>
          <dt>${esc(t('dso.d.ra'))}</dt><dd>${fmtRa(o.raH)}</dd>
          <dt>${esc(t('dso.d.dec'))}</dt><dd>${fmtDec(o.decDeg)}</dd>
          <dt>${esc(t('dso.d.mag'))}</dt><dd>${magTxt(o)}</dd>
          <dt>${esc(t('dso.d.size'))}</dt><dd>${sizeTxt(o)}</dd>
          <dt>${esc(t('dso.d.vis'))} ${infoBtn('vis')}</dt><dd><span class="dso-vis ${v ? v.cls : ''}">${esc(clsName(v && v.cls))}</span></dd>
        </dl>
        <p class="dso-sub">${o.a ? esc(t('dso.d.covers', { a: o.a.toFixed(1), b: (o.b || o.a).toFixed(1) })) : ''} ${esc(wide)}</p>
        <p class="dso-note" data-note="vis" hidden>${t('dso.vis.note')}</p></section>
      ${stripsHtml}
      <section class="card dso-now ${up ? 'up' : 'down'}"><span class="eye">${up ? '👁' : '🚫'}</span><div><b>${esc(t(up ? 'dso.visnow' : 'dso.belownow'))}</b>
        <small>${esc(t('dso.d.now2', { alt: p.alt.toFixed(1), az: p.az.toFixed(0), dir: Astro.compass(p.az) }))}</small></div></section>
      <section class="card"><div class="dso-h"><h3>${esc(t('dso.d.altchart'))}</h3></div>${altChart(o, loc, night)}
        <p class="dso-note">${esc(night ? t('dso.d.altnote') : t('dso.d.altnote.nonight'))}</p></section>`;
    let redraw = null;
    const show = (k) => {
      body.querySelectorAll('#dsoPM button').forEach((b) => b.classList.toggle('on', b.dataset.pm === k));
      const bx = body.querySelector('#dsoPMBox');
      if (k === 'photo') photoViewer(bx, o); else redraw = finder(bx, o);
    };
    body.querySelectorAll('#dsoPM button').forEach((b) => b.addEventListener('click', () => show(b.dataset.pm)));
    show('photo');
  }
  function closeDetail() {
    S.view = null; $d('dsoDetail').hidden = true; $d('dsoMain').hidden = false;
    renderTonight().then(() => window.scrollTo(0, S.scrollY || 0));
  }

  /* ---------- shell ---------- */
  function setTab() { S.shown = 60; renderTonight(); }
  async function show() {
    $d('dsoEmpty').hidden = !!state.current;
    $d('dsoBody').hidden = !state.current;
    $d('dsoLoadErr').hidden = true;
    if (!state.current) return;
    try { await loadData(); } catch (e) { $d('dsoLoadErr').textContent = t('dso.loaderr'); $d('dsoLoadErr').hidden = false; $d('dsoBody').hidden = true; return; }
    $d('dsoMeta').textContent = locName(state.current) + ' · ' + state.current.lat.toFixed(3) + ', ' + state.current.lon.toFixed(3);
    if (S.view && !$d('dsoDetail').hidden) { S.nightKey = null; closeDetail(); }
    setTab();
  }
  function refreshLocation() { S.nightKey = null; S.night = null; if (S.view) closeDetail(); show(); }
  function render() { if (!D || state.view !== 'dso') return; $d('dsoMeta').textContent = state.current ? locName(state.current) + ' · ' + state.current.lat.toFixed(3) + ', ' + state.current.lon.toFixed(3) : ''; if (S.view) openDetail(S.view.id, S.view.fromTonight); else renderTonight(); }

  /* events */
  function init() {
    $d('dsoNight').addEventListener('click', (e) => {
      const card = e.target.closest('.dso-card'); if (card) { openDetail(+card.dataset.id, true); return; }
      const cat = e.target.closest('[data-cat]'); if (cat) { S.cat = cat.dataset.cat; S.shown = 60; renderTonight(); return; }
      if (e.target.closest('#dsoMore')) { S.shown += 60; renderTonight(); return; }
      infoToggle(e);
    });
    $d('dsoDetail').addEventListener('click', infoToggle);
    $d('dsoBack').addEventListener('click', closeDetail);
    $d('dsoLoc').addEventListener('change', () => { $d('locSelect').value = $d('dsoLoc').value; $d('locSelect').dispatchEvent(new Event('change')); $d('dsoLoc').value = $d('locSelect').value; });
  }
  function infoToggle(e) {
    const b = e.target.closest('[data-info]'); if (!b) return;
    const n = b.closest('section, div').parentElement.querySelector(`[data-note="${b.dataset.info}"]`) || document.querySelector(`#view-dso [data-note="${b.dataset.info}"]`);
    if (n) n.hidden = !n.hidden;
  }

  return { init, show, render, refreshLocation, vis, prep, computeNight, pickNight, TYPE_EN, get data() { return D; } };
})();
Dso.init();
