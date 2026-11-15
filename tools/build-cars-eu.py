#!/usr/bin/env python3
"""Builds assets/cars_eu.json: European-market models with their official WLTP combined consumption, read from the version pages of
autotijd.be (which republishes the homologation figures). One brand per run argument; Skoda is the default.

    python tools/build-cars-eu.py [brand-slug ...]        e.g.  python tools/build-cars-eu.py skoda

Same format as assets/cars.json: {"cars": {"Skoda": [[label, kind, value, "2022-2027"], ...]}}  kind p petrol (incl. mild hybrid) · d diesel · e electric
(value = L/100 km or kWh/100 km: the middle of the WLTP range the page gives). Plug-in hybrids and CNG / LPG versions are left out.
The pages are fetched slowly (one per second) and cached under tools/.cache-eu/ so a re-run does not hit the site again.
Figures are official homologation values; please keep the credit to the source if you publish them."""
import html, json, os, re, sys, time, urllib.request

BASE = 'https://autotijd.be'
here = os.path.dirname(os.path.abspath(__file__))
cache_dir = os.path.join(here, '.cache-eu')
os.makedirs(cache_dir, exist_ok=True)
out_path = os.path.join(here, '..', 'assets', 'cars_eu.json')

def get(path):
    fn = os.path.join(cache_dir, re.sub(r'[^A-Za-z0-9_.-]', '_', path) + '.html')
    if os.path.exists(fn):
        return open(fn, encoding='utf-8').read()
    time.sleep(1.0)
    req = urllib.request.Request(BASE + path, headers={'User-Agent': 'Mozilla/5.0 (wefo car list builder)'})
    try:
        s = urllib.request.urlopen(req, timeout=40).read().decode('utf-8', 'ignore')
    except Exception as e:                                           # a missing page: remember it as empty
        print('  !', path, e)
        s = ''
    open(fn, 'w', encoding='utf-8').write(s)
    return s

def text(s):
    s = re.sub(r'<script.*?</script>|<style.*?</style>', '', s, flags=re.S)
    s = html.unescape(re.sub(r'<[^>]+>', '\n', s))
    return [l.strip() for l in s.split('\n') if l.strip()]

def rng(line):
    """'4.9 - 5.3 l/100 km' -> 5.1   (the middle of the range)"""
    line = re.split(r'(?i)\s*(?:l/100|kwh/100)', line)[0]                      # the digits of the unit ("100") are not part of the figure
    m = re.findall(r'(\d+(?:[.,]\d+)?)', line)
    if not m:
        return None
    v = [float(x.replace(',', '.')) for x in m[:2]]
    return round(sum(v) / len(v), 1)

def after(L, label, unit):
    for i, l in enumerate(L):
        if l == label and i + 1 < len(L) and unit in L[i + 1]:
            return rng(L[i + 1])
    return None

def crawl(brand):
    models = sorted(set(re.findall(r'href="/en/consumption/%s/([a-z0-9-]+)"' % brand, get('/en/consumption/%s/octavia' % brand if brand == 'skoda' else '/en/consumption/%s' % brand))))
    seen_pages, variants = set(), set()
    queue = list(models) + (['octavia'] if brand == 'skoda' else [])           # the seed page does not link to itself
    while queue:
        slug = queue.pop(0)
        if slug in seen_pages:
            continue
        seen_pages.add(slug)
        s = get('/en/consumption/%s/%s' % (brand, slug))
        for m in set(re.findall(r'href="(/en/consumption/%s/[a-z0-9-]+/[a-z0-9-]+-\d+)"' % brand, s)):          # any version link (older generations link to the current model's slug)
            variants.add(m)
        for other in set(re.findall(r'href="/en/consumption/%s/(%s-\d{4}-\d{4})"' % (brand, re.escape(slug)), s)):      # older generations
            queue.append(other)
        # a page that is itself a variant listing for another generation links its variants the same way
    todo = list(variants)
    while todo:                                                      # variant pages list their sibling versions too (some model pages do not)
        v = todo.pop()
        for m in set(re.findall(r'href="(/en/consumption/%s/[a-z0-9-]+/[a-z0-9-]+-\d+)"' % brand, get(v))):
            if m not in variants:
                variants.add(m); todo.append(m)
    print(brand, ':', len(seen_pages), 'model pages,', len(variants), 'versions')
    cars = []
    for v in sorted(variants):
        L = text(get(v))
        if not L:
            continue
        k = next((i for i, l in enumerate(L) if l.startswith('Consumption and emissions')), 0)
        head = L[k - 1] if k else ''
        if 'phev' in v.lower():
            continue
        title = next((l for l in L if re.match(r'^%s .*\(\d{4}-\d{4}\)' % brand.capitalize(), l)), '')
        years = re.search(r'\((\d{4}-\d{4})\)', title)
        years = years.group(1) if years else ''
        lbl = re.sub(r'^Consumption( and charging)? %s ' % brand.capitalize(), '', head).strip()
        lbl = re.sub(r'\s+\d{4}$', '', lbl)                          # the trailing model year
        lbl = re.sub(r'\s*\(\d{4}-\d{4}\)\s*$', '', lbl)                    # the years have their own column
        lbl = re.sub(r'\s+', ' ', lbl)
        if years and int(years[-4:]) < 2018:
            continue                                                 # pre-WLTP (NEDC) figures are not comparable
        body = ' '.join(L)
        fuel = after(L, 'Fuel consumption combined', 'l/100')
        elec = after(L, 'Electric consumption combined', 'kWh/100') or after(L, 'Electricity consumption combined', 'kWh/100')
        if fuel is not None and elec is not None:
            continue                                                 # plug-in hybrid
        if re.search(r'(?i)\bCNG\b|G-TEC|LPG', body[:600] + lbl):
            continue
        desc = body[:900].lower()
        extra = ''
        if 'manual transmission' in desc and 'manual' not in lbl.lower():
            extra += ' manual'
        if ('all-wheel' in desc or '4x4' in desc) and 'awd' not in lbl.lower():
            extra += ' AWD'
        if elec is not None:
            cars.append([f'{lbl}{extra}'.strip(), 'e', elec, years])
        elif fuel is not None and fuel >= 3:                         # below 3 L/100 km is a plug-in hybrid's weighted figure: not meaningful here
            diesel = bool(re.search(r'(?i)tdi|diesel', lbl)) or 'diesel' in desc[:400]
            cars.append([f'{lbl}{extra}'.strip(), 'd' if diesel else 'p', fuel, years])
    return cars

brands = sys.argv[1:] or ['skoda']
res = {'v': 1, 'src': 'official WLTP combined figures (middle of the published range) via autotijd.be', 'cars': {}}
if os.path.exists(out_path):
    try:
        res['cars'] = json.load(open(out_path, encoding='utf-8')).get('cars', {})
    except Exception:
        pass
for b in brands:
    lst = crawl(b)
    seen, out = set(), []
    for c in sorted(lst, key=lambda c: (c[0], c[3])):
        k = (c[0], c[1], c[2], c[3])
        if k not in seen:
            seen.add(k); out.append(c)
    res['cars'][b.capitalize()] = out
    print(b, '->', len(out), 'entries')
json.dump(res, open(out_path, 'w', encoding='utf-8'), ensure_ascii=False, separators=(',', ':'))
print(os.path.getsize(out_path), 'bytes')
