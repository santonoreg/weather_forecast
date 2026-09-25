// Εικονίδια καιρού (inline SVG, χωρίς εξωτερικές εξαρτήσεις)
const WI = (() => {
  const rays = (cx, cy, r) => {
    let s = '';
    for (let i = 0; i < 8; i++) {
      const a = i * Math.PI / 4, c = Math.cos(a), n = Math.sin(a);
      s += `M${(cx + c * (r + 4)).toFixed(1)} ${(cy + n * (r + 4)).toFixed(1)}L${(cx + c * (r + 9)).toFixed(1)} ${(cy + n * (r + 9)).toFixed(1)}`;
    }
    return `<path class="ray" d="${s}"/>`;
  };
  const sun = (cx, cy, r) => `<circle class="sun" cx="${cx}" cy="${cy}" r="${r}"/>${rays(cx, cy, r)}`;
  const moon = (t = '') => `<path class="moon" ${t} d="M38 10a22 22 0 1 0 16 36A18 18 0 0 1 38 10z"/>`;
  const cloud = (t = '') => `<path class="cloud" ${t} d="M19 50h27a10 10 0 0 0 2-19.8A15 15 0 0 0 19.5 33 8.7 8.7 0 0 0 19 50z"/>`;
  const drop = (x, y, k = 1) => `<path class="drop" transform="translate(${x} ${y}) scale(${k})" d="M0 0c2.6 3.6 3.8 5.8 3.8 7.6a3.8 3.8 0 0 1-7.6 0C-3.8 5.8-2.6 3.6 0 0z"/>`;
  const drops = (heavy) => (heavy ? [22, 30, 38, 46] : [26, 36, 46]).map((x, i) => drop(x, 51 + (i % 2) * 3)).join('');
  const flakes = '<g class="snowc"><circle cx="24" cy="56" r="2.6"/><circle cx="34" cy="60" r="2.6"/><circle cx="44" cy="56" r="2.6"/></g>';
  const bolt = '<path class="bolt" d="M35 42l-9 14h7l-3 9 12-15h-7z"/>';
  const fogLines = '<rect class="fogl" x="12" y="52" width="38" height="4.5" rx="2.2"/><rect class="fogl" x="20" y="59" width="32" height="4.5" rx="2.2"/>';
  const up = 'transform="translate(0 -6)"';
  const small = 'transform="translate(8 4) scale(.88)"';
  const showerCloud = 'transform="translate(8 -2) scale(.88)"';
  const showerDrops = drop(28, 49, .9) + drop(38, 51, .9) + drop(48, 49, .9);

  const icons = {
    'clear-day': sun(32, 32, 12),
    'clear-night': moon(),
    'partly-day': sun(25, 24, 9) + cloud(small),
    'partly-night': moon('transform="translate(-6 -6) scale(.7)"') + cloud(small),
    cloudy: cloud('transform="translate(0 2)"'),
    fog: cloud('transform="translate(0 -8) scale(.95)"') + fogLines,
    drizzle: cloud(up) + drop(26, 52, .6) + drop(36, 54, .6) + drop(46, 52, .6),
    rain: cloud(up) + drops(false),
    'heavy-rain': cloud(up) + drops(true),
    'showers-day': sun(22, 20, 8) + cloud(showerCloud) + showerDrops,
    'showers-night': moon('transform="translate(-6 -8) scale(.65)"') + cloud(showerCloud) + showerDrops,
    sleet: cloud(up) + drop(26, 52, .9) + drop(46, 52, .9) + '<g class="snowc"><circle cx="36" cy="58" r="2.6"/></g>',
    snow: cloud(up) + flakes,
    thunder: cloud(up) + bolt,
  };

  // Ομαδοποίηση κωδικών WMO σε κατηγορίες
  function category(code) {
    if (code == null) return null;
    if (code <= 1) return 'clear';
    if (code === 2) return 'partly';
    if (code === 3) return 'cloudy';
    if (code === 45 || code === 48) return 'fog';
    if (code >= 51 && code <= 57) return 'drizzle';
    if ((code >= 61 && code <= 67) || (code >= 80 && code <= 82)) return 'rain';
    if ((code >= 71 && code <= 77) || code === 85 || code === 86) return 'snow';
    if (code >= 95) return 'thunder';
    return 'cloudy';
  }
  const CAT_LABEL = { clear: 'Αίθριος', partly: 'Λίγες νεφώσεις', cloudy: 'Συννεφιά', fog: 'Ομίχλη', drizzle: 'Ψιχάλες', rain: 'Βροχή', snow: 'Χιόνι', thunder: 'Καταιγίδα' };
  const CAT_CODE = { clear: 0, partly: 2, cloudy: 3, fog: 45, drizzle: 51, rain: 63, snow: 73, thunder: 95 };

  const LABELS = {
    0: 'Αίθριος', 1: 'Κυρίως αίθριος', 2: 'Λίγες νεφώσεις', 3: 'Συννεφιά', 45: 'Ομίχλη', 48: 'Παγωμένη ομίχλη',
    51: 'Ελαφριές ψιχάλες', 53: 'Ψιχάλες', 55: 'Έντονες ψιχάλες', 56: 'Παγωμένες ψιχάλες', 57: 'Παγωμένες ψιχάλες',
    61: 'Ασθενής βροχή', 63: 'Βροχή', 65: 'Έντονη βροχή', 66: 'Παγωμένη βροχή', 67: 'Παγωμένη βροχή',
    71: 'Ασθενής χιονόπτωση', 73: 'Χιονόπτωση', 75: 'Έντονη χιονόπτωση', 77: 'Κόκκοι χιονιού',
    80: 'Ασθενείς μπόρες', 81: 'Μπόρες', 82: 'Ισχυρές μπόρες', 85: 'Χιονομπόρες', 86: 'Έντονες χιονομπόρες',
    95: 'Καταιγίδα', 96: 'Καταιγίδα με χαλάζι', 99: 'Ισχυρή καταιγίδα με χαλάζι',
  };
  const label = (code) => LABELS[code] || 'Άγνωστο';

  function key(code, night) {
    if (code == null) return null;
    const n = night ? 'night' : 'day';
    if (code === 0 || code === 1) return 'clear-' + n;
    if (code === 2) return 'partly-' + n;
    if (code === 3) return 'cloudy';
    if (code === 45 || code === 48) return 'fog';
    if (code >= 51 && code <= 57) return 'drizzle';
    if (code === 66 || code === 67) return 'sleet';
    if (code === 65 || code === 82) return 'heavy-rain';
    if (code >= 80 && code <= 81) return 'showers-' + n;
    if (code >= 61 && code <= 64) return 'rain';
    if ((code >= 71 && code <= 77) || code === 85 || code === 86) return 'snow';
    if (code >= 95) return 'thunder';
    return 'cloudy';
  }

  function svg(code, night = false, cls = '') {
    const k = key(code, night);
    if (!k) return '<span class="na">–</span>';
    return `<svg class="wi ${cls}" viewBox="0 0 64 64" role="img" aria-label="${label(code)}"><title>${label(code)}</title>${icons[k]}</svg>`;
  }
  // Βέλος προς την κατεύθυνση που φυσά ο άνεμος (deg = από πού φυσά)
  const arrow = (deg) => `<svg class="arrow" viewBox="0 0 24 24" style="transform:rotate(${Math.round(deg + 180)}deg)"><path d="M12 3l6 15-6-4-6 4z"/></svg>`;
  const bolt24 = '<svg class="bolt-i" viewBox="0 0 24 24"><path d="M13 2L5 14h6l-1 8 8-12h-6z"/></svg>';
  // Κοινά gradients για την τρισδιάστατη όψη (ορίζονται μία φορά στη σελίδα)
  const defs = `<svg width="0" height="0" style="position:absolute" aria-hidden="true"><defs>
    <radialGradient id="g-sun" cx=".35" cy=".3" r=".8"><stop offset="0" style="stop-color:#fff3a6"/><stop offset=".45" style="stop-color:#ffc21a"/><stop offset="1" style="stop-color:#f08a00"/></radialGradient>
    <radialGradient id="g-moon" cx=".3" cy=".3" r=".9"><stop offset="0" style="stop-color:#ffffff"/><stop offset=".6" style="stop-color:var(--moon-mid)"/><stop offset="1" style="stop-color:var(--moon-dark)"/></radialGradient>
    <linearGradient id="g-cloud" x1="0" y1="0" x2="0" y2="1"><stop offset="0" style="stop-color:var(--cloud-top)"/><stop offset="1" style="stop-color:var(--cloud-bot)"/></linearGradient>
    <linearGradient id="g-drop" x1="0" y1="0" x2="1" y2="1"><stop offset="0" style="stop-color:#8fd0ff"/><stop offset="1" style="stop-color:#1d6fe0"/></linearGradient>
    <radialGradient id="g-snow" cx=".35" cy=".3" r=".8"><stop offset="0" style="stop-color:#fff"/><stop offset="1" style="stop-color:#8ecdf5"/></radialGradient>
    <linearGradient id="g-bolt" x1="0" y1="0" x2="1" y2="1"><stop offset="0" style="stop-color:#ffe66b"/><stop offset="1" style="stop-color:#f57c00"/></linearGradient>
  </defs></svg>`;
  document.body.insertAdjacentHTML('afterbegin', defs);
  return { svg, category, CAT_LABEL, CAT_CODE, label, arrow, bolt24 };
})();
