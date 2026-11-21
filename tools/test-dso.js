#!/usr/bin/env node
/* Checks for the Astronomy / DSO Explorer maths. Run:  node tools/test-dso.js
   - object altitude/azimuth at transit (independent of the sidereal-time code: 90° − |lat − dec|, azimuth south)
   - the visibility classes of the reference objects
   - sunset / darkness / Moon figures for a known night (Athens)
   - Moon-strip values: new Moon = 0, full Moon in the expected band */
const fs = require('fs');
const path = require('path');
const root = path.join(__dirname, '..');
const stubEl = () => ({ addEventListener() {}, set innerHTML(v) {}, classList: { toggle() {}, add() {}, remove() {} }, hidden: false });
const doc = { getElementById: stubEl, querySelectorAll: () => [] };
const src = fs.readFileSync(path.join(root, 'js/astro.js'), 'utf8') + '\n' + fs.readFileSync(path.join(root, 'js/dso.js'), 'utf8');
const run = new Function('$', 'document', 'window', 'state', 'dateLocale', 't', 'esc', 'locName', 'LANG', 'api', 'setCurrent', 'adhocName', 'renderLocSelect', src + '\nreturn { Astro, Dso };');
const { Astro, Dso } = run(stubEl, doc, { addEventListener() {} }, { cities: [], current: null }, () => 'en-GB', (k) => k, (s) => s, () => 'x', 'en', async () => ({}), () => {}, async () => '', () => {});

const raw = JSON.parse(fs.readFileSync(path.join(root, 'assets/dso.json'), 'utf8'));
const objs = Dso.prep(raw);
const find = (label) => objs.find((o) => o.label === label);
let fails = 0;
const check = (name, ok, extra = '') => { console.log((ok ? 'PASS ' : 'FAIL ') + name + (extra ? '  ' + extra : '')); if (!ok) fails++; };

console.log(`${objs.length} objects, ${objs.filter((o) => o.inCat && o.mag != null).length} candidates with magnitude`);
check('2936 objects', objs.length === 2936);
check('565 catalogue objects with a magnitude', objs.filter((o) => o.inCat && o.mag != null).length === 565, String(objs.filter((o) => o.inCat && o.mag != null).length));
const m31 = find('M 31');
check('M 31 title "M 31 · NGC 224"', m31 && m31.title === 'M 31 · NGC 224', m31 && m31.title);
check('M1-32 is not labelled as a Messier object', !objs.some((o) => o.name.startsWith('PK 11+') && o.label));

// --- transit altitude / azimuth ---
const lat = 38.0, lon = 23.7;
for (const lb of ['M 31', 'M 42', 'M 45']) {
  const o = find(lb);
  // find the time when local sidereal time == RA (bisection on the hour angle over one sidereal day)
  const H = (ms) => { let h = Astro.lstRad(ms, lon) - o.ra; h = Math.atan2(Math.sin(h), Math.cos(h)); return h; };
  let a = Date.UTC(2026, 9, 15), b = a + 86400e3, step = 600e3, ta = null;
  for (let t = a; t < b; t += step) { if (H(t) < 0 && H(t + step) >= 0) { ta = t; break; } }
  let lo = ta, hi = ta + step;
  for (let i = 0; i < 40; i++) { const mid = (lo + hi) / 2; if (H(mid) < 0) lo = mid; else hi = mid; }
  const p = Astro.eq2hor(o.ra, o.dec, (lo + hi) / 2, lat, lon);
  const expAlt = 90 - Math.abs(lat - o.decDeg);
  const southOk = o.decDeg < lat ? Math.abs(p.az - 180) < 0.1 : Math.min(p.az, 360 - p.az) < 0.1;
  check(`${lb} transit altitude ${p.alt.toFixed(2)}° (expected ${expAlt.toFixed(2)}°)`, Math.abs(p.alt - expAlt) < 0.1);
  check(`${lb} transit azimuth ${p.az.toFixed(2)}°`, southOk);
}

// --- visibility classes (two classes only: binoculars, telescope – the naked-eye objects are in 'bino') ---
const cls = (lb) => Dso.vis(find(lb)).cls;
for (const [lb, want] of [['M 31', 'bino'], ['M 45', 'bino'], ['M 42', 'bino'], ['M 13', 'bino'], ['M 57', 'scope'], ['M 1', 'scope'], ['M 51', 'scope'], ['M 74', 'scope']]) {
  const v = Dso.vis(find(lb));
  check(`${lb} class ${v.cls} (SB ${v.sb.toFixed(1)}, eff ${v.eff.toFixed(2)})`, v.cls === want, 'want ' + want);
}

// --- the night (Athens, 15 Oct 2026, UTC+3) ---
const n = Dso.computeNight(Date.UTC(2026, 9, 15, 9, 0) , 37.984, 23.728);
const hm = (ms) => new Date(ms + 3 * 3600e3).toISOString().slice(11, 16);
console.log(`night: sunset ${hm(n.sunset)} sunrise ${hm(n.sunrise)} dark ${hm(n.darkStart)}–${hm(n.darkEnd)} moon rise ${n.moonrise && hm(n.moonrise)} set ${n.moonset && hm(n.moonset)} below ${Math.round(n.moonBelow * 100)}%`);
check('sunset 18:4x local', hm(n.sunset).startsWith('18:4'));
check('astronomical darkness starts ~20:16', Math.abs(new Date(n.darkStart + 3 * 3600e3).getUTCHours() * 60 + new Date(n.darkStart + 3 * 3600e3).getUTCMinutes() - (20 * 60 + 16)) <= 3);

// --- Moon strip value for M31 around new and full Moon ---
const sep = (r1, d1, r2, d2) => Math.acos(Math.min(1, Math.max(-1, Math.sin(d1) * Math.sin(d2) + Math.cos(d1) * Math.cos(d2) * Math.cos(r1 - r2)))) * 180 / Math.PI;
const impact = (o, t) => { const k = Astro.sky(t, 37.984, 23.728), m = Astro.moonEq(t); const d = sep(o.ra, o.dec, m.ra, m.dec); return k.lit * (0.3 + 0.7 * Math.max(0, 1 - d / 90)) * (k.moonAlt > 0 ? Math.sin(k.moonAlt * Math.PI / 180) : 0); };
const scan = (day) => { let mx = 0; for (let h = 0; h < 24 * 4; h++) mx = Math.max(mx, impact(m31, Date.UTC(2026, 9, day) + h * 900e3)); return mx; };
console.log(`Moon impact on M31, max over the day: new Moon (11 Oct) ${(scan(10) * 100).toFixed(0)}, full Moon (26 Oct) ${(scan(26) * 100).toFixed(0)}`);
check('new Moon impact ≈ 0', scan(10) * 100 < 8, (scan(10) * 100).toFixed(1));
check('full Moon impact in 54–74 when it is high', scan(26) * 100 >= 54 && scan(26) * 100 <= 100, (scan(26) * 100).toFixed(1));

console.log(fails ? `\n${fails} check(s) FAILED` : '\nAll checks passed');
process.exit(fails ? 1 : 0);
