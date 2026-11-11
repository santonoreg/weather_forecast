/* ================= Trip =================
   Pick a start and a destination → the driving routes (OpenRouteService, via api/route.php) and the weather you will meet
   along each of them, for the moment you really get there: the multi-model forecast (api/tripweather.php) is read at points
   every ~20 km, each at its own arrival time, and the weather shown is the one most models agree on (with the share that agrees).
   Rough road-condition hints (slippery, fog, gusts …) are estimated from the forecast – there is no road-authority data. */
const Trip = (() => {
  const $t = (id) => document.getElementById(id);
  const T = { from: null, to: null, dep: Date.now(), when: 'now', routes: [], sel: 0, loading: '', error: null, map: null, layer: null, hover: null, token: 0, mapFitted: false };
  const CAT_COL = { clear: '#f5b301', partly: '#f5b301', cloudy: '#94a3b8', fog: '#a8b4c8', drizzle: '#7fb4f5', rain: '#3b82f6', snow: '#38bdf8', thunder: '#a855f7' };
  const SEV_COL = ['#16a34a', '#d9a406', '#ea7a14', '#dc2626'];
  const MODEL_IDS = ['ecmwf_ifs025', 'ecmwf_aifs025_single', 'gfs_seamless', 'icon_seamless', 'meteofrance_seamless', 'ukmo_seamless', 'gem_seamless'];
  const clampN = (x, a, b) => Math.min(b, Math.max(a, x));
  const timeStr = (ms) => new Date(ms).toLocaleTimeString(dateLocale(), { hour: '2-digit', minute: '2-digit' });
  const dayStr = (ms) => new Date(ms).toLocaleDateString(dateLocale(), { weekday: 'short', day: 'numeric', month: 'short' });
  const sameDay = (a, b) => new Date(a).toDateString() === new Date(b).toDateString();
  const when = (ms) => (sameDay(ms, T.dep) ? timeStr(ms) : `${dayStr(ms)} ${timeStr(ms)}`);
  const durStr = (sec) => { const m = Math.round(sec / 60), h = Math.floor(m / 60); return h ? `${h} ${t('trip.h')} ${String(m % 60).padStart(2, '0')} ${t('trip.min')}` : `${m} ${t('trip.min')}`; };
  const kmStr = (km) => Number(km).toLocaleString(dateLocale(), { maximumFractionDigits: km < 100 ? 1 : 0 });
  const sevCol = (s) => { const i = clampN(s, 0, 3), a = Math.floor(i), b = Math.min(3, a + 1), f = i - a; return mixCol(SEV_COL[a], SEV_COL[b], f); };
  const mixCol = (a, b, f) => { const p = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16)); const x = p(a), y = p(b); return '#' + x.map((v, i) => Math.round(v + (y[i] - v) * f).toString(16).padStart(2, '0')).join(''); };

  /* ---------- route: timetable, positions, names ---------- */
  function lerpAt(xs, ys, x) {                                    // ys[i] at xs[i] (ascending), linearly in between
    if (x <= xs[0]) return ys[0];
    const n = xs.length - 1;
    if (x >= xs[n]) return ys[n];
    let lo = 0, hi = n;
    while (hi - lo > 1) { const m = (lo + hi) >> 1; if (xs[m] <= x) lo = m; else hi = m; }
    const d = xs[hi] - xs[lo];
    return d > 0 ? ys[lo] + (ys[hi] - ys[lo]) * ((x - xs[lo]) / d) : ys[lo];
  }
  function prepRoute(r) {
    let acc = 0;
    const kx = [0], ks = [0];
    r.steps.forEach(([, k1, sec]) => { acc += sec; kx.push(Math.max(k1, kx[kx.length - 1])); ks.push(acc); });
    if (acc <= 0) { kx.splice(0, kx.length, 0, r.km); ks.splice(0, ks.length, 0, r.sec); acc = r.sec; }
    const sc = r.sec / acc;
    kx[kx.length - 1] = r.km;
    r.timeAt = (km) => lerpAt(kx, ks, km) * sc * 1000;           // ms after departure
    r.latAt = (km) => lerpAt(r.cum, r.pts.map((p) => p[0]), km);
    r.lonAt = (km) => lerpAt(r.cum, r.pts.map((p) => p[1]), km);
    r.eleAt = (km) => (r.ele[0] == null ? null : lerpAt(r.cum, r.ele, km));
    r.nameAt = (km) => { const s = r.steps.find((x) => km >= x[0] && km <= x[1] && x[3] && x[3] !== '-'); return s ? s[3] : ''; };
    const byName = {};
    r.steps.forEach(([a, b, , nm]) => { if (nm && nm !== '-') byName[nm] = (byName[nm] || 0) + (b - a); });
    r.via = Object.entries(byName).sort((a, b) => b[1] - a[1]).slice(0, 1).map((x) => x[0])[0] || '';
    r.tollKm = r.toll.reduce((s, [a, b]) => s + (b - a), 0);
    const n = clampN(Math.round(r.km / 22), 3, 26);
    r.sampleKm = Array.from({ length: n + 1 }, (_, i) => (r.km * i) / n);
  }

  /* ---------- weather at one point (all models → consensus) ---------- */
  const lv = (pair, f) => { const [a, b] = pair || []; if (a == null) return b ?? null; if (b == null) return a; return a + (b - a) * f; };
  function deriveCode(pr, tm, c, cape) {
    if (pr != null && pr >= 0.1) {
      if (cape != null && cape >= 1500 && pr >= 1) return 95;
      if (tm != null && tm <= 0.5) return 73;
      return pr >= 4 ? 65 : pr >= 0.3 ? 61 : 51;
    }
    if (c == null) return null;
    return c < 20 ? 0 : c < 45 ? 1 : c < 75 ? 2 : 3;
  }
  function modelSev(cat, pr, gust, tm, hum) {                    // 0 fine · 1 minor · 2 difficult · 3 dangerous
    let s = 0;
    if (cat === 'drizzle') s = 1;
    else if (cat === 'rain') s = pr >= 4 ? 3 : pr >= 1.5 ? 2 : 1;
    else if (cat === 'snow') s = pr >= 1 ? 3 : 2;
    else if (cat === 'thunder') s = 3;
    else if (cat === 'fog') s = 2;
    if (gust != null) s = Math.max(s, gust >= 80 ? 3 : gust >= 55 ? 2 : gust >= 40 ? 1 : 0);
    if (tm != null && tm <= 1.5 && ((pr != null && pr >= 0.1) || (hum != null && hum >= 92))) s = Math.max(s, 2);   // ice risk
    return s;
  }
  function analyse(pt) {
    if (!pt || !pt.m) return null;
    const f = pt.f, rows = [], seen = new Set();
    for (const id of MODEL_IDS) {
      const m = pt.m[id];
      if (!m) continue;
      const tm = lv(m.temperature_2m, f), pr = lv(m.precipitation, f), g = lv(m.wind_gusts_10m, f), cl = lv(m.cloud_cover, f), cape = lv(m.cape, f), hum = lv(m.relative_humidity_2m, f);
      if (tm == null) continue;
      const sig = [tm, pr, g, cl].map((v) => (v == null ? '' : v.toFixed(1))).join('|');
      if (seen.has(sig)) continue;                               // a model without own data for this place repeats another one
      seen.add(sig);
      let code = (f < 0.5 ? m.weather_code[0] ?? m.weather_code[1] : m.weather_code[1] ?? m.weather_code[0]);
      if (code == null) code = deriveCode(pr, tm, cl, cape);
      const cat = WI.category(code);
      rows.push({ id, tm, pr: pr ?? 0, g, hum, cat, code, day: lv(m.is_day, f), sev: modelSev(cat, pr ?? 0, g, tm, hum) });
    }
    if (!rows.length) return null;
    const n = rows.length, share = {};
    rows.forEach((r) => { share[r.cat] = (share[r.cat] || 0) + 1 / n; });
    const top = Object.entries(share).sort((a, b) => b[1] - a[1])[0];
    const avg = (k) => mean(nn(rows.map((r) => r[k])));
    const code = (() => { const c = {}; rows.filter((r) => r.cat === top[0]).forEach((r) => (c[r.code] = (c[r.code] || 0) + 1)); return +Object.entries(c).sort((a, b) => b[1] - a[1])[0][0]; })();
    const tms = rows.map((r) => r.tm), gs = nn(rows.map((r) => r.g));
    const ice = rows.filter((r) => r.tm <= 1.5 && (r.pr >= 0.1 || (r.hum != null && r.hum >= 92))).length / n;
    const a = {
      n, cat: top[0], agree: top[1], code, share, temp: avg('tm'), tmin: Math.min(...tms), tmax: Math.max(...tms), rain: avg('pr'), gust: gs.length ? mean(gs) : null, gmax: gs.length ? Math.max(...gs) : null,
      sev: mean(rows.map((r) => r.sev)), ice, day: mean(nn(rows.map((r) => r.day))) >= 0.5,
    };
    const sh = (...c) => c.reduce((s, k) => s + (share[k] || 0), 0);
    a.flags = {
      snow: sh('snow') >= 0.4, ice: ice >= 0.5 && sh('snow') < 0.4, thunder: sh('thunder') >= 0.3, fog: sh('fog') >= 0.4,
      rain: sh('rain', 'drizzle') >= 0.5 && a.rain >= 0.2, heavy: a.rain >= 2.5 && sh('rain') >= 0.4, wind: a.gust != null && a.gust >= 55,
    };
    return a;
  }

  /* ---------- analysis of a whole route ---------- */
  function warnings(r) {
    const out = [], half = (r.sampleKm[1] - r.sampleKm[0]) / 2;
    const kinds = [['thunder', 'thunder'], ['snow', 'snow'], ['ice', 'ice'], ['heavy', 'heavy'], ['rain', 'rain'], ['fog', 'fog'], ['wind', 'wind']];
    for (const [kind] of kinds) {
      let i = 0;
      while (i < r.wx.length) {
        if (!r.wx[i] || !r.wx[i].flags[kind]) { i++; continue; }
        let j = i;
        while (j + 1 < r.wx.length && r.wx[j + 1] && r.wx[j + 1].flags[kind]) j++;
        const a = Math.max(0, r.sampleKm[i] - (i ? half : 0)), b = Math.min(r.km, r.sampleKm[j] + (j < r.wx.length - 1 ? half : 0));
        const seg = r.wx.slice(i, j + 1);
        const key = { thunder: 'thunder', snow: 'snow', ice: 'ice', heavy: 'rain', rain: 'rain', fog: 'fog', wind: 'wind' }[kind];
        const agree = Math.round(100 * mean(seg.map((x) => (kind === 'ice' ? x.ice : kind === 'wind' ? Math.min(1, x.gust / 55) : x.share[key === 'rain' ? 'rain' : key] || 0))));
        out.push({ kind, a, b, t0: T.dep + r.timeAt(r.sampleKm[i]), t1: T.dep + r.timeAt(r.sampleKm[j]), agree: clampN(agree, 0, 100), sev: Math.max(...seg.map((x) => x.sev)), max: kind === 'wind' ? Math.max(...seg.map((x) => x.gmax || 0)) : kind === 'heavy' ? Math.max(...seg.map((x) => x.rain)) : null });
        i = j + 1;
      }
    }
    // a heavy-rain stretch is already part of "rain": keep just the stronger message where they overlap
    return out.filter((w) => !(w.kind === 'rain' && out.some((o) => o.kind === 'heavy' && o.a <= w.b && o.b >= w.a))).sort((x, y) => x.a - y.a);
  }
  function score(r) {
    const s = r.wx.filter(Boolean).map((x) => x.sev);
    return s.length ? mean(s) + 0.5 * Math.max(...s) : 0;
  }
  function verdict(r) {
    const s = r.wx.filter(Boolean).map((x) => x.sev), m = s.length ? mean(s) : 0, mx = s.length ? Math.max(...s) : 0;
    return mx < 0.5 && m < 0.3 ? 0 : mx < 1.5 && m < 0.8 ? 1 : mx < 2.3 ? 2 : 3;
  }

  /* ---------- data loading ---------- */
  async function plan() {
    if (!T.from || !T.to) { T.error = { text: t('trip.need') }; render(); return; }
    const token = ++T.token;
    T.error = null; T.routes = []; T.sel = 0;
    T.dep = T.when === 'now' ? Date.now() : (Date.parse($t('tripAt').value) || Date.now());
    T.loading = 'route'; render();
    try { localStorage.setItem('wefo.trip', JSON.stringify({ from: T.from, to: T.to })); } catch (e) { /* ignore */ }
    try {
      const d = await api(`api/route.php?from=${T.from.lat},${T.from.lon}&to=${T.to.lat},${T.to.lon}`);
      if (token !== T.token) return;
      T.routes = d.routes;
      T.routes.forEach(prepRoute);
      T.loading = 'weather'; render();
      await Promise.all(T.routes.map(async (r) => {
        const pts = r.sampleKm.map((km) => `${r.latAt(km).toFixed(2)},${r.lonAt(km).toFixed(2)},${Math.round((T.dep + r.timeAt(km)) / 1000)}`).join(';');
        const w = await api('api/tripweather.php?pts=' + encodeURIComponent(pts));
        r.wx = w.pts.map(analyse);
        r.warn = warnings(r);
        r.score = score(r);
        r.verdict = verdict(r);
      }));
      if (token !== T.token) return;
      const best = T.routes.reduce((b, r, i) => (r.score < T.routes[b].score - 0.05 ? i : b), 0);
      T.routes.forEach((r, i) => { r.best = T.routes.length > 1 && i === best; });
      T.sel = best;
      T.loading = ''; T.mapFitted = false; render();
    } catch (e) {
      if (token !== T.token) return;
      T.loading = ''; T.routes = [];
      const known = { no_key: 'trip.err.nokey', bad_key: 'trip.err.badkey', quota: 'trip.err.quota', no_route: 'trip.err.noroute', same_point: 'trip.err.same', too_far: 'trip.err.toofar' };
      T.error = { text: t(known[e.message] || 'trip.err.generic', { m: e.message }), setup: e.message === 'no_key' };
      render();
    }
  }

  /* ---------- rendering ---------- */
  const wxIcon = (a, big) => (a ? WI.svg(a.code, !a.day, big ? 'tr-ic' : '') : '<span class="na">–</span>');
  const warnText = (w) => {
    const km = `${Math.round(w.a)}–${Math.round(w.b)}`, tm = `${when(w.t0)}${w.t1 - w.t0 > 600e3 ? '–' + timeStr(w.t1) : ''}`;
    return t('trip.w.' + w.kind, { km, t: tm, p: w.agree, v: w.max != null ? Math.round(w.max * 10) / 10 : '' });
  };
  const WARN_ICON = { thunder: '⚡', snow: '❄', ice: '🧊', heavy: '🌧', rain: '☔', fog: '🌫', wind: '💨' };

  function summaryCards() {
    return T.routes.map((r, i) => {
      const arr = T.dep + r.sec * 1000, nW = r.warn ? r.warn.filter((w) => w.sev >= 2).length : 0;
      const strip = r.wx ? r.wx.map((a) => `<i style="background:${a ? sevCol(a.sev) : 'var(--line)'}"></i>`).join('') : '';
      return `<button type="button" class="tr-rc${i === T.sel ? ' on' : ''}" data-r="${i}">
        <span class="tr-rh"><b>${esc(r.via ? t('trip.via', { r: r.via }) : t('trip.route', { n: i + 1 }))}</b>${r.best ? `<em class="tr-best">${esc(t('trip.best'))}</em>` : ''}</span>
        <span class="tr-rs">${kmStr(r.km)} km · ${durStr(r.sec)} · ${esc(t('trip.arrive'))} ${when(arr)}</span>
        <span class="tr-strip">${strip}</span>
        <span class="tr-rv v${r.verdict}">${esc(t('trip.v.' + r.verdict))}${nW ? ` · ${esc(t('trip.nwarn', { n: nW }))}` : ''}</span></button>`;
    }).join('');
  }

  function chart(r) {
    const W = 1000, H = 330, pl = 46, pr = 46, pw = W - pl - pr, top = 20, iconY = 28, plotT = 66, plotB = 232, barT = 244, barB = 292;
    const X = (km) => pl + (km / r.km) * pw;
    const ws = r.wx.map((a, i) => ({ a, km: r.sampleKm[i] }));
    const temps = ws.filter((w) => w.a).flatMap((w) => [w.a.tmin, w.a.tmax]);
    if (!temps.length) return '';
    let lo = Math.floor(Math.min(...temps, 0) / 5) * 5 - 0, hi = Math.ceil(Math.max(...temps, 0) / 5) * 5;
    if (hi - lo < 10) hi = lo + 10;
    const Y = (v) => plotB - ((v - lo) / (hi - lo)) * (plotB - plotT);
    const eles = r.ele[0] == null ? null : r.ele, eMax = eles ? Math.max(...eles, 50) : 0;
    let g = '';
    // weather colour strip
    ws.forEach((w, i) => {
      if (!w.a) return;
      const a = i ? (ws[i - 1].km + w.km) / 2 : 0, b = i < ws.length - 1 ? (w.km + ws[i + 1].km) / 2 : r.km;
      g += `<rect x="${X(a).toFixed(1)}" y="${top - 12}" width="${Math.max(0.5, X(b) - X(a)).toFixed(1)}" height="9" fill="${CAT_COL[w.a.cat]}" opacity="${(0.35 + 0.65 * w.a.agree).toFixed(2)}"/>`;
    });
    // gridlines + temperature axis
    for (let v = lo; v <= hi; v += (hi - lo > 30 ? 10 : 5)) g += `<line x1="${pl}" x2="${W - pr}" y1="${Y(v).toFixed(1)}" y2="${Y(v).toFixed(1)}" class="${v === 0 ? 'zero' : 'gl'}"/><text x="${pl - 6}" y="${(Y(v) + 3.5).toFixed(1)}" text-anchor="end" class="lb">${v}°</text>`;
    // elevation (background)
    if (eles) {
      const pts = r.cum.map((km, i) => `${X(km).toFixed(1)},${(plotB - (eles[i] / eMax) * (plotB - plotT) * 0.55).toFixed(1)}`);
      g += `<polygon points="${X(0).toFixed(1)},${plotB} ${pts.join(' ')} ${X(r.km).toFixed(1)},${plotB}" class="elev"/><text x="${W - pr + 6}" y="${plotB - 2}" class="lb">0 m</text><text x="${W - pr + 6}" y="${(plotB - (plotB - plotT) * 0.55 + 4).toFixed(1)}" class="lb">${Math.round(eMax)} m</text>`;
    }
    // temperature: spread between models + mean
    const okp = ws.filter((w) => w.a);
    g += `<polygon points="${okp.map((w) => `${X(w.km).toFixed(1)},${Y(w.a.tmax).toFixed(1)}`).join(' ')} ${okp.slice().reverse().map((w) => `${X(w.km).toFixed(1)},${Y(w.a.tmin).toFixed(1)}`).join(' ')}" class="tband"/>`;
    g += `<polyline points="${okp.map((w) => `${X(w.km).toFixed(1)},${Y(w.a.temp).toFixed(1)}`).join(' ')}" class="tline"/>`;
    okp.forEach((w) => { g += `<circle cx="${X(w.km).toFixed(1)}" cy="${Y(w.a.temp).toFixed(1)}" r="3" class="tdot" style="stroke:${sevCol(w.a.sev)}"/>`; });
    // weather icons
    let lastX = -99;
    okp.forEach((w) => {
      const x = X(w.km);
      if (x - lastX < 44) return;
      lastX = x;
      g += WI.svg(w.a.code, !w.a.day).replace('<svg ', `<svg x="${(x - 14).toFixed(1)}" y="${iconY}" width="28" height="28" `);
    });
    // precipitation bars
    const pMax = Math.max(2, ...okp.map((w) => w.a.rain));
    g += `<line x1="${pl}" x2="${W - pr}" y1="${barB}" y2="${barB}" class="gl"/><text x="${pl - 6}" y="${barB + 3}" text-anchor="end" class="lb">0</text><text x="${pl - 6}" y="${barT + 8}" text-anchor="end" class="lb">${Math.round(pMax)}</text><text x="${W - pr + 6}" y="${barT + 8}" class="lb">mm/h</text>`;
    const bw = Math.max(3, Math.min(22, (pw / ws.length) * 0.7));
    okp.forEach((w) => { const h = Math.max(w.a.rain > 0.02 ? 2 : 0, (clampN(w.a.rain, 0, pMax) / pMax) * (barB - barT)); g += `<rect x="${(X(w.km) - bw / 2).toFixed(1)}" y="${(barB - h).toFixed(1)}" width="${bw.toFixed(1)}" height="${h.toFixed(1)}" rx="2" fill="${w.a.cat === 'snow' ? CAT_COL.snow : CAT_COL.rain}" opacity="${(0.45 + 0.5 * Math.min(1, w.a.agree)).toFixed(2)}"/>`; });
    // x axis: kilometres and the clock time there
    const step = r.km > 600 ? 100 : r.km > 250 ? 50 : r.km > 100 ? 25 : r.km > 40 ? 10 : 5;
    for (let k = 0; k <= r.km + 0.01; k += step) g += `<line x1="${X(k).toFixed(1)}" x2="${X(k).toFixed(1)}" y1="${plotT}" y2="${barB + 4}" class="gl v"/><text x="${X(k).toFixed(1)}" y="${barB + 18}" text-anchor="middle" class="lb">${k}</text><text x="${X(k).toFixed(1)}" y="${barB + 31}" text-anchor="middle" class="lb tm">${timeStr(T.dep + r.timeAt(k))}</text>`;
    g += `<text x="${pl - 6}" y="${barB + 18}" text-anchor="end" class="lb">km</text>`;
    g += `<line id="trCur" x1="0" x2="0" y1="${plotT - 4}" y2="${barB + 4}" class="cur" visibility="hidden"/><rect id="trHit" x="${pl}" y="0" width="${pw}" height="${H}" fill="transparent"/>`;
    return `<div class="tr-chart"><svg viewBox="0 0 ${W} ${H}" id="trSvg" role="img" aria-label="${esc(t('trip.chart'))}">${g}</svg><div id="trTip" class="tr-tip" hidden></div></div>`;
  }

  function stages(r) {
    return r.wx.map((a, i) => {
      const km = r.sampleKm[i], tm = T.dep + r.timeAt(km), nm = r.nameAt(km), el = r.eleAt(km);
      const fl = a ? Object.entries(a.flags).filter(([, v]) => v).map(([k]) => `<span class="tr-fl ${k}">${WARN_ICON[k] || ''} ${esc(t('trip.f.' + k))}</span>`).join('') : '';
      return `<div class="tr-st" data-i="${i}">
        <div class="tr-c1"><b>${when(tm)}</b><small>${t('trip.km', { n: Math.round(km) })}${el != null ? ` · ${Math.round(el)} m` : ''}</small></div>
        <div class="tr-c2">${a ? wxIcon(a, true) : ''}<span><b>${a ? esc(t('cat.' + a.cat)) : '–'}</b><small>${a ? esc(t('trip.agree', { p: Math.round(a.agree * 100), n: a.n })) : esc(t('trip.nodata'))}${nm ? ` · ${esc(nm)}` : ''}</small></span></div>
        <div class="tr-c3">${a ? `<span title="${esc(t('trip.tspread'))}"><b>${Math.round(a.temp)}°</b> <small>${Math.round(a.tmin)}…${Math.round(a.tmax)}°</small></span><span><b>${a.rain >= 0.05 ? a.rain.toFixed(1) : '0'}</b> <small>mm/h</small></span><span><b>${a.gust != null ? Math.round(a.gust) : '–'}</b> <small>km/h</small></span>` : ''}</div>
        <div class="tr-c4">${fl}</div></div>`;
    }).join('');
  }

  function render() {
    const box = $t('tripOut');
    if (!box) return;
    if (T.map) { T.map.remove(); T.map = null; }
    const hint = $t('tripHint');
    if (hint) hint.hidden = !!(T.routes.length || T.loading || T.error);
    if (T.loading) { box.innerHTML = `<div class="loading"><div class="spinner"></div><span>${esc(t(T.loading === 'route' ? 'trip.finding' : 'trip.fetching'))}</span></div>`; return; }
    if (T.error) { box.innerHTML = `<div class="notice error">${esc(T.error.text)}</div>${T.error.setup ? `<div class="notice tr-setup">${t('trip.setup')}</div>` : ''}`; return; }
    if (!T.routes.length) { box.innerHTML = ''; return; }
    const r = T.routes[T.sel], arr = T.dep + r.sec * 1000, v = r.verdict;
    const tolls = r.tollKm >= 0.5 ? `<div class="tr-k"><span>${esc(t('trip.toll'))}</span><b>${t('trip.tollkm', { n: kmStr(r.tollKm) })}</b></div>` : '';
    box.innerHTML = `
      <section class="card tr-sum">
        <div class="tr-title"><h2>${esc(T.from.name)} <span>→</span> ${esc(T.to.name)}</h2><span class="meta">${esc(T.when === 'now' ? t('trip.now') + ' · ' + timeStr(T.dep) : when(T.dep))}</span></div>
        <div class="tr-kpis">
          <div class="tr-k"><span>${esc(t('trip.dist'))}</span><b>${kmStr(r.km)} km</b></div>
          <div class="tr-k"><span>${esc(t('trip.dur'))}</span><b>${durStr(r.sec)}</b></div>
          <div class="tr-k"><span>${esc(t('trip.arrive'))}</span><b>${when(arr)}</b></div>
          ${r.ascent != null ? `<div class="tr-k"><span>${esc(t('trip.climb'))}</span><b>↑ ${r.ascent} m · ↓ ${r.descent} m</b></div>` : ''}
          ${tolls}
          <div class="tr-k"><span>${esc(t('trip.cost'))}</span><b class="na">${esc(t('trip.cost.na'))}</b></div>
        </div>
        ${T.routes.length > 1 ? `<div class="tr-rcs">${summaryCards()}</div>` : ''}
      </section>
      <div class="tr-grid">
        <section class="card tr-mapc"><div id="tripMap" class="tr-map"></div></section>
        <section class="card tr-wx">
          <div class="tr-verdict v${v}"><b>${esc(t('trip.v.' + v))}</b><span>${esc(t('trip.vd.' + v))}</span></div>
          <h3>${esc(t('trip.warnings'))}</h3>
          ${r.warn.length ? `<ul class="tr-warn">${r.warn.slice(0, 9).map((w) => `<li class="s${Math.min(3, Math.round(w.sev))}"><i>${WARN_ICON[w.kind] || '•'}</i><span>${esc(warnText(w))}</span></li>`).join('')}</ul>` : `<p class="hint">${esc(t('trip.nowarn'))}</p>`}
          <p class="hint">${esc(t('trip.basis', { n: r.wx.find((x) => x) ? r.wx.find((x) => x).n : 0 }))}</p>
        </section>
      </div>
      <section class="card tr-tl"><h3>${esc(t('trip.timeline'))}</h3>${chart(r)}
        <p class="hint">${esc(t('trip.chart.note'))}</p></section>
      <section class="card tr-stages"><h3>${esc(t('trip.stages'))}</h3><div class="tr-sh"><span>${esc(t('trip.col.when'))}</span><span>${esc(t('trip.col.wx'))}</span><span>${esc(t('trip.col.nums'))}</span><span></span></div>${stages(r)}
        <p class="hint">${t('trip.note')}</p></section>`;
    box.querySelectorAll('.tr-rc').forEach((b) => b.addEventListener('click', () => { T.sel = +b.dataset.r; T.mapFitted = false; render(); }));
    drawMap();
    bindChart(r);
  }

  /* ---------- map ---------- */
  function drawMap() {
    const el = $t('tripMap'), r = T.routes[T.sel];
    if (!el || !r) return;
    T.map = L.map(el, { zoomControl: true, scrollWheelZoom: true });
    L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 18, attribution: '© OpenStreetMap' }).addTo(T.map);
    const grp = L.layerGroup().addTo(T.map);
    // the other routes, thin and grey (click to choose)
    T.routes.forEach((o, i) => {
      if (i === T.sel) return;
      L.polyline(o.pts, { color: '#7b8aa3', weight: 5, opacity: 0.55 }).on('click', () => { T.sel = i; render(); }).addTo(grp);
    });
    // the chosen one: a casing, then a colour per stretch by how bad the weather is there
    L.polyline(r.pts, { color: '#0b1220', weight: 9, opacity: 0.45 }).addTo(grp);
    const seg = r.sampleKm.length - 1;
    for (let i = 0; i < seg; i++) {
      const a = r.sampleKm[i], b = r.sampleKm[i + 1];
      const idx = r.cum.map((k, j) => [k, j]).filter(([k]) => k >= a - 0.01 && k <= b + 0.01).map(([, j]) => r.pts[j]);
      if (idx.length < 2) continue;
      const s = r.wx[i] && r.wx[i + 1] ? (r.wx[i].sev + r.wx[i + 1].sev) / 2 : r.wx[i] ? r.wx[i].sev : 0;
      L.polyline(idx, { color: sevCol(s), weight: 5.5, opacity: 1, lineCap: 'round' }).addTo(grp);
    }
    const mk = (ll, txt, c) => L.marker(ll, { icon: L.divIcon({ className: '', html: `<span class="tr-pin" style="background:${c}">${txt}</span>`, iconSize: [26, 26], iconAnchor: [13, 13] }) }).addTo(grp);
    mk(r.pts[0], 'A', '#2563eb'); mk(r.pts[r.pts.length - 1], 'B', '#dc2626');
    const every = Math.ceil(r.sampleKm.length / 9);
    r.sampleKm.forEach((km, i) => {
      const a = r.wx[i];
      if (!a || i === 0 || i === r.sampleKm.length - 1 || i % every) return;
      L.marker([r.latAt(km), r.lonAt(km)], { icon: L.divIcon({ className: 'tr-wxm', html: `<span class="tr-wxi" style="border-color:${sevCol(a.sev)}">${WI.svg(a.code, !a.day)}<small>${Math.round(a.temp)}°</small></span>`, iconSize: [42, 42], iconAnchor: [21, 21] }) })
        .bindTooltip(`${when(T.dep + r.timeAt(km))} · ${t('cat.' + a.cat)} · ${t('trip.agree', { p: Math.round(a.agree * 100), n: a.n })}`).addTo(grp);
    });
    T.hover = L.circleMarker(r.pts[0], { radius: 7, color: '#fff', weight: 2, fillColor: '#2563eb', fillOpacity: 1, interactive: false });
    T.map.fitBounds(L.latLngBounds(r.pts), { padding: [28, 28] });
    setTimeout(() => T.map && T.map.invalidateSize(), 60);
  }

  /* ---------- chart hover ---------- */
  function bindChart(r) {
    const svg = $t('trSvg'), hit = $t('trHit'), tip = $t('trTip'), cur = $t('trCur');
    if (!svg || !hit) return;
    const W = 1000, pl = 46, pr = 46, pw = W - pl - pr;
    const move = (e) => {
      const rc = svg.getBoundingClientRect(), x = ((e.clientX - rc.left) / rc.width) * W;
      const km = clampN(((x - pl) / pw) * r.km, 0, r.km);
      let bi = 0; r.sampleKm.forEach((k, i) => { if (Math.abs(k - km) < Math.abs(r.sampleKm[bi] - km)) bi = i; });
      const a = r.wx[bi];
      const cx = pl + (km / r.km) * pw;
      cur.setAttribute('x1', cx); cur.setAttribute('x2', cx); cur.setAttribute('visibility', 'visible');
      tip.hidden = false;
      tip.innerHTML = `<b>${when(T.dep + r.timeAt(km))}</b> · ${t('trip.km', { n: Math.round(km) })}${a ? `<br>${esc(t('cat.' + a.cat))} (${Math.round(a.agree * 100)}%) · ${Math.round(a.temp)}° · ${a.rain >= 0.05 ? a.rain.toFixed(1) : '0'} mm/h · ${a.gust != null ? Math.round(a.gust) : '–'} km/h` : ''}`;
      const left = (cx / W) * rc.width;
      tip.style.left = Math.min(Math.max(left, 90), rc.width - 90) + 'px';
      if (T.map && T.hover) { T.hover.setLatLng([r.latAt(km), r.lonAt(km)]); if (!T.map.hasLayer(T.hover)) T.hover.addTo(T.map); }
    };
    const leave = () => { cur.setAttribute('visibility', 'hidden'); tip.hidden = true; if (T.map && T.hover && T.map.hasLayer(T.hover)) T.map.removeLayer(T.hover); };
    hit.addEventListener('mousemove', move); hit.addEventListener('mouseleave', leave);
    hit.addEventListener('touchmove', (e) => { if (e.touches[0]) move(e.touches[0]); }, { passive: true }); hit.addEventListener('touchend', leave);
  }

  /* ---------- place pickers ---------- */
  function bindPicker(inputId, listId, key) {
    const inp = $t(inputId), box = $t(listId);
    let timer = null;
    const set = (loc) => { T[key] = loc; inp.value = loc ? loc.name : ''; box.hidden = true; };
    const local = (q) => {
      const ql = q.toLowerCase();
      return (typeof allLocations === 'function' ? allLocations() : []).filter((l) => l.lat != null && (locName(l).toLowerCase().includes(ql) || (l.name || '').toLowerCase().includes(ql))).slice(0, 4).map((l) => ({ name: locName(l), lat: +l.lat, lon: +l.lon }));
    };
    const show = (res) => {
      box._res = res;
      box.innerHTML = res.length ? res.map((r, i) => `<li data-i="${i}">${esc(r.name)}</li>`).join('') : `<li>${esc(t('search.none'))}</li>`;
      box.hidden = false;
    };
    inp.addEventListener('input', () => {
      T[key] = null;
      clearTimeout(timer);
      const q = inp.value.trim();
      if (q.length < 2) { box.hidden = true; return; }
      timer = setTimeout(async () => {
        const loc = local(q);
        try {
          const res = await api(`api/geocode.php?lang=${LANG}&q=` + encodeURIComponent(q));
          if (inp.value.trim() !== q) return;
          const seen = new Set(loc.map((l) => l.name));
          show([...loc, ...res.filter((r) => !seen.has(r.name)).map((r) => ({ name: r.name.split(',').slice(0, 2).join(',').trim(), lat: +r.lat, lon: +r.lon }))]);
        } catch (e) { show(loc); }
      }, 300);
    });
    box.addEventListener('click', (e) => { const li = e.target.closest('li[data-i]'); if (li) set(box._res[+li.dataset.i]); });
    document.addEventListener('click', (e) => { if (!e.target.closest('.tf')) box.hidden = true; });
    inp.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); if (!box.hidden && box._res && box._res[0] && !T[key]) set(box._res[0]); plan(); } });
    return set;
  }

  /* ---------- wiring ---------- */
  function init() {
    if (!$t('view-trip')) return;
    const setFrom = bindPicker('tripFrom', 'tripFromRes', 'from'), setTo = bindPicker('tripTo', 'tripToRes', 'to');
    try { const s = JSON.parse(localStorage.getItem('wefo.trip') || 'null'); if (s && s.from && s.to) { setFrom(s.from); setTo(s.to); } } catch (e) { /* ignore */ }
    $t('tripSwap').addEventListener('click', () => { const a = T.from, b = T.to; setFrom(b); setTo(a); });
    $t('tripGeo').addEventListener('click', () => {
      if (!navigator.geolocation) return;
      navigator.geolocation.getCurrentPosition(async (p) => {
        const lat = +p.coords.latitude.toFixed(4), lon = +p.coords.longitude.toFixed(4);
        let name = t('trip.myloc');
        try { const r = await api(`api/geocode.php?lat=${lat}&lon=${lon}&lang=${LANG}`); if (r.name) name = r.name.split(',')[0]; } catch (e) { /* ignore */ }
        setFrom({ name, lat, lon });
      }, () => { /* refused: nothing to do */ });
    });
    const at = $t('tripAt'), sel = $t('tripWhen');
    const pad = (n) => String(n).padStart(2, '0');
    const loc = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
    const lim = () => { const n = new Date(); at.min = loc(n); at.max = loc(new Date(n.getTime() + 6 * 86400e3)); if (!at.value) at.value = loc(new Date(n.getTime() + 3600e3)); };
    sel.addEventListener('change', () => { T.when = sel.value; at.hidden = sel.value === 'now'; lim(); });
    $t('tripGo').addEventListener('click', plan);
  }
  function show() { if (T.map) setTimeout(() => T.map && T.map.invalidateSize(), 50); }
  return { init, render, show };
})();
Trip.init();
