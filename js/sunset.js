/* ================= Sunset & sunrise quality =================
   "Will the sky colour up?" – an ESTIMATE from the cloud layers the models forecast:
   high and mid cloud catch the light (best at about 45 %), the horizon on the Sun's side must be open (low cloud there
   blocks it), a little aerosol deepens the reds, rain/poor visibility spoil it. The horizon is sampled at points 30, 80 and
   150 km along the Sun's azimuth (api/skypoints.php). Sun positions come from js/astro.js. */
const Sunset = (() => {
  const RAD = Math.PI / 180, EARTH = 6371, DIST = [30, 80, 150];
  const clamp = (x, a, b) => Math.min(b, Math.max(a, x));
  const S = { kind: 'set', key: null, ev: null, sky: null, err: null, loading: false, av: null, avKey: null };

  /* ---------- the Sun at the horizon, day by day ---------- */
  function dest(lat, lon, azDeg, km) {                         // point `km` away along a bearing
    const d = km / EARTH, th = azDeg * RAD, p = lat * RAD, l = lon * RAD;
    const p2 = Math.asin(Math.sin(p) * Math.cos(d) + Math.cos(p) * Math.sin(d) * Math.cos(th));
    const l2 = l + Math.atan2(Math.sin(th) * Math.sin(d) * Math.cos(p), Math.cos(d) - Math.sin(p) * Math.sin(p2));
    return [+(p2 / RAD).toFixed(1), +((((l2 / RAD) + 540) % 360) - 180).toFixed(1)];            // 0.1° (~10 km): a week of sunsets share most points, so the request stays small
  }
  function events(loc, off) {
    const ln = new Date(Date.now() + off * 1000);
    const noon = (k) => Date.UTC(ln.getUTCFullYear(), ln.getUTCMonth(), ln.getUTCDate() + k, 12) - off * 1000;
    const cr = (a, b, lim, dir) => Astro.crossing(a, b, loc.lat, loc.lon, 'sunAlt', lim, dir);
    const out = [];
    for (let k = 0; k < 7; k++) {
      const n = noon(k), mid = n - 43200e3, end = n + 86400e3;
      const ymd = new Date(n + off * 1000).toISOString().slice(0, 10);
      const mk = (kind, t, g1, g2, b1, b2) => (t == null ? null : { kind, k, ymd, t, az: Astro.sky(t, loc.lat, loc.lon).sunAz, gold: [g1, g2], blue: [b1, b2] });
      const set = cr(n, end, -0.833, -1), rise = cr(mid, n, -0.833, 1);
      out.push({
        k, ymd,
        set: mk('set', set, cr(n, end, 6, -1), cr(n, end, -4, -1), cr(n, end, -4, -1), cr(n, end, -8, -1)),
        rise: mk('rise', rise, cr(mid, n, -4, 1), cr(mid, n, 6, 1), cr(mid, n, -8, 1), cr(mid, n, -4, 1)),
      });
    }
    return out;
  }

  /* ---------- the forecast around the horizon ---------- */
  const tms = (sky) => sky.time.map((ts) => Date.UTC(+ts.slice(0, 4), +ts.slice(5, 7) - 1, +ts.slice(8, 10), +ts.slice(11, 13), +ts.slice(14, 16)) - sky.utc_offset_seconds * 1000);
  function at(sky, tm, arr, t) {                                   // hourly series interpolated at an instant
    let i = tm.findIndex((x) => x > t) - 1;          // last hour at or before t (none after t: the last one)
    if (i === -2) i = tm.length - 1; else if (i < 0) i = 0;
    const a = arr[i], b = arr[Math.min(i + 1, arr.length - 1)];
    if (a == null) return b ?? null;
    if (b == null || i + 1 >= tm.length) return a;
    return a + (b - a) * clamp((t - tm[i]) / (tm[i + 1] - tm[i]), 0, 1);
  }
  /* ---------- real airport data (METAR now, TAF for the next 9–30 h) along the Sun's direction ---------- */
  const COVER = { FEW: 0.18, SCT: 0.44, BKN: 0.75, OVC: 1, VV: 1 };            // oktas -> fraction (centre of each class)
  function layerPct(clouds) {                                                   // low = base <= 6500 ft, mid = 6500..20000 ft (stations do not see cirrus)
    let lo = 1, mi = 1;
    for (const [cv, base] of clouds || []) {
      const f = COVER[cv]; if (!f) continue;
      const b = base == null ? 0 : base;
      if (b <= 6500) lo *= 1 - f; else if (b <= 20000) mi *= 1 - f;
    }
    return { low: Math.round((1 - lo) * 100), mid: Math.round((1 - mi) * 100) };
  }
  function tafAt(taf, tSec) {                                                   // the forecast group in force at an instant (TEMPO / PROB groups only mix in)
    if (!taf || tSec < taf.from || tSec >= taf.to) return null;
    const cov = taf.fcsts.filter((g) => g.from <= tSec && tSec < g.to);
    const main = cov.filter((g) => g.change !== 'TEMPO' && !(g.change || '').startsWith('PROB')).sort((a, b) => b.from - a.from)[0] || taf.fcsts[0];
    if (!main) return null;
    let r = layerPct(main.clouds);
    cov.filter((g) => g.change === 'TEMPO' || (g.change || '').startsWith('PROB')).forEach((g) => { const x = layerPct(g.clouds); r = { low: Math.round(0.7 * r.low + 0.3 * Math.max(r.low, x.low)), mid: Math.round(0.7 * r.mid + 0.3 * Math.max(r.mid, x.mid)) }; });
    return r;
  }
  /* what the stations say for the sky point `ptIdx` at the event time, and how much it counts (0..1) */
  function station(ptIdx, tMs) {
    if (!S.av) return null;
    const ap = S.av.points[S.av.map.get(ptIdx)];
    if (!ap) return null;
    const h = (tMs - Date.now()) / 3600e3;
    if (h < -0.5 || h > 30) return null;
    const m = ap.metar && S.av.data.metar[ap.metar.id], f = ap.taf && S.av.data.taf[ap.taf.id];
    const metar = m && Date.now() / 1000 - m.time < 3 * 3600 ? (m.cavok ? { low: 0, mid: 0 } : layerPct(m.clouds)) : null;
    const taf = f ? tafAt(f, tMs / 1000) : null;
    const a = clamp((3 - h) / 3, 0, 1);                                         // a METAR says little about more than ~3 h ahead
    const wTaf = taf ? (h <= 9 ? 0.6 : 0.4) : 0, wObs = metar ? a * 0.6 : 0;
    let est = null, w = 0;
    if (taf) { est = taf; w = wTaf; if (metar && a > 0) { est = { low: taf.low + (metar.low - taf.low) * a * 0.7, mid: taf.mid + (metar.mid - taf.mid) * a * 0.7 }; w = Math.max(wTaf, wObs); } }
    else if (metar && wObs > 0) { est = metar; w = wObs; }
    if (!est || w <= 0) return null;
    return { low: est.low, mid: est.mid, w, metar: ap.metar && metar ? ap.metar : null, taf: ap.taf && taf ? ap.taf : null };
  }

  const tri = (c) => Math.max(0.18, 1 - Math.abs(c - 45) / 45);        // light-catching cloud: best around 45 %, plain sky still gives some colour
  function score(ev, sky, tm) {
    const P = (j, name) => at(sky, tm, sky.points[ev.pi[j]][name], ev.t);
    const base = { low: at(sky, tm, sky.points[0].low, ev.t), mid: at(sky, tm, sky.points[0].mid, ev.t), high: at(sky, tm, sky.points[0].high, ev.t) };
    const used = new Map();                                                     // stations that changed the picture
    const pts = [base, ...[0, 1, 2].map((j) => {
      const p = { low: P(j, 'low'), mid: P(j, 'mid'), high: P(j, 'high') };
      const st = station(ev.pi[j], ev.t);
      if (st) {
        p.low = (1 - st.w) * (p.low ?? 0) + st.w * st.low; p.mid = (1 - st.w) * (p.mid ?? 0) + st.w * st.mid;
        [['M', st.metar], ['T', st.taf]].forEach(([k, x]) => { if (x && !used.has(x.id + k)) used.set(x.id + k, { id: x.id, km: x.km, kind: k, low: Math.round(st.low), mid: Math.round(st.mid), w: st.w }); });
      }
      return p;
    })];
    const nz = (v) => (v == null ? 0 : v);
    const canvas = pts.reduce((a, p) => a + Math.max(nz(p.high), nz(p.mid)), 0) / pts.length;             // cloud that can catch the light
    const hz = [pts[2], pts[3]];                                                                         // 80 and 150 km: the real horizon band
    const block = clamp(hz.reduce((a, p) => a + 0.8 * nz(p.low) + 0.35 * nz(p.mid), 0) / hz.length, 0, 100);   // what hides the Sun
    const aod = at(sky, tm, sky.aod, ev.t), vis = at(sky, tm, sky.points[0].vis, ev.t), rain = at(sky, tm, sky.points[0].precip, ev.t);
    const fa = aod == null ? 1 : aod < 0.05 ? 0.9 : aod < 0.35 ? 1 + 0.15 * Math.min(1, (aod - 0.05) / 0.2) : Math.max(0.7, 1.15 - (aod - 0.35) * 1.2);
    const fv = vis == null ? 1 : clamp(vis / 1000 / 20, 0.65, 1);
    const fr = rain != null && rain > 0.2 ? 0.5 : 1;
    const sc = clamp(Math.round(100 * tri(canvas) * (1 - Math.min(1, block / 70)) * fa * fv * fr), 0, 100);
    return { score: sc, canvas: Math.round(canvas), block: Math.round(block), open: Math.round(100 - block), aod, vis: vis == null ? null : vis / 1000, rain, obs: [...used.values()] };
  }
  const tier = (s) => (s >= 70 ? 4 : s >= 50 ? 3 : s >= 30 ? 2 : s >= 12 ? 1 : 0);

  /* ---------- seen it! (kept in this browser only) ---------- */
  const seenKey = (loc, ev) => `${loc.lat},${loc.lon}|${ev.ymd}|${ev.kind}`;
  const seenAll = () => { try { return JSON.parse(localStorage.getItem('wefo.sunseen') || '{}'); } catch (e) { return {}; } };
  function toggleSeen(key) {
    const m = seenAll(); if (m[key]) delete m[key]; else m[key] = 1;
    try { localStorage.setItem('wefo.sunseen', JSON.stringify(m)); } catch (e) { /* ignore */ }
  }

  /* ---------- rendering ---------- */
  const hm = (ms, off) => new Date(ms + off * 1000).toISOString().slice(11, 16);
  const dayName = (ymd, k) => (k === 0 ? t('today') : new Date(Date.UTC(+ymd.slice(0, 4), +ymd.slice(5, 7) - 1, +ymd.slice(8, 10))).toLocaleDateString(dateLocale(), { weekday: 'short', timeZone: 'UTC' }));
  const dayDate = (ymd) => new Date(Date.UTC(+ymd.slice(0, 4), +ymd.slice(5, 7) - 1, +ymd.slice(8, 10))).toLocaleDateString(dateLocale(), { day: 'numeric', month: 'short', timeZone: 'UTC' });
  const label = (s) => t('sun.q.' + tier(s));
  const win = (a, b, off) => (a != null && b != null ? `${hm(a, off)}–${hm(b, off)}` : '–');

  function paint() {
    const box = $('sunsetBox'), loc = state.current;
    if (!loc || !state.data) { box.innerHTML = ''; return; }
    const off = state.data.utc_offset_seconds || 0;
    const head = `<div class="ss-top"><div class="seg2" id="ssKind"><button type="button" data-k="set" class="${S.kind === 'set' ? 'on' : ''}">${esc(t('sun.set'))}</button><button type="button" data-k="rise" class="${S.kind === 'rise' ? 'on' : ''}">${esc(t('sun.rise'))}</button></div>
      <button type="button" class="dso-i" id="ssInfo" aria-label="info">i</button></div>
      <p class="ss-note" id="ssNote" hidden>${t('sun.note')}</p>`;
    if (S.loading) { box.innerHTML = head + `<div class="loading"><div class="spinner"></div></div>`; return; }
    if (S.err) { box.innerHTML = head + `<div class="notice error">${esc(S.err)} <button type="button" class="btn ghost" id="ssRetry">${esc(t('sun.retry'))}</button></div>`; return; }
    if (!S.sky || !S.ev) { box.innerHTML = head; return; }
    const tm = S.tm, seen = seenAll();
    const rows = S.ev.map((d) => {
      const out = { d };
      ['set', 'rise'].forEach((kind) => { const ev = d[kind]; if (ev) { out[kind] = { ev, ...score(ev, S.sky, tm) }; } });
      return out;
    });
    const list = rows.map((r) => r[S.kind] ? r : null).filter(Boolean);
    const bars = list.map((r) => { const e = r[S.kind]; return `<div class="ss-bar" title="${esc(label(e.score))}"><span class="ss-t${tier(e.score)}" style="height:${Math.max(8, e.score)}%"><b>${e.score}</b></span><small>${esc(dayName(r.d.ymd, r.d.k))}</small></div>`; }).join('');
    const cards = list.map((r) => {
      const e = r[S.kind], ev = e.ev, past = ev.t < Date.now() - 1800e3, key = seenKey(loc, ev), on = !!seen[key];
      const g = S.kind === 'set' ? [ev.gold, ev.blue] : [ev.blue, ev.gold];
      const names = S.kind === 'set' ? ['sun.golden', 'sun.blue'] : ['sun.blue', 'sun.golden'];
      return `<article class="ss-card${past ? ' past' : ''}">
        <div class="ss-day"><b>${esc(dayName(r.d.ymd, r.d.k))}</b><small>${esc(dayDate(r.d.ymd))}</small></div>
        <div class="ss-when"><span class="ss-ico">${S.kind === 'set' ? '🌇' : '🌅'}</span><b>${hm(ev.t, off)}</b><small>${ev.az.toFixed(0)}° ${esc(Astro.compass(ev.az))}</small></div>
        <div class="ss-score ss-t${tier(e.score)}"><span class="num">${e.score}</span><small>${esc(label(e.score))}</small></div>
        <div class="ss-facts">
          <div><span>${esc(t('sun.f.canvas'))}</span><b>${e.canvas}%</b><i><u style="width:${clamp(e.canvas, 0, 100)}%"></u></i></div>
          <div><span>${esc(t('sun.f.open'))}</span><b>${e.open}%</b><i><u style="width:${clamp(e.open, 0, 100)}%"></u></i></div>
          <div class="sm"><span>${esc(t('sun.f.aod'))}</span><b>${e.aod == null ? '–' : e.aod.toFixed(2)}</b><span>${esc(t('sun.f.vis'))}</span><b>${e.vis == null ? '–' : Math.round(e.vis) + ' km'}</b>${e.rain > 0.2 ? `<span class="rn">☔ ${e.rain.toFixed(1)} mm</span>` : ''}</div>
        </div>
        ${e.obs && e.obs.length ? `<div class="ss-obs" title="${esc(t('sun.obs.tip'))}">✈ <b>${esc(t('sun.obs'))}</b> ${e.obs.map((o) => `${esc(o.id)}${o.kind === 'M' ? ' METAR' : ' TAF'} (${Math.round(o.km)} km): ${esc(t('sun.obs.low'))} ${o.low}%`).join(' · ')}</div>` : ''}
        <div class="ss-times"><span>${esc(t(names[0]))} <b>${win(g[0][0], g[0][1], off)}</b></span><span>${esc(t(names[1]))} <b>${win(g[1][0], g[1][1], off)}</b></span></div>
        <button type="button" class="ss-seen${on ? ' on' : ''}" data-seen="${esc(key)}">${on ? '★' : '☆'} ${esc(t('sun.seen'))}</button>
      </article>`;
    }).join('');
    box.innerHTML = head + `<div class="ss-bars">${bars}</div><div class="ss-list">${cards}</div>`;
  }

  const withTimeout = (p, ms) => new Promise((res, rej) => { const id = setTimeout(() => rej(new Error(t('sun.timeout'))), ms); p.then((v) => { clearTimeout(id); res(v); }, (e) => { clearTimeout(id); rej(e); }); });
  async function render() {
    const loc = state.current;
    if (!loc || !state.data) return paint();
    const key = loc.lat + ',' + loc.lon;
    if (S.key === key && S.sky) return paint();
    if (S.loading && S.pending === key) return;                      // the same request is already on its way: do not start another
    const off = state.data.utc_offset_seconds || 0;
    const ev = events(loc, off);
    // points: [0] the place, then the (de-duplicated) points along the Sun's azimuth for every sunset / sunrise
    const pts = [[loc.lat, loc.lon]], seen = new Map();
    const idxOf = (p) => { const k = p.join(','); if (!seen.has(k)) { seen.set(k, pts.length); pts.push(p); } return seen.get(k); };
    ev.forEach((d) => ['set', 'rise'].forEach((kind) => { if (d[kind]) d[kind].pi = DIST.map((km) => idxOf(dest(loc.lat, loc.lon, d[kind].az, km))); }));
    S.loading = true; S.pending = key; S.err = null; paint();
    try {
      const sky = await withTimeout(api('api/skypoints.php?pts=' + pts.map((p) => p.join(',')).join(';')), 40000);
      if (state.current && state.current.lat + ',' + state.current.lon === key) { S.sky = sky; S.tm = tms(sky); S.ev = ev; S.key = key; }
    } catch (e) { S.err = e.message || String(e); S.sky = null; }
    finally { S.loading = false; S.pending = null; }
    if (state.orient === 's') { try { paint(); } catch (e) { S.err = e.message; $('sunsetBox').innerHTML = `<div class="notice error">${esc(e.message)}</div>`; } }
    if (S.sky && S.key === key) loadAviation(key);
  }
  /* airport observations / forecasts for the horizon points of the events in the next 30 hours; failure just leaves the model forecast */
  async function loadAviation(key) {
    if (S.avKey === key) return;
    S.avKey = key;
    const now = Date.now(), idx = new Set();
    S.ev.forEach((d) => ['set', 'rise'].forEach((k) => { const e = d[k]; if (e && e.t - now > -1800e3 && e.t - now < 30 * 3600e3) e.pi.forEach((i) => idx.add(i)); }));
    const list = [...idx];
    if (!list.length) return;
    try {
      const data = await withTimeout(api('api/aviation.php?pts=' + list.map((i) => S.sky.points[i].lat + ',' + S.sky.points[i].lon).join(';')), 20000);
      if (S.key !== key) return;
      S.av = { data, points: data.points, map: new Map(list.map((i, n) => [i, n])) };
      if (state.orient === 's') paint();
    } catch (e) { S.avKey = null; /* the model forecast stays as it is */ }
  }

  function init() {
    const box = $('sunsetBox');
    box.addEventListener('click', (e) => {
      const k = e.target.closest('#ssKind [data-k]'); if (k) { S.kind = k.dataset.k; paint(); return; }
      if (e.target.closest('#ssRetry')) { S.key = null; S.err = null; render(); return; }
      if (e.target.closest('#ssInfo')) { const n = $('ssNote'); if (n) n.hidden = !n.hidden; return; }
      const sn = e.target.closest('[data-seen]'); if (sn) { toggleSeen(sn.dataset.seen); paint(); }
    });
  }
  return { init, render, paint, invalidate() { S.key = null; S.sky = null; S.av = null; S.avKey = null; } };
})();
Sunset.init();
