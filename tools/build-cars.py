#!/usr/bin/env python3
"""Builds assets/cars.json (the car list of the Trip tab's fuel / energy estimate) from the US EPA fuel-economy data
(https://www.fueleconomy.gov/feg/epadata/vehicles.csv.zip, public domain).

    python tools/build-cars.py [path-to-vehicles.csv.zip]      (downloads the file when no path is given)

Combined city/highway figures, converted to European units:  L/100 km = 235.215 / mpg   and   kWh/100 km = kWh/100 mi / 1.609.
Plug-in hybrids, CNG/LPG-only and other exotic fuels are left out. Rows that differ only in the transmission or the model year
are merged (the figure is the average), so each entry is "make, model, engine (+ AWD / turbo)" with the years it was sold.
Output: {"v": 1, "src": "...", "cars": {"Make": [[label, kind, value, "2015-2022"], ...]}}  with kind  p petrol · d diesel · h hybrid · e electric
(value = L/100 km, or kWh/100 km for electric).
"""
import csv, io, json, os, sys, urllib.request, zipfile
from collections import defaultdict

URL = 'https://www.fueleconomy.gov/feg/epadata/vehicles.csv.zip'
MIN_YEAR = 2008                      # the EPA changed its method in 2008: older figures are not comparable
here = os.path.dirname(os.path.abspath(__file__))
out_path = os.path.join(here, '..', 'assets', 'cars.json')

if len(sys.argv) > 1:
    data = open(sys.argv[1], 'rb').read()
else:
    print('downloading', URL)
    data = urllib.request.urlopen(urllib.request.Request(URL, headers={'User-Agent': 'wefo-build-cars/1.0'}), timeout=120).read()
rows = list(csv.DictReader(io.TextIOWrapper(zipfile.ZipFile(io.BytesIO(data)).open('vehicles.csv'), encoding='utf-8')))
print(len(rows), 'rows in the EPA file')

def f(x):
    try:
        return float(x)
    except (TypeError, ValueError):
        return 0.0

groups = defaultdict(list)
for r in rows:
    year = int(r['year'] or 0)
    if year < MIN_YEAR:
        continue
    atv = r['atvType'] or ''
    f1 = r['fuelType1'] or ''
    if atv in ('Plug-in Hybrid', 'CNG', 'Bifuel (CNG)', 'Bifuel (LPG)', 'FCV'):
        continue
    if f1 == 'Electricity':
        kind, val = 'e', f(r['combE']) / 1.609344
    elif f1 == 'Diesel':
        kind, val = 'd', 235.215 / f(r['comb08']) if f(r['comb08']) else 0
    elif 'Gasoline' in f1:
        kind, val = ('h' if atv == 'Hybrid' else 'p'), 235.215 / f(r['comb08']) if f(r['comb08']) else 0
    else:
        continue
    if val <= 0:
        continue
    make, model = {'Mini': 'MINI'}.get(r['make'].strip(), r['make'].strip()), r['model'].strip()
    if kind == 'e':
        label = model
        key = (make, model, kind)
    else:
        displ = f(r['displ'])
        turbo = 'T' if (r['tCharger'] or r['sCharger']) else ''
        awd = ' AWD' if any(x in (r['drive'] or '') for x in ('All-Wheel', '4-Wheel')) else ''
        eng = f'{displ:.1f}L{turbo}' if displ else ''
        label = f'{model} {eng}{awd}'.strip()
        key = (make, model, kind, eng, awd)
    groups[key].append((year, val, label))

cars = defaultdict(list)
for key, lst in groups.items():
    ys = [y for y, _, _ in lst]
    avg = sum(v for _, v, _ in lst) / len(lst)
    y0, y1 = min(ys), max(ys)
    cars[key[0]].append([lst[0][2], key[2], round(avg, 1 if key[2] != 'e' else 1), str(y0) if y0 == y1 else f'{y0}-{y1}'])
for make in cars:
    cars[make].sort(key=lambda c: (c[0], c[1]))
res = {'v': 1, 'src': 'US EPA fueleconomy.gov (combined cycle), converted to L/100 km and kWh/100 km', 'cars': dict(sorted(cars.items()))}
with open(out_path, 'w', encoding='utf-8') as fh:
    json.dump(res, fh, ensure_ascii=False, separators=(',', ':'))
n = sum(len(v) for v in cars.values())
print(n, 'entries,', len(cars), 'makes ->', os.path.getsize(out_path) // 1024, 'KB')
