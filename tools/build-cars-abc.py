#!/usr/bin/env python3
"""Adds older / real-world figures to assets/cars_eu.json from auto-abc.eu's "real fuel consumption" pages, which list, per version,
the claimed consumption and the real consumption reported by owners. The real figure is used when there is one (it is what you
actually pay for), else the claimed one.

    python tools/build-cars-abc.py "Alfa Romeo" 147        (make, model as in the auto-abc.eu address: Alfa-Romeo-147)

Pages are cached under tools/.cache-eu/ and fetched once. Output entries: [label, kind (p / d), L/100 km, "2001-2007"]."""
import html, json, os, re, sys, time, urllib.request

here = os.path.dirname(os.path.abspath(__file__))
cache_dir = os.path.join(here, '.cache-eu')
os.makedirs(cache_dir, exist_ok=True)
out_path = os.path.join(here, '..', 'assets', 'cars_eu.json')

def get(url):
    fn = os.path.join(cache_dir, re.sub(r'[^A-Za-z0-9_.-]', '_', url) + '.html')
    if os.path.exists(fn):
        return open(fn, encoding='utf-8').read()
    time.sleep(1.0)
    s = urllib.request.urlopen(urllib.request.Request(url, headers={'User-Agent': 'Mozilla/5.0 (wefo car list builder)'}), timeout=40).read().decode('utf-8', 'ignore')
    open(fn, 'w', encoding='utf-8').write(s)
    return s

make, model = sys.argv[1], sys.argv[2]
slug = f"{make.replace(' ', '-')}-{model}"
s = get(f'https://www.auto-abc.eu/info/real-fuel-consumption/{slug}')
s = re.sub(r'<script.*?</script>|<style.*?</style>', '', s, flags=re.S)
L = [l.strip() for l in html.unescape(re.sub(r'<[^>]+>', '\n', s)).split('\n') if l.strip()]
rows = {}
for i, l in enumerate(L):
    m = re.match(r'^%s %s (\d{4}) (.+)$' % (re.escape(make), re.escape(model)), l)
    if not m or i + 3 >= len(L) or L[i + 1] not in ('Petrol', 'Diesel'):
        continue
    year, name = int(m.group(1)), m.group(2)
    nums = []
    j = i + 2
    while j < len(L) and len(nums) < 2 and re.match(r'^\d+(\.\d+)?$', L[j]) and j + 1 < len(L) and L[j + 1].startswith('l/100'):
        nums.append(float(L[j])); j += 2                              # claimed, then (when owners reported it) real
    if not nums:
        continue
    val = nums[1] if len(nums) > 1 else nums[0]
    kind = 'd' if L[i + 1] == 'Diesel' else 'p'
    label = re.sub(r's+', ' ', f'{model} {name}'.replace(' ', ' '))
    k = (label, kind)
    if k in rows:
        rows[k][0] = min(rows[k][0], year); rows[k][1] = max(rows[k][1], year); rows[k][2].append(val)
    else:
        rows[k] = [year, year, [val]]
entries = []
for (label, kind), (y0, y1, vals) in sorted(rows.items()):
    entries.append([label, kind, round(sum(vals) / len(vals), 1), f'{y0}-{y1}' if y0 != y1 else str(y0)])
res = {'v': 1, 'cars': {}}
if os.path.exists(out_path):
    res = json.load(open(out_path, encoding='utf-8'))
keep = [c for c in res['cars'].get(make, []) if not c[0].startswith(model + ' ')]
res['cars'][make] = sorted(keep + entries, key=lambda c: (c[0], c[3]))
json.dump(res, open(out_path, 'w', encoding='utf-8'), ensure_ascii=False, separators=(',', ':'))
print(len(entries), 'versions of', make, model)
for e in entries:
    print(' ', e)
