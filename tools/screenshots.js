#!/usr/bin/env node
/* Takes the README screenshots with a headless Edge/Chrome driven over the DevTools protocol.
     node tools/screenshots.js [base-url] [admin-user] [admin-password]
   Needs a running copy of the app (default http://127.0.0.1:8901/) and, for the Locations / History shots, an admin login.
   Output: docs/screenshots/*.png */
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const BASE = (process.argv[2] || 'http://127.0.0.1:8901/').replace(/\/?$/, '/');
const USER = process.argv[3] || '', PASS = process.argv[4] || '';
const OUT = path.join(__dirname, '..', 'docs', 'screenshots');
const BROWSER = ['C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', 'C:/Program Files/Microsoft/Edge/Application/msedge.exe', 'C:/Program Files/Google/Chrome/Application/chrome.exe'].find((p) => fs.existsSync(p));
if (!BROWSER) { console.error('No Edge/Chrome found'); process.exit(1); }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const only = process.env.ONLY ? process.env.ONLY.split(',') : null;      // e.g. ONLY=dso,astronomy re-takes just those groups
const want = (n) => !only || only.includes(n);

(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wefo-shots-'));
  const proc = spawn(BROWSER, ['--headless=new', '--disable-gpu', '--hide-scrollbars', '--remote-debugging-port=9333', '--user-data-dir=' + dir, '--no-first-run', 'about:blank'], { stdio: 'ignore' });
  let info = null;
  for (let i = 0; i < 60 && !info; i++) { try { info = await (await fetch('http://127.0.0.1:9333/json/list')).json(); } catch (e) { await sleep(500); } }
  const page = info.find((p) => p.type === 'page');
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((r) => { ws.onopen = r; });
  let id = 0; const pend = new Map();
  ws.onmessage = (m) => { const d = JSON.parse(m.data); if (d.id && pend.has(d.id)) { const { res, rej } = pend.get(d.id); pend.delete(d.id); d.error ? rej(new Error(d.error.message)) : res(d.result); } };
  const send = (method, params = {}) => new Promise((res, rej) => { const i = ++id; pend.set(i, { res, rej }); ws.send(JSON.stringify({ id: i, method, params })); });
  const js = async (expr) => { const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true }); if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text); return r.result.value; };
  const waitFor = async (expr, ms = 90000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { try { if (await js(expr)) return true; } catch (e) { /* page still loading */ } await sleep(500); } throw new Error('timeout: ' + expr); };
  const viewport = (w, h, mobile = false) => send('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: mobile ? 2 : 1, mobile });
  const go = async (query = '') => { await send('Page.navigate', { url: BASE + query }); await sleep(800); await waitFor("document.readyState === 'complete'"); };
  const loaded = () => waitFor("typeof state !== 'undefined' && state.data && !document.getElementById('forecastBody').hidden && !document.getElementById('loading').offsetParent");
  /* screenshot of the box spanning from the top of element `a` to the bottom of element `b` (full width of the page) */
  const shot = async (name, { from, to, top, maxH = 3000, width = 1400, pad = 12, scale = 1 }) => {
    const r = await js(`(() => { const a = ${from ? `document.querySelector(${JSON.stringify(from)})` : 'null'}, b = document.querySelector(${JSON.stringify(to)}); if (!b) return null;
      const ra = a ? a.getBoundingClientRect() : { top: ${top ?? 0} }, rb = b.getBoundingClientRect(); return { y: Math.max(0, ra.top + scrollY - ${pad}), y2: rb.bottom + scrollY + ${pad} }; })()`);
    if (!r) throw new Error('no element ' + to);
    const h = Math.min(maxH, Math.round(r.y2 - r.y));
    const out = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true, clip: { x: 0, y: r.y, width, height: h, scale } });
    fs.writeFileSync(path.join(OUT, name + '.png'), Buffer.from(out.data, 'base64'));
    console.log('  ' + name + '.png  ' + width + 'x' + h);
  };
  const click = (sel) => js(`document.querySelector(${JSON.stringify(sel)}).click()`);
  const prefs = (o) => js(`Object.entries(${JSON.stringify(o)}).forEach(([k, v]) => v == null ? localStorage.removeItem(k) : localStorage.setItem(k, v))`);

  fs.mkdirSync(OUT, { recursive: true });
  await send('Page.enable');
  await viewport(1400, 1000);
  await go();
  // a clean state: light theme, English, Athens, time across, models hidden
  await prefs({ 'wefo.theme': 'light', 'wefo.lang': 'en', 'wefo.orient': 'h', 'wefo.modelsOpen': '0', 'wefo.weighted': '1', 'wefo.disabled': null, 'wefo.loc': null, 'wefo.adhoc': null });
  if (USER) { await js(`fetch('api/auth.php', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'login', user: ${JSON.stringify(USER)}, password: ${JSON.stringify(PASS)} }) }).then((r) => r.json())`); }
  await go('?shots=1');
  await loaded();
  await js(`(() => { const c = state.cities.find((x) => x.name === 'Athens'); if (c) setCurrent(c); })()`);
  await sleep(2500); await loaded();
  await waitFor("!!state.verify || state.verifyErr || true"); await sleep(6000);        // let reliability / observation finish

  if (want('forecast')) {
  console.log('forecast');
  await shot('forecast-weather', { from: '.toolbar', to: '#forecastBody .hours' });
  await js("document.getElementById('expert').open = true"); await sleep(600);
  await shot('forecast-expert', { from: '#legend', to: '#expert', pad: 30 });
  await js("document.getElementById('expert').open = false");
  // the reliability weighting + models drop-down
  await js("document.getElementById('models').open = true"); await sleep(500);
  await shot('models-dropdown', { top: 0, to: '#models .mdl-panel', pad: 40 });
  await js("document.getElementById('models').open = false");
  await click('#orientSeg [data-orient=v]'); await sleep(1200);
  await shot('forecast-timedown', { from: '#view-forecast .hours', to: '#view-forecast .hours', maxH: 1000 });
  await click('#orientSeg [data-orient=m]'); await sleep(1500);
  await shot('forecast-meteogram', { from: '#view-forecast .hours', to: '#view-forecast .hours', maxH: 1100 });
  await click('#orientSeg [data-orient=s]');
  await waitFor("document.querySelector('.ss-card') || document.querySelector('#sunsetBox .notice')", 60000); await sleep(800);
  await shot('forecast-sunset', { from: '#view-forecast .hours', to: '#view-forecast .hours', maxH: 1500 });
  await click('#orientSeg [data-orient=h]'); await sleep(800);
  await click('#modelsToggle'); await sleep(800);                                      // rain / wind / reliability show the individual models
  await click('.tab[data-param=precip]'); await sleep(1000);
  await shot('forecast-rain', { from: '#view-forecast .hours', to: '#view-forecast .hours', maxH: 1100 });
  await click('.tab[data-param=wind]'); await sleep(1000);
  await shot('forecast-wind', { from: '#view-forecast .hours', to: '#view-forecast .hours', maxH: 1200 });
  await click('#modelsToggle'); await sleep(600);
  await click('.tab[data-param=reliability]'); await sleep(1500);
  await shot('reliability', { from: '#view-forecast .hours', to: '#view-forecast .hours', maxH: 1300 });
  await click('.tab[data-param=weather]'); await sleep(600);

  }
  if (want('astronomy')) {
  console.log('astronomy');
  await click('[data-view=astro]');
  await waitFor("!document.getElementById('astroBody').hidden", 90000); await sleep(4000);
  await shot('astronomy', { from: '#view-astro .toolbar', to: '#view-astro .astro-tab', maxH: 2600 });
  await shot('astronomy-lightpollution', { from: '#view-astro .lpcard', to: '#view-astro .lpcard', maxH: 800 });

  }
  if (want('dso')) {
  console.log('dso');
  await click('[data-view=dso]');
  await waitFor("document.querySelector('.dso-line')", 120000);
    await waitFor("(() => { const i = document.querySelector('#dsoNight .ln-photo img'); return i && i.complete && i.naturalWidth > 0; })()", 90000); await sleep(1500);
  await shot('dso-tonight', { from: '#view-dso .toolbar', to: '#dsoNight .dso-line', maxH: 1700 });

  }
  if (USER && want('admin')) {
    console.log('admin');
    await click('[data-view=places]'); await sleep(2500);
    await shot('locations-map', { from: '.places-layout', to: '.places-layout', maxH: 800 });
    await js(`(() => { const l = state.locations[0] || state.cities.find((c) => c.name === 'Athens'); openHistory(l); })()`);
    await waitFor("document.querySelector('#histBody .h-chart, #histBody svg, #histBody table')", 120000); await sleep(3000);
    await shot('history', { from: '#histSec', to: '#histSec', maxH: 1600 });
  }

  if (want('theme')) {
  console.log('theme / language / phone');
  await click('[data-view=forecast]'); await sleep(800);
  await prefs({ 'wefo.theme': 'dark' }); await js("document.documentElement.setAttribute('data-theme', 'dark')"); await sleep(800);
  await shot('forecast-dark', { from: '.toolbar', to: '#forecastBody .hours' });
  await prefs({ 'wefo.theme': 'light' }); await js("document.documentElement.setAttribute('data-theme', 'light')");
  await js("setLang('el')"); await sleep(1500);
  await shot('forecast-weather-el', { from: '.toolbar', to: '#forecastBody .hours' });
  await js("setLang('en')"); await sleep(800);
  await viewport(390, 900, true); await sleep(1200);
  await shot('mobile-forecast', { top: 0, to: '#forecastBody .hours', width: 390, maxH: 1850, pad: 0, scale: 1 });

  }
  ws.close(); proc.kill();
  console.log('done');
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
