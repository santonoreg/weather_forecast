# WeFo – weather model comparison

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

WeFo is a small self-hosted web app that puts the forecasts of many **free** weather models side by side, hour by hour, and adds a final row with a **probability derived from how much the models agree** (optionally weighted by how reliable each model has recently been for your location).

- Backend: **PHP 8** + **SQLite** (no framework, no Composer)
- Frontend: plain **HTML / CSS / JavaScript** (no build step), [Leaflet](https://leafletjs.com/) for the map
- UI languages: **English** (default) and **Greek** – switch with the `EN | ΕΛ` buttons in the header
- **Light / dark theme** – follows your system setting; use the sun/moon button next to the language switch to override it
- No API keys, no accounts

> The probabilities are a measure of model agreement. They are **not** an official forecast and must not be used for safety-critical decisions.

---

## Screenshots

**Forecast – weather** (hero card with rain outlook and days-ahead on the left; on the right, the Weather tab's five-lane dashboard – Weather, Agree, Temp, Rain, Wind – with the individual providers collapsed behind "Show all models"; the current interval is highlighted)

![Forecast – weather](docs/screenshots/forecast-weather.png)

**See what the models say** – a per-provider spaghetti chart (temperature, next 48h) and precipitation bars, expandable below the table

![See what the models say](docs/screenshots/forecast-expert.png)

**Time down** – the same table transposed to one row per hour (Show all models collapsed to the consensus-only view)

![Time down](docs/screenshots/forecast-timedown.png)

**Meteogram** – temperature (with the model-spread band), precipitation and wind for the selected day as charts, independent of the parameter tab

![Meteogram](docs/screenshots/forecast-meteogram.png)

**Rain** – per-model rainfall per step, average and chance of rain

![Forecast – rain](docs/screenshots/forecast-rain.png)

**Wind** – speed, direction arrow and gusts per model, chance of strong wind

![Forecast – wind](docs/screenshots/forecast-wind.png)

**Reliability** – per-model score, error and bias against ERA5 (last 28 days) and, in blue, against real METAR observations of the nearest airport

![Reliability](docs/screenshots/reliability.png)

**Models drop-down** – enable/disable models, regional notes and reliability scores

![Models drop-down](docs/screenshots/models-dropdown.png)

**Locations & Map** – pick a point on the map, search, save locations

![Locations & Map](docs/screenshots/locations-map.png)

**Location history** – shown below the map when you click *History*: records, annual/monthly climate and charts since 1940 (downloaded once, then only new days are added)

![Location history](docs/screenshots/history.png)

**Dark theme**

![Dark theme](docs/screenshots/forecast-dark.png)

**Responsive layout** (phone) and **Greek UI**

<p>
  <img src="docs/screenshots/mobile-forecast.png" alt="Mobile layout" width="260">
  &nbsp;
  <img src="docs/screenshots/forecast-weather-el.png" alt="Greek UI" width="620">
</p>

---

## Table of contents

1. [Screenshots](#screenshots)
2. [What it shows](#what-it-shows)
3. [How it works](#how-it-works)
4. [Requirements](#requirements)
5. [Installation](#installation)
6. [Configuration](#configuration)
7. [Project structure](#project-structure)
8. [HTTP API](#http-api)
9. [Data, privacy and external services](#data-privacy-and-external-services)
10. [Limitations](#limitations)
11. [Adding a language](#adding-a-language)
12. [Troubleshooting](#troubleshooting)

---

## What it shows

### Locations & Map

- Pick a place by **clicking on the map**, typing **latitude/longitude**, **searching by name**, or using **My location**.
- The name is filled in automatically (reverse geocoding) and you can edit it.
- **Save** the location: it is stored in the SQLite database and appears in the *Location* drop-down of the Forecast page. Saved locations are shown on the map and can be deleted.
- **History** button next to every saved location: opens the long-term weather history for that place (see below).

### Location history

Click **History** next to a saved location and a section opens **below the map** (nothing is shown until you choose a location) with what the weather has been like there since **1940**:

- **Coverage:** which data grid point was used (its coordinates, its distance from your location and its elevation), the period and the number of days available.
- **Records:** hottest day, coldest night, wettest day, strongest gust, snowiest day, with dates.
- **Charts (full width):** *Annual mean temperature* (with a trend line in °C per decade) and *Annual precipitation*. Each chart has its own **Period** drop-down: *Whole year* shows the annual value, while choosing a month (e.g. *January*) shows the mean temperature – or the total rainfall – of that month for every year in the history.
- **Temperature heatmap:** one cell for every month of every year since 1940 (columns = years, rows = months). By default the colour is the **difference from that month's long-term average** (red warmer, blue colder), so you can see at once how every month has changed over the whole history; a switch shows the actual temperature instead.
- **Monthly climate:** average temperature (mean / max / min), rainfall and rainy days for each month over all years.
- **Year by year:** mean / max / min temperature, precipitation (with bars), rainy days (≥ 1 mm), strongest gust and snowfall.

The first time you open it, the app downloads the complete daily series (about 1.5 MB, a few seconds) from the Open-Meteo Historical Weather API for the grid point **nearest to the coordinates** (ERA5 / ERA5-Land reanalysis, ~10 km resolution) and **stores it in SQLite**. Every later visit is served from the local database in a fraction of a second, and **only the days that are not stored yet are downloaded and appended** (checked at most once every 6 hours, or immediately with *Check for new data now*). Deleting a location also deletes its stored history. Note that this is a reanalysis (a model constrained by observations), not station measurements.

### Forecast

Choose a saved location and you get a two-column layout: a **hero card** and the **days-ahead** list on the left, the hour-by-hour table on the right (stacked on narrow screens).

1. **Hero card**: current conditions right now (icon, temperature, feels-like, wind) and a **verdict** strip — a 1–5 dot scale plus a sentence saying how much the models agree (*"The models mostly/partly agree" / "are split"*), with the temperature range behind it. Below it, three lines built from three different sources, from most to least "real-time": a **"Measured now"** line with real METAR observations (temperature, wind, humidity, rain) from the nearest airport station (`api/observed.php`, via aviationweather.gov — the same source `api/verify.php` uses for reliability scoring), a **radar "Next break"** line sampled from RainViewer's live radar composite at the exact point (`api/radar.php`, needs the `gd` PHP extension — degrades silently without it), and finally the model-based one-line **rain outlook** (*"Rain expected from 13:00"*, *"Next break: dry from …"*, *"No rain expected in the next Nh"*), computed by scanning the next 24 hours for the next change in the rain-probability consensus. Each line only appears when its data source actually has something for that location. A **View full history** link jumps straight to that location's [long-term history](#location-history).
2. **Days ahead** (7 days): one row per day with icon, high/low, chance of rain (≥ 1 mm) and peak gust; click a day to jump the table below to it.
3. **Parameter tabs**, each showing one table (the Weather tab also shows a colour legend for the category icons above the table). By default each table is **consensus-first**: on the **Weather** tab it shows a five-row dashboard — **Weather** (top category icon), **Agree** (its share), **Temp**, **Rain** (chance + mm) and **Wind** (speed, gusts, direction) — all at once; every other tab shows its own average/agreement pair (see the table below). A **"Show all N models"** button reveals every individual provider's row underneath (plus, on the Weather tab, the named AI models, which stay visible either way). A **→ Time across / ↓ Time down / 〰 Meteogram** switch changes how the table is shown: *across* keeps time as columns with one row per provider (as below); *down* turns it into a one-row-per-hour agenda (average + probability only, better for narrow screens or scanning many hours at once); *Meteogram* replaces the table with charts – temperature (with a shaded band for the spread between providers), precipitation and wind speed for the selected day, all at once and independent of which tab is selected. All three always reflect the same underlying **Weight by reliability** setting.

   | Tab | Provider cells | Second-to-last row | **Last row (probability)** |
   |---|---|---|---|
   | **Weather** | weather icon + temperature | *(see the five-lane dashboard above instead)* | every weather category predicted by the models with its share (e.g. *Clear 55 %, Overcast 27 %, Partly cloudy 18 %*) is what the **Weather** lane's icon summarises; the **Agree** lane is its share |
   | **Temperature** | °C, colour-coded | average, min–max | agreement % and ± standard deviation |
   | **Rain** | mm per step | average, max | chance of rain (share of models giving ≥ 0.2 mm in the step) |
   | **Wind** | 10 m speed km/h, arrow = direction the wind blows towards, gust in brackets | average and range, mean direction | chance of strong wind (share of models ≥ 30 km/h) and of gusts ≥ 60 km/h |
   | **Thunderstorm** | CAPE (J/kg) and a bolt when the model forecasts a thunderstorm | average CAPE | chance of thunderstorm |
   | **Cloud cover / Humidity / Pressure** | value, colour-coded | average, min–max | agreement % |

   Below the table, a collapsible **"See what the models say"** panel plots the next 48 hours independent of the tab/day/step selection: a spaghetti chart with every active provider's own temperature line (thin) plus the weighted average (highlighted) – tight lines mean the models agree, spread-out lines mean uncertainty – and a precipitation-per-hour bars pair (model average vs. the single wettest model).
   | **Reliability** | see [Model verification](#model-verification-reliability-tab) | | |

4. **Step**: 1, 3, 6 or 12 hours. Values are aggregated per step (rain = sum, gust/CAPE = max, weather code = most severe, wind direction = speed-weighted circular mean, others = mean).
5. The **current time interval is highlighted** (whole column) and, when the table needs horizontal scrolling, it is **automatically centred**. Past intervals are slightly dimmed.
6. **Models** drop-down: enable/disable individual models (see below).
7. **Weight by reliability** checkbox: turn reliability weighting on/off.
8. **Refresh** forces a fresh download (otherwise data is cached for 30 minutes).

### Models drop-down

- Each model has a checkbox, a short note about **which regions it is best for**, and its reliability score (0–100) once verification has loaded.
- Disabled models disappear from the tables and from all averages and probabilities. At least one model must stay enabled.
- The choice is **per browser** (saved in `localStorage`, see [privacy](#data-privacy-and-external-services)) and applies to all locations.
- Models that cannot cover the selected location are listed under *No coverage for this location*.
- Some regional models (KNMI, DMI, MET Norway Nordic) silently return a **copy of a global model** outside their domain. WeFo detects identical series and counts them **only once**; they are shown greyed out with the note *Same data as …*.

---

## How it works

### Data sources

| Provider | How it is fetched |
|---|---|
| **ECMWF AIFS** (AI / neural-network forecast), ECMWF IFS, NOAA GFS, DWD ICON, Environment Canada GEM, Météo-France, UK Met Office, JMA, CMA GRAPES, BOM ACCESS, KNMI, DMI, MET Norway Nordic | one request to the [Open-Meteo forecast API](https://open-meteo.com/) with the `models=` parameter |
| MET Norway / Yr (global) | directly from the [MET Norway Locationforecast API](https://api.met.no/) (converted to the same hourly format) |

Real observations used only for the reliability score come from [aviationweather.gov](https://aviationweather.gov/data/api/) (METAR). Models that return no data for the location are dropped automatically. **ECMWF AIFS** is ECMWF's newer AI/neural-network forecast system (as opposed to the physics-based numerical models everything else here uses) – it is included as just another model in the comparison, weighted like the rest by the [reliability](#model-verification-reliability-tab) score. **Google WeatherNext 3** (Google DeepMind's AI model) can optionally be added the same way – see [below](#optional-google-weathernext-3-and-the-wefo-vs-ai-comparison); it needs your own API key and is off by default. Everything is fetched **server-side** (`api/forecast.php`) and cached in SQLite for **30 minutes** per location (Google WeatherNext 3 has its own, longer cache – see below).

### Consensus and probability

For every time step and every parameter WeFo collects one value per active provider and computes:

- **Average / range** – (weighted) mean, min and max of the provider values.
- **Weather category** – WMO weather codes are grouped into *clear, partly cloudy, overcast, fog, drizzle, rain, snow, thunderstorm*. Each provider votes for its category; the shares are shown as percentages. If a provider gives no weather code it is derived from precipitation, temperature (snow), CAPE and cloud cover.
- **Chance of rain** – share of providers with ≥ **0.2 mm** in the step.
- **Chance of strong wind** – share of providers with ≥ **30 km/h** (Beaufort 5).
- **Chance of thunderstorm** – each provider gives a signal: weather code 95–99 = 1, CAPE ≥ 1000 J/kg = 0.5, otherwise 0; the chance is the (weighted) mean signal.
- **Agreement** (temperature, cloud, humidity, pressure) – `100 % × (1 − σ / tolerance)`, where σ is the standard deviation between providers and the tolerance is 4 °C, 50 %, 25 %, 4 hPa respectively (0 % when σ ≥ tolerance).

The thresholds are constants at the top of `js/app.js` (`RAIN_THR`, `WIND_THR`, `TOL`).

### Model verification (Reliability tab)

To find out which models have recently been closest to reality **for your location**, `api/verify.php` compares every model's *archived forecasts* (Open-Meteo **Historical Forecast API**) with two references:

1. **ERA5 reanalysis** (Open-Meteo **Archive API**) – a gridded "what actually happened" for the last **28 days** (ending 6 days ago, because ERA5 is published with a delay). Available everywhere, but it is a model product, produced with ECMWF's system, so it slightly favours ECMWF.
2. **Real METAR observations** – the hourly weather reports of the **nearest airport station** within 60 km (from [aviationweather.gov](https://aviationweather.gov/data/api/), no key needed). Roughly the last 1–2 weeks (the API returns up to ~400 reports). METAR gives measured temperature, dew point (→ relative humidity), wind, pressure, cloud cover and present weather (rain, snow, thunderstorm, fog).

For each model and reference it computes: mean absolute error and bias for temperature, wind, cloud cover, humidity and pressure; the *critical success index* for detecting wet hours; and the share of hours with the correct weather category (drizzle and rain are treated as one category for this comparison).

**Combining the two:** per parameter, `skill = 0.6 × METAR skill + 0.4 × ERA5 skill` when at least 48 matched hourly observations exist; otherwise ERA5 alone is used. Observations get the larger share because ERA5 is not independent of the models being judged. The **score (0–100)** is the mean skill across parameters, and the skills are turned into **weights between 0.5 and 1.8** (average = 1) per parameter. With *Weight by reliability* enabled, the averages, chances and weather-category shares use these weights, so better models count more. Results are cached for 24 hours per location.

In the Reliability table every cell shows the error against ERA5 and, in blue, the error against METAR; the note under the table names the station, its distance and the number of reports used.

Notes and caveats:

- An airport is a point measurement. Distance, elevation and local effects (sea breeze, urban heat) add errors that affect all models similarly; the station is shown so you can judge how representative it is.
- Pressure comes from the METAR sea-level pressure (or altimeter setting), and rain/weather from the *present-weather* code at report time – rain detection against METAR is therefore approximate.
- Models without archived data for the area (regional models outside their domain) and Yr are not scored and count with weight 1. Rain weights are only used when the period contains enough rain events to be meaningful.
- If no METAR station with enough reports is near the location, ERA5 alone is used and the note says so.

### Optional: Google WeatherNext 3, and the "WeFo vs AI" comparison

In the **Weather** tab, right after the *Most likely weather* row (WeFo's own weighted result — unchanged, still just the category breakdown), two more rows appear on their own, tagged **AI**, for direct comparison with it:

- **ECMWF AIFS** – always shown (it's just another free Open-Meteo model, see above).
- **Google WeatherNext 3** – Google DeepMind's AI weather model, exposed via the paid [Google Maps Platform Weather API](https://developers.google.com/maps/documentation/weather/overview). This is **optional and off by default**: unlike every other data source in this app, it needs your own Google Cloud project with billing enabled and an API key, and is not free beyond a monthly quota.

#### Getting a key, without risking a surprise charge

1. In [Google Cloud Console](https://console.cloud.google.com/), create a project and enable billing on it (required even for the free tier — a card must be on file).
2. **APIs & Services → Library**, search **Weather API**, click **Enable**.
3. **APIs & Services → Credentials → Create Credentials → API key**. Then edit the key and, under *API restrictions*, limit it to just the Weather API (and, since it's only ever called from your server, optionally restrict it further by IP address to your VPS).
4. **Cap the quota so Google itself refuses calls beyond a number you choose** — this is what actually prevents a bill, a budget alert on its own does not stop charges: **APIs & Services → Enabled APIs & services → Weather API → Quotas** tab (or open `https://console.cloud.google.com/apis/api/weather.googleapis.com/quotas` directly), select the *Requests per day* limit, **Edit Quotas**, and set it to something at or below the free tier for your usage (e.g. `300`/day ≈ 9,000/month, matching this app's own cap below). Once hit, Google returns errors instead of billing you further.
5. Optionally, also add **Billing → Budgets & alerts → Create budget** (e.g. €1, alert at 100%) as a second, independent warning.

#### Giving the app the key

**Recommended — a file:** copy `api/config.example.php` to `api/config.php` (git-ignored, never committed, and never served as plain text since it's PHP, not downloadable — a request for it just runs and returns nothing) and set `google_weather_api_key`. Lock it down a bit further if you like: `sudo chown root:www-data api/config.php && sudo chmod 640 api/config.php` (only root and the web-server group can read it). No restart of anything needed — reload the app and the model appears once data is fetched for a location.

**Advanced alternative — an environment variable** (`WEFO_GOOGLE_WEATHER_API_KEY`, overrides `api/config.php` if both are set), if you'd rather not keep the key in any file the app reads directly: `SetEnv WEFO_GOOGLE_WEATHER_API_KEY "your-key"` in an Apache conf (mod_php) or `env[WEFO_GOOGLE_WEATHER_API_KEY] = your-key` in the PHP-FPM pool file (Nginx), then reload the web server. In practice this route has more moving parts than it looks: `php -r` / `php -S` from a terminal do **not** see Apache's `SetEnv` (they're separate processes — only real requests handled by Apache do), so test it by requesting a page through the actual site, not via SSH; and if the site sits behind Cloudflare Access or similar, `curl` from outside won't get past the login redirect either — test from a browser tab where you're already signed in. Given all that, the file above is simpler for most setups.

#### What protects you from unexpected cost

Pricing (as published by Google): **10,000 calls/month free**, then pay-as-you-go. On top of the Google Cloud quota you set above, `api/google_weather.php` protects you from surprise bills with a few constants at the top of that file: responses are cached for **3 hours** (`GOOGLE_CACHE_TTL`), only **3 days** of hourly data are requested per fetch (`GOOGLE_HOURS`, i.e. 3 calls per fetch — Google caps 24 hours per call), and a **hard daily cap of 300 calls** (`GOOGLE_DAILY_CALL_CAP`, ~9,000/month) stops the app from calling Google at all for the rest of the UTC day once reached. A failed request (bad/expired key, billing disabled, quota exceeded, network error) is followed by a 15-minute cooldown before retrying. **If there is no key, or the key stops working, or the free quota runs out, Google WeatherNext 3 simply does not appear anywhere in the app** — nothing else is affected, and no error is shown to visitors.

To check usage: **APIs & Services → Weather API → Metrics** (requests over time) or **Billing → Reports** filtered to the *Weather Usage* SKU (exact call counts and any cost). For a quick local check of how many calls the app itself made today: `sqlite3 data/wefo.sqlite "SELECT k, body FROM cache WHERE k LIKE 'goo:quota:%' ORDER BY k DESC LIMIT 5;"`.

You are responsible for your own Google Cloud billing; check current pricing before relying on this beyond light personal use.

---

## Requirements

- **PHP 8.0+** (developed on 8.4) with the extensions **`pdo_sqlite`** and **`curl`** (`mbstring` and `gd` are optional — `gd` is only needed for the hero card's radar "Next break" line, see below)
- A web server that can run PHP (Apache, Nginx + PHP-FPM, or the built-in PHP server for development)
- Write permission for the web-server user on the `data/` directory
- Outbound HTTPS access to `open-meteo.com`, `api.met.no`, `aviationweather.gov`, `nominatim.openstreetmap.org`, `api.rainviewer.com` + `tilecache.rainviewer.com`, `unpkg.com`, `fonts.googleapis.com` and OpenStreetMap tile servers (plus `weather.googleapis.com` only if you configure the optional Google WeatherNext 3 key)

## Installation

### Quick start (local development)

```bash
git clone https://github.com/santonoreg/weather_forecast.git
cd weather_forecast
php -S 127.0.0.1:8099
```

Open <http://127.0.0.1:8099/>, go to **Locations & Map**, save a location, then open **Forecast**.

> With PHP's built-in server the `data/` directory is not protected by `.htaccess`. Use it for development only.

### Laragon / XAMPP / WAMP (Windows)

1. Copy or clone the project into the web root, e.g. `C:\laragon\www\wefo` (or `htdocs\wefo`).
2. Make sure `extension=pdo_sqlite` and `extension=curl` are enabled in `php.ini`.
3. Open `http://localhost/wefo/`.

### Ubuntu / Debian VPS with Apache

```bash
sudo apt update
sudo apt install apache2 php php-sqlite3 php-curl php-mbstring libapache2-mod-php git

cd /var/www
sudo git clone https://github.com/santonoreg/weather_forecast.git wefo

# the web-server user must be able to write the database
sudo mkdir -p /var/www/wefo/data
sudo chown -R www-data:www-data /var/www/wefo/data
sudo chmod 775 /var/www/wefo/data
```

`data/.htaccess` already denies web access to the database; this requires `AllowOverride All` (or at least `AllowOverride AuthConfig`) for the directory:

```apache
<Directory /var/www/wefo>
    AllowOverride All
    Require all granted
</Directory>
```

Enable HTTPS (recommended), e.g. with Let's Encrypt: `sudo apt install certbot python3-certbot-apache && sudo certbot --apache`.

### Ubuntu / Debian VPS with Nginx + PHP-FPM

```bash
sudo apt install nginx php-fpm php-sqlite3 php-curl php-mbstring git
cd /var/www && sudo git clone https://github.com/santonoreg/weather_forecast.git wefo
sudo mkdir -p /var/www/wefo/data && sudo chown -R www-data:www-data /var/www/wefo/data && sudo chmod 775 /var/www/wefo/data
```

Nginx does not read `.htaccess`, so **block the database directory explicitly**:

```nginx
server {
    server_name example.com;
    root /var/www/wefo;
    index index.html;

    location ^~ /data/ { deny all; return 404; }

    location ~ \.php$ {
        include snippets/fastcgi-php.conf;
        fastcgi_pass unix:/run/php/php-fpm.sock;   # adjust to your PHP-FPM socket
    }
}
```

### Installing under a sub-path (e.g. `https://example.com/forecast/`)

Just put the project in a sub-folder of the web root. All URLs in the app are relative, so no configuration is needed.

### Updating

```bash
cd /var/www/wefo && git pull
```

Then hard-refresh the browser (Ctrl+F5). The CSS/JS URLs carry a `?v=` version parameter in `index.html` to avoid stale caches; bump it when you change those files.

## Configuration

Most settings are constants in the PHP files below. One optional file, `api/config.php` (copy it from `api/config.example.php`, git-ignored) — or, if you'd rather not keep it in a file, the `WEFO_GOOGLE_WEATHER_API_KEY` environment variable — holds your own Google Maps Platform API key; see [above](#optional-google-weathernext-3-and-the-wefo-vs-ai-comparison). Everything else needs no config file at all.

| Where | Constant | Meaning |
|---|---|---|
| `api/forecast.php` | `CACHE_TTL` (1800) | forecast cache in seconds |
| `api/forecast.php` | `$MODELS` | Open-Meteo model ids and display names |
| `api/verify.php` | `WINDOW_DAYS` (28), `LAG_DAYS` (6), `VERIFY_TTL` (86400) | ERA5 window, ERA5 delay, cache |
| `api/verify.php` | `MAX_STATION_KM` (60), `MIN_OBS` (48), `OBS_WEIGHT` (0.6), `METAR_HOURS` (360) | METAR station distance limit, minimum matched observations, METAR share of the blended skill, how far back to ask for reports |
| `api/verify.php` | `$TOL` | error at which a parameter's skill reaches 0 |
| `api/db.php` | `http_get()` | User-Agent and cURL options |
| `api/google_weather.php` | `GOOGLE_CACHE_TTL`, `GOOGLE_HOURS`, `GOOGLE_PAGE_SIZE`, `GOOGLE_DAILY_CALL_CAP`, `GOOGLE_FAIL_COOLDOWN` | Google WeatherNext 3 cache lifetime, hours requested per fetch, Google's page size cap, hard daily call cap, retry backoff after a failure |
| `js/app.js` | `RAIN_THR`, `WIND_THR`, `TOL` | thresholds for the probabilities |
| `js/app.js` | `HEADLINE_MODEL_IDS` | which models get their own named line in the "WeFo vs AI" comparison |

**Please change the User-Agent** in `api/db.php` (`wefo-weather-compare/1.0 …`) to identify your own installation with a contact address – [MET Norway requires this](https://api.met.no/doc/TermsOfService).

## Project structure

```
index.html          single-page UI (Forecast + Locations views)
css/style.css       styles (light/dark, responsive)
js/i18n.js          translations (en, el) and language switching
js/icons.js         3D-style SVG weather icons, WMO code → category mapping
js/app.js           UI logic: tables, consensus, weighting, map, preferences
api/db.php          SQLite connection, JSON helpers, HTTP client, error handling
api/locations.php   GET / POST / DELETE saved locations
api/geocode.php     place search (Open-Meteo) and reverse geocoding (Nominatim)
api/forecast.php    multi-model forecast aggregation + 30 min cache
api/verify.php      model verification against ERA5 + METAR observations, 24 h cache
api/history.php     long-term daily history per saved location (download once, cached in SQLite)
api/google_weather.php   optional Google WeatherNext 3 integration (used by forecast.php)
api/config.example.php   template for api/config.php (your own API keys — copy it, don't edit this one)
api/config.php      your own local config (git-ignored; absent = optional features stay off)
data/               SQLite database (created automatically, git-ignored)
```

Database tables (created automatically): `locations(id, name, lat, lon, created_at)`, `cache(k, body, fetched_at)`, `history_daily(loc_id, d, tmax, tmin, tmean, prcp, wmax, gust, snow)` and `history_meta(loc_id, grid_lat, grid_lon, elevation, timezone, first_date, last_date, fetched_at)`. The history of one location takes roughly 2–3 MB.

## HTTP API

| Endpoint | Description |
|---|---|
| `GET api/locations.php` | list saved locations |
| `POST api/locations.php` | body `{"name","lat","lon"}` – save a location |
| `DELETE api/locations.php?id=ID` | delete a location |
| `GET api/geocode.php?q=TEXT&lang=en\|el` | search places |
| `GET api/geocode.php?lat=..&lon=..&lang=en\|el` | reverse geocode a point |
| `GET api/forecast.php?lat=..&lon=..[&refresh=1]` | normalised hourly forecasts from all providers |
| `GET api/verify.php?lat=..&lon=..` | per-model scores, errors (vs ERA5 and vs METAR), weights and the METAR station used |
| `GET api/history.php?id=ID[&refresh=1]` | history summary (records, monthly, annual) for a saved location; downloads and stores the data on first use |

Errors are returned as `{"error": "message"}` with an HTTP 4xx/5xx status.

> The saved-locations list is **shared by everyone who can open the site** (there are no user accounts). If you expose the app publicly, protect it with HTTP basic auth or your own login.

## Data, privacy and external services

- **Server side:** saved locations, cached API responses and the downloaded weather history in `data/wefo.sqlite`. No personal data or cookies.
- **Browser side (`localStorage`, never sent to the server):** `wefo.lang` (language), `wefo.theme` (light/dark), `wefo.disabled` (disabled models), `wefo.weighted` (reliability weighting on/off), `wefo.loc` (last selected location).
- **Requests made by the server:** coordinates of the selected locations go to Open-Meteo, MET Norway, aviationweather.gov (to find the nearest METAR station), (reverse geocoding) Nominatim, and — only if you configured a key — Google (`weather.googleapis.com`).
- **Requests made by the browser:** map tiles (OpenStreetMap), Leaflet (unpkg CDN) and the Inter font (Google Fonts).
- **Terms:** Open-Meteo's free API is for **non-commercial** use with fair-use limits; Nominatim, MET Norway and aviationweather.gov (NOAA) have their own usage policies. Caching in this app keeps usage low, but check the terms before any commercial or high-traffic deployment. The optional Google Weather API is **not free beyond its monthly quota** and is entirely opt-in — see [above](#optional-google-weathernext-3-and-the-wefo-vs-ai-comparison).

## Limitations

- ERA5 is a reanalysis produced with ECMWF's model, so on its own it slightly favours ECMWF; real METAR observations reduce this bias where a station is near, but an airport is a single point that may not represent your exact spot.
- Archived forecasts mostly represent short lead times, so the score reflects short-range skill more than day-5 skill.
- Weather icons for models without a weather code are derived heuristically.
- cURL certificate verification is disabled in `api/db.php` (`CURLOPT_SSL_VERIFYPEER => false`) so it works out of the box on Windows without a CA bundle. On a production server, remove that line (or point cURL at a CA bundle).
- No authentication (see the note above).
- Google WeatherNext 3's `weatherCondition.type` values don't map 1:1 onto the WMO codes used elsewhere in the app (Google's set is more fine-grained, e.g. several rain-intensity steps); the closest bucket is used (see `google_wmo_code()` in `api/google_weather.php`).

## Adding a language

Open `js/i18n.js`, copy the `en` block to a new key (for example `de: { ... }`), translate the values, and add a button `<button data-lang="de">DE</button>` to the `.lang` group in `index.html`. Missing keys automatically fall back to English. Also add the language code to the check in `api/geocode.php` if you want localised place names.

## Troubleshooting

| Symptom | Likely cause / fix |
|---|---|
| *Error 500* when saving a location | `data/` not writable by the web-server user, or `pdo_sqlite` missing. The error message in the app names the cause. |
| *Failed to fetch data from Open-Meteo* | no outbound HTTPS from the server, or the API rate limit was hit – retry later |
| Table looks old after an update | hard refresh (Ctrl+F5); check the `?v=` version in `index.html` |
| Reliability tab empty / "unavailable" | the historical APIs could not be reached; the forecast tabs still work |
| Reliability note says "ERA5 only" | no METAR station with enough recent reports within 60 km – normal for remote locations |
| KNMI / DMI / MET Norway Nordic rows are "greyed out" | they do not cover your location and returned a copy of another model; they are counted once |
| "Google WeatherNext 3" never appears | expected unless you configured `api/config.php` or `WEFO_GOOGLE_WEATHER_API_KEY` with a working, billing-enabled API key (see [above](#optional-google-weathernext-3-and-the-wefo-vs-ai-comparison)); it also disappears silently once the daily call cap or your monthly free quota is reached |
