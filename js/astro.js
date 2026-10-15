/* ================= Astronomy tab =================
   Sun/Moon positions are computed here (low-precision formulas, good to a fraction of a degree – plenty for
   twilight/moonrise times and an hourly table). The atmosphere comes from api/astro.php (multi-model mean).
   Seeing and transparency are NOT measured by any free source: they are estimates derived from the jet stream,
   wind shear, convection, aerosols, humidity and thin high cloud, and the tab says so. */
const Astro = (() => {
  const RAD = Math.PI / 180, DAY = 864e5, J1970 = 2440588, J2000 = 2451545, OBL = RAD * 23.4397;
  const toDays = (ms) => ms / DAY - 0.5 + J1970 - J2000;
  const clamp = (x, a, b) => Math.min(b, Math.max(a, x));

  /* ---- positions (same low-precision series as SunCalc) ---- */
  const ra = (l, b) => Math.atan2(Math.sin(l) * Math.cos(OBL) - Math.tan(b) * Math.sin(OBL), Math.cos(l));
  const dec = (l, b) => Math.asin(Math.sin(b) * Math.cos(OBL) + Math.cos(b) * Math.sin(OBL) * Math.sin(l));
  function sunCoords(d) {
    const M = RAD * (357.5291 + 0.98560028 * d);
    const C = RAD * (1.9148 * Math.sin(M) + 0.02 * Math.sin(2 * M) + 0.0003 * Math.sin(3 * M));
    const L = M + C + RAD * 102.9372 + Math.PI;
    return { dec: dec(L, 0), ra: ra(L, 0), dist: 149598000 };
  }
  function moonCoords(d) {
    const L = RAD * (218.316 + 13.176396 * d), M = RAD * (134.963 + 13.064993 * d), F = RAD * (93.272 + 13.22935 * d);
    const l = L + RAD * 6.289 * Math.sin(M), b = RAD * 5.128 * Math.sin(F);
    return { ra: ra(l, b), dec: dec(l, b), dist: 385001 - 20905 * Math.cos(M) };
  }
  /* azimuth in degrees clockwise from north */
  const azimuth = (H, phi, de) => ((Math.atan2(Math.sin(H), Math.cos(H) * Math.sin(phi) - Math.tan(de) * Math.cos(phi)) / RAD + 180) % 360 + 360) % 360;
  const COMPASS = { en: ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE', 'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW'], el: ['Β', 'ΒΒΑ', 'ΒΑ', 'ΑΒΑ', 'Α', 'ΑΝΑ', 'ΝΑ', 'ΝΝΑ', 'Ν', 'ΝΝΔ', 'ΝΔ', 'ΔΝΔ', 'Δ', 'ΔΒΔ', 'ΒΔ', 'ΒΒΔ'] };
  const compass = (az) => (COMPASS[LANG] || COMPASS.en)[Math.round(az / 22.5) % 16];
  const altitude = (H, phi, de) => Math.asin(Math.sin(phi) * Math.sin(de) + Math.cos(phi) * Math.cos(de) * Math.cos(H));
  const sidereal = (d, lw) => RAD * (280.16 + 360.9856235 * d) - lw;

  /* Sun/Moon altitude (degrees), moon lit fraction (0..1) and phase (0 new .. 0.5 full .. 1) at epoch ms */
  function sky(ms, lat, lon) {
    const d = toDays(ms), lw = RAD * -lon, phi = RAD * lat;
    const s = sunCoords(d), m = moonCoords(d);
    const sunAlt = altitude(sidereal(d, lw) - s.ra, phi, s.dec) / RAD, sunAz = azimuth(sidereal(d, lw) - s.ra, phi, s.dec);
    const moonAz = azimuth(sidereal(d, lw) - m.ra, phi, m.dec);
    let h = altitude(sidereal(d, lw) - m.ra, phi, m.dec);
    h -= Math.asin(6378 / m.dist) * Math.cos(h);          // parallax: the Moon is close
    const dRa = s.ra - m.ra;
    const ph = Math.acos(Math.sin(s.dec) * Math.sin(m.dec) + Math.cos(s.dec) * Math.cos(m.dec) * Math.cos(dRa));
    const inc = Math.atan2(s.dist * Math.sin(ph), m.dist - s.dist * Math.cos(ph));
    const ang = Math.atan2(Math.cos(s.dec) * Math.sin(dRa), Math.sin(s.dec) * Math.cos(m.dec) - Math.cos(s.dec) * Math.sin(m.dec) * Math.cos(dRa));
    return { sunAlt, sunAz, moonAz, moonAlt: h / RAD, lit: (1 + Math.cos(inc)) / 2, phase: 0.5 + (0.5 * inc * (ang < 0 ? -1 : 1)) / Math.PI };
  }
  const PHASE_ICON = ['🌑', '🌒', '🌓', '🌔', '🌕', '🌖', '🌗', '🌘'];
  const phaseIdx = (p) => Math.floor(((p % 1) * 8 + 0.5) % 8);

  /* ---- first time (epoch ms) in [a,b] where a body's altitude crosses `lim` going up (dir=1) or down (dir=-1) ---- */
  function crossing(a, b, lat, lon, key, lim, dir) {
    const step = 600e3;
    let prev = sky(a, lat, lon)[key];
    for (let t0 = a + step; t0 <= b; t0 += step) {
      const cur = sky(t0, lat, lon)[key];
      if (dir > 0 ? prev < lim && cur >= lim : prev > lim && cur <= lim) return t0 - step + (step * (lim - prev)) / (cur - prev);
      prev = cur;
    }
    return null;
  }

  /* ---- atmosphere-derived quantities ---- */
  const ms = (kmh) => (kmh == null ? null : kmh / 3.6);
  const vec = (s, d) => (s == null || d == null ? null : [-s * Math.sin(d * RAD), -s * Math.cos(d * RAD)]);
  const shear = (h, i, la, lb) => {
    const a = vec(ms(h['wind_speed_' + la + 'hPa'][i]), h['wind_direction_' + la + 'hPa'][i]);
    const b = vec(ms(h['wind_speed_' + lb + 'hPa'][i]), h['wind_direction_' + lb + 'hPa'][i]);
    return a && b ? Math.hypot(a[0] - b[0], a[1] - b[1]) : null;
  };
  /* seeing in arcseconds (smaller = steadier): jet stream + upper shear dominate, ground wind and convection add */
  function seeingArcsec(h, i) {
    const j3 = ms(h.wind_speed_300hPa[i]), j2 = ms(h.wind_speed_250hPa[i]);
    const jet = Math.max(j3 ?? 0, j2 ?? 0);
    const sh = shear(h, i, 500, 250) ?? shear(h, i, 700, 300) ?? 0;
    const w10 = ms(h.wind_speed_10m[i]) ?? 0, cape = h.cape[i] ?? 0;
    if (j3 == null && j2 == null) return null;
    return clamp(0.65 + 0.035 * jet + 0.02 * sh + 0.04 * w10 + 0.0006 * cape, 0.6, 5);
  }
  /* transparency 0..100: aerosols/dust, humidity, thin high cloud, visibility, precipitation */
  function transparency(h, i) {
    const aod = h.aerosol_optical_depth[i], rh = h.relative_humidity_2m[i], hi = h.cloud_cover_high[i];
    const vis = h.visibility[i] == null ? null : h.visibility[i] / 1000, pr = h.precipitation[i];
    let T = 100;
    if (aod != null) T -= 140 * Math.max(0, aod - 0.05);
    if (rh != null) T -= 0.5 * Math.max(0, rh - 55);
    if (hi != null) T -= 0.3 * hi;
    if (vis != null) T -= Math.max(0, 20 - vis);
    if (pr != null && pr > 0.1) T -= 30;
    return clamp(T, 5, 100);
  }
  const cloudEff = (h, i) => {
    const l = (h.cloud_cover_low[i] ?? h.cloud_cover[i] ?? 0) / 100, m = (h.cloud_cover_mid[i] ?? 0) / 100, hi = (h.cloud_cover_high[i] ?? 0) / 100;
    return clamp(1 - (1 - l) * (1 - m) * (1 - 0.6 * hi), 0, 1);
  };

  /* light pollution: Bortle class 1..9 -> how much of the deep-sky score survives, naked-eye limiting magnitude, sky brightness */
  const BORTLE_FACTOR = [null, 1, 1, 0.97, 0.9, 0.78, 0.62, 0.47, 0.33, 0.22];
  const BORTLE_NELM = [null, 7.6, 7.1, 6.6, 6.2, 5.6, 5.1, 4.6, 4.1, 3.8];
  const BORTLE_SQM = [null, 21.9, 21.6, 21.3, 20.8, 20.1, 19.4, 18.9, 18.4, 17.8];
  const DEFAULT_BORTLE = 5;                       // used while a place has no value yet
  const bkey = (loc) => 'wefo.bortle.' + loc.lat + ',' + loc.lon;
  /* the visitor's own choice (this browser) beats the stored one (database: seeded estimate for the Greek towns, admin's correction) */
  function bortleOf(loc) {
    try { const v = +localStorage.getItem(bkey(loc)); if (v >= 1 && v <= 9) return { v, src: 'own' }; } catch (e) { /* ignore */ }
    if (loc.bortle >= 1 && loc.bortle <= 9) return { v: +loc.bortle, src: state.cities.includes(loc) ? 'est' : 'saved' };
    return { v: null, src: 'none' };
  }

  /* quality tiers 0 (bad) .. 4 (excellent) */
  const qSeeing = (a) => (a == null ? null : a <= 1.0 ? 4 : a <= 1.5 ? 3 : a <= 2.2 ? 2 : a <= 3.2 ? 1 : 0);
  const qTransp = (v) => (v == null ? null : v >= 80 ? 4 : v >= 65 ? 3 : v >= 50 ? 2 : v >= 35 ? 1 : 0);
  const qCloud = (c) => (c == null ? null : c <= 10 ? 4 : c <= 25 ? 3 : c <= 50 ? 2 : c <= 75 ? 1 : 0);
  const qScore = (s) => (s == null ? null : s >= 70 ? 4 : s >= 50 ? 3 : s >= 30 ? 2 : s >= 12 ? 1 : 0);
  const qDew = (m) => (m == null ? null : m > 5 ? 4 : m > 3 ? 3 : m > 2 ? 2 : m > 1 ? 1 : 0);
  const qWind = (w) => (w == null ? null : w <= 10 ? 4 : w <= 20 ? 3 : w <= 30 ? 2 : w <= 45 ? 1 : 0);
  const qJet = (w) => (w == null ? null : w <= 60 ? 4 : w <= 100 ? 3 : w <= 140 ? 2 : w <= 190 ? 1 : 0);
  const qHum = (r) => (r == null ? null : r <= 60 ? 4 : r <= 75 ? 3 : r <= 88 ? 2 : r <= 95 ? 1 : 0);

  /* ---- build the hourly model of the whole response ---- */
  function build(data, bortle) {
    const off = data.utc_offset_seconds || 0, h = data.hourly, lat = data.lat, lon = data.lon;
    const rows = data.time.map((ts, i) => {
      const e = Date.UTC(+ts.slice(0, 4), +ts.slice(5, 7) - 1, +ts.slice(8, 10), +ts.slice(11, 13), +ts.slice(14, 16)) - off * 1000;
      const k = sky(e, lat, lon);
      const eff = cloudEff(h, i), see = seeingArcsec(h, i), tr = transparency(h, i);
      const seeFrac = see == null ? 0.5 : clamp((3.2 - see) / 2.4, 0, 1);
      const darkDeep = clamp((-k.sunAlt - 6) / 12, 0, 1), darkPlan = clamp((-k.sunAlt - 3) / 6, 0, 1);
      const moonPen = k.moonAlt > 0 ? k.lit * clamp(0.35 + k.moonAlt / 45, 0, 1) : 0;
      const lp = BORTLE_FACTOR[bortle || DEFAULT_BORTLE];
      const deep = 100 * (1 - eff) * darkDeep * (1 - 0.75 * moonPen) * (0.55 + 0.45 * tr / 100) * (0.85 + 0.15 * seeFrac) * lp;
      const planets = 100 * (1 - eff) * darkPlan * (0.35 + 0.65 * seeFrac) * (0.7 + 0.3 * tr / 100);
      const dew = h.temperature_2m[i] != null && h.dew_point_2m[i] != null ? h.temperature_2m[i] - h.dew_point_2m[i] : null;
      return { i, ts, e, ...k, eff, see, tr, deep, planets, dew, jet: Math.max(h.wind_speed_300hPa[i] ?? 0, h.wind_speed_250hPa[i] ?? 0) || null };
    });
    return { off, h, lat, lon, rows };
  }

  const localHM = (e, off) => new Date(e + off * 1000).toISOString().slice(11, 16);
  const localDay = (e, off) => new Date(e + off * 1000).toISOString().slice(0, 10);
  const dayLabel = (ymd) => new Date(Date.UTC(+ymd.slice(0, 4), +ymd.slice(5, 7) - 1, +ymd.slice(8, 10))).toLocaleDateString(dateLocale(), { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' });

  /* ---- one card per night (from the afternoon of day k to the next afternoon) ---- */
  function nights(m) {
    const first = m.rows[0], d0 = first.ts.slice(0, 10);
    const noon = (k) => Date.UTC(+d0.slice(0, 4), +d0.slice(5, 7) - 1, +d0.slice(8, 10) + k, 12) - m.off * 1000;
    const nowLocalH = new Date(Date.now() + m.off * 1000).getUTCHours();
    const start = nowLocalH < 7 ? -1 : 0;
    const out = [];
    for (let k = start; k < start + 4; k++) {
      const a = noon(k), b = noon(k + 1);
      if (b > m.rows[m.rows.length - 1].e + 3600e3) break;
      const ev = (key, lim, dir) => crossing(a, b, m.lat, m.lon, key, lim, dir);
      const sunset = ev('sunAlt', -0.833, -1), dusk = ev('sunAlt', -18, -1), dawn = dusk != null ? crossing(dusk, b, m.lat, m.lon, 'sunAlt', -18, 1) : null;
      const sunrise = sunset != null ? crossing(sunset, b, m.lat, m.lon, 'sunAlt', -0.833, 1) : null;
      const mr = ev('moonAlt', 0, 1), ms2 = ev('moonAlt', 0, -1);
      const mid = sky((a + b) / 2, m.lat, m.lon);
      const dark = m.rows.filter((r) => r.e >= a && r.e <= b && r.sunAlt < -12);
      let best = null;
      for (let j = 0; j + 2 < dark.length; j++) {
        if (dark[j + 2].e - dark[j].e > 2.5 * 3600e3) continue;
        const avg = (dark[j].deep + dark[j + 1].deep + dark[j + 2].deep) / 3;
        if (!best || avg > best.avg) best = { avg, from: dark[j].e, to: dark[j + 2].e + 3600e3 };
      }
      const cl = dark.length ? dark.reduce((s, r) => s + m.h.cloud_cover[r.i], 0) / dark.length : null;
      out.push({ day: localDay(a, m.off), sunset, dusk, dawn, sunrise, mr, ms: ms2, mid, best, cloud: cl, nDark: dark.length });
    }
    return out;
  }

  /* ---- per-hour mini charts: each cell draws its own hour (7 samples, 10 min apart), so the cells join up into one
     continuous trajectory / band even when the daytime hours in between are hidden ---- */
  const CH_H = 44, CH_W = 46, ALT_MIN = -40, ALT_MAX = 90;
  const altY = (a) => (CH_H * (ALT_MAX - clamp(a, ALT_MIN, ALT_MAX))) / (ALT_MAX - ALT_MIN);
  /* ---- icons drawn at the position of "now" ---- */
  const sunIcon = () => `<svg viewBox="-12 -12 24 24" width="22" height="22"><g stroke="#f59e0b" stroke-width="1.8" stroke-linecap="round">${[0, 45, 90, 135, 180, 225, 270, 315].map((a) => `<line x1="0" y1="-7.6" x2="0" y2="-10.6" transform="rotate(${a})"/>`).join('')}</g><circle r="5.6" fill="#fbbf24" stroke="#f59e0b" stroke-width="1.2"/></svg>`;
  /* the Moon as it is lit: phase 0 = new, .25 = first quarter, .5 = full, .75 = last quarter (mirrored in the southern hemisphere) */
  function moonIcon(phase, lat, size = 24) {
    const r = 9, k = Math.cos(2 * Math.PI * phase), rx = Math.abs(k) * r;
    const waxing = phase < 0.5, flip = waxing === (lat >= 0);                 // northern sky: waxing is lit on the right
    const lit = `M0,${-r} A${r},${r} 0 0 1 0,${r} A${rx.toFixed(2)},${r} 0 0 ${k > 0 ? 0 : 1} 0,${-r}Z`;
    return `<svg viewBox="-12 -12 24 24" width="${size}" height="${size}"><circle r="${r}" fill="#2a3352" stroke="#98a6c2" stroke-width="1"/><path d="${lit}" fill="#f4ead0" transform="${flip ? '' : 'scale(-1,1)'}"/><circle r="${r}" fill="none" stroke="#98a6c2" stroke-width="1"/></svg>`;
  }
  function nowIcon(m, e, key) {
    const now = Date.now(), f = (now - (e - 1800e3)) / 3600e3;
    if (f < 0 || f >= 1) return '';
    const k = sky(now, m.lat, m.lon);
    const a = k[key];
    const svg = key === 'sunAlt' ? sunIcon() : moonIcon(k.phase, m.lat);
    const az = key === 'sunAlt' ? k.sunAz : k.moonAz;
    const y = (altY(a) / CH_H) * 100;
    return `<span class="nowicon${a > 0 ? '' : ' below'}${y < 38 ? ' lbl-below' : ''}" style="left:${(f * 100).toFixed(1)}%;top:${((altY(a) / CH_H) * 100).toFixed(1)}%">${svg}<b class="nl">${a.toFixed(0)}° · ${az.toFixed(0)}° ${compass(az)}</b></span>`;
  }

  function altChart(m, e, key, stroke, fill) {
    const pts = [];
    for (let j = 0; j <= 6; j++) pts.push(sky(e - 1800e3 + j * 600e3, m.lat, m.lon)[key]);
    const y0 = altY(0), x = (j) => ((j / 6) * CH_W).toFixed(1);
    const line = pts.map((a, j) => `${x(j)},${altY(a).toFixed(1)}`).join(' ');
    const area = `0,${y0.toFixed(1)} ` + pts.map((a, j) => `${x(j)},${Math.min(altY(a), y0).toFixed(1)}`).join(' ') + ` ${CH_W},${y0.toFixed(1)}`;
    const cur = pts[3], ni = nowIcon(m, e, key);
    return `<svg viewBox="0 0 ${CH_W} ${CH_H}" preserveAspectRatio="none" class="alt" aria-hidden="true">
      <polygon points="${area}" fill="${fill}"/><line x1="0" x2="${CH_W}" y1="${y0.toFixed(1)}" y2="${y0.toFixed(1)}" class="hz"/>
      <polyline points="${line}" fill="none" stroke="${stroke}" stroke-width="1.6" vector-effect="non-scaling-stroke"/></svg>
      ${ni ? ni : `<i class="dot${cur > 0 ? ' up' : ''}" style="top:${((altY(cur) / CH_H) * 100).toFixed(1)}%;--c:${stroke}"></i>`}`;
  }
  /* twilight stage of the Sun at an instant: day, civil / nautical / astronomical twilight (evening = dusk, morning = dawn), night */
  const PHASE_COL = {
    day: 'rgba(250,204,21,.38)', 'civ.d': 'rgba(251,146,60,.45)', 'civ.a': 'rgba(244,114,182,.40)', 'naut.d': 'rgba(129,140,248,.45)', 'naut.a': 'rgba(129,140,248,.45)',
    'astro.d': 'rgba(67,56,202,.50)', 'astro.a': 'rgba(67,56,202,.50)', night: 'rgba(15,23,60,.82)', golden: 'rgba(245,158,11,.55)', blue: 'rgba(59,130,246,.50)',
  };
  function phaseAt(m, e) {
    const a = sky(e, m.lat, m.lon).sunAlt;
    if (a > 0) return 'day';
    if (a <= -18) return 'night';
    const falling = sky(e + 300e3, m.lat, m.lon).sunAlt < sky(e - 300e3, m.lat, m.lon).sunAlt;
    return (a > -6 ? 'civ' : a > -12 ? 'naut' : 'astro') + (falling ? '.d' : '.a');
  }
  const gbAt = (m, e) => { const a = sky(e, m.lat, m.lon).sunAlt; return a <= 6 && a > -4 ? 'golden' : a <= -4 && a >= -8 ? 'blue' : null; };
  const bandBg = (keys) => 'linear-gradient(90deg,' + keys.map((k, i) => `${k ? PHASE_COL[k] : 'transparent'} ${(i * 100) / keys.length}% ${((i + 1) * 100) / keys.length}%`).join(',') + ')';
  const subTimes = (e) => [0, 1, 2, 3, 4, 5].map((j) => e - 1500e3 + j * 600e3);   // 6 stripes of 10 min, centred on the hour

  /* ---- rendering ---- */
  let model = null, nightsList = [];
  const cell = (q, html, extra = '') => `<td class="aq${q == null ? ' nq' : ' q' + q} ${extra}">${html}</td>`;
  const sd = (v, d = 0) => (v == null ? '–' : Number(v).toFixed(d));

  function renderNights() {
    const off = model.off;
    const hm = (e) => (e == null ? '–' : localHM(e, off));
    $('astroNights').innerHTML = nightsList.map((n, idx) => {
      const ph = phaseIdx(n.mid.phase);
      const dur = n.dusk != null && n.dawn != null ? (n.dawn - n.dusk) / 3600e3 : null;
      const q = n.best ? qScore(n.best.avg) : null;
      const rating = q == null ? t('as.nobest') : t('as.rate.' + q);
      return `<div class="card night">
        <div class="night-h"><b>${esc(idx === 0 && n.day === model.rows[0].ts.slice(0, 10) ? t('as.tonight') : dayLabel(n.day))}</b><span class="chip aq q${q == null ? 'x' : q}">${esc(rating)}</span></div>
        <div class="night-moon"><span class="mi">${moonIcon(n.mid.phase, model.lat, 36)}</span><span>${t('as.ph.' + ph)} · ${Math.round(n.mid.lit * 100)}%<small>${t('as.moonrise')} ${hm(n.mr)} · ${t('as.moonset')} ${hm(n.ms)}</small></span></div>
        <dl>
          <dt>${t('as.sunset')}</dt><dd>${hm(n.sunset)} → ${hm(n.sunrise)}</dd>
          <dt>${t('as.darkness')}</dt><dd>${n.dusk == null ? t('as.nodark') : `${hm(n.dusk)} → ${hm(n.dawn)}${dur != null ? ` <small>(${dur.toFixed(1)} h)</small>` : ''}`}</dd>
          <dt>${t('as.best')}</dt><dd>${n.best ? `${hm(n.best.from)}–${hm(n.best.to)} <small>${Math.round(n.best.avg)}/100</small>` : '–'}</dd>
          <dt>${t('as.avgcloud')}</dt><dd>${n.cloud == null ? '–' : Math.round(n.cloud) + '%'}</dd>
        </dl></div>`;
    }).join('');
  }

  function renderTable() {
    const { rows, h, off } = model;
    const all = $('astroAll').checked, nowE = Date.now() - 3600e3;
    const vis = rows.filter((r) => r.e >= nowE && (all || r.sunAlt < 0));
    if (!vis.length) { $('astroTable').innerHTML = `<tbody><tr><td class="pad">${t('as.nohours')}</td></tr></tbody>`; return; }
    const days = [];
    vis.forEach((r) => { const d = localDay(r.e, off); const last = days[days.length - 1]; if (last && last.d === d) last.n++; else days.push({ d, n: 1 }); });
    const rowH = (label, hint) => `<th class="rowh">${label}${hint ? `<small>${hint}</small>` : ''}</th>`;
    const mk = (label, hint, fn, cls = '') => `<tr class="${cls}">${rowH(label, hint)}${vis.map((r) => fn(r)).join('')}</tr>`;
    let html = `<thead><tr><th class="rowh" rowspan="2">${t('as.col.metric')}</th>${days.map((d) => `<th class="dayh" colspan="${d.n}">${esc(dayLabel(d.d))}</th>`).join('')}</tr>
      <tr>${vis.map((r) => `<th class="hr${r.sunAlt >= -0.833 ? ' dayt' : ''}">${localHM(r.e, off).slice(0, 2)}</th>`).join('')}</tr></thead><tbody>`;
    html += mk(t('as.row.deep'), t('as.row.deep.h'), (r) => cell(qScore(r.deep), `<b>${sd(r.deep)}</b>`), 'ascore');
    html += mk(t('as.row.planets'), t('as.row.planets.h'), (r) => cell(qScore(r.planets), `<b>${sd(r.planets)}</b>`), 'ascore');
    const posTitle = (e, who) => { const k = sky(e, model.lat, model.lon), a = k[who + 'Alt'], z = k[who + 'Az']; return `${t('as.alt')} ${a.toFixed(0)}° · ${t('as.az')} ${z.toFixed(0)}° ${compass(z)}`; };
    const ab = { civ: t('as.ab.civ'), naut: t('as.ab.naut'), astro: t('as.ab.astro') };
    const phaseName = (k) => t('as.ph2.' + k);
    html += mk(t('as.row.sun'), t('as.row.sun.h'), (r) => `<td class="achart" title="${esc(posTitle(r.e, 'sun'))}">${altChart(model, r.e, 'sunAlt', '#f59e0b', 'rgba(245,158,11,.28)')}</td>`, 'chart');
    html += mk(t('as.row.phase'), t('as.row.phase.h'), (r) => {
      const keys = subTimes(r.e).map((e) => phaseAt(model, e)), c = keys[2];
      const base = c.split('.')[0], txt = c === 'day' ? '' : c === 'night' ? '●' : ab[base] + (c.endsWith('.d') ? '↓' : '↑');
      return `<td class="aband${c === 'night' || base === 'astro' ? ' dk' : ''}" style="background:${bandBg(keys)}" title="${esc(phaseName(c))}">${txt}</td>`;
    }, 'band');
    html += mk(t('as.row.gb'), t('as.row.gb.h'), (r) => {
      const keys = subTimes(r.e).map((e) => gbAt(model, e)), c = keys[2] || keys.find(Boolean);
      return `<td class="aband" style="background:${bandBg(keys)}" title="${c ? esc(phaseName(c)) : ''}"></td>`;
    }, 'band');
    html += mk(t('as.row.moonalt'), t('as.row.moonalt.h'), (r) => `<td class="achart" title="${esc(posTitle(r.e, 'moon'))}">${altChart(model, r.e, 'moonAlt', '#7c8fc9', 'rgba(124,143,201,.30)')}</td>`, 'chart');
    // moonlight as a grey level: black = no light (Moon down or new), white = full Moon high in the sky
    html += mk(t('as.row.moonlit'), t('as.row.moonlit.h'), (r) => {
      const p = Math.round(r.lit * 100), lvl = r.moonAlt > 0 ? r.lit * clamp(Math.sin(r.moonAlt * RAD) / 0.87, 0, 1) : 0, g = Math.round(255 * lvl);
      return `<td class="amoon${lvl > 0.5 ? ' lt' : ''}" style="background:rgb(${g},${g},${g})" title="${esc(posTitle(r.e, 'moon'))}">${p}%</td>`;
    });
    html += mk(t('as.row.cloud'), t('as.row.cloud.h'), (r) => cell(qCloud(r.eff * 100), `<b>${sd(r.eff * 100)}%</b>${h.cloud_cover_min[r.i] != null && h.cloud_cover_max[r.i] - h.cloud_cover_min[r.i] >= 30 ? `<small>${h.cloud_cover_min[r.i]}–${h.cloud_cover_max[r.i]}</small>` : ''}`));
    [['low', 'cloud_cover_low'], ['mid', 'cloud_cover_mid'], ['high', 'cloud_cover_high']].forEach(([k, v]) => {
      html += mk(t('as.row.' + k), '', (r) => cell(qCloud(h[v][r.i]), `${sd(h[v][r.i])}%`), 'sub');
    });
    html += mk(t('as.row.seeing'), t('as.row.seeing.h'), (r) => cell(qSeeing(r.see), r.see == null ? '–' : `<b>${r.see.toFixed(1)}″</b><small>${t('as.sq.' + qSeeing(r.see))}</small>`));
    html += mk(t('as.row.transp'), t('as.row.transp.h'), (r) => cell(qTransp(r.tr), `<b>${sd(r.tr)}</b><small>${t('as.sq.' + qTransp(r.tr))}</small>`));
    html += mk(t('as.row.hum'), '', (r) => cell(qHum(h.relative_humidity_2m[r.i]), `${sd(h.relative_humidity_2m[r.i])}%`));
    html += mk(t('as.row.dew'), t('as.row.dew.h'), (r) => cell(qDew(r.dew), r.dew == null ? '–' : `${r.dew.toFixed(1)}°${r.dew <= 2 ? '<small>' + t('as.dewrisk') + '</small>' : ''}`));
    html += mk(t('as.row.wind'), '', (r) => cell(qWind(h.wind_speed_10m[r.i]), `${sd(h.wind_speed_10m[r.i])}`));
    html += mk(t('as.row.jet'), t('as.row.jet.h'), (r) => cell(qJet(r.jet), sd(r.jet)));
    html += '</tbody>';
    $('astroTable').innerHTML = html;
    $('astroPhaseKey').innerHTML = ['day', 'golden', 'blue', 'civ.d', 'civ.a', 'naut.d', 'naut.a', 'astro.d', 'astro.a', 'night']
      .map((k) => `<span><i style="background:${PHASE_COL[k]}"></i>${esc(phaseName(k))}</span>`).join('');
    // scroll the first visible hour into place (table starts at "now")
  }

  function renderBortle() {
    const b = S.bortle || { v: null, src: 'none' };
    $('astroBortle').innerHTML = `<option value="0">${esc(t('as.bl.none'))}</option>` + [1, 2, 3, 4, 5, 6, 7, 8, 9].map((i) => `<option value="${i}">${i} – ${esc(t('as.bl.' + i))}</option>`).join('');
    $('astroBortle').value = String(b.v || 0);
    const eff = b.v || DEFAULT_BORTLE;
    $('astroBortleInfo').textContent = t('as.bl.info', { mag: BORTLE_NELM[eff], sqm: BORTLE_SQM[eff], pct: Math.round(BORTLE_FACTOR[eff] * 100) })
      + ' · ' + t(b.src === 'none' ? 'as.bl.src.none' : 'as.bl.src.' + b.src);
  }
  function setBortle(v) {
    const loc = state.current; if (!loc || !S.data) return;
    S.bortle = { v: v || null, src: 'own' };
    const done = () => { renderBortle(); model = build(S.data, S.bortle.v); nightsList = nights(model); render(); };
    if (state.admin && loc.id != null) {
      // the admin's value is stored with the location and becomes the default for everybody
      api('api/locations.php', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'bortle', id: loc.id, bortle: v || null }) })
        .then(() => { loc.bortle = v || null; try { localStorage.removeItem(bkey(loc)); } catch (e) { /* ignore */ } S.bortle = bortleOf(loc); done(); })
        .catch((e) => { $('astroErr').textContent = e.message; $('astroErr').hidden = false; });
      return;
    }
    try { if (v) localStorage.setItem(bkey(loc), v); else localStorage.removeItem(bkey(loc)); } catch (e) { /* ignore */ }
    S.bortle = bortleOf(loc); done();
  }

  function render() {
    if (!model) return;
    renderBortle();
    renderNights();
    renderTable();
    $('astroNote').innerHTML = t('as.note', { models: model.h ? esc(Astro.models.join(', ')) : '', aer: Astro.aerosols ? t('as.note.aer') : t('as.note.noaer'), lp: t('as.note.lp') });
  }

  /* ---- loading ---- */
  const S = { token: 0, key: null, models: [], aerosols: false, data: null, bortle: null };
  async function load(refresh = false) {
    const loc = state.current;
    $('astroEmpty').hidden = !!loc;
    if (!loc) { $('astroBody').hidden = true; return; }
    const key = loc.lat + ',' + loc.lon;
    if (!refresh && model && S.key === key) { S.bortle = bortleOf(loc); $('astroBody').hidden = false; render(); return; }
    const token = ++S.token;
    $('astroErr').hidden = true; $('astroLoading').hidden = false; $('astroBody').hidden = true;
    try {
      const data = await api(`api/astro.php?lat=${loc.lat}&lon=${loc.lon}${refresh ? '&refresh=1' : ''}`);
      if (token !== S.token) return;
      S.data = data; S.key = key; S.models = data.models || []; S.aerosols = !!data.aerosols;
      S.bortle = bortleOf(loc);
      model = build(data, S.bortle.v);
      nightsList = nights(model);
      $('astroLoading').hidden = true; $('astroBody').hidden = false;
      $('astroMeta').textContent = `${locName(loc)} · ${(+data.lat).toFixed(3)}, ${(+data.lon).toFixed(3)}${data.elevation != null ? ' · ' + Math.round(data.elevation) + ' m' : ''}`;
      render();
    } catch (err) {
      if (token !== S.token) return;
      $('astroLoading').hidden = true; $('astroErr').textContent = err.message; $('astroErr').hidden = false;
    }
  }

  return { load, render, setBortle, get models() { return S.models; }, get aerosols() { return S.aerosols; }, sky, invalidate() { S.key = null; } };
})();

$('astroRefresh').addEventListener('click', () => Astro.load(true));
$('astroAll').addEventListener('change', () => Astro.render());
$('astroBortle').addEventListener('change', (e) => Astro.setBortle(+e.target.value));
$('astroLoc').addEventListener('change', () => {
  $('locSelect').value = $('astroLoc').value;
  $('locSelect').dispatchEvent(new Event('change'));
  $('astroLoc').value = $('locSelect').value;
});
