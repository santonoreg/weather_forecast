'use strict';

/* ================= Helpers ================= */
const $ = (id) => document.getElementById(id);
const clamp = (x, a = 0, b = 1) => Math.min(b, Math.max(a, x));
const nn = (arr) => arr.filter((x) => x != null && !Number.isNaN(x));
const mean = (a) => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : null);
const fmt = (v, d = 0) => (v == null ? '–' : Number(v).toFixed(d).replace(/^-0$/, '0'));
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

// Built-in Greek cities carry a Greek name too; saved/ad-hoc locations only have the one name they were given
const locName = (l) => ((LANG === 'el' && l.name_el) ? l.name_el : l.name);

async function api(path, opts) {
  const res = await fetch(path, opts);
  const data = await res.json().catch(() => ({}));
  if (res.status === 401 && data.code === 'login_required') { if (typeof showGate === 'function') showGate(); throw new Error(data.error); }
  if (!res.ok) throw new Error(data.error || t('err.http', { s: res.status }));
  return data;
}

const state = { view: 'forecast', locations: [], cities: [], admin: false, current: null, data: null, verify: null, observed: null, radar: null, weighted: true, day: 0, step: 1, param: 'weather', token: 0, orient: 'h', modelsOpen: false, vHours: 24 };
try { state.weighted = localStorage.getItem('wefo.weighted') !== '0'; } catch (e) { /* ignore */ }
state.bias = true;   // "Correct systematic error" (on by default)
try { state.bias = localStorage.getItem('wefo.bias') !== '0'; } catch (e) { /* ignore */ }
state.oneVote = false;   // "one vote per model family" (off by default)
try { state.oneVote = localStorage.getItem('wefo.oneVote') === '1'; } catch (e) { /* ignore */ }
try { const so = localStorage.getItem('wefo.orient'); state.orient = (so === 'v' || so === 's') ? so : 'h'; } catch (e) { /* ignore */ }
// Προτιμήσεις ανά χρήστη/browser (localStorage): μοντέλα που έχουν απενεργοποιηθεί
state.disabled = new Set();
try { state.disabled = new Set(JSON.parse(localStorage.getItem('wefo.disabled') || '[]')); } catch (e) { /* ignore */ }
// Πάροχοι με ταυτόσημα δεδομένα με άλλον (p.dupOf) μετρούν μόνο μία φορά
const uniqueProviders = () => state.data.providers.filter((p) => !p.dupOf);
// display names come from the server (api/models.php via the forecast / verify responses); i18n "mn.<id>" overrides
const MODEL_NAMES = {};
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

/* Some "seamless" models (KNMI, DMI, MET Nordic, sometimes UKMO / Météo-France) hand back another model's data —
   usually ECMWF IFS — outside their own domain or beyond their own forecast range. That model would then be counted
   twice. Found per HOUR: provider q is a copy of an earlier provider p at hour i when temperature, rain, wind and
   pressure are identical over the whole window i-3..i+3 (a window, so a coincidence of one hour is not enough).
   p.dupHours[i] = id of the original (or null); those hours are ignored in every average, share and agreement
   (see agg), but still listed — dimmed — on the provider's own row. p.dupOf = the original when ALL of its hours are copies. */
const DUP_WINDOW = 3;                 // hours either side that must also be identical
const DUP_EPS = 1e-6;
const DUP_VARS = ['temperature_2m', 'precipitation', 'wind_speed_10m', 'pressure_msl'];
function markDuplicates(data) {
  const P = data.providers, n = data.time.length;
  const same = (x, y) => (x == null || y == null ? x == null && y == null : Math.abs(x - y) <= DUP_EPS);
  P.forEach((q, qi) => {
    const eq = [];   // eq[pi][i]: hour i identical to provider pi
    for (let pi = 0; pi < qi; pi++) {
      const p = P[pi];
      eq[pi] = Array.from({ length: n }, (_, i) => q.hourly.temperature_2m[i] != null && p.hourly.temperature_2m[i] != null && DUP_VARS.every((k) => same(q.hourly[k][i], p.hourly[k][i])));
    }
    q.dupHours = Array(n).fill(null);
    let any = false;
    for (let i = 0; i < n; i++) {
      if (q.hourly.temperature_2m[i] == null) continue;
      const lo = Math.max(0, i - DUP_WINDOW), hi = Math.min(n - 1, i + DUP_WINDOW);
      for (let pi = 0; pi < qi; pi++) {
        let all = true;
        for (let j = lo; j <= hi && all; j++) all = eq[pi][j];
        if (all) { q.dupHours[i] = P[pi].id; any = true; break; }   // the earliest provider in the list is the original
      }
    }
    if (!any) { q.dupHours = null; return; }
    const valid = []; for (let i = 0; i < n; i++) if (q.hourly.temperature_2m[i] != null) valid.push(i);
    const first = q.dupHours[valid[0]];
    if (first && valid.every((i) => q.dupHours[i] === first)) q.dupOf = first;
  });
}
/* Yr (MET Norway) is built on ECMWF outside the Nordics, so it is not an independent opinion. Its temperature is
   compared with ECMWF IFS over the whole forecast: when it follows it almost exactly (correlation above
   ECMWF_COPY_R and the same direction of change in at least ECMWF_COPY_TREND of the hours) its weight is cut
   by ECMWF_COPY_FACTOR. p.corr = { ref, r, trend, cut } is also shown in the Reliability window. */
const ECMWF_COPY_R = 0.97;
const ECMWF_COPY_TREND = 0.9;
const ECMWF_COPY_FACTOR = 0.5;
function markDerived(data) {
  data.providers.forEach((p) => {
    const ref = p.derives_from && data.providers.find((x) => x.id === p.derives_from && !x.dupOf);
    if (!ref || p.dupOf) return;
    const a = p.hourly.temperature_2m, b = ref.hourly.temperature_2m;
    const idx = a.map((_, i) => i).filter((i) => a[i] != null && b[i] != null);
    if (idx.length < 24) return;
    const ma = mean(idx.map((i) => a[i])), mb = mean(idx.map((i) => b[i]));
    let sab = 0, saa = 0, sbb = 0;
    idx.forEach((i) => { sab += (a[i] - ma) * (b[i] - mb); saa += (a[i] - ma) ** 2; sbb += (b[i] - mb) ** 2; });
    const r = saa && sbb ? sab / Math.sqrt(saa * sbb) : 0;
    let ok = 0, n = 0;
    for (let k = 1; k < idx.length; k++) {
      if (idx[k] !== idx[k - 1] + 1) continue;
      const da = a[idx[k]] - a[idx[k - 1]], db = b[idx[k]] - b[idx[k - 1]];
      if (da === 0 || db === 0) continue;
      n++; if (Math.sign(da) === Math.sign(db)) ok++;
    }
    const trend = n ? ok / n : 0;
    p.corr = { ref: ref.id, r, trend, cut: r > ECMWF_COPY_R && trend >= ECMWF_COPY_TREND };
  });
}
/* "One vote per family": the weight of a family (ECMWF = IFS + AIFS + Yr, …) is shared between its active members */
let famCount = null;
const familyShare = (p) => {
  if (!state.oneVote || !p.family) return 1;
  if (!famCount) { famCount = {}; activeProviders().forEach((x) => { if (x.family) famCount[x.family] = (famCount[x.family] || 0) + 1; }); }
  return 1 / (famCount[p.family] || 1);
};
/* Tooltip for a dimmed (copied) hour: "Same data as X from 21/11 06:00" — the start of the run of copied hours */
function dupNote(p, i) {
  const src = p.dupHours && p.dupHours[i];
  if (!src) return '';
  let j = i; while (j > 0 && p.dupHours[j - 1] === src) j--;
  const tm = state.data.time[j];
  return t('m.duphour', { n: nameById(src), when: `${tm.slice(8, 10)}/${tm.slice(5, 7)} ${tm.slice(11, 16)}` });
}

function prepare(data) {
  const n = data.time.length;
  data.providers.forEach((p) => {
    if (p.name) MODEL_NAMES[p.id] = p.name;
    p.hourly.code = p.hourly.weather_code.map((c, i) => (c != null ? c : deriveCode(p, i)));
  });
  Object.entries(data.models_known || {}).forEach(([id, name]) => { if (!MODEL_NAMES[id]) MODEL_NAMES[id] = name; });
  markDuplicates(data);
  markDerived(data);
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
// hourly values of a provider over a..b without the hours that merely copy another model (for code that reads p.hourly directly)
const liveHours = (p, arr, a, b) => nn(arr.slice(a, b).filter((_, k) => !(p.dupHours && p.dupHours[a + k])));
let AGG_RAW = false;   // true while building a provider's own row: copied hours are shown (dimmed) instead of skipped
function agg(p, param, a, b) {
  lastAggA = a;
  const h = p.hourly;
  const keep = []; for (let i = a; i < Math.min(b, h.temperature_2m.length); i++) if (AGG_RAW || !p.dupHours || !p.dupHours[i]) keep.push(i);
  const sl = (arr, key) => nn(keep.map((i) => (key ? fixValue(p, key, i, arr[i]) : arr[i])));
  switch (param) {
    case 'precip': {
      // Yr only gives a 6 h total for later hours, POSEIDON a 3 h total, each spread evenly over its hours: fine for blocks as long as the total, not as an hourly value
      const sm6 = h.precip_6h_block, sm3 = h.precip_3h_block;
      const smeared = (sm6 && b - a < 6 ? (i) => sm6[i] : null) || (sm3 && b - a < 3 ? (i) => sm3[i] : null);
      const v = smeared ? nn(keep.filter((i) => !smeared(i)).map((i) => h.precipitation[i])) : sl(h.precipitation);
      return v.length ? v.reduce((s, x) => s + x, 0) : null;
    }
    case 'gust': { const v = sl(h.wind_gusts_10m, 'wind_gusts_10m'); return v.length ? Math.max(...v) : null; }
    case 'li': { const v = sl(h.lifted_index || []); return v.length ? Math.min(...v) : null; }   // most unstable hour of the block
    case 'cin': { const v = sl(h.convective_inhibition || []); return v.length ? Math.max(...v.map(Math.abs)) : null; }   // strongest inhibition (Open-Meteo gives it as a positive J/kg)
    case 'cape': { const v = sl(h.cape); return v.length ? Math.max(...v) : null; }
    case 'code': { const v = sl(h.code); return v.length ? Math.max(...v) : null; }
    case 'dir': {
      const idx = keep.filter((i) => h.wind_direction_10m[i] != null);
      return idx.length ? circMean(idx.map((i) => h.wind_direction_10m[i]), idx.map((i) => h.wind_speed_10m[i] || 1)) : null;
    }
    default: { const v = sl(h[param], param); return mean(v); }
  }
}

/* ================= Χρωματισμός =================
   Heatmap cell backgrounds for the Time across tabs other than Weather (Temperature, Rain, Wind,
   Thunderstorm, Cloud cover, Humidity, Pressure) — the Weather tab itself stays plain/coloured-text
   only (matches Glett there; buildWeatherLanes doesn't pass a bg for temp/wind). */
const heat = (t, h1, h2, alpha = 0.3) => `hsla(${h1 + (h2 - h1) * clamp(t)},78%,52%,${alpha})`;
const bgTemp = (v) => (v == null ? '' : heat((v + 5) / 45, 220, 0));
const bgWind = (v) => (v == null ? '' : heat(v / 60, 170, 10));
const bgCloud = (v) => (v == null ? '' : `hsla(215,18%,55%,${0.04 + clamp(v / 100) * 0.34})`);
const bgHum = (v) => (v == null ? '' : `hsla(200,80%,50%,${0.03 + clamp(v / 100) * 0.3})`);
const bgPress = (v) => (v == null ? '' : heat((v - 990) / 50, 260, 120, 0.2));
const bgRain = (v, step) => (v == null || v < 0.05 ? '' : `hsla(215,85%,50%,${0.12 + clamp(v / (step * 2.5)) * 0.5})`);
// Solid (opaque) versions of the same scales, for the Meteogram's point markers/bars rather than a cell background.
const heatTemp = (v) => (v == null ? 'var(--muted)' : heat((v + 5) / 45, 220, 0, 0.95));
const heatWind = (v) => (v == null ? 'var(--muted)' : heat(v / 60, 170, 10, 0.95));
const heatCloud = (v) => (v == null ? 'var(--muted)' : `hsl(215,20%,${72 - clamp(v / 100) * 38}%)`);
const heatRain = (v) => (v == null ? 'var(--muted)' : `hsla(215,85%,50%,${0.35 + clamp(v / 4) * 0.6})`);

/* ================= Παράμετροι ================= */
// Τυπική απόκλιση μεταξύ παρόχων στην οποία η συμφωνία μηδενίζεται
const TOL = { temperature_2m: 4, wind_speed_10m: 15, cloud_cover: 50, relative_humidity_2m: 25, pressure_msl: 4 };
// mm that make a block of hours "rainy": the longer the block, the more a trace of rain adds up, so a 12 h step
// must not count a mere 0.2 mm. Same 1 mm as the 24 h "Days ahead" card.
const RAIN_THR_BY_HOURS = [[1, 0.2], [3, 0.5], [Infinity, 1.0]];   // [block length up to (h), threshold mm]
const rainThr = (hours) => RAIN_THR_BY_HOURS.find(([h]) => hours <= h)[1];
/* Ensemble probabilities (api/ensemble.php): the share of ensemble members that rain / blow hard is a real probability, unlike
   "how many models agree". The chances shown are P = ENS_BETA * P_ensemble + (1 - ENS_BETA) * P_consensus; without ensemble
   data (still loading, or the service failed) they are the consensus alone, as before. */
const ENS_BETA = 0.7;
const ENS_SPREAD_MID = 4;    // hero verdict: temperature P10-P90 spread (deg C) from which the models "partly" agree ...
const ENS_SPREAD_LOW = 8;    // ... and from which they are "split"
const blendP = (det, ens) => (det == null || ens == null ? det : ENS_BETA * ens + (1 - ENS_BETA) * det);
// the ensemble probability of the block a..b ("rain" | "wind" | "gust"); null unless the ensemble has that block for this step
function ensP(kind, a, b) {
  const e = state.ens;
  if (!e || !state.data || e.time[a] !== state.data.time[a]) return null;
  const n = b - a, arr = e[`p_${kind}`]?.[n];
  if (!arr || a % n !== 0) return null;
  const v = arr[a / n];
  return v == null ? null : v;
}
/* Thunderstorm signal of one model for one block, 0..1:
     weather code 95-99                      -> 1
     otherwise  clamp((CAPE - 300) / 1500)   x 0.4 if CIN is strong (> 100 J/kg: a lid on the atmosphere)
                                             x 1.2 if the lifted index is below -3 (very unstable)
                                             x 1.3 if the block has >= 0.5 mm of rain (a storm is likely to show it), x 0.6 if it has none
   A model that gives neither a weather code nor CAPE gives no signal. */
const STORM_CAPE0 = 300, STORM_CAPE_SPAN = 1500, STORM_CIN_STRONG = 100, STORM_CIN_FACTOR = 0.4, STORM_LI_UNSTABLE = -3, STORM_LI_FACTOR = 1.2, STORM_RAIN_MM = 0.5, STORM_RAIN_UP = 1.3, STORM_DRY_DOWN = 0.6;
/* Systematic-error correction. The verification measures how much too warm / too windy each model runs (api/verify_lib.php
   correction_of, per lead day). With "Correct systematic error" on, the bias is removed from every value BEFORE any average,
   share or agreement is computed: temperature, pressure and humidity are shifted, wind and gusts are multiplied by truth/model.
   Rain and cloud are not touched. Limits keep a bad estimate harmless. */
const BIAS_MAX = { temperature_2m: 3, pressure_msl: 4, relative_humidity_2m: 15 };   // largest shift applied (deg C / hPa / %)
const WIND_RATIO_MIN = 0.7, WIND_RATIO_MAX = 1.3;
const BIAS_KEYS = ['temperature_2m', 'apparent_temperature', 'pressure_msl', 'relative_humidity_2m', 'wind_speed_10m', 'wind_gusts_10m'];
const biasVar = (key) => (key === 'apparent_temperature' ? 'temperature_2m' : key === 'wind_gusts_10m' ? 'wind_speed_10m' : key);
/* the correction of one model for one variable at forecast hour i: { add } or { mul } (null = none), interpolated between lead days */
function correctionAt(p, key, i) {
  const v = state.verify; if (!state.bias || !v) return null;
  const m = v.models?.[p.id]; if (!m) return null;
  const vr = biasVar(key), wind = vr === 'wind_speed_10m';
  v._lc = v._lc || {};
  const ck = `${p.id}|${vr}`;
  if (!v._lc[ck]) {
    const pick = (c) => (wind ? c?.wind_ratio : c?.bias?.[vr]);
    const pts = Object.keys(m.by_lead || {}).map(Number).sort((x, y) => x - y).map((d) => [d, pick(m.by_lead[d].corr)]).filter(([, x]) => x != null);
    if (!pts.length) { const x = wind ? m.corr?.wind_ratio : m.corr?.bias?.[vr] ?? m.obs?.bias?.[vr] ?? m.bias?.[vr]; if (x != null) pts.push([0, x]); }
    v._lc[ck] = pts;
  }
  const pts = v._lc[ck]; if (!pts.length) return null;
  const L = leadHoursOf(i) / 24;
  let x = pts[pts.length - 1][1];
  if (L <= pts[0][0]) x = pts[0][1];
  else for (let k = 1; k < pts.length; k++) if (L <= pts[k][0]) { const [d0, a0] = pts[k - 1], [d1, a1] = pts[k]; x = a0 + ((a1 - a0) * (L - d0)) / (d1 - d0); break; }
  return wind ? { mul: clamp(x, WIND_RATIO_MIN, WIND_RATIO_MAX) } : { add: -clamp(x, -BIAS_MAX[vr], BIAS_MAX[vr]) };
}
function fixValue(p, key, i, x) {
  if (x == null || !BIAS_KEYS.includes(key)) return x;
  const c = correctionAt(p, key, i); if (!c) return x;
  const y = c.mul != null ? x * c.mul : x + c.add;
  return key === 'relative_humidity_2m' ? clamp(y, 0, 100) : y;
}
const RAIN_THR = rainThr(1);   // hourly threshold (hero outlook, meteogram)
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

/* "Time down" ignores the Day selector and always starts from *now*, scrolling forward across day
   boundaries — a rolling window that grows via "Show N more hours" (see renderGridVertical), matching
   Glett. `hours` is how many real hours ahead to include (translated to step-blocks). */
/* "Time down" starts at the current hour for today and at 00:00 for any later day picked above */
function verticalStart() {
  const { data, step } = state;
  const nowStr = new Date(Date.now() + data.utc_offset_seconds * 1000).toISOString().slice(0, 13);
  let start = state.day > 0 ? state.day * 24 : data.time.findIndex((x) => x.slice(0, 13) >= nowStr);
  if (start < 0) start = 0;
  return start - (start % step);
}
function verticalColumns(hours) {
  const { data, step } = state;
  const nowStr = new Date(Date.now() + data.utc_offset_seconds * 1000).toISOString().slice(0, 13);
  const start = verticalStart();
  const count = Math.max(1, Math.ceil(hours / step));
  const cols = [];
  for (let a = start; cols.length < count && a < data.time.length; a += step) {
    const b = Math.min(a + step, data.time.length);
    const last = data.time[b - 1].slice(0, 13);
    cols.push({
      a, b, dateIdx: Math.floor(a / 24),
      label: step > 1 ? `${data.time[a].slice(11, 13)}–${String((+data.time[a].slice(11, 13) + step) % 24).padStart(2, '0')}` : data.time[a].slice(11, 16),
      past: false,
      now: data.time[a].slice(0, 13) <= nowStr && nowStr <= last,
      night: data.isDay[Math.min(a + Math.floor(step / 2), b - 1)] === 0,
    });
  }
  return cols;
}
const hasMoreVerticalHours = (hours) => {
  const { data, step } = state;
  const nowStr = new Date(Date.now() + data.utc_offset_seconds * 1000).toISOString().slice(0, 13);
  const start = verticalStart();
  return start + Math.ceil(hours / step) * step < data.time.length;
};

const cell = (html, bg = '', cls = '') => ({ html, bg, cls });

/* Reliability weighting: κάθε πάροχος έχει βάρος ανά παράμετρο (1 = ουδέτερο) */
const weightsOn = () => state.weighted && !!state.verify;
/* Lead time. The verification gives every model its own weights for several forecast lead days (see
   api/verify_lib.php); a column far into the future must not borrow the weights earned a few hours ahead.
   The lead of a column is its distance in hours from the moment the forecast was fetched; the weight is read
   from the neighbouring measured lead days and blended linearly (held constant beyond the first/last one).
   `at` is the hour index of the column: callers do not pass it — agg() notes the hour it was last asked about
   (lastAggA) and wpairs() reads it right after the callback has run; code that reads p.hourly directly (renderDays)
   passes it as wpairs' 3rd argument. Without it (or without lead data) the lead-0 weights are used, as before. */
let lastAggA = null;
const leadHoursOf = (a) => Math.max(0, (Date.parse(`${state.data.time[Math.min(a, state.data.time.length - 1)]}:00Z`) - state.data.utc_offset_seconds * 1000 - Date.parse(state.data.generated)) / 3600000);
function leadWeight(p, key, a) {
  const w = leadWeightNational(p, key, a), loc = state.verify.local, nat0 = state.verify.models[p.id]?.weights?.[key], wl = loc?.weights?.[p.id]?.[key];
  if (!loc || !loc.alpha || wl == null || nat0 == null) return w;
  return Math.min(2.2, Math.max(0.3, w + loc.alpha * (wl - nat0)));   // tilted towards the nearest stations (api/verify_lib.php local_blend)
}
function leadWeightNational(p, key, a) {
  const v = state.verify, base = v.models[p.id]?.weights?.[key];
  const wbl = v.weights_by_lead;
  if (!wbl || a == null) return base || 1;
  v._lw = v._lw || {};
  const ck = `${p.id}|${key}`;
  if (!v._lw[ck]) {
    v._lw[ck] = Object.keys(wbl).map(Number).sort((x, y) => x - y).map((d) => [d, wbl[d]?.[p.id]?.[key]]).filter(([, w]) => w != null);
  }
  const pts = v._lw[ck];
  if (!pts.length) return base || 1;
  const L = leadHoursOf(a) / 24;
  if (L <= pts[0][0]) return pts[0][1];
  for (let k = 1; k < pts.length; k++) {
    if (L <= pts[k][0]) { const [d0, w0] = pts[k - 1], [d1, w1] = pts[k]; return w0 + ((w1 - w0) * (L - d0)) / (d1 - d0); }
  }
  return pts[pts.length - 1][1];
}
const W = (p, key, a) => (weightsOn() ? leadWeight(p, key, a) : 1)
  * (state.weighted && p.corr?.cut ? ECMWF_COPY_FACTOR : 1) * familyShare(p);
const wpairs = (key, fn, at) => activeProviders().map((p) => { lastAggA = null; const v = fn(p); return { v, w: W(p, key, at ?? lastAggA) }; }).filter((x) => x.v != null && !Number.isNaN(x.v));
const wsum = (pr) => pr.reduce((a, x) => a + x.w, 0);
const wmean = (pr) => (pr.length ? pr.reduce((a, x) => a + x.v * x.w, 0) / wsum(pr) : null);
const wshare = (pr, f) => (pr.length ? pr.filter((x) => f(x.v)).reduce((a, x) => a + x.w, 0) / wsum(pr) : null);

/* Weighted share of each weather category for one column, sorted highest first — used by both the
   "Most likely weather" table row and the hero card so they always agree with each other. */
function weatherShares(c) {
  const pr = wpairs('weather', (p) => { const code = agg(p, 'code', c.a, c.b); return code == null ? null : WI.category(code); });
  if (!pr.length) return null;
  const tot = wsum(pr), cnt = {};
  pr.forEach((x) => (cnt[x.v] = (cnt[x.v] || 0) + x.w));
  return Object.entries(cnt).map(([k, w]) => [k, w / tot]).sort((a, b) => b[1] - a[1]);
}

function buildRows(param, cols) {
  const { data, step } = state;
  const P = activeProviders();
  const rows = [];   // ενδιάμεσες γραμμές παρόχων
  let summary, prob, summaryLabel, probLabel;

  // a provider's own row shows every hour, also the ones that are copies of another model (dimmed, with a tooltip)
  const ownCell = (fn, p, c) => {
    AGG_RAW = true;
    try {
      const x = fn(p, c);
      for (let i = c.a; p.dupHours && i < c.b; i++) if (p.dupHours[i]) { x.cls = `${x.cls || ''} dupc`; x.title = dupNote(p, i); break; }
      if (x.fix && state.bias) { const k = correctionAt(p, x.fix, c.a); if (k) { x.cls = `${x.cls || ''} corrc`; x.title = x.title || t('m.corrcell', { v: k.mul != null ? `×${k.mul.toFixed(2)}` : `${k.add >= 0 ? '+' : '−'}${Math.abs(k.add).toFixed(1)}` }); } }
      return x;
    } finally { AGG_RAW = false; }
  };
  const perProvider = (fn, list = P) => list.map((p) => ({ name: pname(p), id: p.id, cells: cols.map((c) => ownCell(fn, p, c)) }))
    .filter((r) => r.cells.some((c) => c.has));
  let extraRows;   // only set for 'weather': the named AI models, shown as their own rows right after "Most likely weather"

  if (param === 'weather') {
    const weatherCell = (p, c) => {
      const code = agg(p, 'code', c.a, c.b), t = agg(p, 'temperature_2m', c.a, c.b);
      return { has: code != null, html: code == null ? '<span class="na">–</span>' : `${WI.svg(code, c.night)}<small>${fmt(t)}°</small>`, cls: 'cell' };
    };
    // The flagship single-model AI forecasts (ECMWF AIFS, Google WeatherNext) don't mix in with the
    // regular provider rows here — they get their own rows below "Most likely weather" instead.
    rows.push(...perProvider(weatherCell, P.filter((p) => !HEADLINE_MODEL_IDS.includes(p.id))));
    summaryLabel = t('g.temp_avg');
    summary = cols.map((c) => {
      const m = wmean(wpairs('temperature_2m', (p) => agg(p, 'temperature_2m', c.a, c.b)));
      return cell(`<b>${fmt(m)}°</b>`, bgTemp(m));
    });
    probLabel = t('g.prob_weather');
    prob = cols.map((c) => {
      const shares = weatherShares(c);
      if (!shares) return cell('–');
      const top = shares[0][0];
      // Όλες οι κατηγορίες που προβλέπουν τα μοντέλα, με το ποσοστό τους
      const lines = shares.slice(0, 4).map(([k, sh], i) => `<div class="wline${i === 0 ? ' top' : ''}">${WI.svg(WI.CAT_CODE[k], c.night, 'mini')}<span>${t('cat.' + k)}</span><b>${Math.round(sh * 100)}%</b></div>`).join('');
      return cell(`${WI.svg(WI.CAT_CODE[top], c.night, 'big')}<div class="wlist">${lines}</div>`);
    });
    extraRows = perProvider(weatherCell, HEADLINE_MODEL_IDS.map((id) => P.find((p) => p.id === id)).filter(Boolean));
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
      const pr = blendP(wshare(wpairs('precip', (p) => agg(p, 'precip', c.a, c.b)), (x) => x >= rainThr(c.b - c.a)), ensP('rain', c.a, c.b));
      return cell(`<div class="pct">${Math.round(pr * 100)}%</div>`, `hsla(215,85%,50%,${pr * 0.55})`);
    });
  } else if (param === 'wind') {
    rows.push(...perProvider((p, c) => {
      const s = agg(p, 'wind_speed_10m', c.a, c.b), g = agg(p, 'gust', c.a, c.b), d = agg(p, 'dir', c.a, c.b);
      return { has: s != null, html: s == null ? '<span class="na">–</span>' : `${d != null ? WI.arrow(d) : ''}${fmt(s)}${g != null ? `<small>(${fmt(g)})</small>` : ''}`, bg: bgWind(s), cls: 'cell', fix: 'wind_speed_10m' };
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
      const pr = blendP(wshare(wpairs('wind', (p) => agg(p, 'wind_speed_10m', c.a, c.b)), (x) => x >= WIND_THR), ensP('wind', c.a, c.b));
      const g = nn(P.map((p) => agg(p, 'gust', c.a, c.b)));
      const gp = g.length ? `<small>${t('g.gusts', { v: Math.round(blendP(g.filter((x) => x >= 60).length / g.length, ensP('gust', c.a, c.b)) * 100) })}</small>` : '';
      return cell(`<div class="pct">${Math.round(pr * 100)}%</div>${gp}`, `hsla(170,70%,40%,${pr * 0.5})`);
    });
  } else if (param === 'storm') {
    const signal = (p, c) => {
      const code = agg(p, 'code', c.a, c.b), cape = agg(p, 'cape', c.a, c.b);
      const raw = (AGG_RAW ? p.hourly.weather_code.slice(c.a, c.b).filter((x) => x != null) : liveHours(p, p.hourly.weather_code, c.a, c.b)).length > 0;
      const thunder = raw ? code >= 95 : null;
      if (thunder == null && cape == null) return { s: null, cape };
      if (thunder) return { s: 1, cape };
      if (cape == null) return { s: 0, cape };
      let sig = clamp((cape - STORM_CAPE0) / STORM_CAPE_SPAN);
      const cin = agg(p, 'cin', c.a, c.b), li = agg(p, 'li', c.a, c.b), rain = agg(p, 'precip', c.a, c.b);
      if (cin != null && cin > STORM_CIN_STRONG) sig *= STORM_CIN_FACTOR;
      if (li != null && li < STORM_LI_UNSTABLE) sig *= STORM_LI_FACTOR;
      if (rain != null) sig *= rain >= STORM_RAIN_MM ? STORM_RAIN_UP : STORM_DRY_DOWN;
      return { s: clamp(sig), cape };
    };
    rows.push(...perProvider((p, c) => {
      const { s, cape } = signal(p, c);
      const html = s == null ? '<span class="na">–</span>' : `${s === 1 ? WI.bolt24 + ' ' : ''}${cape != null ? fmt(cape) : ''}<small>${s >= 0.99 ? t('g.storm_yes') : s >= 0.3 ? t('g.storm_maybe') : cape != null ? 'J/kg' : t('g.storm_no')}</small>`;
      return { has: s != null, html, bg: s > 0.02 ? `hsla(35,95%,50%,${0.15 + s * 0.4})` : '', cls: 'cell' };
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
      return { has: v != null, html: v == null ? '<span class="na">–</span>' : fmt(v, def.d) + (def.unit === '°C' ? '°' : ''), bg: def.bg(v), cls: 'cell', fix: param };
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
  return { rows, summary, prob, summaryLabel, probLabel, extraRows };
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

/* Reliability pop-up: how each model scored against ERA5 / METAR, and where models are switched on and off. */
let relDraft = new Set();   // the on/off choices made in the pop-up, applied only with "Exit and save"
function renderRelModal() {
  if ($('relModal').hidden || !state.data) return;
  const v = state.verify;
  const all = state.data.providers;
  const region = (id) => (hasT('mi.' + id) ? `<small>${t('mi.' + id)}</small>` : '');
  const corrNote = (p) => (p.corr ? `<small class="${p.corr.cut ? 'warn' : ''}">${esc(t(p.corr.cut ? 'm.corr.cut' : 'm.corr', { n: nameById(p.corr.ref), r: p.corr.r.toFixed(2), tr: Math.round(p.corr.trend * 100), f: ECMWF_COPY_FACTOR }))}</small>` : '');
  const nameCell = (p) => (p.dupOf
    ? `<span class="mdl off"><span class="mtxt"><b>${esc(pname(p))}</b><small>${esc(t('m.dup', { n: nameById(p.dupOf) }))}</small></span></span>`
    : `<label class="mdl"><input type="checkbox" data-mid="${p.id}" ${relDraft.has(p.id) ? '' : 'checked'}><span class="mtxt"><b>${esc(pname(p))}</b>${region(p.id)}${corrNote(p)}</span></label>`);
  const missing = allModelIds().filter((id) => !all.some((p) => p.id === id) && !OPTIONAL_MODEL_IDS.includes(id));
  const ncol = 9;
  const note = v ? '' : `<tr><td class="pad" colspan="${ncol - 1}">${state.verifyErr ? esc(t('r.unavailable', { e: state.verifyErr })) : t('r.loading')}</td></tr>`;
  const scoreOf = (p) => v?.models?.[p.id]?.score ?? -1;
  const sorted = [...all].sort((a, b) => scoreOf(b) - scoreOf(a));
  const metrics = (m) => {
    const src = (label, value, extra = '', cls = '') => `<div class="src ${cls}"><i>${label}</i> <b>${value}</b>${extra}</div>`;
    const mae = (k, d = 1) => {
      if (m.mae[k] == null) return '–';
      const o = m.obs?.mae?.[k];
      const bias = `<small>${t('r.bias', { v: (m.bias[k] > 0 ? '+' : '') + m.bias[k].toFixed(d) })}</small>`;
      return src('ERA5', m.mae[k].toFixed(d), bias) + (o != null ? src('METAR', o.toFixed(d), '', 'obs') : '');
    };
    const pct = (e, o) => (e != null ? src('ERA5', Math.round(e * 100) + '%') : '–') + (o != null ? src('METAR', Math.round(o * 100) + '%', '', 'obs') : '');
    // score per forecast day: shows which models lose accuracy quickly (only when the nightly job has measured the leads)
    const bl = m.by_lead ? Object.keys(m.by_lead).map(Number).sort((x, y) => x - y).filter((d) => m.by_lead[d].score != null) : [];
    const lead = bl.length > 1 ? `<div class="byl" title="${esc(t('r.bylead'))}">${bl.map((d) => `<span title="${esc(t('r.bylead.day', { d, s: m.by_lead[d].score }))}"><i class="${scoreCls(m.by_lead[d].score)}" style="height:${Math.max(2, Math.round(m.by_lead[d].score * 0.22))}px"></i><small>${d}</small></span>`).join('')}</div>` : '';
    return `<td><div class="bar"><i style="width:${m.score ?? 0}%"></i></div><b class="score ${scoreCls(m.score)}">${m.score ?? '–'}</b>${m.n ? `<small class="nsamp" title="${esc(t('r.samples.tip'))}">${t('r.samples', { n: m.n })}</small>` : ''}${lead}</td>
      <td class="cell">${mae('temperature_2m')}</td><td class="cell">${mae('wind_speed_10m')}</td><td class="cell">${mae('cloud_cover', 0)}</td>
      <td class="cell">${mae('relative_humidity_2m', 0)}</td><td class="cell">${mae('pressure_msl', 2)}</td>
      <td class="cell">${pct(m.csi, m.obs?.csi)}</td><td class="cell">${pct(m.code_acc, m.obs?.code_acc)}</td>`;
  };
  let html = `<thead><tr><th class="rowh">${t('r.model')}</th><th>${t('r.score')}</th><th>${t('r.temp')}</th><th>${t('r.wind')}</th><th>${t('r.cloud')}</th><th>${t('r.hum')}</th><th>${t('r.press')}</th><th>${t('r.rain')}</th><th>${t('r.code')}</th></tr></thead><tbody>${note}`;
  sorted.forEach((p) => {
    const m = v?.models?.[p.id];
    html += `<tr class="${relDraft.has(p.id) || p.dupOf ? 'off' : ''}"><th class="rowh">${nameCell(p)}</th>${m && !p.dupOf ? metrics(m) : `<td colspan="${ncol - 1}"></td>`}</tr>`;
  });
  missing.forEach((id) => { html += `<tr class="off"><th class="rowh"><span class="mdl off"><span class="mtxt"><b>${esc(nameById(id))}</b><small>${t('m.missing')}</small></span></span></th><td colspan="${ncol - 1}"></td></tr>`; });
  $('relTable').innerHTML = html + '</tbody>';
  const loc = v?.local;
  const localNote = loc && loc.alpha > 0 ? `<p class="hint">${t('r.local', { a: Math.round(loc.alpha * 100), list: loc.stations.map((x) => `${esc(x.name)} (${x.km} km)`).join(', ') })}</p>` : '';
  // transparency: when it was computed, how, over what, and whether it is out of date
  let meta = '';
  if (v) {
    const when = v.computed_at ? new Date(v.computed_at).toLocaleString(dateLocale(), { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : null;
    const parts = [
      v.greece ? t('r.meta.gr', { n: v.greece.stations }) : v.station ? t('r.meta.pt', { name: esc(v.station.name), km: v.station.km }) : t('r.meta.era'),
      loc && loc.alpha > 0 ? t('r.meta.loc', { a: Math.round(loc.alpha * 100) }) : '',
      v.leads && v.leads.length > 1 ? t('r.meta.lead', { l: v.leads.join(', ') }) : t('r.meta.nolead'),
      t('r.meta.win', { a: v.start, b: v.end, h: v.hours }),
    ].filter(Boolean);
    meta = `<p class="hint relmeta">${when ? `<b>${t('r.meta.when', { when })}</b> · ` : ''}${parts.join(' · ')}${v.stale ? ` <span class="stale">⚠ ${t('r.meta.stale')}</span>` : ''}</p>`;
  }
  $('relNote').innerHTML = t('r.howto') + localNote + meta;
}
const badge = (id) => { const sc = state.verify?.models?.[id]?.score; return sc != null ? `<span class="rel ${scoreCls(sc)}" title="${t('r.badge')}">${sc}</span>` : ''; };

/* The single current hour, independent of whatever day/step is selected in the table below */
function nowColumn() {
  const { data } = state;
  const nowStr = new Date(Date.now() + data.utc_offset_seconds * 1000).toISOString().slice(0, 13);
  let a = data.time.findIndex((x) => x.startsWith(nowStr));
  if (a < 0) a = data.time.findIndex((x) => x.slice(0, 13) >= nowStr);
  if (a < 0) a = 0;
  return { a, b: Math.min(a + 1, data.time.length), night: data.isDay[a] === 0 };
}

/* Hero card: the answer first — current conditions and how much the models agree on them */
/* When does the rain situation next change? Scans the weighted rain-probability consensus hour by hour
   from now, up to 24h ahead, for the first switch between "raining" and "dry" (≥ 50% of models agree). */
function rainOutlook(c0) {
  const { data } = state;
  const start = c0.a, horizon = Math.min(24, data.time.length - start);
  if (horizon <= 1) return null;
  const wetAt = (i) => { const s = blendP(wshare(wpairs('precip', (p) => agg(p, 'precip', i, i + 1)), (x) => x >= RAIN_THR), ensP('rain', i, i + 1)); return s != null && s >= 0.5; };
  const nowWet = wetAt(start);
  const when = (i) => (data.time[i].slice(0, 10) === data.time[start].slice(0, 10) ? '' : t('hero.rain.tomorrow') + ' ') + data.time[i].slice(11, 16);   // "tomorrow 21:00", not a bare 21:00
  for (let k = 1; k < horizon; k++) {
    const i = start + k;
    if (wetAt(i) !== nowWet) return nowWet ? t('hero.rain.break', { time: when(i) }) : t('hero.rain.start', { time: when(i) });
  }
  return nowWet ? t('hero.rain.continues') : t('hero.rain.none', { h: horizon });
}
const RAIN_DOT = '<svg class="rdot" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 2c4 5 7 8.5 7 12a7 7 0 0 1-14 0c0-3.5 3-7 7-12z" fill="var(--rain)"/></svg>';

function renderHero() {
  if (!state.data || !state.current) return;
  const c = nowColumn();
  const shares = weatherShares(c);
  const temp = wmean(wpairs('temperature_2m', (p) => agg(p, 'temperature_2m', c.a, c.b)));
  const feels = wmean(wpairs('temperature_2m', (p) => agg(p, 'apparent_temperature', c.a, c.b)));
  const ws = wmean(wpairs('wind', (p) => agg(p, 'wind_speed_10m', c.a, c.b)));
  const gust = wmean(wpairs('wind', (p) => agg(p, 'gust', c.a, c.b)));
  const dirs = nn(activeProviders().map((p) => agg(p, 'dir', c.a, c.b)));
  const top = shares ? shares[0] : null;
  const nAll = activeProviders().length, kTop = top ? Math.round(top[1] * nAll) : 0;
  $('heroNow').innerHTML = `${top ? WI.svg(WI.CAT_CODE[top[0]], c.night, 'xl') : ''}
    <div class="big"><div class="big-temp">${fmt(temp)}°</div>${feels != null && temp != null && Math.abs(feels - temp) >= 1 ? `<span class="feels">${t('hero.feels', { v: fmt(feels) })}</span>` : ''}</div>
    <div class="desc"><b>${top ? t('cat.' + top[0]) : ''}</b><span>${top ? t('hero.nmodels', { k: kTop, n: nAll }) : ''}</span>
      <div class="wind">${ws != null ? `${dirs.length ? WI.arrow(circMean(dirs, dirs.map(() => 1))) : ''}${fmt(ws)}${gust != null ? ` (${fmt(gust)})` : ''} km/h` : ''}</div>
    </div>`;
  if (top) {
    let level = top[1] >= 0.8 ? 'hi' : top[1] >= 0.5 ? 'mid' : 'lo';
    // the ensemble spread can only lower the confidence: a coin-flip chance of rain, or a wide temperature spread, means the models do not really agree
    const ens = state.ens && state.ens.time[c.a] === state.data.time[c.a] ? state.ens : null;
    const pRain = ens ? blendP(wshare(wpairs('precip', (p) => agg(p, 'precip', c.a, c.b)), (x) => x >= rainThr(c.b - c.a)), ensP('rain', c.a, c.b)) : null;
    const spread = ens && ens.t_p10[c.a] != null && ens.t_p90[c.a] != null ? ens.t_p90[c.a] - ens.t_p10[c.a] : null;
    if (ens) {
      const ensLevel = (pRain != null && pRain >= 0.35 && pRain <= 0.65) || (spread != null && spread >= ENS_SPREAD_LOW) ? 'lo'
        : (pRain != null && pRain >= 0.2 && pRain <= 0.8) || (spread != null && spread >= ENS_SPREAD_MID) ? 'mid' : 'hi';
      const rank = { lo: 0, mid: 1, hi: 2 };
      if (rank[ensLevel] < rank[level]) level = ensLevel;
    }
    const dots = Math.max(1, Math.round(top[1] * 5));
    const tv = nn(activeProviders().map((p) => agg(p, 'temperature_2m', c.a, c.b)));
    $('heroVerdict').className = `verdict ${level}`;
    $('heroVerdict').innerHTML = `<span class="dots ${level}">${Array.from({ length: 5 }, (_, i) => `<i class="${i < dots ? 'on' : ''}"></i>`).join('')}</span><div><b>${t('hero.verdict.' + level)}</b><small>${t('hero.verdict.detail', { time: state.data.time[c.a].slice(11, 16), k: kTop, n: nAll, cat: t('cat.' + top[0]).toLowerCase(), min: fmt(Math.min(...tv)), max: fmt(Math.max(...tv)) })}${ens && pRain != null ? ` ${t('hero.ens', { p: Math.round(pRain * 100), s: spread != null ? fmt(spread, 1) : '–' })}` : ''}</small></div>`;
    $('heroVerdict').hidden = false;
  } else { $('heroVerdict').hidden = true; }
  const obs = state.observed;
  $('heroObs').hidden = !obs;
  if (obs) {
    $('heroObs').innerHTML = `<b>${t('hero.obs', { loc: esc(locName(state.current)) })}:</b> ${fmt(obs.temp)}°${obs.rain != null ? ` · ${obs.rain ? t('hero.obs.wet') : t('hero.obs.dry')}` : ''}${obs.wind_kmh != null ? ` · ${t('hero.obs.wind', { v: fmt(obs.wind_kmh) })}` : ''}${obs.humidity != null ? ` · ${t('hero.obs.hum', { v: obs.humidity })}` : ''}
      <small>${t('hero.obs.station', { name: esc(obs.station.name), km: obs.station.km })}</small>`;
  }
  const radar = state.radar;
  $('heroRadar').hidden = !radar;
  if (radar) {
    const localTime = (iso) => { const d = new Date(new Date(iso).getTime() + state.data.utc_offset_seconds * 1000); return d.toISOString().slice(11, 16); };
    const msg = radar.changeAt
      ? t(radar.now ? 'hero.radar.break' : 'hero.radar.start', { time: localTime(radar.changeAt) })
      : t(radar.now ? 'hero.radar.now' : 'hero.radar.clear');
    $('heroRadar').innerHTML = `${RAIN_DOT}<span>${msg}</span>`;
  }
  const outlook = rainOutlook(c);
  $('heroRain').hidden = !outlook;
  if (outlook) $('heroRain').innerHTML = `${RAIN_DOT}<span>${outlook}</span>`;
  renderWarnings();
}

/* Colour legend for the weather-category icons, shown above the table only on the Weather tab */
function renderSegKey() {
  const show = state.param === 'weather';
  $('segKey').hidden = !show;
  if (!show) return;
  const cats = ['clear', 'partly', 'cloudy', 'fog', 'drizzle', 'rain', 'snow', 'thunder'];
  $('segKey').innerHTML = `<b>${t('lg.colours')}</b>` + cats.map((k) => `<span><i class="c-${k}"></i>${t('cat.' + k)}</span>`).join('');
}

function dayLabelFor(dateIdx) {
  const { data } = state;
  if (dateIdx < 0 || dateIdx >= data.dates.length) return '';
  const dt = new Date(data.dates[dateIdx] + 'T12:00:00');
  const label = dateIdx === 0 ? t('today') : dateIdx === 1 ? t('tomorrow') : dt.toLocaleDateString(dateLocale(), { weekday: 'short' });
  return `${label} ${dt.toLocaleDateString(dateLocale(), { day: 'numeric', month: 'short' })}`;
}

/* "Time down": one row per hour, starting from *now* and scrolling across day boundaries (see
   verticalColumns) — the consensus columns for the current tab, plus one column per provider (AI
   headline models always, the rest behind "Show all N models") — matches Glett. Ported directly from
   his renderGridVertical/buildRows (class names, structure and sizes) instead of a fresh design, so
   the two stay pixel-comparable: a "big" icon (.wi.big, 44px) leads the category list (.wlist/.wline,
   the same classes the old horizontal "prob" cell already used), only the top 2 categories show, and
   the segmented bar is .segbar (an <i> per category, same c-<key> colours as the legend). */
const weatherAgreeCell = (c) => {
  const shares = weatherShares(c);
  if (!shares) return cell('–');
  const top = shares[0][0];
  const lines = shares.slice(0, 2).map(([k, sh], i) => `<div class="wline${i === 0 ? ' top' : ''}">${WI.svg(WI.CAT_CODE[k], c.night, 'mini')}<span>${t('cat.' + k)}</span><b>${Math.round(sh * 100)}%${i === 0 ? ` <em>${t('g.agree_word')}</em>` : ''}</b></div>`).join('');
  const bar = `<div class="segbar">${shares.map(([k, sh]) => `<i class="c-${k}" style="width:${Math.max(sh * 100, 0)}%"></i>`).join('')}</div>`;
  return cell(`${WI.svg(WI.CAT_CODE[top], c.night, 'big')}<div class="wlist">${lines}${bar}</div>`, '', 'prob');
};
const tempWindRainCell = (c) => {
  const m = wmean(wpairs('temperature_2m', (p) => agg(p, 'temperature_2m', c.a, c.b)));
  const ws = wmean(wpairs('wind', (p) => agg(p, 'wind_speed_10m', c.a, c.b)));
  const g = wmean(wpairs('wind', (p) => agg(p, 'gust', c.a, c.b)));
  const dd = nn(activeProviders().map((p) => agg(p, 'dir', c.a, c.b)));
  const wind = ws != null ? `<small class="wnd">${dd.length ? WI.arrow(circMean(dd, dd.map(() => 1))) : ''}${fmt(ws)}${g != null ? ` (${fmt(g)})` : ''} km/h</small>` : '';
  const pr = blendP(wshare(wpairs('precip', (p) => agg(p, 'precip', c.a, c.b)), (x) => x >= rainThr(c.b - c.a)), ensP('rain', c.a, c.b));
  const mm = wmean(wpairs('precip', (p) => agg(p, 'precip', c.a, c.b)));
  const rain = pr != null ? `<small class="rn${Math.round(pr * 100) === 0 ? ' dim' : ''}">${Math.round(pr * 100)}%${mm != null && mm >= 0.05 ? ` · ${fmt(mm, 1)} mm` : ''}</small>` : '';
  const avg = (k) => wmean(wpairs(k, (p) => agg(p, k, c.a, c.b)));
  const cl = avg('cloud_cover'), hu = avg('relative_humidity_2m'), pr2 = avg('pressure_msl');
  const more = [cl != null ? `☁ ${fmt(cl)}%` : '', hu != null ? `💧 ${fmt(hu)}%` : '', pr2 != null ? `${fmt(pr2)} hPa` : ''].filter(Boolean);
  return cell(`${m != null ? `<b>${fmt(m)}°</b>` : ''}${wind}${rain}${more.length ? `<small class="mre">${more.join(' · ')}</small>` : ''}`, '', 'summary');
};

/* The "Weather" tab is the overview: every parameter, for the models too. Any other tab keeps the full
   weighted summary but lists the individual models for that one parameter only. */
const ALL_SECTIONS = ['weather', 'temperature_2m', 'precip', 'wind', 'cloud_cover', 'relative_humidity_2m', 'pressure_msl'];
const LANE_OF = { temperature_2m: 'temp', precip: 'rain', wind: 'wind', cloud_cover: 'cloud', relative_humidity_2m: 'hum', pressure_msl: 'press' };
/* Time across: the + next to a lane opens the comparison of the individual models for that parameter, right under it
   (the Weather lane opens the weather and the thunderstorm rows). All closed when the page opens. */
const LANE_SECTIONS = { wx: ['weather', 'storm'], temp: ['temperature_2m'], rain: ['precip'], wind: ['wind'], cloud: ['cloud_cover'], hum: ['relative_humidity_2m'], press: ['pressure_msl'] };
const openLanes = new Set();
/* "Time down": the weighted answer as one column per parameter (most likely weather, then temperature,
   wind, rain, cloud, humidity, pressure). With the models shown, every model gets one sub-column per
   parameter on the Weather tab, or a single column for the chosen parameter on the other tabs. */
function renderGridVertical(cols, builts) {
  const { rows, extraRows } = builts[0].built;
  const cls = (c) => (c.now ? ' now' : '');
  const lanes = buildWeatherLanes(cols).slice(2);   // temp, rain, wind, cloud, hum, press (weather + agreement come from weatherAgreeCell)
  const order = ['temp', 'wind', 'rain', 'cloud', 'hum', 'press'];
  const sumCols = order.map((k) => lanes.find((l) => l.cls === k));
  const models = [];   // the weighted columns only: the model comparison is in the Time across layout
  const subs = builts.map(({ key }) => ({ key, label: key === 'weather' ? t('lane.weather') : t('lane.' + LANE_OF[key]) }));
  const multi = builts.length > 1 && models.length;
  const rowOf = (b, id) => [...(b.extraRows || []), ...b.rows].find((r) => r.id === id);
  const colspan = 2 + sumCols.length + models.length * builts.length;
  const sel = LANE_OF[state.param];
  let html = `<thead><tr><th class="rowh"${multi ? ' rowspan="2"' : ''}>${t('g.time')}</th><th class="prob"${multi ? ' rowspan="2"' : ''}>${t('g.prob_weather')}<small class="hint2">${t('g.prob_weather.sub')}</small></th>`
    + sumCols.map((l) => `<th class="summary${l.cls === sel ? ' sel' : ''}"${multi ? ' rowspan="2"' : ''}>${l.name}</th>`).join('')
    + models.map((r) => `<th class="${r.cls}${multi ? ' grp' : ''}"${multi ? ` colspan="${builts.length}"` : ''}>${esc(r.name)}${badge(r.id)}</th>`).join('') + '</tr>';
  if (multi) html += `<tr class="subh">${models.map((r) => subs.map((s, j) => `<th class="${r.cls} sub${j === 0 ? ' first' : ''}">${s.label}</th>`).join('')).join('')}</tr>`;
  html += '</thead><tbody>';
  let prevDate = -1;
  cols.forEach((c, i) => {
    if (c.dateIdx !== prevDate) { html += `<tr class="dayrow"><th class="dh" colspan="${colspan}"><span>${dayLabelFor(c.dateIdx)}</span></th></tr>`; prevDate = c.dateIdx; }
    const left = weatherAgreeCell(c);
    const sums = sumCols.map((l) => { const x = l.cells[i]; return `<td class="summary sc" style="background:${x.bg || ''}">${x.html}</td>`; }).join('');
    const provCells = models.map((r) => builts.map(({ built }, j) => {
      const pr = rowOf(built, r.id), pc = pr && pr.cells[i];
      return `<td class="${r.cls}${j === 0 && multi ? ' first' : ''}" style="background:${pc && pc.bg || ''}">${pc ? pc.html : ''}</td>`;
    }).join('')).join('');
    html += `<tr class="hr${cls(c)}"><th class="rowh">${c.label}</th><td class="${left.cls || ''}" style="background:${left.bg || ''}">${left.html}</td>${sums}${provCells}</tr>`;
  });
  html += '</tbody>';
  $('grid').innerHTML = html;
  $('grid').classList.add('vert');
  $('grid').classList.add('weather-cols');
  $('grid').classList.toggle('solo', !models.length);   // only the weighted columns: let their bars use the free width
  const more = hasMoreVerticalHours(state.vHours);
  $('vFooter').hidden = false;
  $('vFooter').innerHTML = `<span>${t('v.showing', { d: dayLabelFor(cols[cols.length - 1]?.dateIdx), time: cols[cols.length - 1]?.label })}</span>
    ${more ? `<button type="button" class="btn primary small" id="vMore">${t('v.more', { n: 6 })}</button>` : ''}
    <button type="button" class="btn ghost small" id="vTop">${t('v.top')}</button>`;
  // Re-centering on the current hour makes sense the first time this view opens, but not after "Show N
  // more hours" — the reader is scrolled down reading new rows and a jump back to "now" would be jarring
  // (matches Glett, which appends rows in place without ever re-scrolling).
  if (vAutoCenter) { const nowRow = document.querySelector('#grid tbody tr.now'); if (nowRow) nowRow.scrollIntoView({ block: 'center' }); }
  vAutoCenter = true;
}
let vAutoCenter = true;
document.addEventListener('click', (e) => {
  if (e.target.id === 'vMore') { vAutoCenter = false; state.vHours += 6; renderGrid(); }
  else if (e.target.id === 'vTop') { document.querySelector('.hours-h')?.scrollIntoView({ block: 'start' }); }
});

/* A small hourly line/bar chart for the meteogram: x = hour of the selected day. `band` (optional) shades
   the min–max spread between providers behind the average line; `nowI` (optional) draws a dashed marker
   at the current hour. Deliberately independent of the Step selector — a meteogram is always hourly. */
function hourChart(points, { kind, color, unit, d = 1, band = null, band2 = null, nowI = -1, heat = null, fixed = null }) {
  const n = points.length;
  if (n < 2) return '';
  const label0 = (i) => points[i].label;
  const W = 1200, H = kind === 'bar' ? 110 : 170, pl = 40, pr = 12, pt = 10, pb = 22;
  const vals = nn(points.map((p) => p.v).concat(band ? band.flat() : [], band2 ? band2.flat() : []));
  let lo, hi;
  if (kind === 'bar') { lo = 0; hi = Math.max(2, (vals.length ? Math.max(...vals) : 0) * 1.25); }
  else if (fixed) { [lo, hi] = fixed; }
  else { lo = vals.length ? Math.min(...vals) : 0; hi = vals.length ? Math.max(...vals) : 1; const pad = (hi - lo) * 0.15 || 1; lo -= pad; hi += pad; }
  const x = (i) => pl + (i * (W - pl - pr)) / (n - 1);
  const y = (v) => pt + (H - pt - pb) * (1 - (v - lo) / (hi - lo || 1));
  let g = '';
  for (let i = 0; i <= 3; i++) {
    const v = lo + ((hi - lo) * i) / 3;
    g += `<line x1="${pl}" x2="${W - pr}" y1="${y(v).toFixed(1)}" y2="${y(v).toFixed(1)}" class="gl"/><text x="${pl - 6}" y="${(y(v) + 4).toFixed(1)}" text-anchor="end" class="tx">${Math.round(v)}</text>`;
  }
  points.forEach((p, i) => { if (i % 3 === 0 || i === n - 1) g += `<text x="${x(i).toFixed(1)}" y="${H - 6}" text-anchor="middle" class="tx">${p.label}</text>`; });
  let body = '';
  if (band2 && kind !== 'bar') {   // ensemble P10-P90: a fainter, outlined second band next to the model range
    const ok = band2.every((b_) => b_[0] != null && b_[1] != null);
    if (ok) {
      const top2 = band2.map((b_, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)} ${y(b_[1]).toFixed(1)}`).join('');
      const bot2 = band2.map((b_, i) => `L${x(n - 1 - i).toFixed(1)} ${y(band2[n - 1 - i][0]).toFixed(1)}`).join('');
      body += `<path d="${top2}${bot2}Z" fill="#8b5cf6" opacity=".09" stroke="#8b5cf6" stroke-opacity=".35" stroke-dasharray="4 3"/>`;
    }
  }
  if (band2 && kind === 'bar') {   // ensemble: a whisker from P10 to P90 on each bar
    body += band2.map((b_, i) => (b_[1] == null || b_[1] <= 0.01 ? '' : `<line x1="${x(i).toFixed(1)}" x2="${x(i).toFixed(1)}" y1="${y(b_[1]).toFixed(1)}" y2="${y(b_[0] ?? 0).toFixed(1)}" stroke="#8b5cf6" stroke-width="2.2" opacity=".6"><title>${label0(i)}: P10–P90 ${(b_[0] ?? 0).toFixed(d)}–${b_[1].toFixed(d)}${unit}</title></line>`)).join('');
  }
  if (band && kind === 'bar') {
    const bw0 = Math.max(2, (W - pl - pr) / n - 3);
    body += band.map((b_, i) => (b_[1] == null || b_[1] <= 0.01 ? '' : `<rect x="${(x(i) - bw0 / 2).toFixed(1)}" y="${y(b_[1]).toFixed(1)}" width="${bw0.toFixed(1)}" height="${(y(0) - y(b_[1])).toFixed(1)}" fill="${color}" opacity=".22"><title>${label0(i)}: max ${b_[1].toFixed(d)}${unit}</title></rect>`)).join('');
  } else if (band) {
    const top = band.map((b_, i) => (b_[1] == null ? '' : `${i ? 'L' : 'M'}${x(i).toFixed(1)} ${y(b_[1]).toFixed(1)}`)).join('');
    const bot = band.map((b_, i) => (b_[0] == null ? '' : `L${x(n - 1 - i).toFixed(1)} ${y(band[n - 1 - i][0]).toFixed(1)}`)).join('');
    body += `<path d="${top}${bot}Z" fill="${color}" opacity=".14"/>`;
  }
  if (kind === 'bar') {
    const bw = Math.max(2, (W - pl - pr) / n - 3);
    body += points.map((p, i) => (p.v == null ? '' : `<rect x="${(x(i) - bw / 2).toFixed(1)}" y="${y(p.v).toFixed(1)}" width="${bw.toFixed(1)}" height="${(y(0) - y(p.v)).toFixed(1)}" fill="${heat ? heat(p.v) : color}" opacity=".9"><title>${p.label}: ${p.v.toFixed(d)}${unit}</title></rect>`)).join('');
  } else {
    const pts = points.map((p, i) => (p.v == null ? null : `${x(i).toFixed(1)},${y(p.v).toFixed(1)}`)).filter(Boolean).join(' ');
    body += `<polyline points="${pts}" fill="none" stroke="${heat ? 'var(--line)' : color}" stroke-width="2"/>`;
    body += points.map((p, i) => (p.v == null ? '' : `<circle cx="${x(i).toFixed(1)}" cy="${y(p.v).toFixed(1)}" r="${heat ? 3.6 : 2.4}" fill="${heat ? heat(p.v) : color}"><title>${p.label}: ${p.v.toFixed(d)}${unit}</title></circle>`)).join('');
  }
  if (nowI >= 0 && nowI < n) body += `<line x1="${x(nowI).toFixed(1)}" x2="${x(nowI).toFixed(1)}" y1="${pt}" y2="${H - pb}" stroke="var(--accent)" stroke-width="1.5" stroke-dasharray="3 3"/>`;
  return `<svg class="hchart" viewBox="0 0 ${W} ${H}" role="img">${g}${body}</svg>`;
}

/* Meteogram: temperature (with model-spread band), precipitation and wind for the selected day, all 24
   hours at once — independent of the current parameter tab and step. */
function meteoHtml() {
  const { data } = state;
  const a = state.day * 24, b = Math.min(a + 24, data.time.length);
  const idx = []; for (let i = a; i < b; i++) idx.push(i);
  const label = (i) => data.time[i].slice(11, 16);
  const nowStr = new Date(Date.now() + data.utc_offset_seconds * 1000).toISOString().slice(0, 13);
  const nowI = idx.findIndex((i) => data.time[i].slice(0, 13) === nowStr);

  const temps = idx.map((i) => ({ v: wmean(wpairs('temperature_2m', (p) => agg(p, 'temperature_2m', i, i + 1))), label: label(i) }));
  const rng = (key, k2) => idx.map((i) => { const v = nn(activeProviders().map((p) => agg(p, k2 || key, i, i + 1))); return v.length ? [Math.min(...v), Math.max(...v)] : [null, null]; });
  const band = rng('temperature_2m');
  const e = state.ens && state.ens.time[idx[0]] === data.time[idx[0]] ? state.ens : null;   // ensemble percentiles for the same hours
  const eb = (lo, hi) => (e ? idx.map((i) => [e[lo][i], e[hi][i]]) : null);
  const precs = idx.map((i) => ({ v: wmean(wpairs('precip', (p) => agg(p, 'precip', i, i + 1))), label: label(i) }));
  const winds = idx.map((i) => ({ v: wmean(wpairs('wind', (p) => agg(p, 'wind_speed_10m', i, i + 1))), label: label(i) }));

  const clouds = idx.map((i) => ({ v: wmean(wpairs('cloud_cover', (p) => agg(p, 'cloud_cover', i, i + 1))), label: label(i) }));
  return `
    <div class="mg-lane"><b>${t('mg.temp')}${e ? t('mg.ens') : ''}</b>${hourChart(temps, { kind: 'line', color: 'var(--accent)', unit: '°C', band, band2: eb('t_p10', 't_p90'), nowI, heat: heatTemp })}</div>
    <div class="mg-lane"><b>${t('mg.precip')}${e ? t('mg.ens.bar') : ''}</b>${hourChart(precs, { kind: 'bar', color: 'var(--rain)', unit: 'mm', nowI, band: rng('precip'), band2: eb('r_p10', 'r_p90'), heat: heatRain })}</div>
    <div class="mg-lane"><b>${t('mg.wind')}</b>${hourChart(winds, { kind: 'line', color: 'var(--good)', unit: 'km/h', d: 0, nowI, band: rng('wind', 'wind_speed_10m'), heat: heatWind })}</div>
    <div class="mg-lane"><b>${t('mg.cloud')}</b>${hourChart(clouds, { kind: 'line', color: 'var(--muted)', unit: '%', d: 0, nowI, fixed: [0, 100], band: rng('cloud_cover'), heat: heatCloud })}</div>`;
}

/* Weather tab only, "time across" mode: instead of one summary/prob pair, show every key metric as its
   own row at once (weather, agreement, temperature, rain, wind) — a compact dashboard, with the
   per-provider detail still available (collapsed) via "Show all N models" underneath. */
function buildWeatherLanes(cols) {
  const lane = (name, cells, cls) => ({ name, cells, cls });
  const wx = cols.map((c) => {
    const shares = weatherShares(c);
    return shares ? cell(WI.svg(WI.CAT_CODE[shares[0][0]], c.night, 'big')) : cell('–');
  });
  const agree = cols.map((c) => {
    const shares = weatherShares(c);
    if (!shares) return cell('–');
    const pct = Math.round(shares[0][1] * 100);
    const bar = `<div class="segbar">${shares.map(([k, sh]) => `<i class="c-${k}" style="width:${Math.max(sh * 100, 0)}%"></i>`).join('')}</div>`;
    return cell(`<div class="pct ${pct >= 75 ? '' : pct >= 50 ? 'dim' : 'dim'}">${pct}%</div>${bar}`);
  });
  const temp = cols.map((c) => {
    const m = wmean(wpairs('temperature_2m', (p) => agg(p, 'temperature_2m', c.a, c.b)));
    return cell(`<b>${fmt(m)}°</b>`);   // no heat tint here: the Weather tab stays plain, like Glett
  });
  const rain = cols.map((c) => {
    const pr = blendP(wshare(wpairs('precip', (p) => agg(p, 'precip', c.a, c.b)), (x) => x >= rainThr(c.b - c.a)), ensP('rain', c.a, c.b));
    if (pr == null) return cell('–');
    const m = wmean(wpairs('precip', (p) => agg(p, 'precip', c.a, c.b)));
    return cell(`<div class="pct">${Math.round(pr * 100)}%</div>${m != null && m >= 0.05 ? `<small>${fmt(m, 1)} mm</small>` : ''}`);
  });
  const wind = cols.map((c) => {
    const m = wmean(wpairs('wind', (p) => agg(p, 'wind_speed_10m', c.a, c.b)));
    if (m == null) return cell('–');
    const g = wmean(wpairs('wind', (p) => agg(p, 'gust', c.a, c.b)));
    const dd = nn(activeProviders().map((p) => agg(p, 'dir', c.a, c.b)));
    return cell(`${dd.length ? WI.arrow(circMean(dd, dd.map(() => 1))) : ''}${fmt(m)}${g != null ? `<small>(${fmt(g)})</small>` : ''}`);
  });
  const plain = (key, d, suffix = '', shade = null) => cols.map((c) => {
    const m = wmean(wpairs(key, (p) => agg(p, key, c.a, c.b)));
    return m == null ? cell('–') : cell(`${fmt(m, d)}${suffix}`, shade ? shade(m) : '');   // cloud / humidity: shading grows with the percentage
  });
  return [
    lane(t('lane.weather'), wx, 'wx'), lane(t('lane.agree'), agree, 'agree'), lane(t('lane.temp'), temp, 'temp'),
    lane(t('lane.rain'), rain, 'rain'), lane(t('lane.wind'), wind, 'wind'),
    lane(t('lane.cloud'), plain('cloud_cover', 0, '%', bgCloud), 'cloud'), lane(t('lane.hum'), plain('relative_humidity_2m', 0, '%', bgHum), 'hum'),
    lane(t('lane.press'), plain('pressure_msl', 0), 'press'),
  ];
}

function renderGrid() {
  const { param } = state;
  renderSegKey();
  // "Sunset & sunrise" view: its own panel, no parameter tabs / legend / model list
  const sun = state.orient === 's';
  $('legend').hidden = sun; $('sunsetBox').hidden = !sun;
  if (sun) { $('segKey').hidden = true; $('grid').classList.remove('vert', 'lanes'); $('grid').hidden = true; $('hcharts').hidden = true; $('chartsToggle').hidden = true; $('modelsCount').hidden = true; $('vFooter').hidden = true; Sunset.render(); return; }

  const cols = state.orient === 'v' ? verticalColumns(state.vHours) : columns();
  // Weather = overview: the models are listed for every parameter; any other tab lists them for that one only
  const builts = (param === 'weather' ? ALL_SECTIONS : [param]).map((key) => ({ key, built: buildRows(key, cols) }));
  const { rows, extraRows } = builts[0].built;

  if (state.orient === 'v') {
    $('grid').classList.remove('lanes');
    $('grid').hidden = false; $('hcharts').hidden = true; $('chartsToggle').hidden = true;
    renderGridVertical(cols, builts);
    setModelsCount();
  } else {
    $('grid').classList.remove('vert');
    $('grid').classList.add('lanes');
    $('vFooter').hidden = true;
    $('grid').hidden = false;
    const cls = (c) => `${c.past ? 'past' : ''}${c.now ? ' now' : ''}`;
    const rowHtml = (r, extraCls = '') => `<tr class="${extraCls}"><th class="rowh">${esc(r.name)}${badge(r.id)}</th>${r.cells.map((c, i) => `<td class="${c.cls || ''} ${cls(cols[i])}" style="background:${c.bg || ''}"${c.title ? ` title="${esc(c.title)}"` : ''}>${c.html}</td>`).join('')}</tr>`;
    let html = `<thead><tr><th class="rowh">${t('g.provider')}</th>${cols.map((c) => `<th class="${cls(c)}">${c.label}</th>`).join('')}</tr></thead><tbody>`;
    // Consensus-first, matching Glett: the weighted answer (lanes / summary+prob) comes first, then the
    // flagship AI models, then the collapsed "Show all N models" individual provider rows last.
    // the full weighted summary on every tab; the tab's own parameter is highlighted
    buildWeatherLanes(cols).forEach((l) => {
      const secs = LANE_SECTIONS[l.cls], open = !!secs && openLanes.has(l.cls);
      const tip = secs ? t(open ? 'm.lane.hide' : 'm.lane.show', { p: l.name }) : '';
      const tog = secs ? `<button type="button" class="lane-x" aria-expanded="${open}" aria-label="${esc(tip)}">${open ? '−' : '+'}</button>` : '';
      const thTitle = secs ? tip : (state.ens && (l.cls === 'rain' || l.cls === 'wind') ? t('ens.tip') : '');
      html += `<tr class="lane ${l.cls}${open ? ' open' : ''}"${secs ? ` data-lane="${l.cls}"` : ''}><th class="rowh${secs ? ' tog' : ''}"${thTitle ? ` title="${esc(thTitle)}"` : ''}>${tog}${l.name}</th>${l.cells.map((c, i) => `<td class="${cls(cols[i])}" style="background:${c.bg || ''}">${c.html}</td>`).join('')}</tr>`;
      if (!open) return;
      // the individual models for this parameter (the AI ones first)
      secs.forEach((key) => {
        const b = buildRows(key, cols), list = [...(b.extraRows || []).map((r) => [r, 'ai']), ...b.rows.map((r) => [r, ''])];
        if (!list.length) return;
        if (secs.length > 1) html += `<tr class="sect"><th colspan="${cols.length + 1}"><span>${t('p.' + key)}</span></th></tr>`;
        list.forEach(([r, c]) => { html += rowHtml(r, `${c} mrow`); });
      });
    });
    html += '</tbody>';
    $('grid').innerHTML = html;
    centerNow();
    requestAnimationFrame(() => requestAnimationFrame(centerNow));
    $('chartsToggle').hidden = false;
    $('chartsToggle').classList.toggle('active', state.chartsOpen);
    $('hcharts').hidden = !state.chartsOpen;
    if (state.chartsOpen) $('hcharts').innerHTML = meteoHtml();
    setModelsCount();
  }
  // the legend explains the summary, and every parameter whose models are open
  const openKeys = state.orient === 'v' ? [] : [...openLanes].flatMap((k) => LANE_SECTIONS[k]).filter((k) => k !== 'weather');
  const compareNote = openLanes.size && state.orient !== 'v' && extraRows && extraRows.length ? t('lg.compare') : '';
  $('legend').textContent = ['weather', ...openKeys].map((k) => t('lg.' + k, { thr: k === 'precip' ? rainThr(state.step) : WIND_THR })).join(' ') + t('lg.providers', { n: rows.length }) + (weightsOn() ? t('lg.weighted') : '') + compareNote + (state.ens ? t('lg.ens', { b: Math.round(ENS_BETA * 100), n: state.ens.systems.reduce((a, x) => a + x.members, 0), k: state.ens.systems.length }) : '');
}
// how many models are switched on, above the table; it opens the Reliability window (where they are switched on and off)
function setModelsCount() {
  const uniq = uniqueProviders(), on = uniq.filter((p) => !state.disabled.has(p.id)).length;
  const b = $('modelsCount');
  b.hidden = false; b.querySelector('span').textContent = t('m.count', { a: on, n: uniq.length });
}
$('modelsCount').addEventListener('click', () => $('relBtn').click());
state.chartsOpen = (() => { try { return localStorage.getItem('wefo.chartsOpen') === '1'; } catch (e) { return false; } })();
$('chartsToggle').addEventListener('click', () => {
  state.chartsOpen = !state.chartsOpen;
  try { localStorage.setItem('wefo.chartsOpen', state.chartsOpen ? '1' : '0'); } catch (e) { /* ignore */ }
  renderGrid();
});
// + / − on a lane (or a click on its name): open or close the model comparison for that parameter
$('grid').addEventListener('click', (e) => {
  const th = e.target.closest('tr.lane[data-lane] > th.rowh'); if (!th) return;
  const k = th.parentElement.dataset.lane;
  if (openLanes.has(k)) openLanes.delete(k); else openLanes.add(k);
  renderGrid();
});
document.querySelectorAll('#orientSeg [data-orient]').forEach((b) => {
  b.classList.toggle('active', b.dataset.orient === state.orient);
  b.addEventListener('click', () => {
    state.orient = b.dataset.orient;
    try { localStorage.setItem('wefo.orient', state.orient); } catch (e) { /* ignore */ }
    document.querySelectorAll('#orientSeg [data-orient]').forEach((x) => x.classList.toggle('active', x === b));
    renderGrid();
  });
});

/* ================= Ημέρες & καρτέλες ================= */
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
    const wp = (key, fn) => wpairs(key, fn, a + 12);   // a day's weights: the lead at midday
    const cnt = {};
    wp('weather', (p) => dayCategory(liveHours(p, p.hourly.code, a + 6, a + 22))).forEach((x) => (cnt[x.v] = (cnt[x.v] || 0) + x.w));
    const top = Object.entries(cnt).sort((x, y) => y[1] - x[1])[0];
    const ext = (fn) => wmean(wp('temperature_2m', (p) => { const v = liveHours(p, p.hourly.temperature_2m, a, b); return v.length ? fn(...v) : null; }));
    const hi = ext(Math.max), lo = ext(Math.min);
    const rp0 = wshare(wp('precip', (p) => { const v = liveHours(p, p.hourly.precipitation, a, b); return v.length ? v.reduce((s, x) => s + x, 0) : null; }), (x) => x >= 1);
    const rp = blendP(rp0, b - a === 24 ? ensP('rain', a, b) : null);
    const rain = rp == null ? null : Math.round(rp * 100);
    const sp = wshare(wp('storm', (p) => { const v = liveHours(p, p.hourly.weather_code, a, b); return v.length ? (v.some((x) => x >= 95) ? 1 : 0) : null; }), (x) => x === 1);
    const storm = sp == null ? 0 : Math.round(sp * 100);
    const gm = wmean(wp('wind', (p) => { const v = liveHours(p, p.hourly.wind_gusts_10m, a, b); return v.length ? Math.max(...v) : null; }));
    const dt = new Date(date + 'T12:00:00');
    const name = d === 0 ? t('today') : dt.toLocaleDateString(dateLocale(), { weekday: 'short' });
    return `<button class="d ${d === state.day ? 'sel' : ''}" data-day="${d}">
      <span class="lab">${name}<small>${dt.toLocaleDateString(dateLocale(), { day: 'numeric', month: 'short' })}</small></span>
      ${top ? WI.svg(WI.CAT_CODE[top[0]]) : '<span></span>'}
      <span class="hl">${fmt(hi)}°<span>/${fmt(lo)}°</span></span>
      <span class="pr">${rain != null ? `<b>${rain}%</b>` : '–'}${storm >= 20 ? `<small class="storm">${WI.bolt24}${storm}%</small>` : ''}</span>
      <span class="gu">${gm != null ? fmt(gm) : '–'}</span>
    </button>`;
  }).join('');
}


const allModelIds = () => Object.keys(state.data.models_known || {});   // used to list models without coverage for a location
// Optional, key-gated models (e.g. need a Google Cloud API key in api/config.php): most deployments
// won't have them configured, so — unlike an ordinary "no coverage here" model — they are only ever
// listed when actually present in the data, never shown as a perpetual "missing" placeholder.
const OPTIONAL_MODEL_IDS = ['google_weathernext'];
// Individual models to call out by name in the weighted "most likely weather" cell, next to WeFO's own
// blended result — the flagship single-model AI forecasts people are most likely to compare against.
const HEADLINE_MODEL_IDS = ['google_weathernext', 'ecmwf_aifs025_single'];

function renderModels() {
  $('relBtn').textContent = t('p.reliability');   // how many are active is shown above the forecast table
  renderRelModal();
}
function saveDisabled() {
  try { localStorage.setItem('wefo.disabled', JSON.stringify([...state.disabled])); } catch (e) { /* ignore */ }
  Prefs.save('wefo.disabled', JSON.stringify([...state.disabled]));
}
$('relTable').addEventListener('change', (e) => {
  const id = e.target.dataset.mid; if (!id) return;
  if (e.target.checked) relDraft.delete(id);
  else if (uniqueProviders().filter((p) => !relDraft.has(p.id)).length > 1) relDraft.add(id);
  else e.target.checked = true;   // at least one model must stay on
  renderRelModal();
});
$('relAll').addEventListener('click', () => { relDraft.clear(); renderRelModal(); });
$('relBtn').addEventListener('click', () => { relDraft = new Set(state.disabled); $('relModal').hidden = false; renderRelModal(); });
// Exit and save: apply the choices and refresh the tables only if some model was switched on or off
$('relSave').addEventListener('click', () => {
  const changed = relDraft.size !== state.disabled.size || [...relDraft].some((id) => !state.disabled.has(id));
  $('relModal').hidden = true;
  if (!changed) return;
  state.disabled = new Set(relDraft); saveDisabled(); renderAll();
});

function renderAll() {
  famCount = null;
  renderModels(); renderDays(); renderHero(); renderGrid();
  const d = state.data, loc = state.current;
  $('meta').textContent = t('meta', { name: locName(loc), lat: d.lat.toFixed(3), lon: d.lon.toFixed(3), el: Math.round(d.elevation ?? 0), a: activeProviders().length, n: uniqueProviders().length, time: new Date(d.generated).toLocaleTimeString(dateLocale(), { hour: '2-digit', minute: '2-digit' }) });
}

$('days').addEventListener('click', (e) => {
  const b = e.target.closest('[data-day]'); if (!b) return;
  state.day = +b.dataset.day; state.vHours = 24; vAutoCenter = true; renderDays(); renderGrid();
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
    const data = await api(`api/forecast.php?lat=${loc.lat}&lon=${loc.lon}${loc.elevation != null ? `&elevation=${loc.elevation}` : ''}${refresh ? '&refresh=1' : ''}`);
    if (token !== state.token) return;
    state.data = prepare(data);
    state.day = 0; state.vHours = 24;
    state.verify = null; state.verifyErr = null; state.observed = null; state.radar = null; state.ens = null;
    $('loading').hidden = true; $('forecastBody').hidden = false;
    renderAll();
    loadVerify(loc, token);
    loadObserved(loc, token);
    loadEnsemble(loc, token);
    loadWarnings(token);
    // Radar nowcast ("Next break") is built (see loadRadar/api/radar.php) but turned off for now: the
    // hero card is meant to hold exactly three boxes — agreement, measured now, and the outlook —
    // per request. Re-add a `loadRadar(loc, token);` call here to bring it back.
  } catch (err) {
    if (token !== state.token) return;
    $('loading').hidden = true;
    $('error').textContent = err.message; $('error').hidden = false;
  }
}

/* "Measured now": the latest real METAR observation from the nearest airport station — actual
   measured data, not a model forecast. Silent failure (no station nearby, API down) just keeps
   the hero card's "Measured now" line hidden. */
async function loadObserved(loc, token) {
  try {
    const r = await api(`api/observed.php?lat=${loc.lat}&lon=${loc.lon}`);
    if (token !== state.token) return;
    state.observed = r.observed || null;
    renderHero();
  } catch (err) { /* silent: this line is a nice-to-have, not core */ }
}

/* "Next break": a short-term rain nowcast sampled from RainViewer's real radar composite at this exact
   point (not a map) — independent of, and usually more precise near-term than, the model-based outlook
   in #heroRain below it. Silent failure keeps the line hidden. */
async function loadRadar(loc, token) {
  try {
    const r = await api(`api/radar.php?lat=${loc.lat}&lon=${loc.lon}`);
    if (token !== state.token) return;
    state.radar = r.radar || null;
    renderHero();
  } catch (err) { /* silent */ }
}

/* EMY warnings (api/warnings.php, from MeteoAlarm). The feed has no geometry, so they are listed for Greece as a whole, with their region
   names, and only for a location inside Greece. Silent when the feed fails or nothing is in force. */
const WARN_LEVEL = { 2: 'yellow', 3: 'orange', 4: 'red' };
const inGreece = (lat, lon) => lat >= 34 && lat <= 41.8 && lon >= 19 && lon <= 29.8;
function renderWarnings() {
  const el = $('heroWarn'), loc = state.current, w = state.warn;
  if (!el) return;
  if (!loc || !w || !w.length || !inGreece(loc.lat, loc.lon)) { el.hidden = true; return; }
  const tz = (iso) => { const d = new Date(new Date(iso).getTime() + state.data.utc_offset_seconds * 1000); return `${String(d.getUTCDate()).padStart(2, '0')}/${String(d.getUTCMonth() + 1).padStart(2, '0')} ${d.toISOString().slice(11, 16)}`; };
  const groups = new Map();   // one chip per kind and level, listing its regions
  w.forEach((x) => { const k = `${x.type}|${x.level}`; if (!groups.has(k)) groups.set(k, { ...x, areas: [], until: x.expires }); const g = groups.get(k); const a = LANG === 'el' && x.area_el ? x.area_el : x.area; if (!g.areas.includes(a)) g.areas.push(a); if (x.expires > g.until) g.until = x.expires; });
  const rows = [...groups.values()].sort((x, y) => y.level - x.level);
  const top = WARN_LEVEL[rows[0].level] || 'yellow';   // the box takes the colour of the most severe warning
  el.className = `warnline ${top}`;
  el.innerHTML = `<div class="wlab" title="${esc(t('warn.tip'))}">⚠ ${t('warn.title')}</div><ul>`
    + rows.map((g) => `<li class="${WARN_LEVEL[g.level] || 'yellow'}"><i></i><span><b>${esc(t('warn.type.' + g.type))}</b> — ${esc(g.areas.join(', '))} <small>${t('warn.until', { when: tz(g.until) })}</small></span></li>`).join('') + '</ul>';
  el.hidden = false;
}
async function loadWarnings(token) {
  try {
    const r = await api('api/warnings.php');
    if (token !== state.token) return;
    state.warn = r.warnings || [];
    renderWarnings();
  } catch (e) { /* silent: no warning line */ }
}
// Ensemble probabilities arrive after the page is already usable; any failure leaves the consensus-only behaviour
async function loadEnsemble(loc, token) {
  try {
    const e = await api(`api/ensemble.php?lat=${loc.lat}&lon=${loc.lon}${loc.elevation != null ? `&elevation=${loc.elevation}` : ''}`);
    if (token !== state.token || !e || !e.time) return;
    state.ens = e;
    renderAll();
  } catch (err) { /* silent: the deterministic consensus stays */ }
}
async function loadVerify(loc, token) {
  $('vfStatus').textContent = t('vf.loading');
  try {
    const v = await api(`api/verify.php?lat=${loc.lat}&lon=${loc.lon}`);
    if (token !== state.token) return;
    state.verify = v;
    Object.entries(v.models || {}).forEach(([id, m]) => { if (m.name && !MODEL_NAMES[id]) MODEL_NAMES[id] = m.name; });
    $('vfStatus').textContent = '';
    renderAll();
  } catch (err) {
    if (token !== state.token) return;
    state.verifyErr = err.message;
    $('vfStatus').textContent = t('vf.unavail');
    renderRelModal();
  }
}
$('weightChk').checked = state.weighted;
$('weightChk').addEventListener('change', (e) => {
  state.weighted = e.target.checked;
  try { localStorage.setItem('wefo.weighted', state.weighted ? '1' : '0'); } catch (err) { /* ignore */ }
  Prefs.save('wefo.weighted', state.weighted ? '1' : '0');
  if (state.data) renderAll();
});

$('biasChk').checked = state.bias;
$('biasChk').addEventListener('change', (e) => {
  state.bias = e.target.checked;
  try { localStorage.setItem('wefo.bias', state.bias ? '1' : '0'); } catch (err) { /* ignore */ }
  Prefs.save('wefo.bias', state.bias ? '1' : '0');
  if (state.data) renderAll();
});
$('oneVoteChk').checked = state.oneVote;
$('oneVoteChk').addEventListener('change', (e) => {
  state.oneVote = e.target.checked;
  try { localStorage.setItem('wefo.oneVote', state.oneVote ? '1' : '0'); } catch (err) { /* ignore */ }
  Prefs.save('wefo.oneVote', state.oneVote ? '1' : '0');
  if (state.data) renderAll();
});

/* A location is { id, name, name_el?, lat, lon }. Saved locations and the built-in Greek cities have a
   database id; a point picked on the map (or "My location" for a visitor) is ad-hoc: id = null, kept only
   in this browser, and without the climate history, which needs a stored location. */
const allLocations = () => [...state.locations, ...state.cities];
const ADHOC = '__adhoc__';

function renderLocSelect() {
  const opt = (l) => `<option value="${l.id}">${esc(locName(l))}</option>`;
  const cities = [...state.cities].sort((a, b) => locName(a).localeCompare(locName(b), dateLocale()));
  const adhoc = state.current && state.current.id == null ? `<option value="${ADHOC}">📌 ${esc(state.current.name)}</option>` : '';
  $('locSelect').innerHTML = `<option value="__geo__">📍 ${esc(t('pl.geo'))}</option><option value="__map__">🗺️ ${esc(t('loc.map'))}</option>${adhoc}`
    + (state.user && state.locations.length ? `<optgroup label="${esc(t('loc.saved'))}">${state.locations.map(opt).join('')}</optgroup>` : '')
    + `<optgroup label="${esc(t('loc.cities'))}">${cities.map(opt).join('')}</optgroup>`;
  $('locSelect').value = state.current ? (state.current.id == null ? ADHOC : String(state.current.id)) : '';
  $('astroLoc').innerHTML = $('locSelect').innerHTML; $('astroLoc').value = $('locSelect').value;
  $('dsoLoc').innerHTML = $('locSelect').innerHTML; $('dsoLoc').value = $('locSelect').value;   // the Astronomy tab shares the location
  $('histLoc').innerHTML = $('locSelect').innerHTML; $('histLoc').value = $('locSelect').value;   // and so does the History tab
}

function setCurrent(loc, go = false) {
  state.current = loc || null;
  try {
    if (!loc) { localStorage.removeItem('wefo.loc'); localStorage.removeItem('wefo.adhoc'); }
    else if (loc.id != null) { localStorage.setItem('wefo.loc', loc.id); localStorage.removeItem('wefo.adhoc'); }
    else { localStorage.setItem('wefo.loc', ADHOC); localStorage.setItem('wefo.adhoc', JSON.stringify({ name: loc.name, lat: loc.lat, lon: loc.lon })); }
  } catch (e) { /* ignore */ }
  renderLocSelect();
  if (go && state.view !== 'astro' && state.view !== 'dso' && state.view !== 'history') showView('forecast');
  loadForecast();
  if (state.view === 'astro') Astro.load();
  if (typeof LpMap !== 'undefined' && LpMap.isOpen) LpMap.sync();
  if (state.view === 'dso') Dso.refreshLocation();
  if (state.view === 'history') showHistoryView();
}
$('locSelect').addEventListener('change', (e) => {
  const v = e.target.value;
  const back = () => { $('locSelect').value = state.current ? (state.current.id == null ? ADHOC : String(state.current.id)) : ''; $('astroLoc').value = $('locSelect').value; $('dsoLoc').value = $('locSelect').value; $('histLoc').value = $('locSelect').value; };
  if (v === '__geo__') { back(); useMyLocation(); return; }
  if (v === '__map__') { back(); openMapPicker(); return; }
  if (v === ADHOC) return;
  const loc = allLocations().find((l) => l.id == v);
  if (loc) setCurrent(loc); else back();
});
$('refreshBtn').addEventListener('click', () => loadForecast(true));

const toolbarErr = (text) => { $('error').textContent = text; $('error').hidden = false; };
const adhocName = async (lat, lon) => {
  try { const r = await api(`api/geocode.php?lat=${lat}&lon=${lon}&lang=${LANG}`); if (r.name) return r.name; } catch (e) { /* ignore */ }
  return `${lat.toFixed(3)}, ${lon.toFixed(3)}`;
};

/* "My location" in the toolbar's Location select. A logged-in admin gets it saved (reusing a saved location
   already within 1 km, so repeat use doesn't pile up near-duplicates — same as the Places tab's pin-and-save,
   in one step); a visitor just gets the forecast for the spot, nothing is stored on the server. */
function useMyLocation() {
  if (!navigator.geolocation) { toolbarErr(t('err.geo.unsupported')); return; }
  navigator.geolocation.getCurrentPosition(
    async (pos) => {
      const lat = pos.coords.latitude, lon = pos.coords.longitude;
      const near = allLocations().find((l) => haversineKm(lat, lon, l.lat, l.lon) < 1);
      if (near) { setCurrent(near); return; }
      const name = await adhocName(lat, lon);
      if (!state.user) { setCurrent({ id: null, name, lat, lon }); return; }
      try {
        const loc = await api('api/locations.php', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name, lat, lon }) });
        await loadLocations(loc.id);
      } catch (e) { toolbarErr(e.message); }
    },
    () => toolbarErr(t('err.geo.fail')),
  );
}

/* ================= Choose a place on the map (everybody) ================= */
let pickMap, pickMarker, pickChoice = null, pickTimer;
function openMapPicker() {
  $('mapModal').hidden = false;
  if (!pickMap) {
    pickMap = L.map('pickMap').setView([38.4, 24.0], 6);
    L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 18, attribution: '© OpenStreetMap' }).addTo(pickMap);
    pickMap.on('click', (e) => choosePoint(e.latlng.lat, e.latlng.lng));
  }
  setTimeout(() => pickMap.invalidateSize(), 50);
}
async function choosePoint(lat, lon, name) {
  lat = +lat.toFixed(4); lon = +(((lon + 540) % 360) - 180).toFixed(4);
  if (pickMarker) pickMarker.setLatLng([lat, lon]); else pickMarker = L.marker([lat, lon]).addTo(pickMap);
  pickChoice = { id: null, name: name || `${lat.toFixed(3)}, ${lon.toFixed(3)}`, lat, lon };
  $('pickGo').disabled = false;
  $('pickInfo').textContent = t('pick.picked', { name: pickChoice.name });
  if (!name) {
    const n = await adhocName(lat, lon);
    if (pickChoice && pickChoice.lat === lat && pickChoice.lon === lon) { pickChoice.name = n; $('pickInfo').textContent = t('pick.picked', { name: n }); }
  }
}
$('pickGo').addEventListener('click', () => { if (pickChoice) { closeModals(); setCurrent(pickChoice, true); } });
$('pickSearch').addEventListener('input', (e) => {
  clearTimeout(pickTimer);
  const q = e.target.value.trim(), box = $('pickResults');
  if (q.length < 2) { box.hidden = true; return; }
  pickTimer = setTimeout(async () => {
    try {
      const res = await api(`api/geocode.php?lang=${LANG}&q=` + encodeURIComponent(q));
      box.innerHTML = res.length ? res.map((r, i) => `<li data-i="${i}">${esc(r.name)}</li>`).join('') : `<li>${t('search.none')}</li>`;
      box._res = res; box.hidden = false;
    } catch (err) { box.hidden = true; }
  }, 350);
});
$('pickResults').addEventListener('click', (e) => {
  const li = e.target.closest('li[data-i]'); if (!li) return;
  const r = $('pickResults')._res[+li.dataset.i];
  $('pickResults').hidden = true; $('pickSearch').value = '';
  choosePoint(r.lat, r.lon, r.name.split(',')[0]); pickMap.setView([r.lat, r.lon], 11);
});

/* ================= Login, users ================= */
const jsonPost = (body) => ({ method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
function updateAuthUI() {
  document.body.classList.toggle('locked', !state.user);
  $('gate').hidden = !!state.user;
  $('userBtn').hidden = !state.user;
  $('userBtn').textContent = state.user ? state.user.name : '';
  $('logoutBtn').hidden = !state.user;
  $('tabUsers').hidden = !state.admin;
  $('tabLog').hidden = !state.admin;
}
function setUser(u) { state.user = u || null; state.admin = !!(u && u.role === 'admin'); updateAuthUI(); }
async function loadAuth() {
  try { setUser((await api('api/auth.php')).user); } catch (e) { setUser(null); }
}
function showGate() {                                   // the session ended (or never existed): back to the login screen
  if (state.user) setUser(null);
  closeModals();
  $('gate').hidden = false;
  $('loginMsg').textContent = ''; $('loginPass').value = '';
  setTimeout(() => $('loginUser').focus(), 30);
}
function closeModals() { document.querySelectorAll('.modal').forEach((m) => { m.hidden = true; }); }
document.querySelectorAll('.modal').forEach((m) => m.addEventListener('mousedown', (e) => { if (e.target === m || e.target.closest('[data-close]')) closeModals(); }));
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeModals(); });
$('loginForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  $('loginSubmit').disabled = true; $('loginMsg').textContent = '';
  try {
    const res = await fetch('api/auth.php', jsonPost({ action: 'login', user: $('loginUser').value, password: $('loginPass').value, remember: $('loginRemember').checked }));
    const j = await res.json().catch(() => ({}));
    if (!res.ok) {
      $('loginMsg').textContent = t({ locked: 'auth.err.locked', not_configured: 'auth.err.notconfigured' }[j.code] || 'auth.err.bad');
      return;
    }
    $('loginPass').value = '';
    setUser(j.user);
    await startApp();
  } catch (err) { $('loginMsg').textContent = t('auth.err.net'); }
  finally { $('loginSubmit').disabled = false; }
});
$('logoutBtn').addEventListener('click', async () => {
  try { await api('api/auth.php', jsonPost({ action: 'logout' })); } catch (e) { /* the session is only a convenience; clear the UI regardless */ }
  closeHistory();
  state.current = null; state.data = null;
  setUser(null); showGate();
});
$('userBtn').addEventListener('click', () => showView('account'));
/* My cars (profile): the Trip tab lists these first */
const accCars = {
  list: [],
  unit: (k) => (k === 'e' ? 'kWh / 100 km' : 'L / 100 km'),
  draw() {
    $('accCars').innerHTML = this.list.length ? this.list.map((c) => `<li data-id="${c.id}"><span>${esc(c.name)} <small>${c.cons} ${this.unit(c.kind)} · ${esc(t('trip.ft.' + c.kind))}</small></span><button type="button" class="cb-x" title="${esc(t('trip.mycar.del'))}">✕</button></li>`).join('') : `<li class="none">${esc(t('trip.mycar.none'))}</li>`;
    $('acCons').placeholder = this.unit($('acKind').value);
  },
  async load() { try { this.list = (await api('api/cars.php')).cars || []; } catch (e) { this.list = []; } this.draw(); },
};
$('acKind').addEventListener('change', () => accCars.draw());
$('acAdd').addEventListener('click', async () => {
  const name = $('acName').value.trim(), cons = parseFloat($('acCons').value);
  $('acMsg').classList.remove('err'); $('acMsg').textContent = '';
  if (!name || !(cons > 0)) { (name ? $('acCons') : $('acName')).focus(); return; }
  try {
    await api('api/cars.php', jsonPost({ name, kind: $('acKind').value, cons }));
    $('acName').value = ''; $('acCons').value = ''; $('acMsg').textContent = t('trip.mycar.saved'); await accCars.load();
  } catch (err) { $('acMsg').textContent = err.message; $('acMsg').classList.add('err'); }
});
$('accCars').addEventListener('click', async (e) => {
  const b = e.target.closest('button'); if (!b) return;
  const li = b.closest('li'), c = accCars.list.find((x) => x.id === +li.dataset.id);
  if (!c || !confirm(t('trip.mycar.del.confirm', { n: c.name }))) return;
  try { await api('api/cars.php?id=' + c.id, { method: 'DELETE' }); await accCars.load(); } catch (err) { $('acMsg').textContent = err.message; $('acMsg').classList.add('err'); }
});
$('accForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  $('accMsg').classList.remove('err');
  try {
    await api('api/auth.php', jsonPost({ action: 'password', old: $('accOld').value, new: $('accNew').value }));
    $('accMsg').textContent = t('acc.done'); $('accOld').value = ''; $('accNew').value = '';
  } catch (err) { $('accMsg').textContent = err.message; $('accMsg').classList.add('err'); }
});
/* My account page: tabs for Locations & Map, Cars, Users (administrator) and Password */
const Account = {
  tab: 'places',
  show(tab) {
    this.tab = tab || this.tab || 'places';
    if ((this.tab === 'users' || this.tab === 'log') && !state.admin) this.tab = 'places';
    $('accName').textContent = state.user.name;
    $('accInfo').textContent = t(state.admin ? 'usr.role.admin' : 'usr.role.user');
    document.querySelectorAll('.acc-tab').forEach((b) => b.classList.toggle('active', b.dataset.tab === this.tab));
    document.querySelectorAll('.acc-pane').forEach((p) => { p.hidden = p.id !== 'pane-' + this.tab; });
    try { history.replaceState(null, '', '#' + this.tab); } catch (e) { /* ignore */ }
    if (this.tab === 'places') { initMap(); setTimeout(() => map.invalidateSize(), 50); drawSavedMarkers(); }
    if (this.tab === 'cars') accCars.load();
    if (this.tab === 'users') Users.show();
    if (this.tab === 'log') Logs.show();
    if (this.tab === 'password') { $('accOld').value = ''; $('accNew').value = ''; $('accMsg').textContent = ''; $('accMsg').classList.remove('err'); }
  },
};
document.querySelectorAll('.acc-tab').forEach((b) => b.addEventListener('click', () => Account.show(b.dataset.tab)));
/* Users page (administrator) */
const Users = (() => {
  async function load() {
    const box = $('usersList');
    let r;
    try { r = await api('api/users.php'); } catch (e) { box.textContent = e.message; return; }
    box.innerHTML = `<table class="users-tbl"><thead><tr><th>${esc(t('auth.user'))}</th><th>${esc(t('usr.role'))}</th><th>${esc(t('usr.locs'))}</th><th>${esc(t('usr.cars'))}</th><th></th></tr></thead><tbody>`
      + r.users.map((u) => `<tr data-id="${u.id}"><td><b>${esc(u.name)}</b>${u.id === r.me ? ` <small>(${esc(t('usr.you'))})</small>` : ''}</td>
        <td><select data-act="role"${u.id === r.me ? ' disabled' : ''}><option value="user"${u.role === 'user' ? ' selected' : ''}>${esc(t('usr.role.user'))}</option><option value="admin"${u.role === 'admin' ? ' selected' : ''}>${esc(t('usr.role.admin'))}</option></select></td>
        <td>${u.locations}</td><td>${u.cars}</td>
        <td class="ut-act"><button class="btn ghost small" data-act="pw" type="button">${esc(t('usr.pw'))}</button>${u.id === r.me ? '' : ` <button class="btn ghost small danger" data-act="del" type="button">${esc(t('usr.del'))}</button>`}</td></tr>`).join('')
      + '</tbody></table>';
  }
  const msg = (m, err) => { $('usersMsg').textContent = m || ''; $('usersMsg').classList.toggle('err', !!err); };
  $('userForm').addEventListener('submit', async (e) => {
    e.preventDefault(); msg('');
    try {
      await api('api/users.php', jsonPost({ action: 'create', name: $('nuName').value, password: $('nuPass').value, role: $('nuRole').value }));
      msg(t('usr.created', { n: $('nuName').value })); $('nuName').value = ''; $('nuPass').value = ''; load();
    } catch (err) { msg(err.message, true); }
  });
  $('usersList').addEventListener('click', async (e) => {
    const b = e.target.closest('button[data-act]'); if (!b) return;
    const id = +b.closest('tr').dataset.id, name = b.closest('tr').querySelector('b').textContent;
    try {
      if (b.dataset.act === 'del') {
        if (!confirm(t('usr.del.confirm', { n: name }))) return;
        await api('api/users.php?id=' + id, { method: 'DELETE' }); msg(t('usr.deleted', { n: name })); load();
      } else if (b.dataset.act === 'pw') {
        const p = prompt(t('usr.pw.ask', { n: name }));
        if (!p) return;
        await api('api/users.php', jsonPost({ action: 'password', id, password: p })); msg(t('usr.pw.done', { n: name }));
      }
    } catch (err) { msg(err.message, true); }
  });
  $('usersList').addEventListener('change', async (e) => {
    const s = e.target.closest('select[data-act="role"]'); if (!s) return;
    try { await api('api/users.php', jsonPost({ action: 'role', id: +s.closest('tr').dataset.id, role: s.value })); msg(t('usr.saved')); }
    catch (err) { msg(err.message, true); }
    load();
  });
  return { show: load };
})();
/* Activity log (administrator): logins, failed logins, errors, background jobs (api/logs.php) */
const Logs = (() => {
  const KIND_CLS = { login: 'ok', logout: '', login_fail: 'warn', error: 'bad', job: '' };
  let oldest = 0;
  async function load(more) {
    const box = $('logList');
    let r;
    try { r = await api('api/logs.php?group=' + encodeURIComponent($('logGroup').value) + (more && oldest ? '&before=' + oldest : '')); }
    catch (e) { box.textContent = e.message; return; }
    const fmt = (s) => new Date(s * 1000).toLocaleString(dateLocale(), { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' });
    const rows = r.rows.map((x) => `<tr class="lg-${KIND_CLS[x.kind] || ''}"><td class="lg-t">${esc(fmt(x.ts))}</td><td><span class="lg-k">${esc(t('log.k.' + x.kind))}</span></td><td>${esc(x.user || '')}</td><td class="lg-ip">${esc(x.ip || '')}</td><td class="lg-m">${esc(x.message)}</td></tr>`).join('');
    if (more) box.querySelector('tbody').insertAdjacentHTML('beforeend', rows);
    else box.innerHTML = r.rows.length
      ? `<div class="log-wrap"><table class="users-tbl log-tbl"><thead><tr><th>${esc(t('log.time'))}</th><th>${esc(t('log.kind'))}</th><th>${esc(t('auth.user'))}</th><th>IP</th><th>${esc(t('log.msg'))}</th></tr></thead><tbody>${rows}</tbody></table></div>`
      : `<p class="hint">${esc(t('log.empty'))}</p>`;
    if (r.rows.length) oldest = r.rows[r.rows.length - 1].id;
    $('logMore').hidden = !r.more;
    const c = r.counts || {};
    $('logCounts').textContent = t('log.counts', { l: c.login || 0, f: c.login_fail || 0, e: c.error || 0 });
  }
  $('logGroup').addEventListener('change', () => load(false));
  $('logRefresh').addEventListener('click', () => load(false));
  $('logMore').addEventListener('click', () => load(true));
  return { show: () => load(false) };
})();
const haversineKm = (la1, lo1, la2, lo2) => {
  const r = 6371, dLa = (la2 - la1) * Math.PI / 180, dLo = (lo2 - lo1) * Math.PI / 180;
  const a = Math.sin(dLa / 2) ** 2 + Math.cos(la1 * Math.PI / 180) * Math.cos(la2 * Math.PI / 180) * Math.sin(dLo / 2) ** 2;
  return r * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
};

/* ================= Τοποθεσίες ================= */
async function loadLocations(selectId) {
  const r = await api('api/locations.php');
  state.locations = r.saved || [];   // your own saved locations
  state.cities = r.cities || [];
  renderSaved();
  let saved = null;
  try { saved = localStorage.getItem('wefo.loc'); } catch (e) { /* ignore */ }
  let pick = allLocations().find((l) => l.id == (selectId ?? saved)) || null;
  if (!pick && saved === ADHOC) {
    try { const a = JSON.parse(localStorage.getItem('wefo.adhoc')); if (a && Number.isFinite(a.lat) && Number.isFinite(a.lon)) pick = { id: null, name: String(a.name || ''), lat: a.lat, lon: a.lon }; } catch (e) { /* ignore */ }
  }
  setCurrent(pick || state.cities.find((c) => c.name === 'Athens') || state.cities[0] || state.locations[0] || null);
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
  fillElevation(lat, lon);
  if (marker) marker.setLatLng([lat, lon]); else marker = L.marker([lat, lon]).addTo(map);
  if (name) { $('nameInput').value = name; nameAuto = false; }
  else if (reverse && nameAuto) {
    $('nameInput').value = '';
    try { const r = await api(`api/geocode.php?lat=${lat}&lon=${lon}&lang=${LANG}`); if (r.name && nameAuto) $('nameInput').value = r.name; } catch (e) { /* ignore */ }
  }
}
// Elevation field: shows the terrain height of the picked point (Open-Meteo DEM) as the default; saving it unchanged stores nothing
let elevTimer;
function fillElevation(lat, lon) {
  clearTimeout(elevTimer);
  elevTimer = setTimeout(async () => {
    const el = $('elevInput');
    try {
      const r = await api(`api/elevation.php?lat=${lat}&lon=${lon}`);
      if (r.elevation == null) return;
      el.value = r.elevation; el.dataset.dem = r.elevation;
    } catch (e) { /* the field simply stays as it is */ }
  }, 400);
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
  const e = parseFloat($('elevInput').value), elevation = Number.isFinite(e) && e !== Number($('elevInput').dataset.dem) ? e : null;   // the DEM default is not stored: only a height the user typed
  try {
    const loc = await api('api/locations.php', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name, lat, lon, elevation }) });
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
  if (!state.user) return;   // the login screen covers everything until you are in
  let tab = null;
  if (['places', 'cars', 'users', 'password'].includes(name)) { tab = name; name = 'account'; }          // old links: the account page, on that tab
  if (tab === 'users' && !state.admin) tab = 'places';
  state.view = name;
  try { history.replaceState(null, '', name === 'forecast' ? location.pathname + location.search : '#' + name); } catch (e) { /* ignore */ }   // a refresh stays on this tab
  document.querySelectorAll('.view').forEach((v) => v.classList.toggle('active', v.id === 'view-' + name));
  document.querySelectorAll('.nav-btn').forEach((b) => b.classList.toggle('active', b.dataset.view === name));
  $('userBtn').classList.toggle('active', name === 'account');
  if (name === 'astro') Astro.load();
  if (name === 'dso') Dso.show();
  if (name === 'history') showHistoryView();
  else if (histFromView) { closeHistory(); histFromView = false; }   // the climate history opened by the History tab goes away with it
  if (name === 'trip') Trip.show();
  if (name === 'account') Account.show(tab);
}
document.querySelectorAll('.nav-btn').forEach((b) => b.addEventListener('click', () => showView(b.dataset.view)));
document.addEventListener('click', (e) => { const a = e.target.closest('[data-goto]'); if (a) { e.preventDefault(); showView(a.dataset.goto); } });

/* ================= History dialog ================= */
const histSec = $('histSec');
let histState = null;   // { loc, data }

function niceNum(v, d = 1) { return v == null ? '–' : Number(v).toLocaleString(dateLocale(), { minimumFractionDigits: d, maximumFractionDigits: d }); }

/* Simple SVG chart: kind = 'line' | 'bar', points = [{x: year, v: value}] */
function histChart(points, { kind, color, unit, d = 1, trend = false, w = 1200, h = 270 }) {
  if (points.length < 2) return '';
  const W = w, H = h, pl = 46, pr = 12, pt = 14, pb = 26;
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

/* Heatmap: one cell per month of every year. mode 'anom' = difference from that month's long-term average, 'abs' = mean temperature */
function heatColor(v, lo, mid, hi, cols) {
  const [c0, c1, c2] = cols;
  const mix = (a, b, f) => a.map((x, i) => Math.round(x + (b[i] - x) * f));
  const rgb = v <= mid ? mix(c0, c1, clamp((v - lo) / (mid - lo || 1))) : mix(c1, c2, clamp((v - mid) / (hi - mid || 1)));
  return `rgb(${rgb.join(',')})`;
}
function heatmap(series, mode) {
  const rows = series.filter((r) => r[4] >= 25 && r[2] != null);
  if (rows.length < 24) return '';
  const years = rows.map((r) => r[0]), y0 = Math.min(...years), y1 = Math.max(...years), ny = y1 - y0 + 1;
  const sums = Array(13).fill(0), cnts = Array(13).fill(0);
  rows.forEach((r) => { sums[r[1]] += r[2]; cnts[r[1]]++; });
  const avg = sums.map((s, m) => (cnts[m] ? s / cnts[m] : 0));
  const val = (r) => (mode === 'anom' ? r[2] - avg[r[1]] : r[2]);
  const vals = rows.map(val);
  let lo, mid, hi, cols;
  if (mode === 'anom') {
    const abs = vals.map(Math.abs).sort((x, y) => x - y);
    const lim = Math.max(1.5, Math.ceil(abs[Math.floor(abs.length * 0.92)] * 2) / 2);   // saturate at the 92nd percentile so the colours stay readable
    lo = -lim; mid = 0; hi = lim; cols = [[37, 99, 235], [243, 244, 246], [220, 38, 38]];
  } else {
    lo = Math.min(...vals); hi = Math.max(...vals); mid = (lo + hi) / 2; cols = [[37, 99, 235], [250, 204, 21], [220, 38, 38]];
  }
  const W = 900, pl = 42, pr = 10, pt = 8, ch = 22, pb = 22, H = pt + 12 * ch + pb;
  const cw = (W - pl - pr) / ny;
  let cells = '';
  rows.forEach((r) => {
    const v = val(r);
    cells += `<rect x="${(pl + (r[0] - y0) * cw).toFixed(2)}" y="${pt + (r[1] - 1) * ch}" width="${(cw + 0.4).toFixed(2)}" height="${ch - 1}" fill="${heatColor(v, lo, mid, hi, cols)}"><title>${monthName(r[1])} ${r[0]}: ${niceNum(r[2])} °C${mode === 'anom' ? ` (${v >= 0 ? '+' : ''}${niceNum(v)})` : ''}</title></rect>`;
  });
  let axes = '';
  for (let m = 1; m <= 12; m++) axes += `<text x="${pl - 6}" y="${pt + (m - 1) * ch + ch / 2 + 3}" text-anchor="end" class="tx">${monthName(m, true)}</text>`;
  for (let y = Math.ceil(y0 / 10) * 10; y <= y1; y += 10) axes += `<text x="${pl + (y - y0 + 0.5) * cw}" y="${H - 6}" text-anchor="middle" class="tx">${y}</text>`;
  const stops = Array.from({ length: 11 }, (_, i) => `<stop offset="${i * 10}%" stop-color="${heatColor(lo + ((hi - lo) * i) / 10, lo, mid, hi, cols)}"/>`).join('');
  const fmtL = (v) => (mode === 'anom' ? `${v > 0 ? '+' : ''}${niceNum(v, 1)}°` : `${niceNum(v, 0)}°`);
  const legend = `<div class="hlegend"><span>${fmtL(lo)}</span><svg viewBox="0 0 200 10" preserveAspectRatio="none"><defs><linearGradient id="hg">${stops}</linearGradient></defs><rect width="200" height="10" rx="5" fill="url(#hg)"/></svg><span>${fmtL(hi)}</span></div>`;
  return `<svg class="hchart heat" viewBox="0 0 ${W} ${H}" role="img">${cells}${axes}</svg>${legend}`;
}

function renderHistory() {
  if (!histState) return;
  const { loc, data: h, fresh, added } = histState;
  if (!h) { return; }
  const m = h.meta;
  const heatMode = histState.heat || 'anom';
  const complete = h.annual.filter((a) => a.n >= 350);
  // Each chart has its own period selector: whole year (annual values) or a single calendar month of every year
  const pT = histState.periodT || 'all', pP = histState.periodP || 'all';
  const seriesT = pT === 'all' ? complete.filter((a) => a.tmean != null).map((a) => ({ x: a.y, v: a.tmean }))
    : h.series.filter((r) => r[1] === +pT && r[4] >= 25 && r[2] != null).map((r) => ({ x: r[0], v: r[2] }));
  const seriesP = pP === 'all' ? complete.filter((a) => a.prcp != null).map((a) => ({ x: a.y, v: a.prcp }))
    : h.series.filter((r) => r[1] === +pP && r[4] >= 25 && r[3] != null).map((r) => ({ x: r[0], v: r[3] }));
  const periodSel = (id, cur) => `<label class="hperiod">${t('h.periodsel')} <select id="${id}"><option value="all">${t('h.period.all')}</option>${Array.from({ length: 12 }, (_, i) => `<option value="${i + 1}" ${+cur === i + 1 ? 'selected' : ''}>${monthName(i + 1)}</option>`).join('')}</select></label>`;
  const fmtDate = (d) => new Date(d + 'T12:00:00').toLocaleDateString(dateLocale(), { day: 'numeric', month: 'short', year: 'numeric' });
  const rec = (k, unit, d = 1) => (h.records[k] ? `<div class="rcard"><span>${t('h.rec.' + k)}</span><b>${niceNum(h.records[k].v, d)} ${unit}</b><small>${fmtDate(h.records[k].d)}</small></div>` : '');
  const months = h.monthly.map((r) => `<tr><th>${monthName(r.m)}</th><td>${niceNum(r.tmean)}</td><td>${niceNum(r.tmax)}</td><td>${niceNum(r.tmin)}</td><td>${niceNum(r.prcp, 0)}</td><td>${niceNum(r.rainy, 1)}</td></tr>`).join('');
  const maxP = Math.max(...h.annual.map((a) => a.prcp || 0), 1);
  const years = h.annual.slice().reverse().map((a) => `<tr><th>${a.y}${a.n < 350 ? '*' : ''}</th><td>${niceNum(a.tmean)}</td><td>${niceNum(a.tmax)}</td><td>${niceNum(a.tmin)}</td>
      <td><div class="pbar"><i style="width:${Math.round(((a.prcp || 0) / maxP) * 100)}%"></i><span>${niceNum(a.prcp, 0)}</span></div></td><td>${a.rainy}</td><td>${niceNum(a.gust, 0)}</td><td>${niceNum(a.snow)}</td></tr>`).join('');
  $('histBody').innerHTML = `
    <h2>${t('h.title')} – ${esc(locName(loc))}</h2>
    <div class="h-info">
      <div>📍 ${t('h.grid', { lat: m.grid_lat.toFixed(4), lon: m.grid_lon.toFixed(4), km: m.distance_km, el: Math.round(m.elevation ?? 0) })}</div>
      <div>📅 ${t('h.period', { first: m.first, last: m.last, days: m.days.toLocaleString(dateLocale()) })}</div>
      <div class="muted">${t('h.source', { date: new Date(m.fetched_at * 1000).toLocaleDateString(dateLocale()) })}</div>
      <div class="h-status">${fresh ? t('h.status.new') : added > 0 ? t('h.status.added', { n: added }) : t('h.status.cached')}${state.admin ? ` <button type="button" class="btn ghost small" id="histUpdate">${t('h.update')}</button>` : ''}</div>
    </div>
    <h3>${t('h.rec.title')}</h3>
    <div class="rcards">${rec('hottest', '°C')}${rec('coldest', '°C')}${rec('wettest', 'mm')}${rec('windiest', 'km/h', 0)}${(h.records.snowiest && h.records.snowiest.v > 0) ? rec('snowiest', 'cm') : ''}</div>
    <div class="h-chartbox">
      <div class="h-charthead"><h3>${pT === 'all' ? t('h.chart.temp') : t('h.chart.temp.m', { m: monthName(+pT) })}</h3>${periodSel('histPeriodT', pT)}</div>
      ${histChart(seriesT, { kind: 'line', color: 'var(--accent)', unit: '°C', trend: true })}
    </div>
    <div class="h-chartbox">
      <div class="h-charthead"><h3>${pP === 'all' ? t('h.chart.prcp') : t('h.chart.prcp.m', { m: monthName(+pP) })}</h3>${periodSel('histPeriodP', pP)}</div>
      ${histChart(seriesP, { kind: 'bar', color: 'var(--rain)', unit: 'mm', d: 0 })}
    </div>
    <div class="h-heathead"><h3>${t('h.heat')}</h3>
      <div class="seg" role="group"><button type="button" data-heat="anom" class="${heatMode === 'anom' ? 'active' : ''}">${t('h.heat.anom')}</button><button type="button" data-heat="abs" class="${heatMode === 'abs' ? 'active' : ''}">${t('h.heat.abs')}</button></div></div>
    <div class="h-climate">${heatmap(h.series, heatMode)}<p class="hint">${t('h.heat.hint.' + heatMode)}</p></div>
    <h3>${t('h.monthly')}</h3>
    <div class="h-tablewrap"><table class="htable"><thead><tr><th>${t('h.col.month')}</th><th>${t('h.col.mean')}</th><th>${t('h.col.max')}</th><th>${t('h.col.min')}</th><th>${t('h.col.prcp')}</th><th>${t('h.col.rainy')}</th></tr></thead><tbody>${months}</tbody></table></div>
    <h3>${t('h.annual')}</h3>
    <div class="h-tablewrap tall"><table class="htable"><thead><tr><th>${t('h.col.year')}</th><th>${t('h.col.mean')}</th><th>${t('h.col.max')}</th><th>${t('h.col.min')}</th><th>${t('h.col.prcp')}</th><th>${t('h.col.rainy')}</th><th>${t('h.col.gust')}</th><th>${t('h.col.snow')}</th></tr></thead><tbody>${years}</tbody></table></div>
    <p class="hint">${t('h.partial')}</p>`;
  const upd = $('histUpdate'); if (upd) upd.addEventListener('click', () => openHistory(loc, true));
  document.querySelectorAll('[data-heat]').forEach((b) => b.addEventListener('click', () => { histState.heat = b.dataset.heat; renderHistory(); }));
  $('histPeriodT').addEventListener('change', (e) => { histState.periodT = e.target.value; renderHistory(); });
  $('histPeriodP').addEventListener('change', (e) => { histState.periodP = e.target.value; renderHistory(); });
}

async function openHistory(loc, refresh = false) {
  histState = { loc, data: null, fresh: false, added: 0, periodT: (histState && histState.loc.id === loc.id && histState.periodT) || 'all', periodP: (histState && histState.loc.id === loc.id && histState.periodP) || 'all', heat: (histState && histState.heat) || 'anom' };
  const wasHidden = histSec.hidden;
  histSec.hidden = false;
  if (wasHidden || !refresh) histSec.scrollIntoView({ behavior: 'smooth', block: 'start' });
  $('histBody').innerHTML = `<h2>${t('h.title')} – ${esc(locName(loc))}</h2><div class="loading"><div class="spinner"></div> <span>${t('h.loading.first')}</span></div>`;
  try {
    const h = await api(`api/history.php?id=${loc.id}${refresh ? '&refresh=1' : ''}`);
    if (!histState || histState.loc.id !== loc.id) return;
    histState.data = h; histState.fresh = h.downloaded; histState.added = h.added || 0;
    renderHistory();
  } catch (err) {
    $('histBody').innerHTML = `<h2>${t('h.title')} – ${esc(locName(loc))}</h2><div class="notice error">${esc(err.message)}</div>`;
  }
}
function closeHistory() { histSec.hidden = true; histState = null; $('histBody').innerHTML = ''; }
$('histClose').addEventListener('click', () => { closeHistory(); if (state.view === 'history') $('histNote').hidden = false; });
/* The History tab: the climate history of the chosen location (it needs a stored one: a saved place or a Greek city) */
let histFromView = false;
function showHistoryView() {
  const loc = state.current;
  if (!loc || loc.id == null) { closeHistory(); $('histNote').hidden = false; return; }
  $('histNote').hidden = true;
  histFromView = true;
  openHistory(loc);
}
$('histLoc').addEventListener('change', () => { $('locSelect').value = $('histLoc').value; $('locSelect').dispatchEvent(new Event('change')); $('histLoc').value = $('locSelect').value; });

/* ================= Language ================= */
function onLangChange() {
  renderSaved();
  renderLocSelect();
  if (!histSec.hidden && histState && histState.data) renderHistory();
  if (state.data) renderAll();
  Astro.render();
  Dso.render();
  WxModels.render();
  if (LpMap.isOpen) LpMap.sync();
  Trip.render();
  Trip.renderModels();
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
  if (state.view === 'dso') Dso.render();   // the DSO hour boxes colour cloud differently in the two themes
});
if (sysDark && sysDark.addEventListener) sysDark.addEventListener('change', () => { syncThemeBtn(); if (state.view === 'dso') Dso.render(); });
syncThemeBtn();

$('brandIcon').innerHTML = WI.svg(2, false);
/* Per-user settings on the server (api/prefs.php). localStorage stays the working copy; at login the server's values win, and anything
   this browser has that the server does not know yet is uploaded once. A failing server just leaves localStorage in charge. */
const PREF_KEYS = ['wefo.disabled', 'wefo.weighted', 'wefo.bias', 'wefo.oneVote'];
const Prefs = {
  save(k, v) {
    if (!state.user) return;
    api('api/prefs.php', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ prefs: { [k]: v } }) }).catch(() => { /* kept locally */ });
  },
  async sync() {
    try {
      const srv = (await api('api/prefs.php')).prefs || {};
      const up = {};
      PREF_KEYS.forEach((k) => {
        if (srv[k] != null) { try { localStorage.setItem(k, srv[k]); } catch (e) { /* ignore */ } }
        else { let v = null; try { v = localStorage.getItem(k); } catch (e) { /* ignore */ } if (v != null) up[k] = v; }
      });
      if (Object.keys(up).length) await api('api/prefs.php', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ prefs: up }) });
    } catch (e) { /* offline or old server: localStorage only */ }
    try {
      state.disabled = new Set(JSON.parse(localStorage.getItem('wefo.disabled') || '[]'));
      state.weighted = localStorage.getItem('wefo.weighted') !== '0';
      state.bias = localStorage.getItem('wefo.bias') !== '0';
      state.oneVote = localStorage.getItem('wefo.oneVote') === '1';
    } catch (e) { /* ignore */ }
    $('weightChk').checked = state.weighted; $('biasChk').checked = state.bias; $('oneVoteChk').checked = state.oneVote;
  },
};
async function startApp() {
  await Prefs.sync();
  await loadLocations();
  const v = location.hash.slice(1);
  if (v === 'astro' || v === 'dso' || v === 'history' || v === 'trip' || v === 'account' || v === 'places' || v === 'cars' || v === 'password' || (v === 'users' && state.admin)) showView(v); else showView('forecast');
}
$('gateIcon').innerHTML = WI.svg(2, false);
loadAuth().then(() => { if (state.user) return startApp(); showGate(); }).catch((err) => { $('error').textContent = err.message; $('error').hidden = false; });

if (document.fonts && document.fonts.ready) document.fonts.ready.then(() => setTimeout(centerNow, 50));
window.addEventListener('load', () => setTimeout(centerNow, 100));

/* Offline: sw.js keeps the DSO catalogue files and every photo you have opened */
if ('serviceWorker' in navigator) window.addEventListener('load', () => navigator.serviceWorker.register('sw.js').catch(() => { /* no service worker: everything still works online */ }));
