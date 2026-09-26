'use strict';

/* ================= Helpers ================= */
const $ = (id) => document.getElementById(id);
const clamp = (x, a = 0, b = 1) => Math.min(b, Math.max(a, x));
const nn = (arr) => arr.filter((x) => x != null && !Number.isNaN(x));
const mean = (a) => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : null);
const fmt = (v, d = 0) => (v == null ? '–' : Number(v).toFixed(d).replace(/^-0$/, '0'));
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

async function api(path, opts) {
  const res = await fetch(path, opts);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || t('err.http', { s: res.status }));
  return data;
}

const state = { locations: [], current: null, data: null, verify: null, weighted: true, day: 0, step: 1, param: 'weather', token: 0 };
try { state.weighted = localStorage.getItem('wefo.weighted') !== '0'; } catch (e) { /* ignore */ }
// Προτιμήσεις ανά χρήστη/browser (localStorage): μοντέλα που έχουν απενεργοποιηθεί
state.disabled = new Set();
try { state.disabled = new Set(JSON.parse(localStorage.getItem('wefo.disabled') || '[]')); } catch (e) { /* ignore */ }
// Πάροχοι με ταυτόσημα δεδομένα με άλλον (p.dupOf) μετρούν μόνο μία φορά
const uniqueProviders = () => state.data.providers.filter((p) => !p.dupOf);
const MODEL_NAMES = {
  ecmwf_ifs025: 'ECMWF IFS', gfs_seamless: 'NOAA GFS', icon_seamless: 'DWD ICON', gem_seamless: 'Environment Canada GEM',
  meteofrance_seamless: 'Météo-France', ukmo_seamless: 'UK Met Office', jma_seamless: 'JMA (Japan)', cma_grapes_global: 'CMA GRAPES (China)',
  bom_access_global: 'BOM ACCESS (Australia)', knmi_seamless: 'KNMI (Netherlands)', dmi_seamless: 'DMI (Denmark)', metno_seamless: 'MET Norway (Nordic)', yr: 'MET Norway / Yr',
};
const nameById = (id) => (hasT('mn.' + id) ? t('mn.' + id) : MODEL_NAMES[id] || id);
const pname = (p) => nameById(p.id);
const activeProviders = () => {
  const all = uniqueProviders(), act = all.filter((p) => !state.disabled.has(p.id));
  return act.length ? act : all;   // ποτέ κενό σύνολο
};

/* ================= Προετοιμασία δεδομένων ================= */
function deriveCode(p, i) {
  const h = p.hourly, pr = h.precipitation[i], t = h.temperature_2m[i], c = h.cloud_cover[i], cape = h.cape[i];
  if (pr != null && pr >= 0.1) {
    if (cape != null && cape >= 1500 && pr >= 1) return 95;
    if (t != null && t <= 0.5) return 73;
    return pr >= 4 ? 65 : pr >= 0.3 ? 61 : 51;
  }
  if (c == null) return null;
  return c < 20 ? 0 : c < 45 ? 1 : c < 75 ? 2 : 3;
}

function prepare(data) {
  const n = data.time.length;
  data.providers.forEach((p) => {
    p.hourly.code = p.hourly.weather_code.map((c, i) => (c != null ? c : deriveCode(p, i)));
  });
  // Μοντέλα εκτός περιοχής κάλυψης επιστρέφουν αντίγραφο ενός άλλου μοντέλου: εντοπισμός ταυτόσημων προβλέψεων
  const seen = new Map();
  data.providers.forEach((p) => {
    const sig = ['temperature_2m', 'precipitation', 'wind_speed_10m', 'pressure_msl'].map((k) => p.hourly[k].join(',')).join('|');
    if (seen.has(sig)) p.dupOf = seen.get(sig); else seen.set(sig, p.id);
  });
  data.isDay = Array.from({ length: n }, (_, i) => {
    for (const p of data.providers) if (p.hourly.is_day[i] != null) return p.hourly.is_day[i];
    const hr = +data.time[i].slice(11, 13);
    return hr >= 7 && hr < 20 ? 1 : 0;
  });
  data.dates = [...new Set(data.time.map((t) => t.slice(0, 10)))];
  return data;
}

/* Συνάθροιση ενός παρόχου σε ένα βήμα (ώρες a..b) */
function circMean(dirs, weights) {
  let x = 0, y = 0;
  dirs.forEach((d, i) => { const w = weights[i] || 1; x += Math.cos(d * Math.PI / 180) * w; y += Math.sin(d * Math.PI / 180) * w; });
  return (Math.atan2(y, x) * 180 / Math.PI + 360) % 360;
}
function agg(p, param, a, b) {
  const h = p.hourly, sl = (arr) => nn(arr.slice(a, b));
  switch (param) {
    case 'precip': { const v = sl(h.precipitation); return v.length ? v.reduce((s, x) => s + x, 0) : null; }
    case 'gust': { const v = sl(h.wind_gusts_10m); return v.length ? Math.max(...v) : null; }
    case 'cape': { const v = sl(h.cape); return v.length ? Math.max(...v) : null; }
    case 'code': { const v = sl(h.code); return v.length ? Math.max(...v) : null; }
    case 'dir': {
      const idx = []; for (let i = a; i < b; i++) if (h.wind_direction_10m[i] != null) idx.push(i);
      return idx.length ? circMean(idx.map((i) => h.wind_direction_10m[i]), idx.map((i) => h.wind_speed_10m[i] || 1)) : null;
    }
    default: { const v = sl(h[param]); return mean(v); }
  }
}

/* ================= Χρωματισμός ================= */
const heat = (t, h1, h2, alpha = 0.3) => `hsla(${h1 + (h2 - h1) * clamp(t)},78%,52%,${alpha})`;
const bgTemp = (v) => (v == null ? '' : heat((v + 5) / 45, 220, 0));
const bgWind = (v) => (v == null ? '' : heat(v / 60, 170, 10));
const bgCloud = (v) => (v == null ? '' : `hsla(215,18%,55%,${0.04 + clamp(v / 100) * 0.34})`);
const bgHum = (v) => (v == null ? '' : `hsla(200,80%,50%,${0.03 + clamp(v / 100) * 0.3})`);
const bgPress = (v) => (v == null ? '' : heat((v - 990) / 50, 260, 120, 0.2));
const bgRain = (v, step) => (v == null || v < 0.05 ? '' : `hsla(215,85%,50%,${0.12 + clamp(v / (step * 2.5)) * 0.5})`);

/* ================= Παράμετροι ================= */
// Τυπική απόκλιση μεταξύ παρόχων στην οποία η συμφωνία μηδενίζεται
const TOL = { temperature_2m: 4, wind_speed_10m: 15, cloud_cover: 50, relative_humidity_2m: 25, pressure_msl: 4 };
const RAIN_THR = 0.2;   // mm ανά βήμα για να θεωρηθεί «βροχή»
const WIND_THR = 30;    // km/h (5 μποφόρ)

const PARAMS = {
  weather: {  },
  temperature_2m: { unit: '°C', d: 1, bg: bgTemp },
  precip: {  },
  wind: {  },
  storm: {  },
  cloud_cover: { unit: '%', d: 0, bg: bgCloud },
  relative_humidity_2m: { unit: '%', d: 0, bg: bgHum },
  pressure_msl: { unit: ' hPa', d: 0, bg: bgPress },
  reliability: {  },
};

const agreementPill = (vals, tol) => {
  if (vals.length < 2) return '<span class="na">–</span>';
  const m = mean(vals), sd = Math.sqrt(mean(vals.map((x) => (x - m) ** 2)));
  const a = Math.round(clamp(1 - sd / tol) * 100);
  return `<span class="pill ${a >= 75 ? 'hi' : a >= 50 ? 'mid' : 'lo'}">${a}%</span>`;
};

/* ================= Κατασκευή πίνακα ================= */
function columns() {
  const { data, day, step } = state;
  const base = day * 24, cols = [];
  const nowStr = new Date(Date.now() + data.utc_offset_seconds * 1000).toISOString().slice(0, 13);
  for (let s = 0; s < 24; s += step) {
    const a = base + s, b = Math.min(base + s + step, data.time.length);
    if (a >= data.time.length) break;
    const last = data.time[b - 1].slice(0, 13);
    cols.push({
      a, b,
      label: step > 1 ? `${data.time[a].slice(11, 13)}–${String((+data.time[a].slice(11, 13) + step) % 24).padStart(2, '0')}` : data.time[a].slice(11, 16),
      past: last < nowStr,
      now: data.time[a].slice(0, 13) <= nowStr && nowStr <= last,
      night: data.isDay[Math.min(a + Math.floor(step / 2), b - 1)] === 0,
    });
  }
  return cols;
}

const cell = (html, bg = '', cls = '') => ({ html, bg, cls });

/* Reliability weighting: κάθε πάροχος έχει βάρος ανά παράμετρο (1 = ουδέτερο) */
const weightsOn = () => state.weighted && !!state.verify;
const W = (p, key) => (weightsOn() && state.verify.models[p.id]?.weights?.[key]) || 1;
const wpairs = (key, fn) => activeProviders().map((p) => ({ v: fn(p), w: W(p, key) })).filter((x) => x.v != null && !Number.isNaN(x.v));
const wsum = (pr) => pr.reduce((a, x) => a + x.w, 0);
const wmean = (pr) => (pr.length ? pr.reduce((a, x) => a + x.v * x.w, 0) / wsum(pr) : null);
const wshare = (pr, f) => (pr.length ? pr.filter((x) => f(x.v)).reduce((a, x) => a + x.w, 0) / wsum(pr) : null);

function buildRows(param, cols) {
  const { data, step } = state;
  const P = activeProviders();
  const rows = [];   // ενδιάμεσες γραμμές παρόχων
  let summary, prob, summaryLabel, probLabel;

  const perProvider = (fn) => P.map((p) => ({ name: pname(p), id: p.id, cells: cols.map((c) => fn(p, c)) }))
    .filter((r) => r.cells.some((c) => c.has));

  if (param === 'weather') {
    rows.push(...perProvider((p, c) => {
      const code = agg(p, 'code', c.a, c.b), t = agg(p, 'temperature_2m', c.a, c.b);
      return { has: code != null, html: code == null ? '<span class="na">–</span>' : `${WI.svg(code, c.night)}<small>${fmt(t)}°</small>`, cls: 'cell' };
    }));
    summaryLabel = t('g.temp_avg');
    summary = cols.map((c) => {
      const m = wmean(wpairs('temperature_2m', (p) => agg(p, 'temperature_2m', c.a, c.b)));
      return cell(`<b>${fmt(m)}°</b>`, bgTemp(m));
    });
    probLabel = t('g.prob_weather');
    prob = cols.map((c) => {
      const pr = wpairs('weather', (p) => { const code = agg(p, 'code', c.a, c.b); return code == null ? null : WI.category(code); });
      if (!pr.length) return cell('–');
      const tot = wsum(pr), cnt = {}; pr.forEach((x) => (cnt[x.v] = (cnt[x.v] || 0) + x.w));
      const sorted = Object.entries(cnt).sort((x, y) => y[1] - x[1]);
      const top = sorted[0][0];
      // Όλες οι κατηγορίες που προβλέπουν τα μοντέλα, με το ποσοστό τους
      const lines = sorted.slice(0, 4).map(([k, w], i) => `<div class="wline${i === 0 ? ' top' : ''}">${WI.svg(WI.CAT_CODE[k], c.night, 'mini')}<span>${t('cat.' + k)}</span><b>${Math.round(w / tot * 100)}%</b></div>`).join('');
      return cell(`${WI.svg(WI.CAT_CODE[top], c.night, 'big')}<div class="wlist">${lines}</div>`);
    });
  } else if (param === 'precip') {
    rows.push(...perProvider((p, c) => {
      const v = agg(p, 'precip', c.a, c.b);
      return { has: v != null, html: v == null ? '<span class="na">–</span>' : v < 0.05 ? '<span class="na">0</span>' : fmt(v, 1), bg: bgRain(v, step), cls: 'cell' };
    }));
    summaryLabel = t('g.avg_mm');
    summary = cols.map((c) => {
      const v = nn(P.map((p) => agg(p, 'precip', c.a, c.b)));
      const m = wmean(wpairs('precip', (p) => agg(p, 'precip', c.a, c.b)));
      return cell(v.length ? `<b>${fmt(m, 1)}</b><small>${t('g.upto', { v: fmt(Math.max(...v), 1) })}</small>` : '–', bgRain(m, step));
    });
    probLabel = t('g.prob_rain');
    prob = cols.map((c) => {
      const v = nn(P.map((p) => agg(p, 'precip', c.a, c.b)));
      if (!v.length) return cell('–');
      const pr = wshare(wpairs('precip', (p) => agg(p, 'precip', c.a, c.b)), (x) => x >= RAIN_THR);
      return cell(`<div class="pct">${Math.round(pr * 100)}%</div>`, `hsla(215,85%,50%,${pr * 0.55})`);
    });
  } else if (param === 'wind') {
    rows.push(...perProvider((p, c) => {
      const s = agg(p, 'wind_speed_10m', c.a, c.b), g = agg(p, 'gust', c.a, c.b), d = agg(p, 'dir', c.a, c.b);
      return { has: s != null, html: s == null ? '<span class="na">–</span>' : `${d != null ? WI.arrow(d) : ''}${fmt(s)}${g != null ? `<small>(${fmt(g)})</small>` : ''}`, bg: bgWind(s), cls: 'cell' };
    }));
    summaryLabel = t('g.avg_kmh');
    summary = cols.map((c) => {
      const v = nn(P.map((p) => agg(p, 'wind_speed_10m', c.a, c.b)));
      const dirs = P.map((p) => agg(p, 'dir', c.a, c.b));
      const dd = nn(dirs);
      const m = wmean(wpairs('wind', (p) => agg(p, 'wind_speed_10m', c.a, c.b)));
      return cell(v.length ? `<b>${dd.length ? WI.arrow(circMean(dd, dd.map(() => 1))) : ''}${fmt(m)}</b><small>${fmt(Math.min(...v))}–${fmt(Math.max(...v))}</small>` : '–', bgWind(m));
    });
    probLabel = t('g.prob_wind', { v: WIND_THR });
    prob = cols.map((c) => {
      const v = nn(P.map((p) => agg(p, 'wind_speed_10m', c.a, c.b)));
      if (!v.length) return cell('–');
      const pr = wshare(wpairs('wind', (p) => agg(p, 'wind_speed_10m', c.a, c.b)), (x) => x >= WIND_THR);
      const g = nn(P.map((p) => agg(p, 'gust', c.a, c.b)));
      const gp = g.length ? `<small>${t('g.gusts', { v: Math.round(g.filter((x) => x >= 60).length / g.length * 100) })}</small>` : '';
      return cell(`<div class="pct">${Math.round(pr * 100)}%</div>${gp}`, `hsla(170,70%,40%,${pr * 0.5})`);
    });
  } else if (param === 'storm') {
    const signal = (p, c) => {
      const code = agg(p, 'code', c.a, c.b), cape = agg(p, 'cape', c.a, c.b);
      const raw = p.hourly.weather_code.slice(c.a, c.b).some((x) => x != null);
      const thunder = raw ? code >= 95 : null;
      if (thunder == null && cape == null) return { s: null, cape };
      return { s: thunder ? 1 : cape != null && cape >= 1000 ? 0.5 : 0, cape };
    };
    rows.push(...perProvider((p, c) => {
      const { s, cape } = signal(p, c);
      const html = s == null ? '<span class="na">–</span>' : `${s === 1 ? WI.bolt24 + ' ' : ''}${cape != null ? fmt(cape) : ''}<small>${s === 1 ? t('g.storm_yes') : s === 0.5 ? t('g.storm_maybe') : cape != null ? 'J/kg' : t('g.storm_no')}</small>`;
      return { has: s != null, html, bg: s ? `hsla(35,95%,50%,${0.15 + s * 0.4})` : '', cls: 'cell' };
    }));
    summaryLabel = t('g.cape_avg');
    summary = cols.map((c) => {
      const v = nn(P.map((p) => agg(p, 'cape', c.a, c.b)));
      return cell(v.length ? `<b>${fmt(mean(v))}</b>` : '–');
    });
    probLabel = t('g.prob_storm');
    prob = cols.map((c) => {
      const pw = wpairs('storm', (p) => signal(p, c).s);
      if (!pw.length) return cell('–');
      const pr = wmean(pw);
      return cell(`${pr >= 0.5 ? WI.bolt24 + ' ' : ''}<div class="pct" style="display:inline">${Math.round(pr * 100)}%</div>`, `hsla(35,95%,50%,${pr * 0.6})`);
    });
  } else {
    const def = PARAMS[param];
    rows.push(...perProvider((p, c) => {
      const v = agg(p, param, c.a, c.b);
      return { has: v != null, html: v == null ? '<span class="na">–</span>' : fmt(v, def.d) + (def.unit === '°C' ? '°' : ''), bg: def.bg(v), cls: 'cell' };
    }));
    summaryLabel = def.unit === '%' ? t('g.avg_pct') : def.unit === '°C' ? t('g.avg_c') : t('g.avg_hpa');
    summary = cols.map((c) => {
      const v = nn(P.map((p) => agg(p, param, c.a, c.b)));
      const m = wmean(wpairs(param, (p) => agg(p, param, c.a, c.b)));
      return cell(v.length ? `<b>${fmt(m, def.d)}${def.unit === '°C' ? '°' : ''}</b><small>${fmt(Math.min(...v), def.d)}–${fmt(Math.max(...v), def.d)}</small>` : '–', def.bg(m));
    });
    probLabel = t('g.agree');
    prob = cols.map((c) => {
      const v = nn(P.map((p) => agg(p, param, c.a, c.b)));
      const sd = v.length > 1 ? Math.sqrt(mean(v.map((x) => (x - mean(v)) ** 2))) : 0;
      return cell(`${agreementPill(v, TOL[param])}${param === 'temperature_2m' && v.length > 1 ? `<small>±${fmt(sd, 1)}°</small>` : ''}`);
    });
  }
  return { rows, summary, prob, summaryLabel, probLabel };
}

/* Centers οριζόντια την τρέχουσα ώρα/διάστημα όταν ο πίνακας έχει scroll */
function centerNow() {
  const wrap = document.querySelector('.table-wrap'), th = document.querySelector('#grid thead th.now'), first = document.querySelector('#grid thead .rowh');
  if (!wrap) return;
  if (!th || wrap.scrollWidth <= wrap.clientWidth) { wrap.scrollLeft = 0; return; }
  const w = wrap.getBoundingClientRect(), t = th.getBoundingClientRect();
  const visible = wrap.clientWidth - first.offsetWidth;   // η πρώτη στήλη μένει καρφωμένη
  wrap.scrollLeft = Math.max(0, wrap.scrollLeft + (t.left - w.left) - first.offsetWidth - (visible - t.width) / 2);
}

const scoreCls = (v) => (v >= 80 ? 'hi' : v >= 60 ? 'mid' : 'lo');

function renderReliability() {
  const v = state.verify;
  if (!v) {
    $('grid').innerHTML = `<tbody><tr><td class="pad">${state.verifyErr ? esc(t('r.unavailable', { e: state.verifyErr })) : t('r.loading')}</td></tr></tbody>`;
    $('legend').textContent = '';
    $('relNote').hidden = true;
    return;
  }
  const ids = Object.entries(v.models).sort((a, b) => (b[1].score ?? -1) - (a[1].score ?? -1));
  const src = (label, value, extra = '', cls = '') => `<div class="src ${cls}"><i>${label}</i> <b>${value}</b>${extra}</div>`;
  const mae = (m, k, d = 1) => {
    if (m.mae[k] == null) return '–';
    const o = m.obs?.mae?.[k];
    const bias = `<small>${t('r.bias', { v: (m.bias[k] > 0 ? '+' : '') + m.bias[k].toFixed(d) })}</small>`;
    return src('ERA5', m.mae[k].toFixed(d), bias) + (o != null ? src('METAR', o.toFixed(d), '', 'obs') : '');
  };
  const pct = (e, o) => (e != null ? src('ERA5', Math.round(e * 100) + '%') : '–') + (o != null ? src('METAR', Math.round(o * 100) + '%', '', 'obs') : '');
  let html = `<thead><tr><th class="rowh">${t('r.model')}</th><th>${t('r.score')}</th><th>${t('r.temp')}</th><th>${t('r.wind')}</th><th>${t('r.cloud')}</th><th>${t('r.hum')}</th><th>${t('r.press')}</th><th>${t('r.rain')}</th><th>${t('r.code')}</th></tr></thead><tbody>`;
  ids.forEach(([id, m]) => {
    html += `<tr class="${state.disabled.has(id) ? 'off' : ''}"><th class="rowh">${esc(nameById(id))}${state.disabled.has(id) ? ` <small>${t('r.disabled')}</small>` : ''}</th>
      <td><div class="bar"><i style="width:${m.score ?? 0}%"></i></div><b class="score ${scoreCls(m.score)}">${m.score ?? '–'}</b></td>
      <td class="cell">${mae(m, 'temperature_2m')}</td><td class="cell">${mae(m, 'wind_speed_10m')}</td><td class="cell">${mae(m, 'cloud_cover', 0)}</td>
      <td class="cell">${mae(m, 'relative_humidity_2m', 0)}</td><td class="cell">${mae(m, 'pressure_msl', 2)}</td>
      <td class="cell">${pct(m.csi, m.obs?.csi)}</td><td class="cell">${pct(m.code_acc, m.obs?.code_acc)}</td></tr>`;
  });
  $('grid').innerHTML = html + '</tbody>';
  $('relNote').innerHTML = t('r.howto'); $('relNote').hidden = false;
  const st = v.station
    ? t('r.station', { id: v.station.id, name: esc(v.station.name), km: v.station.km, n: v.station.reports, start: v.station.start, end: v.station.end })
    : t('r.nostation', { km: 60 });
  $('legend').innerHTML = `${st}<br>${t('r.legend', { start: v.start, end: v.end, hours: v.hours, loc: esc(state.current.name), w: Math.round((v.obs_weight || 0) * 100) })}<br>${t('r.limits')}`;
}

const badge = (id) => { const sc = state.verify?.models?.[id]?.score; return sc != null ? `<span class="rel ${scoreCls(sc)}" title="${t('r.badge')}">${sc}</span>` : ''; };

function renderGrid() {
  const { data, param } = state;
  $('relNote').hidden = param !== 'reliability';
  if (param === 'reliability') return renderReliability();
  const cols = columns();
  const { rows, summary, prob, summaryLabel, probLabel } = buildRows(param, cols);
  const cls = (c) => `${c.past ? 'past' : ''}${c.now ? ' now' : ''}`;
  let html = `<thead><tr><th class="rowh">${t('g.provider')}</th>${cols.map((c) => `<th class="${cls(c)}">${c.label}</th>`).join('')}</tr></thead><tbody>`;
  rows.forEach((r) => {
    html += `<tr><th class="rowh">${esc(r.name)}${badge(r.id)}</th>${r.cells.map((c, i) => `<td class="${c.cls || ''} ${cls(cols[i])}" style="background:${c.bg || ''}">${c.html}</td>`).join('')}</tr>`;
  });
  html += `<tr class="summary"><th class="rowh">${summaryLabel}</th>${summary.map((c, i) => `<td class="${cls(cols[i])}" style="background:${c.bg || ''}">${c.html}</td>`).join('')}</tr>`;
  html += `<tr class="prob"><th class="rowh">${probLabel}</th>${prob.map((c, i) => `<td class="${cls(cols[i])}" style="background:${c.bg || ''}">${c.html}</td>`).join('')}</tr></tbody>`;
  $('grid').innerHTML = html;
  centerNow();
  requestAnimationFrame(() => requestAnimationFrame(centerNow));
  $('legend').textContent = t('lg.' + param, { thr: param === 'precip' ? RAIN_THR : WIND_THR }) + t('lg.providers', { n: rows.length }) + (weightsOn() ? t('lg.weighted') : '');
}

/* ================= Ημέρες & καρτέλες ================= */
const DROP = '<svg class="arrow" viewBox="0 0 24 24" style="transform:none;fill:var(--rain)"><path d="M12 2c4 5 7 8.5 7 12a7 7 0 0 1-14 0c0-3.500 3-7 7-12z"/></svg>';

function dayCategory(codes) {
  const cats = nn(codes).map(WI.category), c = {};
  cats.forEach((k) => (c[k] = (c[k] || 0) + 1));
  if ((c.thunder || 0) >= 2) return 'thunder';
  if ((c.snow || 0) >= 2) return 'snow';
  if ((c.rain || 0) + (c.drizzle || 0) >= 3) return 'rain';
  const rest = Object.entries(c).sort((a, b) => b[1] - a[1]);
  return rest.length ? rest[0][0] : null;
}

function renderDays() {
  const { data } = state;
  $('days').innerHTML = data.dates.map((date, d) => {
    const a = d * 24, b = Math.min(a + 24, data.time.length);
    const cnt = {};
    wpairs('weather', (p) => dayCategory(p.hourly.code.slice(a + 6, a + 22))).forEach((x) => (cnt[x.v] = (cnt[x.v] || 0) + x.w));
    const top = Object.entries(cnt).sort((x, y) => y[1] - x[1])[0];
    const ext = (fn) => wmean(wpairs('temperature_2m', (p) => { const v = nn(p.hourly.temperature_2m.slice(a, b)); return v.length ? fn(...v) : null; }));
    const hi = ext(Math.max), lo = ext(Math.min);
    const rp = wshare(wpairs('precip', (p) => { const v = nn(p.hourly.precipitation.slice(a, b)); return v.length ? v.reduce((s, x) => s + x, 0) : null; }), (x) => x >= 1);
    const rain = rp == null ? null : Math.round(rp * 100);
    const sp = wshare(wpairs('storm', (p) => { const v = nn(p.hourly.weather_code.slice(a, b)); return v.length ? (v.some((x) => x >= 95) ? 1 : 0) : null; }), (x) => x === 1);
    const storm = sp == null ? 0 : Math.round(sp * 100);
    const dt = new Date(date + 'T12:00:00');
    const name = d === 0 ? t('today') : dt.toLocaleDateString(dateLocale(), { weekday: 'short' });
    return `<button class="day ${d === state.day ? 'active' : ''}" data-day="${d}">
      <b>${name}</b><small>${dt.toLocaleDateString(dateLocale(), { day: 'numeric', month: 'short' })}</small><br>
      ${top ? WI.svg(WI.CAT_CODE[top[0]]) : ''}
      <div class="hilo">${fmt(hi)}° <span>${fmt(lo)}°</span></div>
      <div class="chips">${rain != null ? `<i>${DROP}${rain}%</i>` : ''}${storm >= 20 ? `<i>${WI.bolt24}${storm}%</i>` : ''}</div>
    </button>`;
  }).join('');
}

function renderTabs() {
  $('tabs').innerHTML = Object.entries(PARAMS).map(([k, v]) => `<button class="tab ${k === state.param ? 'active' : ''}" data-param="${k}">${t('p.' + k)}</button>`).join('');
}

const ALL_MODEL_IDS = Object.keys(MODEL_NAMES);

function renderModels() {
  const all = state.data.providers, uniq = uniqueProviders(), off = uniq.filter((p) => state.disabled.has(p.id)).length;
  $('mdlCount').textContent = t('m.active', { a: uniq.length - off, n: uniq.length });
  const region = (id) => (hasT('mi.' + id) ? `<small>${t('mi.' + id)}</small>` : '');
  const row = (p) => {
    if (p.dupOf) {
      return `<div class="mdl off"><span class="mtxt"><b>${esc(pname(p))}</b><small>${esc(t('m.dup', { n: nameById(p.dupOf) }))}</small></span></div>`;
    }
    const sc = state.verify?.models?.[p.id]?.score;
    return `<label class="mdl"><input type="checkbox" data-mid="${p.id}" ${state.disabled.has(p.id) ? '' : 'checked'}>
      <span class="mtxt"><b>${esc(pname(p))}</b>${region(p.id)}</span>${sc != null ? `<span class="rel ${scoreCls(sc)}" title="${t('r.badge')}">${sc}</span>` : ''}</label>`;
  };
  // Models without data for this location (outside their coverage area)
  const missing = ALL_MODEL_IDS.filter((id) => !all.some((p) => p.id === id));
  $('mdlList').innerHTML = all.map(row).join('')
    + (missing.length ? `<div class="mdl-sep">${t('m.missing')}</div>${missing.map((id) => `<div class="mdl off"><span class="mtxt"><b>${esc(nameById(id))}</b>${region(id)}</span></div>`).join('')}` : '')
    + `<button type="button" class="btn ghost small" id="mdlAll">${t('m.all')}</button>`;
}
function saveDisabled() {
  try { localStorage.setItem('wefo.disabled', JSON.stringify([...state.disabled])); } catch (e) { /* ignore */ }
}
$('mdlList').addEventListener('change', (e) => {
  const id = e.target.dataset.mid; if (!id) return;
  if (e.target.checked) state.disabled.delete(id);
  else if (uniqueProviders().filter((p) => !state.disabled.has(p.id)).length > 1) state.disabled.add(id);
  else e.target.checked = true;   // πρέπει να μείνει τουλάχιστον ένα μοντέλο
  saveDisabled(); renderAll();
});
$('mdlList').addEventListener('click', (e) => {
  if (e.target.id !== 'mdlAll') return;
  state.disabled.clear(); saveDisabled(); renderAll();
});
document.addEventListener('click', (e) => { if (!e.target.closest('.models')) $('models').open = false; });

function renderAll() {
  renderModels(); renderDays(); renderTabs(); renderGrid();
  const d = state.data, loc = state.current;
  $('meta').textContent = t('meta', { name: loc.name, lat: d.lat.toFixed(3), lon: d.lon.toFixed(3), el: Math.round(d.elevation ?? 0), a: activeProviders().length, n: uniqueProviders().length, time: new Date(d.generated).toLocaleTimeString(dateLocale(), { hour: '2-digit', minute: '2-digit' }) });
}

$('days').addEventListener('click', (e) => {
  const b = e.target.closest('[data-day]'); if (!b) return;
  state.day = +b.dataset.day; renderDays(); renderGrid();
});
$('tabs').addEventListener('click', (e) => {
  const b = e.target.closest('[data-param]'); if (!b) return;
  state.param = b.dataset.param; renderTabs(); renderGrid();
});
state.step = +$('stepSelect').value || 1;
$('stepSelect').addEventListener('change', (e) => { state.step = +e.target.value; if (state.data) renderGrid(); });

/* ================= Φόρτωση πρόγνωσης ================= */
async function loadForecast(refresh = false) {
  const loc = state.current;
  $('empty').hidden = !!loc;
  if (!loc) { $('forecastBody').hidden = true; $('meta').textContent = ''; return; }
  const token = ++state.token;
  $('error').hidden = true; $('loading').hidden = false; $('forecastBody').hidden = true;
  try {
    const data = await api(`api/forecast.php?lat=${loc.lat}&lon=${loc.lon}${refresh ? '&refresh=1' : ''}`);
    if (token !== state.token) return;
    state.data = prepare(data);
    state.day = 0;
    state.verify = null; state.verifyErr = null;
    $('loading').hidden = true; $('forecastBody').hidden = false;
    renderAll();
    loadVerify(loc, token);
  } catch (err) {
    if (token !== state.token) return;
    $('loading').hidden = true;
    $('error').textContent = err.message; $('error').hidden = false;
  }
}

async function loadVerify(loc, token) {
  $('vfStatus').textContent = t('vf.loading');
  try {
    const v = await api(`api/verify.php?lat=${loc.lat}&lon=${loc.lon}`);
    if (token !== state.token) return;
    state.verify = v;
    $('vfStatus').textContent = '';
    renderAll();
  } catch (err) {
    if (token !== state.token) return;
    state.verifyErr = err.message;
    $('vfStatus').textContent = t('vf.unavail');
    if (state.param === 'reliability') renderGrid();
  }
}
$('weightChk').checked = state.weighted;
$('weightChk').addEventListener('change', (e) => {
  state.weighted = e.target.checked;
  try { localStorage.setItem('wefo.weighted', state.weighted ? '1' : '0'); } catch (err) { /* ignore */ }
  if (state.data) renderAll();
});

function setCurrent(loc, go = false) {
  state.current = loc || null;
  try { loc ? localStorage.setItem('wefo.loc', loc.id) : localStorage.removeItem('wefo.loc'); } catch (e) { /* ignore */ }
  $('locSelect').value = loc ? loc.id : '';
  if (go) showView('forecast');
  loadForecast();
}
$('locSelect').addEventListener('change', (e) => setCurrent(state.locations.find((l) => l.id == e.target.value)));
$('refreshBtn').addEventListener('click', () => loadForecast(true));

/* ================= Τοποθεσίες ================= */
async function loadLocations(selectId) {
  state.locations = await api('api/locations.php');
  $('locSelect').innerHTML = state.locations.map((l) => `<option value="${l.id}">${esc(l.name)}</option>`).join('');
  renderSaved();
  let saved = null;
  try { saved = localStorage.getItem('wefo.loc'); } catch (e) { /* ignore */ }
  const pick = state.locations.find((l) => l.id == (selectId ?? saved)) || state.locations[0] || null;
  setCurrent(pick);
}

let map, marker, savedLayer, nameAuto = true;
function initMap() {
  if (map) return;
  map = L.map('map').setView([38.0, 24.0], 6);
  L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 18, attribution: '© OpenStreetMap' }).addTo(map);
  savedLayer = L.layerGroup().addTo(map);
  map.on('click', (e) => pickPoint(e.latlng.lat, e.latlng.lng, null, true));
  drawSavedMarkers();
}
function drawSavedMarkers() {
  if (!savedLayer) return;
  savedLayer.clearLayers();
  state.locations.forEach((l) => L.circleMarker([l.lat, l.lon], { radius: 6, color: '#16a34a', fillOpacity: .8 }).bindTooltip(l.name).addTo(savedLayer));
}
async function pickPoint(lat, lon, name, reverse) {
  lat = +lat.toFixed(4); lon = +(((lon + 540) % 360) - 180).toFixed(4);
  $('latInput').value = lat; $('lonInput').value = lon;
  if (marker) marker.setLatLng([lat, lon]); else marker = L.marker([lat, lon]).addTo(map);
  if (name) { $('nameInput').value = name; nameAuto = false; }
  else if (reverse && nameAuto) {
    $('nameInput').value = '';
    try { const r = await api(`api/geocode.php?lat=${lat}&lon=${lon}&lang=${LANG}`); if (r.name && nameAuto) $('nameInput').value = r.name; } catch (e) { /* ignore */ }
  }
}
function msg(text, cls = '') { const el = $('placeMsg'); el.textContent = text; el.className = 'hint ' + cls; }

['latInput', 'lonInput'].forEach((id) => $(id).addEventListener('change', () => {
  const lat = parseFloat($('latInput').value), lon = parseFloat($('lonInput').value);
  if (Number.isFinite(lat) && Number.isFinite(lon) && Math.abs(lat) <= 90 && Math.abs(lon) <= 180) {
    initMap(); pickPoint(lat, lon, null, true); map.setView([lat, lon], Math.max(map.getZoom(), 9));
  }
}));
$('nameInput').addEventListener('input', () => { nameAuto = !$('nameInput').value.trim(); });

$('saveBtn').addEventListener('click', async () => {
  const lat = parseFloat($('latInput').value), lon = parseFloat($('lonInput').value), name = $('nameInput').value.trim();
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return msg(t('err.pick'), 'err');
  if (!name) return msg(t('err.name'), 'err');
  try {
    const loc = await api('api/locations.php', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name, lat, lon }) });
    await loadLocations(loc.id);
    drawSavedMarkers();
    msg(t('ok.saved', { n: name }), 'ok');
    nameAuto = true; $('nameInput').value = '';
  } catch (err) { msg(err.message, 'err'); }
});

$('geoBtn').addEventListener('click', () => {
  if (!navigator.geolocation) return msg(t('err.geo.unsupported'), 'err');
  initMap();
  navigator.geolocation.getCurrentPosition(
    (pos) => { nameAuto = true; pickPoint(pos.coords.latitude, pos.coords.longitude, null, true); map.setView([pos.coords.latitude, pos.coords.longitude], 11); },
    () => msg(t('err.geo.fail'), 'err'),
  );
});

let searchTimer;
$('searchInput').addEventListener('input', (e) => {
  clearTimeout(searchTimer);
  const q = e.target.value.trim(), box = $('searchResults');
  if (q.length < 2) { box.hidden = true; return; }
  searchTimer = setTimeout(async () => {
    try {
      const res = await api(`api/geocode.php?lang=${LANG}&q=` + encodeURIComponent(q));
      box.innerHTML = res.length ? res.map((r, i) => `<li data-i="${i}">${esc(r.name)}</li>`).join('') : `<li>${t('search.none')}</li>`;
      box._res = res; box.hidden = false;
    } catch (err) { box.hidden = true; }
  }, 350);
});
$('searchResults').addEventListener('click', (e) => {
  const li = e.target.closest('li[data-i]'); if (!li) return;
  const r = $('searchResults')._res[+li.dataset.i];
  $('searchResults').hidden = true; $('searchInput').value = '';
  initMap(); pickPoint(r.lat, r.lon, r.name.split(',')[0]); map.setView([r.lat, r.lon], 11);
});
document.addEventListener('click', (e) => { if (!e.target.closest('.search')) $('searchResults').hidden = true; });

function renderSaved() {
  $('savedList').innerHTML = state.locations.length ? state.locations.map((l) => `
    <li data-id="${l.id}">
      <div class="nm" data-act="fly"><b>${esc(l.name)}</b><small>${l.lat.toFixed(3)}, ${l.lon.toFixed(3)}</small></div>
      <button data-act="hist">${t('saved.history')}</button>
      <button data-act="fc">${t('saved.forecast')}</button>
      <button class="del" data-act="del" title="${t('saved.delete')}">✕</button>
    </li>`).join('') : `<li><span class="hint">${t('saved.none')}</span></li>`;
}
$('savedList').addEventListener('click', async (e) => {
  const li = e.target.closest('li[data-id]'), act = e.target.closest('[data-act]')?.dataset.act;
  if (!li || !act) return;
  const loc = state.locations.find((l) => l.id == li.dataset.id);
  if (act === 'fc') setCurrent(loc, true);
  if (act === 'hist') openHistory(loc);
  if (act === 'fly') { initMap(); pickPoint(loc.lat, loc.lon, loc.name); map.setView([loc.lat, loc.lon], 10); }
  if (act === 'del' && confirm(t('confirm.delete', { n: loc.name }))) {
    await api('api/locations.php?id=' + loc.id, { method: 'DELETE' });
    if (histState && histState.loc.id === loc.id) closeHistory();
    await loadLocations(state.current && state.current.id !== loc.id ? state.current.id : undefined);
    drawSavedMarkers();
  }
});

/* ================= Πλοήγηση ================= */
function showView(name) {
  document.querySelectorAll('.view').forEach((v) => v.classList.toggle('active', v.id === 'view-' + name));
  document.querySelectorAll('.nav-btn').forEach((b) => b.classList.toggle('active', b.dataset.view === name));
  if (name === 'places') { initMap(); setTimeout(() => map.invalidateSize(), 50); drawSavedMarkers(); }
}
document.querySelectorAll('.nav-btn').forEach((b) => b.addEventListener('click', () => showView(b.dataset.view)));
document.addEventListener('click', (e) => { const a = e.target.closest('[data-goto]'); if (a) { e.preventDefault(); showView(a.dataset.goto); } });

/* ================= History dialog ================= */
const histSec = $('histSec');
let histState = null;   // { loc, data }

function niceNum(v, d = 1) { return v == null ? '–' : Number(v).toLocaleString(dateLocale(), { minimumFractionDigits: d, maximumFractionDigits: d }); }

/* Simple SVG chart: kind = 'line' | 'bar', points = [{x: year, v: value}] */
function histChart(points, { kind, color, unit, d = 1, trend = false }) {
  if (points.length < 2) return '';
  const W = 640, H = 190, pl = 44, pr = 10, pt = 12, pb = 24;
  const ys = points.map((p) => p.v);
  let min = Math.min(...ys), max = Math.max(...ys);
  if (kind === 'bar') min = 0; else { const pad = (max - min) * 0.12 || 1; min -= pad; max += pad; }
  const x = (i) => pl + (i * (W - pl - pr)) / (points.length - 1);
  const y = (v) => pt + (H - pt - pb) * (1 - (v - min) / (max - min || 1));
  let g = '';
  for (let i = 0; i <= 3; i++) {
    const v = min + ((max - min) * i) / 3;
    g += `<line x1="${pl}" x2="${W - pr}" y1="${y(v)}" y2="${y(v)}" class="gl"/><text x="${pl - 6}" y="${y(v) + 4}" text-anchor="end" class="tx">${niceNum(v, d === 0 ? 0 : d)}</text>`;
  }
  points.forEach((p, i) => { if (p.x % 10 === 0) g += `<text x="${x(i)}" y="${H - 6}" text-anchor="middle" class="tx">${p.x}</text>`; });
  let body = '';
  if (kind === 'bar') {
    const bw = Math.max(1.5, (W - pl - pr) / points.length - 1);
    body = points.map((p, i) => `<rect x="${x(i) - bw / 2}" y="${y(p.v)}" width="${bw}" height="${y(min) - y(p.v)}" fill="${color}" opacity=".85"><title>${p.x}: ${niceNum(p.v, d)} ${unit}</title></rect>`).join('');
  } else {
    body = `<path d="${points.map((p, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)} ${y(p.v).toFixed(1)}`).join('')}" fill="none" stroke="${color}" stroke-width="1.6"/>`
      + points.map((p, i) => `<circle cx="${x(i)}" cy="${y(p.v)}" r="2.2" fill="${color}"><title>${p.x}: ${niceNum(p.v, d)} ${unit}</title></circle>`).join('');
    if (trend) {
      const n = points.length, mx = mean(points.map((p) => p.x)), my = mean(ys);
      const slope = points.reduce((a, p) => a + (p.x - mx) * (p.v - my), 0) / points.reduce((a, p) => a + (p.x - mx) ** 2, 0);
      const y0 = my + slope * (points[0].x - mx), y1 = my + slope * (points[n - 1].x - mx);
      body += `<line x1="${x(0)}" y1="${y(y0)}" x2="${x(n - 1)}" y2="${y(y1)}" stroke="var(--bad)" stroke-width="1.6" stroke-dasharray="5 4"/>`;
      body += `<text x="${W - pr}" y="${pt + 8}" text-anchor="end" class="tx" fill="var(--bad)">${t('h.trend', { v: (slope * 10 >= 0 ? '+' : '') + niceNum(slope * 10, 2) })}</text>`;
    }
  }
  return `<svg class="hchart" viewBox="0 0 ${W} ${H}" role="img">${g}${body}</svg>`;
}

function renderHistory() {
  if (!histState) return;
  const { loc, data: h, fresh, added } = histState;
  if (!h) { return; }
  const m = h.meta;
  const complete = h.annual.filter((a) => a.n >= 350);
  const fmtDate = (d) => new Date(d + 'T12:00:00').toLocaleDateString(dateLocale(), { day: 'numeric', month: 'short', year: 'numeric' });
  const rec = (k, unit, d = 1) => (h.records[k] ? `<div class="rcard"><span>${t('h.rec.' + k)}</span><b>${niceNum(h.records[k].v, d)} ${unit}</b><small>${fmtDate(h.records[k].d)}</small></div>` : '');
  const months = h.monthly.map((r) => `<tr><th>${new Date(2000, r.m - 1, 1).toLocaleDateString(dateLocale(), { month: 'long' })}</th><td>${niceNum(r.tmean)}</td><td>${niceNum(r.tmax)}</td><td>${niceNum(r.tmin)}</td><td>${niceNum(r.prcp, 0)}</td><td>${niceNum(r.rainy, 1)}</td></tr>`).join('');
  const maxP = Math.max(...h.annual.map((a) => a.prcp || 0), 1);
  const years = h.annual.slice().reverse().map((a) => `<tr><th>${a.y}${a.n < 350 ? '*' : ''}</th><td>${niceNum(a.tmean)}</td><td>${niceNum(a.tmax)}</td><td>${niceNum(a.tmin)}</td>
      <td><div class="pbar"><i style="width:${Math.round(((a.prcp || 0) / maxP) * 100)}%"></i><span>${niceNum(a.prcp, 0)}</span></div></td><td>${a.rainy}</td><td>${niceNum(a.gust, 0)}</td><td>${niceNum(a.snow)}</td></tr>`).join('');
  $('histBody').innerHTML = `
    <h2>${t('h.title')} – ${esc(loc.name)}</h2>
    <div class="h-info">
      <div>📍 ${t('h.grid', { lat: m.grid_lat.toFixed(4), lon: m.grid_lon.toFixed(4), km: m.distance_km, el: Math.round(m.elevation ?? 0) })}</div>
      <div>📅 ${t('h.period', { first: m.first, last: m.last, days: m.days.toLocaleString(dateLocale()) })}</div>
      <div class="muted">${t('h.source', { date: new Date(m.fetched_at * 1000).toLocaleDateString(dateLocale()) })}</div>
      <div class="h-status">${fresh ? t('h.status.new') : added > 0 ? t('h.status.added', { n: added }) : t('h.status.cached')} <button type="button" class="btn ghost small" id="histUpdate">${t('h.update')}</button></div>
    </div>
    <h3>${t('h.rec.title')}</h3>
    <div class="rcards">${rec('hottest', '°C')}${rec('coldest', '°C')}${rec('wettest', 'mm')}${rec('windiest', 'km/h', 0)}${(h.records.snowiest && h.records.snowiest.v > 0) ? rec('snowiest', 'cm') : ''}</div>
    <div class="h-charts">
      <div><h3>${t('h.chart.temp')}</h3>${histChart(complete.filter((a) => a.tmean != null).map((a) => ({ x: a.y, v: a.tmean })), { kind: 'line', color: 'var(--accent)', unit: '°C', trend: true })}</div>
      <div><h3>${t('h.chart.prcp')}</h3>${histChart(complete.filter((a) => a.prcp != null).map((a) => ({ x: a.y, v: a.prcp })), { kind: 'bar', color: 'var(--rain)', unit: 'mm', d: 0 })}</div>
    </div>
    <h3>${t('h.monthly')}</h3>
    <div class="h-tablewrap"><table class="htable"><thead><tr><th>${t('h.col.month')}</th><th>${t('h.col.mean')}</th><th>${t('h.col.max')}</th><th>${t('h.col.min')}</th><th>${t('h.col.prcp')}</th><th>${t('h.col.rainy')}</th></tr></thead><tbody>${months}</tbody></table></div>
    <h3>${t('h.annual')}</h3>
    <div class="h-tablewrap tall"><table class="htable"><thead><tr><th>${t('h.col.year')}</th><th>${t('h.col.mean')}</th><th>${t('h.col.max')}</th><th>${t('h.col.min')}</th><th>${t('h.col.prcp')}</th><th>${t('h.col.rainy')}</th><th>${t('h.col.gust')}</th><th>${t('h.col.snow')}</th></tr></thead><tbody>${years}</tbody></table></div>
    <p class="hint">${t('h.partial')}</p>`;
  $('histUpdate').addEventListener('click', () => openHistory(loc, true));
}

async function openHistory(loc, refresh = false) {
  histState = { loc, data: null, fresh: false, added: 0 };
  const wasHidden = histSec.hidden;
  histSec.hidden = false;
  if (wasHidden || !refresh) histSec.scrollIntoView({ behavior: 'smooth', block: 'start' });
  $('histBody').innerHTML = `<h2>${t('h.title')} – ${esc(loc.name)}</h2><div class="loading"><div class="spinner"></div> <span>${t('h.loading.first')}</span></div>`;
  try {
    const h = await api(`api/history.php?id=${loc.id}${refresh ? '&refresh=1' : ''}`);
    if (!histState || histState.loc.id !== loc.id) return;
    histState.data = h; histState.fresh = h.downloaded; histState.added = h.added || 0;
    renderHistory();
  } catch (err) {
    $('histBody').innerHTML = `<h2>${t('h.title')} – ${esc(loc.name)}</h2><div class="notice error">${esc(err.message)}</div>`;
  }
}
function closeHistory() { histSec.hidden = true; histState = null; $('histBody').innerHTML = ''; }
$('histClose').addEventListener('click', closeHistory);

/* ================= Language ================= */
function onLangChange() {
  renderSaved();
  if (!histSec.hidden && histState && histState.data) renderHistory();
  if (state.data) renderAll();
}
document.querySelectorAll('[data-lang]').forEach((b) => b.addEventListener('click', () => setLang(b.dataset.lang)));
applyStaticI18n();

/* ================= Theme (light / dark) ================= */
const sysDark = window.matchMedia ? window.matchMedia('(prefers-color-scheme: dark)') : null;
const effectiveTheme = () => document.documentElement.getAttribute('data-theme') || (sysDark && sysDark.matches ? 'dark' : 'light');
const syncThemeBtn = () => $('themeBtn').classList.toggle('is-dark', effectiveTheme() === 'dark');
$('themeBtn').addEventListener('click', () => {
  const next = effectiveTheme() === 'dark' ? 'light' : 'dark';
  document.documentElement.setAttribute('data-theme', next);
  try { localStorage.setItem('wefo.theme', next); } catch (e) { /* ignore */ }
  syncThemeBtn();
});
if (sysDark && sysDark.addEventListener) sysDark.addEventListener('change', syncThemeBtn);
syncThemeBtn();

$('brandIcon').innerHTML = WI.svg(2, false);
loadLocations().catch((err) => { $('error').textContent = err.message; $('error').hidden = false; });

if (document.fonts && document.fonts.ready) document.fonts.ready.then(() => setTimeout(centerNow, 50));
window.addEventListener('load', () => setTimeout(centerNow, 100));
