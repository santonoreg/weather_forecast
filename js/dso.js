/* ================= DSO Explorer =================
   Catalogue of 2936 deep-sky objects (Messier, Caldwell, Best NGC, Herschel 400 flagged), tonight's best targets,
   a per-object screen with DSS2 photo and a finding chart. Sun/Moon/object positions are computed here with the
   helpers of js/astro.js; cloud comes from api/astro.php (mean of ECMWF IFS / GFS / ICON). The visibility class is a
   heuristic and is labelled as an estimate in the UI. */
const Dso = (() => {
  const RAD = Math.PI / 180, MOON_ARCMIN = 31;
  const clamp = (x, a, b) => Math.min(b, Math.max(a, x));
  const S = { tab: 'tonight', cat: 'all', sort: 'score', rev: false, night: null, nightKey: null, shown: 60, view: null };
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
    return (o._v = { sb, eff, cls: eff <= 8.5 ? 'bino' : eff <= 14 ? 'scope' : 'hard' });
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
    // hourly deep-sky score of the Astronomy tab (cloud, darkness, Moon, transparency, seeing, light pollution)
    const deep = new Map();
    let bortle = null;
    if (data) { try { bortle = await Astro.bortleFor(loc); Astro.buildModel(data, bortle).rows.forEach((r) => deep.set(r.e, r.deep)); } catch (e) { /* no scores */ } }
    S.night = { off: o, night, cloud, hasCloud: cloud.size > 0, deep, bortle, cand: null, loc };
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

  /* photo = square as tall as the text column, so its bottom lines up with the "Now" pill */
  function fitPhotos() {
    document.querySelectorAll('#dsoNight .dl-obj').forEach((panel) => {
      const ph = panel.querySelector('.ln-photo'), main = panel.querySelector('.dl-main');
      if (!ph || !main) return;
      if (getComputedStyle(panel).flexDirection === 'column') { ph.style.width = ph.style.height = ''; return; }
      const h = Math.round(main.getBoundingClientRect().height);
      if (h > 120) { ph.style.width = ph.style.height = h + 'px'; }
    });
  }
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
    // sorting: recommended (score), highest altitude, size, apparent magnitude (brightest first); the arrow reverses it
    const last = (v, dir) => (v == null ? (dir > 0 ? Infinity : -Infinity) : v);                 // unknown values always go to the end
    c.forEach((x) => { x.now = nowAlt(x.o, N.loc).alt; });                                        // altitude right now
    const keys = { score: [(x) => x.score, 1], now: [(x) => x.now, -1], alt: [(x) => x.max, -1], size: [(x) => x.o.a, -1], mag: [(x) => x.o.mag, 1] };
    const [kf, dir0] = keys[S.sort] || keys.score, dir = S.rev ? -dir0 : dir0;
    c = [...c].sort((a, b) => { const va = kf(a), vb = kf(b); if (va == null && vb == null) return 0; if (va == null) return 1; if (vb == null) return -1; return (va - vb) * dir; });
    const cats = ['all', 'galaxy', 'cluster', 'nebula'];
    const loc = N.loc;
    const cw = Math.max(280, Math.round(($d('dsoNight').clientWidth || 700) - 34)), ch = cw < 520 ? 130 : 112;   // chart = the whole width of the card
    S.chartW = cw;
    const cards = c.slice(0, S.shown).map((x) => {
      const o = x.o, fov = fovDegOf(o), v = vis(o), p = nowAlt(o, loc), up = p.alt > 0;
      const flags = [o.m && t('dso.chip.m'), o.c && t('dso.chip.c'), o.best && t('dso.chip.best'), o.h4 && t('dso.chip.h4')].filter(Boolean);
      const size = o.a ? `${o.a.toFixed(1)}′${o.b && Math.abs(o.b - o.a) > 0.5 ? ` × ${o.b.toFixed(1)}′` : ''}` : '–';
      const wide = o.a && o.a > 15 ? ` · ${t('dso.d.moonw', { n: (o.a / MOON_ARCMIN).toFixed(1) })}` : '';
      const cov = o.a ? t('dso.d.cov', { a: o.a.toFixed(0), b: (o.b || o.a).toFixed(0) }) + (o.a > 15 ? t('dso.d.covm', { n: (o.a / MOON_ARCMIN).toFixed(1) }) : '') : '';
      return `<article class="dso-line dl" data-id="${o.id}">
        <div class="dl-top">
          <section class="dl-obj">
            <button type="button" class="ln-photo" data-photo="${o.id}" title="${esc(t('dso.photo'))} / ${esc(t('dso.map'))}">
              <img loading="lazy" alt="" src="${photoUrl(o, 600)}"><span class="fchip">${esc(t('dso.card.field', { fov: fov >= 1 ? fov.toFixed(1) : fov.toFixed(2) }))}</span></button>
            <div class="dl-main">
              <h4>${esc(o.title)}${x.moonNear ? ` <em class="mw">☾ ${esc(t('dso.moonnear'))}</em>` : ''}</h4>
              <p class="dl-sub">${esc(conName(o))} · ${esc(typeName(o))}</p>
              <div class="dso-flags"><span class="cls ${v ? v.cls : ''}">${esc(clsName(v && v.cls))}</span>${flags.map((f) => `<span>${esc(f)}</span>`).join('')}</div>
              <div class="dl-facts">
                <div class="fcol">
                  <div class="f">${ico('star')}<div><span>${esc(t('dso.d.mag'))}:</span> <b>${magTxt(o)}</b></div></div>
                  <div class="f">${ico('expand')}<div><span>${esc(t('dso.d.size'))}:</span> <b>${size}</b>${cov ? `<small>${esc(cov)}</small>` : ''}</div></div>
                </div>
                <div class="fcol">
                  <div class="f">${ico('globe')}<div><span>RA / Dec:</span> <b>${fmtRa(o.raH)} · ${fmtDec(o.decDeg)}</b></div></div>
                  <div class="f">${ico('peak')}<div><span>${esc(t('dso.d.peak'))}:</span> <b>${Math.round(x.max)}° · ${hm(x.tBest)}</b></div></div>
                  <div class="f">${ico('clock')}<div><span>${esc(t('dso.d.above30'))}:</span> <b>${hoursTxt(x.hours)}</b></div></div>
                </div>
              </div>
              <div class="dl-now ${up ? 'up' : 'dn'}">${ico('nav')}<span>${esc(t('dso.d.nowlbl'))}: <b>${up ? '●' : '○'} ${p.alt.toFixed(0)}° · ${p.az.toFixed(0)}° ${Astro.compass(p.az)}</b></span></div>
            </div>
          </section>
          ${rowWx(o, loc, n)}
        </div>
        <section class="dl-chart"><h5>${esc(t('dso.d.altchart'))}</h5>${altChart(o, loc, n, cw, ch)}</section></article>`;
    }).join('');
    box.innerHTML = `<section class="card dso-sum"><div class="dso-h"><h2>${esc(t('dso.night.title'))}</h2>${infoBtn('night')}</div>
<div class="sum-top"><div class="mw">${moonWidget(loc)}</div>
        <div class="sum-info">
          <div><span>${esc(t('dso.night.sunlbl'))}</span><b>${hm(n.sunset)} → ${hm(n.sunrise)}</b></div>
          <div><span>${esc(t(n.partial ? 'dso.night.darkpartial' : 'dso.night.dark'))}</span><b>${hm(n.darkStart)} → ${hm(n.darkEnd)} <small>(${((n.darkEnd - n.darkStart) / 3600e3).toFixed(1)} h)</small></b></div>
          <div><span>${esc(t('dso.night.moonlbl'))}</span><b>${esc(moon)}</b></div>
          <div><span>${esc(t('dso.cloudlbl'))}</span><b>${esc(cloudTxt)}</b></div>
        </div></div>${phasesHtml(loc, N.off)}<p class="dso-note" data-note="night" hidden>${t('dso.night.note')}</p></section>
      <div class="dso-bar"><div class="dso-cats" id="dsoCats">${cats.map((k) => `<button type="button" class="chip${S.cat === k ? ' on' : ''}" data-cat="${k}">${esc(t('dso.cat.' + k))}</button>`).join('')}</div>
        <div class="dso-sort"><label><span>${esc(t('dso.sort'))}</span><select id="dsoSort" title="${esc(t('dso.sort.help'))}">${['score', 'now', 'alt', 'size', 'mag'].map((k) => `<option value="${k}"${S.sort === k ? ' selected' : ''}>${esc(t('dso.sort.' + k))}</option>`).join('')}</select></label>
          <button type="button" id="dsoRev" class="chip" title="${esc(t('dso.sort.rev'))}" aria-label="${esc(t('dso.sort.rev'))}">${S.rev ? '↑' : '↓'}</button></div></div>
      <div class="dso-h2"><h3>${esc(t('dso.cand.title'))} <span class="cnt">(${c.length})</span></h3>${infoBtn('cand')}</div>
      <p class="dso-note" data-note="cand" hidden>${t('dso.cand.note')} ${t('dso.vis.note')} ${t('dso.strip.moon.note')}</p>
      ${c.length ? `<div class="dso-cards">${cards}</div>${c.length > S.shown ? `<button type="button" class="btn ghost" id="dsoMore">${esc(t('dso.more'))}</button>` : ''}` : `<div class="notice">${esc(t('dso.cand.none'))}</div>`}`;
    paintMoon();
    fitPhotos();
    document.querySelectorAll('#dsoNight .ln-photo img').forEach((im) => { if (!im.complete) im.addEventListener('load', fitPhotos, { once: true }); });
  }

  /* detail */
  const nightFor = () => (S.night && S.night.night) || null;
  function altSeries(o, loc, t0, t1, step) {
    const out = [];
    for (let tt = t0; tt <= t1; tt += step) out.push({ t: tt, alt: Astro.eq2hor(o.ra, o.dec, tt, loc.lat, loc.lon).alt });
    return out;
  }
  function altChart(o, loc, night, W = 640, H = 150) {
    const base = night ? night.base : Date.now() - 6 * 3600e3, pl = 38, pr = 8, pt = 6, pb = 20;
    const pts = altSeries(o, loc, base, base + 86400e3, 600e3);
    const x = (tt) => pl + ((tt - base) / 86400e3) * (W - pl - pr), y = (a) => pt + (H - pt - pb) * (1 - (clamp(a, -60, 90) + 60) / 150);
    const yb = y(-60);
    let g = '';
    if (night) g += `<rect x="${x(night.darkStart).toFixed(1)}" y="${pt}" width="${(x(night.darkEnd) - x(night.darkStart)).toFixed(1)}" height="${(yb - pt).toFixed(1)}" class="ng"/>`;
    for (const a of [-60, -30, 0, 30, 60, 90]) g += `<line x1="${pl}" x2="${W - pr}" y1="${y(a).toFixed(1)}" y2="${y(a).toFixed(1)}" class="${a === 0 ? 'hz' : 'gl'}"/><text x="${pl - 6}" y="${(y(a) + 3.5).toFixed(1)}" text-anchor="end" class="lb">${a}°</text>`;
    for (let h = 0; h <= 24; h += 3) { const tt = base + h * 3600e3; g += `<text x="${x(tt).toFixed(1)}" y="${H - 5}" text-anchor="middle" class="lb">${hm(tt).slice(0, 2)}</text>`; }
    g += `<line x1="${pl}" x2="${W - pr}" y1="${y(30).toFixed(1)}" y2="${y(30).toFixed(1)}" class="t30"/>`;
    const pl2 = pts.map((p) => `${x(p.t).toFixed(1)},${y(p.alt).toFixed(1)}`);
    g += `<polygon points="${x(pts[0].t).toFixed(1)},${yb.toFixed(1)} ${pl2.join(' ')} ${x(pts[pts.length - 1].t).toFixed(1)},${yb.toFixed(1)}" class="ar"/>`;
    g += `<polyline points="${pl2.join(' ')}" class="ln" fill="none"/>`;
    const now = Date.now();
    if (now >= base && now <= base + 86400e3) g += `<line x1="${x(now).toFixed(1)}" x2="${x(now).toFixed(1)}" y1="${pt}" y2="${yb.toFixed(1)}" class="now"/>`;
    return `<svg viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" class="dso-alt" role="img">${g}</svg>`;
  }

  const ICO = {'star': '<path d="M12 2l2.4 7.6L22 12l-7.6 2.4L12 22l-2.4-7.6L2 12l7.6-2.4z"/>', 'expand': '<path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5"/>', 'globe': '<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3c3 3 3 15 0 18M12 3c-3 3-3 15 0 18"/>', 'peak': '<path d="M12 20V6M6 12l6-6 6 6M5 21h14"/>', 'clock': '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>', 'nav': '<path d="M3 11l18-8-8 18-2-8z"/>'};
  const ico = (k) => `<svg viewBox="0 0 24 24" class="ico" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">${ICO[k]}</svg>`;

  /* the local calendar day split into night / astronomical / nautical / civil twilight / day, plus golden and blue hour (1-minute samples) */
  const PH_ORDER = ['night', 'astro', 'naut', 'civil', 'day'];
  function dayPhases(loc, offSec) {
    const ln = new Date(Date.now() + offSec * 1000);
    const t0 = Date.UTC(ln.getUTCFullYear(), ln.getUTCMonth(), ln.getUTCDate()) - offSec * 1000;
    const cls = (a) => (a < -18 ? 'night' : a < -12 ? 'astro' : a < -6 ? 'naut' : a < 0 ? 'civil' : 'day');
    const gb = (a) => (a <= 6 && a > -4 ? 'golden' : a <= -4 && a >= -8 ? 'blue' : null);
    const segs = [], gsegs = [];
    const push = (arr, c, m) => { const last = arr[arr.length - 1]; if (last && last.c === c && last.b === m) last.b = m + 1; else if (c) arr.push({ c, a: m, b: m + 1 }); };
    for (let m = 0; m < 1440; m++) {
      const a = Astro.sky(t0 + (m + 0.5) * 60e3, loc.lat, loc.lon).sunAlt;
      push(segs, cls(a), m); push(gsegs, gb(a), m);
    }
    const sun = [], moon = [];
    for (let m = 0; m <= 1440; m += 10) { const k = Astro.sky(t0 + m * 60e3, loc.lat, loc.lon); sun.push([m, k.sunAlt, k.sunAz]); moon.push([m, k.moonAlt, k.moonAz]); }
    const nowK = Astro.sky(Date.now(), loc.lat, loc.lon);
    return { segs, gsegs, sun, moon, now: nowK, nowMin: (Date.now() - t0) / 60e3, date: ln };
  }
  const fmDur = (m) => (m >= 60 ? t('dso.dur.hm', { h: Math.floor(m / 60), m: Math.round(m % 60) }) : t('dso.dur.m', { m: Math.round(m) }));
  const fmMin = (m) => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(Math.round(m % 60)).padStart(2, '0')}`;
  /* One chart for the local day with the Sun AND the Moon: altitude (solid, shaded above the horizon), azimuth (dashed, right axis), ↑ rise • highest ↓ set
     marks (Sun row above the Moon row) and a "now" line with each body's altitude · azimuth */
  function trajChart(d, W, H) {
    const pl = 42, pr = 34, pt = 30, pb = 26, pw = W - pl - pr, ph = H - pt - pb;
    const X = (m) => pl + (m / 1440) * pw, Y = (a) => pt + ph * (1 - (clamp(a, -90, 90) + 90) / 180), Yaz = (az) => pt + ph * (1 - az / 360);
    const hz = Y(0), bodies = [
      { kind: 'sun', pts: d.sun, col: '#f5b800', now: { alt: d.now.sunAlt, az: d.now.sunAz }, },
      { kind: 'moon', pts: d.moon, col: '#9d86f0', now: { alt: d.now.moonAlt, az: d.now.moonAz }, },
    ];
    let g = `<defs><clipPath id="tjc"><rect x="${pl}" y="${pt}" width="${pw}" height="${ph}"/></clipPath></defs>`;
    for (const a of [60, 30, 0, -30, -60]) g += `<line x1="${pl}" x2="${W - pr}" y1="${Y(a).toFixed(1)}" y2="${Y(a).toFixed(1)}" class="${a === 0 ? 'hz' : 'gl'}"/><text x="${pl - 6}" y="${(Y(a) + 3.5).toFixed(1)}" text-anchor="end" class="lb">${a > 0 ? '+' : ''}${a}°</text>`;
    const dirs = LANG === 'el' ? ['Β', 'Δ', 'Ν', 'Α', 'Β'] : ['N', 'W', 'S', 'E', 'N'];
    dirs.forEach((c, i) => { g += `<text x="${W - pr + 8}" y="${(pt + ph * (i / 4) + 3.5).toFixed(1)}" class="lb">${c}</text>`; });
    for (const h of [0, 3, 6, 9, 12, 15, 18, 21, 24]) g += `<text x="${X(h * 60).toFixed(1)}" y="${H - 7}" text-anchor="${h === 0 ? 'start' : h === 24 ? 'end' : 'middle'}" class="lb">${String(h).padStart(2, '0')}:00</text>`;
    let clipped = '', marks = '', dots = '', labels = '';
    const usedX = [];                                                           // x of the rise / set labels already drawn (the Moon's move down a line when they would collide)
    const nx = X(clamp(d.nowMin, 0, 1440));
    const ys = bodies.map((b) => Y(b.now.alt));
    const close = Math.abs(ys[0] - ys[1]) < 18;
    bodies.forEach((b, bi) => {
      let az0 = b.pts[0][2]; if (az0 > 180) az0 -= 360;                         // azimuth drawn continuously across north
      let prev = az0, off = 0;
      const azs = b.pts.map(([m, , az]) => { let v = az + off; while (v - prev > 180) { off -= 360; v -= 360; } while (v - prev < -180) { off += 360; v += 360; } prev = v; return [m, v]; });
      const altLine = b.pts.map(([m, a]) => `${X(m).toFixed(1)},${Y(a).toFixed(1)}`).join(' ');
      const area = `${X(0).toFixed(1)},${hz.toFixed(1)} ` + b.pts.map(([m, a]) => `${X(m).toFixed(1)},${Math.min(Y(a), hz).toFixed(1)}`).join(' ') + ` ${X(1440).toFixed(1)},${hz.toFixed(1)}`;
      const azLine = azs.map(([m, v]) => `${X(m).toFixed(1)},${Yaz(v).toFixed(1)}`).join(' ');
      clipped += `<polygon points="${area}" fill="${b.col}" fill-opacity=".14"/><polyline points="${azLine}" fill="none" stroke="${b.col}" stroke-opacity=".6" stroke-width="0.7" stroke-dasharray="4 3"/><polyline points="${altLine}" fill="none" stroke="${b.col}" stroke-width="1" stroke-linejoin="round"/>`;
      const cross = (dir) => { for (let i = 1; i < b.pts.length; i++) { const a = b.pts[i - 1][1], c = b.pts[i][1]; if (dir > 0 ? a < 0 && c >= 0 : a > 0 && c <= 0) return b.pts[i - 1][0] + ((b.pts[i][0] - b.pts[i - 1][0]) * (0 - a)) / (c - a); } return null; };
      const top = b.pts.reduce((m, q) => (q[1] > m[1] ? q : m), b.pts[0]);
      // rise / set: a small triangle ON the horizon line with its time; highest point: a dot on the curve with the altitude
      const tri = (m, up, label) => {
        if (m == null) return '';
        const x = X(m), clash = usedX.some((u) => Math.abs(u - x) < 40), ty = hz + 16 + (clash ? 12 : 0);
        usedX.push(x);
        return `<path d="${up ? `M${x - 4.5},${hz + 4} L${x + 4.5},${hz + 4} L${x},${hz - 5}` : `M${x - 4.5},${hz - 4} L${x + 4.5},${hz - 4} L${x},${hz + 5}`} Z" fill="${b.col}"><title>${esc(t('dso.ph.' + b.kind))} · ${esc(label)} ${fmMin(m)}</title></path>`
          + `<text x="${x.toFixed(1)}" y="${ty.toFixed(1)}" text-anchor="middle" class="mt" style="fill:${b.col}">${fmMin(m)}</text>`;
      };
      marks += tri(cross(1), true, t('dso.tj.rise')) + tri(cross(-1), false, t('dso.tj.set'));
      if (top[1] > 0) marks += `<circle cx="${X(top[0]).toFixed(1)}" cy="${Y(top[1]).toFixed(1)}" r="2.6" fill="${b.col}"><title>${esc(t('dso.ph.' + b.kind))} · ${esc(t('dso.tj.transit'))} ${fmMin(top[0])} · ${top[1].toFixed(0)}°</title></circle><text x="${X(top[0]).toFixed(1)}" y="${(Y(top[1]) - 7).toFixed(1)}" text-anchor="middle" class="mt" style="fill:${b.col}">${top[1].toFixed(0)}°</text>`;
      const ny = ys[bi];
      dots += `<circle cx="${nx.toFixed(1)}" cy="${ny.toFixed(1)}" r="4" fill="${b.col}" stroke="#fff" stroke-width="1"/>`;
      const right = nx <= W - pr - 100, lx = right ? nx + 9 : nx - 9, anc = right ? 'start' : 'end';
      const ly = close && bi === 1 ? ny + 17 : ny < pt + 20 ? ny + 16 : ny - 9;
      labels += `<text x="${lx.toFixed(1)}" y="${ly.toFixed(1)}" text-anchor="${anc}" class="nl"><tspan fill="${b.col}">●</tspan> ${b.now.alt.toFixed(0)}° · ${b.now.az.toFixed(0)}°</text>`;
    });
    g += `<g clip-path="url(#tjc)">${clipped}</g>${marks}<line x1="${nx.toFixed(1)}" x2="${nx.toFixed(1)}" y1="${pt}" y2="${pt + ph}" class="nw"/>${dots}${labels}`;
    const chip = (b) => `<i class="dotc" style="background:${b.col}"></i>${esc(t('dso.ph.' + b.kind))}`;
    return `<section class="tj-card"><div class="tj-h"><b>${esc(t('dso.tj.both'))}</b><span class="tj-key">${chip(bodies[0])}${chip(bodies[1])}<i class="al"></i>${esc(t('dso.tj.alt'))}<i class="az"></i>${esc(t('dso.tj.az'))}<span class="mkk">▲▼ ${esc(t('dso.tj.riseset'))}</span></span></div>
      <svg viewBox="0 0 ${W} ${H}" class="tj-svg" role="img" aria-label="${esc(t('dso.tj.both'))}">${g}</svg></section>`;
  }
  /* Moon widget: the real disc (LRO colour map) lit with the true phase, turned so the bright limb points where it does in the sky */
  function moonWidget(loc) {
    const v = Astro.moonView(Date.now(), loc.lat, loc.lon);
    S.mv = v;
    return `<canvas id="moonCv" class="mw-cv" width="260" height="260" aria-label="${esc(t('dso.mw.lit'))}"></canvas>
      <div class="mw-st"><span>${esc(t('dso.mw.lit'))} <b>${(v.lit * 100).toFixed(1)}%</b></span><span>${esc(t('dso.mw.age'))} <b>${v.age.toFixed(1)} ${esc(t('dso.mw.d'))}</b></span></div>
      <div class="mw-bar"><i style="width:${(v.lit * 100).toFixed(1)}%"></i></div>`;
  }
  function paintMoon() {
    const cv = $d('moonCv'), v = S.mv;
    if (!cv || !v) return;
    const draw = (img) => {
      const W = 260, tc = document.createElement('canvas'); tc.width = img.width; tc.height = img.height;
      const tx = tc.getContext('2d', { willReadFrequently: true }); tx.drawImage(img, 0, 0);
      const T = tx.getImageData(0, 0, img.width, img.height).data;
      const ctx = cv.getContext('2d'), out = ctx.createImageData(W, W), cosI = 2 * v.lit - 1, sinI = Math.sqrt(Math.max(0, 1 - cosI * cosI));
      const sx = -Math.sin(v.chi) * sinI, sy = Math.cos(v.chi) * sinI, sz = cosI;       // direction of the Sun in the disc frame (x right, y up, z towards us)
      for (let j = 0; j < W; j++) for (let i = 0; i < W; i++) {
        const x = (i + 0.5) / W * 2 - 1, y = 1 - (j + 0.5) / W * 2, r2 = x * x + y * y, o = (j * W + i) * 4;
        if (r2 > 1.02) continue;
        const z = Math.sqrt(Math.max(0, 1 - r2)), lon = Math.atan2(x, z), lat = Math.asin(Math.max(-1, Math.min(1, y)));
        const u = Math.min(img.width - 1, Math.max(0, Math.floor((lon / Math.PI + 1) / 2 * img.width))), w = Math.min(img.height - 1, Math.max(0, Math.floor((0.5 - lat / Math.PI) * img.height))), k = (w * img.width + u) * 4;
        const dI = x * sx + y * sy + z * sz, f = Math.min(1, Math.max(0, (dI + 0.04) / 0.16)), b = 0.035 + 0.965 * f;   // soft terminator + faint earthshine
        const edge = Math.min(1, (1.02 - r2) / 0.03);
        out.data[o] = T[k] * b * 1.12; out.data[o + 1] = T[k + 1] * b * 1.12; out.data[o + 2] = T[k + 2] * b * 1.12; out.data[o + 3] = 255 * edge;
      }
      ctx.putImageData(out, 0, 0);
      cv.style.transform = `rotate(${(v.q * 180 / Math.PI).toFixed(1)}deg)`;
    };
    if (S.moonImg) { draw(S.moonImg); return; }
    const im = new Image(); im.onload = () => { S.moonImg = im; draw(im); }; im.src = 'assets/moon.jpg';
  }
  function phasesHtml(loc, offSec) {
    const d = dayPhases(loc, offSec);
    const dateTxt = d.date.toLocaleDateString(dateLocale(), { day: 'numeric', month: 'short', timeZone: 'UTC' });
    const w = (g) => ((g.b - g.a) / 1440) * 100;
    const bar = d.segs.map((g, i) => `<i class="ph-${g.c}${i ? ' sep' : ''}" style="width:${w(g).toFixed(3)}%" title="${esc(t('dso.ph.' + g.c))} ${fmMin(g.a)}–${fmMin(g.b)}">${w(g) > 9 ? `<span>${fmMin(g.a)}–${fmMin(g.b)}</span>` : ''}</i>`).join('');
    const gbar = d.gsegs.map((g) => `<i class="ph-${g.c}" style="left:${((g.a / 1440) * 100).toFixed(3)}%;width:${w(g).toFixed(3)}%" title="${esc(t('dso.ph.' + g.c))} ${fmMin(g.a)}–${fmMin(g.b)}"></i>`).join('');
    const bodyPos = (alt, az) => `${alt.toFixed(0)}° · ${az.toFixed(0)}° ${Astro.compass(az)}`;     // altitude · azimuth direction
    const axis = [0, 3, 6, 9, 12, 15, 18, 21, 24].map((h) => `<b style="left:${((h / 24) * 100).toFixed(2)}%">${String(h).padStart(2, '0')}:00</b>`).join('');
    const leg = (c, arr) => {                                    // a tall colour bar, then the phase name, each interval on its own line, and the total
      const parts = arr.filter((g) => g.c === c), total = parts.reduce((a, g) => a + (g.b - g.a), 0);
      return `<li title="${esc(t('dso.ph.total'))}"><i class="lgbar ph-${c}"></i><div><b>${esc(t('dso.ph.' + c))}</b>${parts.length ? parts.map((g) => `<span class="rg">${fmMin(g.a)}–${fmMin(g.b)}</span>`).join('') : '<span class="rg">–</span>'}<span class="tot">${total ? fmDur(total) : '–'}</span></div></li>`;
    };
    return `<div class="dp"><section class="tj-card ph-card"><div class="dp-h"><span class="dp-date">${esc(dateTxt)}</span><small>${esc(t('dso.ph.title'))}</small></div>
      <div class="dp-bar">${bar}<u class="now" style="left:${clamp((d.nowMin / 1440) * 100, 0, 100).toFixed(2)}%"></u></div>
      <div class="dp-gb">${gbar}<u class="now" style="left:${clamp((d.nowMin / 1440) * 100, 0, 100).toFixed(2)}%"></u></div>
      <div class="dp-axis">${axis}</div></section>
      <div class="tj-grid one">${trajChart(d, Math.max(300, (S.chartW || 1000) - 30), (S.chartW || 1000) < 520 ? 240 : 270)}</div>
      <ul class="dp-leg">${PH_ORDER.map((c) => leg(c, d.segs)).join('')}${leg('golden', d.gsegs)}${leg('blue', d.gsegs)}</ul></div>`;
  }

  /* colour ramps for the hour boxes */
  const ramp = (v, stops) => {
    if (v <= stops[0][0]) return stops[0][1];
    for (let i = 1; i < stops.length; i++) {
      if (v <= stops[i][0]) { const [a, ca] = stops[i - 1], [b, cb] = stops[i], f = (v - a) / (b - a); return ca.map((c, k) => Math.round(c + (cb[k] - c) * f)); }
    }
    return stops[stops.length - 1][1];
  };
  const CLOUD_RAMP = [[0, [0, 0, 0]], [100, [255, 255, 255]]];                    // 0% cloud = black, 100% = white
  const DEEP_RAMP = [[0, [190, 38, 52]], [6, [224, 90, 56]], [11, [246, 196, 69]], [16, [238, 228, 176]], [24, [160, 208, 150]], [40, [56, 168, 96]], [100, [26, 120, 72]]];
  const MOON_RAMP = [[0, [40, 48, 74]], [1, [245, 231, 176]]];
  const cell = (rgb, txt) => `<i class="cell" style="background:rgb(${rgb});color:${0.299 * rgb[0] + 0.587 * rgb[1] + 0.114 * rgb[2] > 150 ? '#1b2333' : '#fff'}">${txt}</i>`;

  function rowWx(o, loc, night) {
    const pts = altSeries(o, loc, night.darkStart, night.darkEnd, 600e3);
    let best = null, cur = null;
    pts.forEach((p) => {
      if (p.alt > 20) { if (!cur) cur = { a: p.t, b: p.t }; cur.b = p.t; if (!best || cur.b - cur.a > best.b - best.a) best = cur; } else cur = null;
    });
    if (!best) return `<section class="dl-wx"><p class="dso-note">${esc(t('dso.strip.none'))}</p></section>`;
    const chunks = [];
    for (let h = Math.floor((best.a + off() * 1000) / 3600e3) * 3600e3 - off() * 1000; h < best.b; h += 3600e3) {
      const a = Math.max(h, best.a), b = Math.min(h + 3600e3, best.b);
      if (b - a >= 60e3) chunks.push({ h, a, b });
    }
    const interval = `${hm(best.a)} - ${hm(best.b)}`;
    const mv = chunks.map((c) => {
      const mid = (c.a + c.b) / 2, k = Astro.sky(mid, loc.lat, loc.lon), m = Astro.moonEq(mid);
      const d = sepDeg(o.ra, o.dec, m.ra, m.dec), closeness = 0.3 + 0.7 * Math.max(0, 1 - d / 90), height = k.moonAlt > 0 ? Math.sin(k.moonAlt * RAD) : 0;
      return { c, v: k.lit * closeness * height };
    });
    const worst = mv.reduce((w, x) => (x.v > w.v ? x : w), mv[0]);
    const litMid = Math.round(Astro.sky((best.a + best.b) / 2, loc.lat, loc.lon).lit * 100);
    const row = (arr) => `<div class="dl-cells" style="--n:${chunks.length}">${arr.join('')}</div>`;
    const moonCells = mv.map((x) => cell(ramp(clamp(x.v / 0.8, 0, 1), MOON_RAMP), Math.round(x.v * 100)));
    const cloudCells = chunks.map((c) => { const cc = cloudAt(c.h); return cc == null ? cell([60, 66, 90], '–') : cell(ramp(cc, CLOUD_RAMP), Math.round(cc)); });
    const deepCells = chunks.map((c) => { const d = S.night.deep.get(c.h); return d == null ? cell([60, 66, 90], '–') : cell(ramp(d, DEEP_RAMP), Math.round(d)); });
    const go = (view, label) => `<a class="dl-go" href="#${view}" data-goto="${view}">${esc(label)} <i>›</i></a>`;
    return `<section class="dl-wx">
      <div class="dl-wh"><h5>${esc(t('dso.wx.title'))} <small>(${interval})</small></h5>
        <span class="pill moon" style="--p:${litMid}%">${esc(t('dso.wx.moon', { p: litMid }))}</span>${S.night.bortle ? `<span class="pill bort">Bortle ${S.night.bortle}</span>` : ''}</div>
      <div class="dl-cells hrs" style="--n:${chunks.length}">${chunks.map((c) => `<span>${hm(c.h).slice(0, 2)}</span>`).join('')}</div>
      <div class="dl-rt"><b>${esc(t('dso.night.moonlbl'))}</b><small>${worst.v > 0.001 ? esc(t('dso.strip.worst', { t: hm(worst.c.h), v: Math.round(worst.v * 100) })) : esc(t('dso.strip.nomoon'))}</small></div>
      ${row(moonCells)}
      <div class="dl-rt"><b>${esc(t('dso.cloudlbl'))}</b>${go('forecast', t('nav.forecast'))}</div>
      ${S.night.hasCloud ? row(cloudCells) : `<p class="dso-note">${esc(t('dso.nocloud'))}</p>`}
      <div class="dl-rt"><b>${esc(t('dso.wx.deep'))}</b>${go('astro', t('nav.astro'))}</div>
      ${S.night.deep.size ? row(deepCells) : `<p class="dso-note">${esc(t('dso.nocloud'))}</p>`}
    </section>`;
  }

  /* photo viewer: pinch, double tap (2.5×), +/− up to 4× */
  function photoViewer(box, o) {
    const fov = fovDegOf(o);
    box.innerHTML = `<div class="ph-view"><img alt="" decoding="async" src="${photoUrl(o, 1200)}" draggable="false"></div>
      <div class="ph-ctl"><span class="fchip static">${esc(t('dso.card.field', { fov: fov >= 1 ? fov.toFixed(1) : fov.toFixed(2) }))}</span><span class="sp"></span><button type="button" data-z="-1">−</button><button type="button" data-z="1">+</button></div>
      <p class="credit">${esc(t('dso.credit'))}</p>`;
    const view = box.querySelector('.ph-view'), img = view.querySelector('img');
    let sc = 1, tx = 0, ty = 0;
    const apply = () => { const lim = ((sc - 1) * view.clientWidth) / 2; tx = clamp(tx, -lim, lim); ty = clamp(ty, -lim, lim); img.style.transform = `translate(${tx}px,${ty}px) scale(${sc})`; };
    // zoom by factor f; (cx, cy) = the point to keep under the cursor, relative to the centre of the photo
    const zoom = (f, cx = 0, cy = 0) => {
      const ns = clamp(sc * f, 1, 4), k = ns / sc;
      tx = cx - (cx - tx) * k; ty = cy - (cy - ty) * k; sc = ns;
      if (sc === 1) { tx = 0; ty = 0; } apply();
    };
    box.querySelectorAll('[data-z]').forEach((b) => b.addEventListener('click', () => zoom(+b.dataset.z > 0 ? 1.5 : 1 / 1.5)));
    view.addEventListener('wheel', (e) => {                                  // the mouse wheel zooms the photo, as it does on the finding chart (the page does not scroll)
      e.preventDefault();
      const r = view.getBoundingClientRect();
      zoom(e.deltaY > 0 ? 1 / 1.2 : 1.2, e.clientX - r.left - r.width / 2, e.clientY - r.top - r.height / 2);
    }, { passive: false });
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

  /* click a photo: big photo / finding chart in a dialog */
  function openPhoto(id) {
    const o = D.byId.get(id); if (!o) return;
    $d('dsoModalTitle').textContent = o.title;
    const bx = $d('dsoPMBox'), tabs = $d('dsoPM');
    const show = (k) => { tabs.querySelectorAll('button').forEach((b) => b.classList.toggle('on', b.dataset.pm === k)); if (k === 'photo') photoViewer(bx, o); else finder(bx, o); };
    tabs.onclick = (e) => { const b = e.target.closest('[data-pm]'); if (b) show(b.dataset.pm); };
    $d('dsoModal').hidden = false;
    show('photo');
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
    setTab();
  }
  function refreshLocation() { S.nightKey = null; S.night = null; show(); }
  function render() { if (!D || state.view !== 'dso') return; $d('dsoMeta').textContent = state.current ? locName(state.current) + ' · ' + state.current.lat.toFixed(3) + ', ' + state.current.lon.toFixed(3) : ''; renderTonight(); }

  /* events */
  function init() {
    $d('dsoNight').addEventListener('click', (e) => {
      const ph = e.target.closest('[data-photo]'); if (ph) { openPhoto(+ph.dataset.photo); return; }
      const cat = e.target.closest('[data-cat]'); if (cat) { S.cat = cat.dataset.cat; S.shown = 60; renderTonight(); return; }
      if (e.target.closest('#dsoMore')) { S.shown += 60; renderTonight(); return; }
      if (e.target.closest('#dsoRev')) { S.rev = !S.rev; S.shown = 60; renderTonight(); return; }
      infoToggle(e);
    });
    $d('dsoNight').addEventListener('change', (e) => { if (e.target.id === 'dsoSort') { S.sort = e.target.value; S.rev = false; S.shown = 60; renderTonight(); } });
    let rz = null;
    window.addEventListener('resize', () => { clearTimeout(rz); rz = setTimeout(() => { if (state.view === 'dso' && S.chartW && Math.abs(($d('dsoNight').clientWidth - 34) - S.chartW) > 60) renderTonight(); }, 300); });
    $d('dsoLoc').addEventListener('change', () => { $d('locSelect').value = $d('dsoLoc').value; $d('locSelect').dispatchEvent(new Event('change')); $d('dsoLoc').value = $d('locSelect').value; });
  }
  function infoToggle(e) {
    const b = e.target.closest('[data-info]'); if (!b) return;
    const n = document.querySelector(`#view-dso [data-note="${b.dataset.info}"]`);
    if (n) n.hidden = !n.hidden;
  }

  return { init, show, render, refreshLocation, vis, prep, computeNight, pickNight, TYPE_EN, get data() { return D; } };
})();
Dso.init();
