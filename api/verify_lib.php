<?php
// Model verification — the library behind api/verify.php (the endpoint) and tools/verify-cron.php (the nightly job).
//
// For a location inside Greece: archived forecasts of every model are fetched — each at that
// station's own coordinates, never the visitor's — for every METAR-reporting airport in Greece
// (discovered from aviationweather.gov, not a fixed list), and compared with both the ERA5
// reanalysis and real METAR observations at that same point. All stations' results are pooled into
// one nationwide score per model, cached once and reused for every Greek location, rather than
// redone per visited place. This also avoids the bias a single nearby-but-not-collocated station
// would introduce (a forecast computed for the visitor's point compared against measurements from a
// station tens of km away partly reflects real local weather difference, not model error).
//
// For a location outside Greece: the original per-location approach — archived forecasts at that
// point compared with ERA5 there, and, if a METAR station is nearby, a *separate* archived forecast
// fetched at the station's own coordinates compared with its reports (the same point-matching
// principle, just for one station instead of pooling many).
//
// LEAD TIMES. The Historical Forecast API stitches the first hours of every model run together, so on its
// own it only measures the accuracy a few hours ahead — yet the same weight used to be applied to all 7 days.
// With $leads the Previous Runs API is asked too (forecast issued 1, 2, 3, 5 and 7 days before the hour in
// question), every lead gets its own score and weights, and the app picks the weights that fit each column's
// distance from now. Leads a model does not offer (e.g. Météo-France stops at 3 days) are simply absent for it.
declare(strict_types=1);
require_once __DIR__ . '/db.php';

const VERIFY_TTL = 86400;          // cache: 24 hours; after that it is served as "stale" until the nightly job refreshes it
const VERIFY_KEY = 'vf4';          // cache key prefix of the current result format (vf3 = before lead times)
const WINDOW_DAYS = 28;            // ERA5 comparison window
const LAG_DAYS = 6;                // ERA5 is published with a delay of a few days
const METAR_HOURS = 360;           // how far back to ask for METAR reports (the API caps the number of reports)
const MAX_STATION_KM = 60;         // farthest METAR station that is still considered representative (non-Greek fallback)
const MIN_OBS = 48;                // minimum number of matched hourly observations for a station to count
const OBS_WEIGHT = 0.6;            // share of METAR in the blended skill (rest = ERA5)
// METAR cannot see cloud above ~12,000 ft and only reports the thickest layer, so it is a weaker witness for cloud cover
const OBS_WEIGHT_BY_VAR = ['cloud_cover' => 0.3];
const RAIN_WINDOW_H = 1;           // a METAR "wet" report is matched by a model that has >= 0.1 mm in the same hour +- this many hours
const GREECE_STATIONS_TTL = 7 * 86400;  // the set of reporting stations barely changes; cache it for a week
const GREECE_MAX_STATIONS = 40;    // safety cap on how many stations one verification run fetches
const MIN_GREECE_STATIONS = 3;     // fall back to the single-point method if fewer than this report
const LEADS = [1, 2, 3, 5, 7];     // lead days measured with the Previous Runs API, besides lead 0 (the stitched archive)
const PREV_RUNS_URL = 'https://previous-runs-api.open-meteo.com/v1/forecast';
const SHRINK_N = 300;              // a lead with fewer matched hours than this has its weights pulled towards 1 (n / SHRINK_N)
const LOCAL_NEAR_KM = 40;          // nearest station closer than this: the local weights get their full share (LOCAL_ALPHA) ...
const LOCAL_FAR_KM = 120;          // ... which falls linearly to 0 at this distance
const LOCAL_ALPHA = 0.5;           // w = alpha * w_local + (1 - alpha) * w_national
const LOCAL_K = 4;                 // w_local = mean of the K nearest stations, weighted 1 / distance^2
const LOCK_TTL = 900;              // a background recompute that started less than this ago blocks another one

/* What is verified and how */
function verify_cfg(): array
{
    $catalog = require __DIR__ . '/models.php';
    return [
        'catalog' => $catalog,
        'MODELS' => array_keys(array_filter($catalog, fn($m) => $m['verify'])),
        // cloud_cover_low/mid are what a clear-sky METAR (CAVOK / NSC / SKC) can really be compared with
        'VARS' => ['temperature_2m', 'precipitation', 'wind_speed_10m', 'cloud_cover', 'relative_humidity_2m', 'pressure_msl', 'weather_code', 'cloud_cover_low', 'cloud_cover_mid'],
        // Error at which the skill of a continuous parameter drops to 0
        'TOL' => ['temperature_2m' => 4.0, 'wind_speed_10m' => 15.0, 'cloud_cover' => 50.0, 'relative_humidity_2m' => 25.0, 'pressure_msl' => 4.0],
        // model variable => key inside a truth row
        'KEYS' => ['temperature_2m' => 't', 'wind_speed_10m' => 'w', 'cloud_cover' => 'c', 'relative_humidity_2m' => 'h', 'pressure_msl' => 'p'],
    ];
}

function in_greece(float $lat, float $lon): bool
{
    return $lat >= 34.0 && $lat <= 41.8 && $lon >= 19.0 && $lon <= 29.8;
}

/* ---------------------------------------------------------------- helpers */
function haversine(float $la1, float $lo1, float $la2, float $lo2): float
{
    $r = 6371.0;
    $dLa = deg2rad($la2 - $la1);
    $dLo = deg2rad($lo2 - $lo1);
    $a = sin($dLa / 2) ** 2 + cos(deg2rad($la1)) * cos(deg2rad($la2)) * sin($dLo / 2) ** 2;
    return 2 * $r * asin(min(1.0, sqrt($a)));
}

// Weather category of a WMO code, with drizzle merged into rain (METAR cannot tell them apart reliably)
function cat($c): ?string
{
    if ($c === null) return null;
    $c = (int)$c;
    if ($c <= 1) return 'clear';
    if ($c === 2) return 'partly';
    if ($c === 3) return 'cloudy';
    if ($c === 45 || $c === 48) return 'fog';
    if (($c >= 51 && $c <= 57) || ($c >= 61 && $c <= 67) || ($c >= 80 && $c <= 82)) return 'rain';
    if (($c >= 71 && $c <= 77) || $c === 85 || $c === 86) return 'snow';
    if ($c >= 95) return 'thunder';
    return 'cloudy';
}

// Fetches many URLs concurrently; returns [key => ['body' => string|null, 'status' => int]]
function http_get_multi(array $urls, int $timeout = 60): array
{
    if (!$urls) return [];
    $mh = curl_multi_init();
    $handles = [];
    foreach ($urls as $k => $url) {
        $ch = curl_init($url);
        curl_setopt_array($ch, [
            CURLOPT_RETURNTRANSFER => true, CURLOPT_TIMEOUT => $timeout, CURLOPT_FOLLOWLOCATION => true,
            CURLOPT_USERAGENT => 'wefo-weather-compare/1.0 (personal project)', CURLOPT_ENCODING => '',
            CURLOPT_SSL_VERIFYPEER => ssl_verify(),
        ]);
        curl_multi_add_handle($mh, $ch);
        $handles[$k] = $ch;
    }
    $running = null;
    do { $mrc = curl_multi_exec($mh, $running); } while ($mrc === CURLM_CALL_MULTI_PERFORM);
    while ($running && $mrc === CURLM_OK) {
        if (curl_multi_select($mh) === -1) usleep(10000);
        do { $mrc = curl_multi_exec($mh, $running); } while ($mrc === CURLM_CALL_MULTI_PERFORM);
    }
    $out = [];
    foreach ($handles as $k => $ch) {
        $status = (int)curl_getinfo($ch, CURLINFO_RESPONSE_CODE);
        $body = curl_multi_getcontent($ch);
        $out[$k] = ['body' => ($body !== false && $status === 200) ? $body : null, 'status' => $status];
        curl_multi_remove_handle($mh, $ch);
        curl_close($ch);
    }
    curl_multi_close($mh);
    return $out;
}

// Open-Meteo throttles bursts of many concurrent requests (HTTP 429 — observed with as few as ~20 at
// once). Fetches in small concurrent chunks instead of all at once, and retries only the 429'd ones
// with backoff, rather than firing every station's request in a single burst.
function http_get_throttled(array $urls, int $timeout = 60, int $chunkSize = 4, int $delayMs = 300): array
{
    $out = []; $pending = $urls;
    for ($attempt = 0; $attempt < 4 && $pending; $attempt++) {
        $retry = [];
        foreach (array_chunk($pending, $chunkSize, true) as $chunk) {
            foreach (http_get_multi($chunk, $timeout) as $k => $r) {
                if ($r['status'] === 200) $out[$k] = $r['body']; else $retry[$k] = $urls[$k];
            }
            usleep($delayMs * 1000);
        }
        $pending = $retry;
        if ($pending) usleep($delayMs * 3 * 1000);
    }
    foreach ($pending as $k => $u) $out[$k] = null;   // gave up after retries — caller treats like any other fetch failure
    return $out;
}

// Nearest METAR station that reported recently (non-Greek fallback only)
function find_station(float $lat, float $lon): ?array
{
    foreach ([1.0, 2.5] as $d) {
        $bbox = sprintf('%.3f,%.3f,%.3f,%.3f', $lat - $d, $lon - $d, $lat + $d, $lon + $d);
        $body = http_get('https://aviationweather.gov/api/data/metar?format=json&hours=6&bbox=' . $bbox, 25);
        $list = $body ? json_decode($body, true) : null;
        if (!is_array($list) || !$list) continue;
        $best = null;
        foreach ($list as $o) {
            if (!isset($o['icaoId'], $o['lat'], $o['lon'])) continue;
            $km = haversine($lat, $lon, (float)$o['lat'], (float)$o['lon']);
            if ($best === null || $km < $best['km']) {
                $best = ['id' => $o['icaoId'], 'name' => $o['name'] ?? $o['icaoId'], 'lat' => (float)$o['lat'], 'lon' => (float)$o['lon'], 'km' => $km, 'elev' => $o['elev'] ?? null];
            }
        }
        if ($best && $best['km'] <= MAX_STATION_KM) return $best;
    }
    return null;
}

// Every Greek airport that has reported METAR recently, discovered (not hardcoded) via a bounding-box
// query, so the list tracks reality (stations going offline/online) without needing maintenance.
function greece_stations(PDO $pdo): array
{
    $key = 'vf3:greece:stations';
    $st = $pdo->prepare('SELECT body, fetched_at FROM cache WHERE k = ?');
    $st->execute([$key]);
    if (($row = fetch_one($st)) && time() - (int)$row['fetched_at'] < GREECE_STATIONS_TTL) {
        return json_decode($row['body'], true) ?: [];
    }
    $body = http_get('https://aviationweather.gov/api/data/metar?format=json&hours=6&bbox=34.0,19.0,41.8,29.8', 30);
    $list = $body ? json_decode($body, true) : null;
    $stations = []; $seen = [];
    if (is_array($list)) {
        foreach ($list as $o) {
            if (!isset($o['icaoId'], $o['lat'], $o['lon']) || isset($seen[$o['icaoId']])) continue;
            if (!str_starts_with($o['icaoId'], 'LG')) continue;   // the bbox also catches Turkey/Albania/N. Macedonia airports; Greek ICAO codes all start "LG"
            $seen[$o['icaoId']] = true;
            $stations[] = ['id' => $o['icaoId'], 'name' => $o['name'] ?? $o['icaoId'], 'lat' => (float)$o['lat'], 'lon' => (float)$o['lon'], 'elev' => $o['elev'] ?? null];
            if (count($stations) >= GREECE_MAX_STATIONS) break;
        }
    }
    $pdo->prepare('INSERT OR REPLACE INTO cache (k, body, fetched_at) VALUES (?, ?, ?)')->execute([$key, json_encode($stations), time()]);
    return $stations;
}

// Hourly observations (UTC hour key => values) from already-fetched METAR reports for one station
function metar_hourly_from(array $list): array
{
    $cloudPct = ['CLR' => 0, 'SKC' => 0, 'NCD' => 0, 'NSC' => 0, 'CAVOK' => 0, 'FEW' => 19, 'SCT' => 44, 'BKN' => 81, 'OVC' => 100, 'VV' => 100];
    $best = [];
    foreach ($list as $o) {
        if (!isset($o['obsTime'])) continue;
        $ts = (int)$o['obsTime'];
        $hour = (int)(round($ts / 3600) * 3600);
        $dt = abs($ts - $hour);
        if ($dt > 1800) continue;
        $hk = gmdate('Y-m-d\TH:00', $hour);
        if (isset($best[$hk]) && $best[$hk]['dt'] <= $dt) continue;

        $temp = isset($o['temp']) ? (float)$o['temp'] : null;
        $dew = isset($o['dewp']) ? (float)$o['dewp'] : null;
        $rh = null;
        if ($temp !== null && $dew !== null) {
            $rh = 100 * exp(17.625 * $dew / (243.04 + $dew)) / exp(17.625 * $temp / (243.04 + $temp));
            $rh = max(0.0, min(100.0, $rh));
        }
        $cover = $o['cover'] ?? null;
        $cloud = null;
        if (isset($o['clouds']) && is_array($o['clouds'])) {
            $cloud = 0;
            foreach ($o['clouds'] as $l) $cloud = max($cloud, $cloudPct[$l['cover'] ?? ''] ?? 0);
        } elseif ($cover !== null && isset($cloudPct[$cover])) {
            $cloud = $cloudPct[$cover];
        }
        $wx = strtoupper((string)($o['wxString'] ?? ''));
        $wet = (bool)preg_match('/(RA|DZ|SN|SG|PL|GR|GS|SH|TS|UP)/', $wx);
        if (str_contains($wx, 'TS')) $c = 'thunder';
        elseif (preg_match('/(SN|SG|PL|GS)/', $wx)) $c = 'snow';
        elseif ($wet) $c = 'rain';
        elseif (str_contains($wx, 'FG') && !str_contains($wx, 'BR')) $c = 'fog';
        elseif ($cloud !== null) $c = $cloud <= 25 ? 'clear' : ($cloud <= 70 ? 'partly' : 'cloudy');
        else $c = null;

        // CAVOK / NSC / SKC / CLR / NCD: "no cloud that matters" — not "0 % cloud" (there may be high cloud the METAR does not
        // report), so such a report is compared with the model's low + mid cloud instead of its total (see evaluate)
        $clear = $cloud === 0;
        $best[$hk] = [
            'clr' => $clear, 'vc' => (bool)preg_match('/VC(SH|TS)/', $wx),   // vc: showers / thunder in the vicinity: a model's rain is not a false alarm then
            'dt' => $dt, 't' => $temp, 'w' => isset($o['wspd']) ? (float)$o['wspd'] * 1.852 : null, 'c' => $clear ? null : $cloud, 'h' => $rh,
            'p' => isset($o['slp']) ? (float)$o['slp'] : (isset($o['altim']) ? (float)$o['altim'] : null), 'wet' => $wet, 'cat' => $c,
        ];
    }
    return $best;
}
function metar_hourly(string $icao): array
{
    $body = http_get('https://aviationweather.gov/api/data/metar?format=json&hours=' . METAR_HOURS . '&ids=' . rawurlencode($icao), 40);
    $list = $body ? json_decode($body, true) : null;
    return is_array($list) ? metar_hourly_from($list) : [];
}

/* Compares one model against one or more {fc, rows} groups — a single location's data (fallback
   path) or one entry per Greek station (pooled nationwide). Each group's `rows[].j` indexes into
   that *same* group's own `fc`, since every station has its own archived-forecast fetch. */
function evaluate(array $groups, string $m, array $KEYS): array
{
    $s = ['mae' => [], 'bias' => [], 'n' => 0];
    foreach ($KEYS as $var => $k) {
        $sum = 0.0; $bias = 0.0; $cnt = 0;
        foreach ($groups as $g) {
            $a = $g['fc']['hourly']["{$var}_{$m}"] ?? null;
            if (!$a) continue;
            foreach ($g['rows'] as $r) {
                if ($var === 'cloud_cover' && !empty($r['clr'])) {   // clear-sky METAR: truth = "no low/mid cloud"
                    $lo = $g['fc']['hourly']["cloud_cover_low_{$m}"][$r['j']] ?? null; $mi = $g['fc']['hourly']["cloud_cover_mid_{$m}"][$r['j']] ?? null;
                    if ($lo === null || $mi === null) continue;
                    $d = min(100.0, $lo + $mi);
                    $sum += $d; $bias += $d; $cnt++;
                    continue;
                }
                if (!isset($a[$r['j']]) || $r[$k] === null) continue;
                $d = $a[$r['j']] - $r[$k];
                $sum += abs($d); $bias += $d; $cnt++;
            }
        }
        if ($cnt >= 24) { $s['mae'][$var] = $sum / $cnt; $s['bias'][$var] = $bias / $cnt; $s['n'] = max($s['n'], $cnt); }
    }
    // Rain: critical success index over wet hours (model >= 0.1 mm), pooled across groups
    $hit = $miss = $fa = 0;
    foreach ($groups as $g) {
        $p = $g['fc']['hourly']["precipitation_{$m}"] ?? null;
        if (!$p) continue;
        foreach ($g['rows'] as $r) {
            if (!isset($p[$r['j']]) || $r['wet'] === null) continue;
            $f = $p[$r['j']] >= 0.1;
            if (!empty($g['obs']) && $r['wet'] && !$f) {   // a METAR report is an instant, the model gives hourly totals: look at the neighbouring hours too
                for ($dj = -RAIN_WINDOW_H; $dj <= RAIN_WINDOW_H && !$f; $dj++) $f = ($p[$r['j'] + $dj] ?? 0) >= 0.1;
            }
            if ($r['wet'] && $f) $hit++; elseif ($r['wet']) $miss++; elseif ($f && empty($r['vc'])) $fa++;   // VCSH / VCTS reported: no false alarm
        }
    }
    if ($hit + $miss + $fa > 0) { $s['csi'] = $hit / ($hit + $miss + $fa); $s['rain_events'] = $hit + $miss; }
    // Weather category agreement, pooled across groups
    $ok = $tot = 0;
    foreach ($groups as $g) {
        $c = $g['fc']['hourly']["weather_code_{$m}"] ?? null;
        if (!$c) continue;
        foreach ($g['rows'] as $r) {
            if (!isset($c[$r['j']]) || $r['cat'] === null) continue;
            $tot++;
            if (cat($c[$r['j']]) === $r['cat']) $ok++;
        }
    }
    if ($tot >= 24) $s['code_acc'] = $ok / $tot;
    return $s;
}

/* Skill 0..1 per parameter from evaluate() output */
function skills(array $s, array $TOL, int $minRain): array
{
    $sk = [];
    foreach ($TOL as $v => $tol) if (isset($s['mae'][$v])) $sk[$v] = max(0.0, 1 - $s['mae'][$v] / $tol);
    if (isset($s['csi']) && ($s['rain_events'] ?? 0) >= $minRain) $sk['precip'] = $s['csi'];
    if (isset($s['code_acc'])) $sk['code'] = $s['code_acc'];
    return $sk;
}

// Weights (mean = 1, limited to [0.5, 1.8] so that no model dominates)
function norm_weights(array $vals): array
{
    if (!$vals) return [];
    $raw = array_map(fn($x) => $x + 0.15, $vals);
    $mean = array_sum($raw) / count($raw);
    return array_map(fn($x) => round(min(1.8, max(0.5, $x / $mean)), 3), $raw);
}

/* Builds the { score, mae, bias, csi, code_acc, obs, weights } block for every model from pooled
   era/obs groups (one location = one group each; Greece-wide = one group per station). Per (model,
   station) pairs the archive sometimes just echoes ERA5 back (a model with no real coverage there) —
   detected and excluded per group before pooling, so one uncovered station can't fake a perfect score. */
function score_models(array $cfg, array $eraGroupsByStation, array $obsGroupsByStation): array
{
    $KEYS = $cfg['KEYS']; $TOL = $cfg['TOL'];
    $out = []; $blend = [];
    foreach ($cfg['MODELS'] as $m) {
        $eraGroups = [];
        foreach ($eraGroupsByStation as $g) {
            $single = evaluate([$g], $m, $KEYS);
            if ($single['mae'] && array_sum($single['mae']) >= 0.001) $eraGroups[] = $g;
        }
        if (!$eraGroups) continue;
        $era = evaluate($eraGroups, $m, $KEYS);
        $obs = $obsGroupsByStation ? evaluate($obsGroupsByStation, $m, $KEYS) : null;
        if ($obs && !$obs['mae'] && !isset($obs['csi']) && !isset($obs['code_acc'])) $obs = null;

        $skE = skills($era, $TOL, 15);
        $skO = $obs ? skills($obs, $TOL, 6) : [];
        $sk = [];
        foreach (array_unique(array_merge(array_keys($skE), array_keys($skO))) as $v) {
            if (isset($skE[$v], $skO[$v])) { $ow = OBS_WEIGHT_BY_VAR[$v] ?? OBS_WEIGHT; $sk[$v] = $ow * $skO[$v] + (1 - $ow) * $skE[$v]; }
            else $sk[$v] = $skO[$v] ?? $skE[$v];
        }
        $blend[$m] = $sk;
        $out[$m] = [
            'name' => $cfg['catalog'][$m]['name'] ?? $m,
            'score' => $sk ? (int)round(array_sum($sk) / count($sk) * 100) : null,
            'n' => $era['n'],
            'mae' => array_map(fn($x) => round($x, 2), $era['mae']),
            'bias' => array_map(fn($x) => round($x, 2), $era['bias']),
            'csi' => isset($era['csi']) ? round($era['csi'], 3) : null,
            'code_acc' => isset($era['code_acc']) ? round($era['code_acc'], 3) : null,
            'obs' => $obs ? [
                'mae' => array_map(fn($x) => round($x, 2), $obs['mae']),
                'bias' => array_map(fn($x) => round($x, 2), $obs['bias']),
                'csi' => isset($obs['csi']) ? round($obs['csi'], 3) : null,
                'code_acc' => isset($obs['code_acc']) ? round($obs['code_acc'], 3) : null,
            ] : null,
        ];
    }
    $byParam = [];
    foreach ($blend as $m => $ps) foreach ($ps as $v => $x) $byParam[$v][$m] = $x;
    $W = [];
    foreach ($byParam as $v => $vals) foreach (norm_weights($vals) as $m => $w) $W[$m][$v] = $w;
    foreach ($out as $m => &$o) {
        $w = $W[$m] ?? [];
        $o['weights'] = [
            'weather' => $w['code'] ?? null, 'temperature_2m' => $w['temperature_2m'] ?? null, 'precip' => $w['precip'] ?? null,
            'wind' => $w['wind_speed_10m'] ?? null, 'storm' => $w['code'] ?? null, 'cloud_cover' => $w['cloud_cover'] ?? null,
            'relative_humidity_2m' => $w['relative_humidity_2m'] ?? null, 'pressure_msl' => $w['pressure_msl'] ?? null,
        ];
    }
    unset($o);
    return $out;
}

// ?elevation= for Open-Meteo (metres above sea level): the model temperature is corrected from the grid height to this one
function elev_param($elev): array
{
    return is_numeric($elev) ? ['elevation' => (float)$elev] : [];
}

/* ---------------------------------------------------------------- lead times */
// The Previous Runs response of one place, seen as if it were an ordinary archive of the forecasts issued $d days
// earlier: "temperature_2m_previous_day3_gfs_seamless" becomes "temperature_2m_gfs_seamless", so evaluate() needs no changes.
// null when the response does not line up hour by hour with the stitched archive that the truth rows index into.
function lead_view(?array $prev, array $fc, int $d): ?array
{
    if (!$prev || ($prev['hourly']['time'] ?? null) !== $fc['hourly']['time']) return null;
    $out = ['hourly' => ['time' => $fc['hourly']['time']]];
    foreach ($prev['hourly'] as $k => $arr) {
        if ($k !== 'time' && preg_match('/^(.+?)_previous_day' . $d . '_(.+)$/', $k, $m)) $out['hourly'][$m[1] . '_' . $m[2]] = $arr;
    }
    return count($out['hourly']) > 1 ? $out : null;
}
// Groups ({fc, rows, prev}) re-pointed at the forecasts issued $d days ahead; groups without usable data for that lead are dropped
function lead_groups(array $groups, int $d): array
{
    $out = [];
    foreach ($groups as $g) {
        $v = lead_view($g['prev'] ?? null, $g['fc'], $d);
        if ($v) $out[] = ['fc' => $v, 'rows' => $g['rows']] + (isset($g['obs']) ? ['obs' => true] : []);
    }
    return $out;
}
// Previous Runs URL for one place: every verified variable at every measured lead (the un-suffixed name is lead 0 and is not needed)
function prev_runs_url(array $cfg, array $q, string $start, string $fcEnd): string
{
    $names = [];
    foreach ($cfg['VARS'] as $v) foreach (LEADS as $d) $names[] = "{$v}_previous_day{$d}";
    return PREV_RUNS_URL . '?' . http_build_query($q + ['hourly' => implode(',', $names), 'start_date' => $start, 'end_date' => $fcEnd, 'models' => implode(',', $cfg['MODELS'])]);
}
/* Scores every lead and adds the result to the lead-0 block:
     models[m].by_lead = { "<d>": { score, n } }       (lead 0 included)
     weights_by_lead   = { "<d>": { "<model>": { weight per parameter } } }
   A lead's weights are pulled towards 1 when it rests on few matched hours (n / SHRINK_N). */
function add_leads(array $cfg, array $result0, array $eraGroups, array $obsGroups, bool $leads): array
{
    $models = $result0;
    $wbl = ['0' => []];
    foreach ($models as $m => $o) {
        $wbl['0'][$m] = $o['weights'];
        $models[$m]['by_lead'] = ['0' => ['score' => $o['score'], 'n' => $o['n']]];
    }
    if ($leads) {
        foreach (LEADS as $d) {
            $eg = lead_groups($eraGroups, $d);
            if (!$eg) continue;
            $sc = score_models($cfg, $eg, lead_groups($obsGroups, $d));
            foreach ($sc as $m => $o) {
                if (!isset($models[$m])) continue;   // never scored at lead 0: not listed at all
                $f = min(1.0, $o['n'] / SHRINK_N);
                $wbl[(string)$d][$m] = array_map(fn($w) => $w === null ? null : round(1 + ($w - 1) * $f, 3), $o['weights']);
                $models[$m]['by_lead'][(string)$d] = ['score' => $o['score'], 'n' => $o['n']];
            }
        }
    }
    return [$models, $wbl];
}

/* ---------------------------------------------------------------- Greece-wide ---------------------------------------------------------------- */
function compute_greece(PDO $pdo, array $cfg, string $start, string $fcEnd, string $eraEnd, bool $leads): ?array
{
    $stations = greece_stations($pdo);
    if (count($stations) < MIN_GREECE_STATIONS) return null;   // station discovery had a bad day — caller falls back

    $base = ['hourly' => implode(',', $cfg['VARS']), 'timezone' => 'UTC'];
    $fcUrls = []; $eraUrls = []; $metarUrls = []; $prevUrls = [];
    foreach ($stations as $i => $stn) {
        $q = $base + ['latitude' => $stn['lat'], 'longitude' => $stn['lon']] + elev_param($stn['elev'] ?? null);   // the station's own height, so Open-Meteo corrects temperature to it
        $fcUrls[$i] = 'https://historical-forecast-api.open-meteo.com/v1/forecast?' . http_build_query($q + ['start_date' => $start, 'end_date' => $fcEnd, 'models' => implode(',', $cfg['MODELS'])]);
        $eraUrls[$i] = 'https://archive-api.open-meteo.com/v1/archive?' . http_build_query($q + ['start_date' => $start, 'end_date' => $eraEnd]);
        $metarUrls[$i] = 'https://aviationweather.gov/api/data/metar?format=json&hours=' . METAR_HOURS . '&ids=' . rawurlencode($stn['id']);
        if ($leads) $prevUrls[$i] = prev_runs_url($cfg, ['latitude' => $stn['lat'], 'longitude' => $stn['lon'], 'timezone' => 'UTC'] + elev_param($stn['elev'] ?? null), $start, $fcEnd);
    }
    $fcBodies = http_get_throttled($fcUrls, 90);
    $eraBodies = http_get_throttled($eraUrls, 60);
    $metarBodies = http_get_throttled($metarUrls, 40);
    $prevBodies = $leads ? http_get_throttled($prevUrls, 120, 2, 500) : [];   // big responses: smaller chunks

    $eraGroups = []; $obsGroups = []; $used = []; $totalEraRows = 0; $perStation = [];
    foreach ($stations as $i => $stn) {
        $fc = $fcBodies[$i] ? json_decode($fcBodies[$i], true) : null;
        if (!$fc || !isset($fc['hourly']['time'])) continue;
        $fIdx = array_flip($fc['hourly']['time']);
        $prev = ($leads && !empty($prevBodies[$i])) ? json_decode($prevBodies[$i], true) : null;

        $eraRows = [];
        $truth = $eraBodies[$i] ? json_decode($eraBodies[$i], true) : null;
        if ($truth && isset($truth['hourly']['time'])) {
            $T = $truth['hourly'];
            foreach ($T['time'] as $j => $tm) {
                if (!isset($fIdx[$tm])) continue;
                $eraRows[] = [
                    'j' => $fIdx[$tm], 't' => $T['temperature_2m'][$j] ?? null, 'w' => $T['wind_speed_10m'][$j] ?? null,
                    'c' => $T['cloud_cover'][$j] ?? null, 'h' => $T['relative_humidity_2m'][$j] ?? null, 'p' => $T['pressure_msl'][$j] ?? null,
                    'wet' => isset($T['precipitation'][$j]) ? $T['precipitation'][$j] >= 0.1 : null, 'cat' => cat($T['weather_code'][$j] ?? null),
                ];
            }
        }
        $eg = null; $og = null;
        if ($eraRows) { $eraGroups[] = $eg = ['fc' => $fc, 'rows' => $eraRows, 'prev' => $prev]; $totalEraRows += count($eraRows); }

        $metarList = $metarBodies[$i] ? json_decode($metarBodies[$i], true) : null;
        $hourly = is_array($metarList) ? metar_hourly_from($metarList) : [];
        $obsRows = [];
        foreach ($hourly as $hk => $o) { if (isset($fIdx[$hk])) $obsRows[] = ['j' => $fIdx[$hk]] + $o; }
        if (count($obsRows) >= MIN_OBS) { $obsGroups[] = $og = ['fc' => $fc, 'rows' => $obsRows, 'prev' => $prev, 'obs' => true]; $used[] = $stn['name']; }
        if ($eg) $perStation[] = [$stn, $eg, $og];
    }
    if (!$eraGroups) return null;

    [$models, $wbl] = add_leads($cfg, score_models($cfg, $eraGroups, $obsGroups), $eraGroups, $obsGroups, $leads);
    // each station on its own (lead 0): the nationwide weights can then be tilted towards the stations near the visitor (local_blend)
    $stationsOut = [];
    foreach ($perStation as [$stn, $eg, $og]) {
        $w = [];
        foreach (score_models($cfg, [$eg], $og ? [$og] : []) as $m => $o) $w[$m] = $o['weights'];
        if ($w) $stationsOut[] = ['id' => $stn['id'], 'name' => $stn['name'], 'lat' => $stn['lat'], 'lon' => $stn['lon'], 'elev' => $stn['elev'] ?? null, 'weights' => $w];
    }
    return [
        'stations' => $stationsOut,
        'start' => $start, 'end' => $eraEnd, 'hours' => $totalEraRows,
        'station' => null, 'obs_weight' => $obsGroups ? OBS_WEIGHT : 0,
        'greece' => ['stations' => count($obsGroups), 'names' => $used],
        'leads' => array_map('intval', array_keys($wbl)),
        'models' => $models, 'weights_by_lead' => $wbl,
    ];
}

/* ---------------------------------------------------------------- single location (non-Greek) ---------------------------------------------------------------- */
function compute_point(float $lat, float $lon, array $cfg, string $start, string $fcEnd, string $eraEnd, bool $leads): array
{
    $base = ['hourly' => implode(',', $cfg['VARS']), 'timezone' => 'UTC'];
    $q = $base + ['latitude' => $lat, 'longitude' => $lon];
    $fcBody = http_get('https://historical-forecast-api.open-meteo.com/v1/forecast?' . http_build_query($q + ['start_date' => $start, 'end_date' => $fcEnd, 'models' => implode(',', $cfg['MODELS'])]), 60);
    $truthBody = http_get('https://archive-api.open-meteo.com/v1/archive?' . http_build_query($q + ['start_date' => $start, 'end_date' => $eraEnd]), 40);
    $fc = $fcBody ? json_decode($fcBody, true) : null;
    $truth = $truthBody ? json_decode($truthBody, true) : null;
    if (!$fc || !isset($fc['hourly']['time'])) json_out(['error' => 'Could not fetch historical data for verification'], 502);
    $fIdx = array_flip($fc['hourly']['time']);
    $prev = null;
    if ($leads) { $pb = http_get(prev_runs_url($cfg, ['latitude' => $lat, 'longitude' => $lon, 'timezone' => 'UTC'], $start, $fcEnd), 120); $prev = $pb ? json_decode($pb, true) : null; }

    $eraRows = [];
    if ($truth && isset($truth['hourly']['time'])) {
        $T = $truth['hourly'];
        foreach ($T['time'] as $i => $tm) {
            if (!isset($fIdx[$tm])) continue;
            $eraRows[] = [
                'j' => $fIdx[$tm], 't' => $T['temperature_2m'][$i] ?? null, 'w' => $T['wind_speed_10m'][$i] ?? null, 'c' => $T['cloud_cover'][$i] ?? null,
                'h' => $T['relative_humidity_2m'][$i] ?? null, 'p' => $T['pressure_msl'][$i] ?? null,
                'wet' => isset($T['precipitation'][$i]) ? $T['precipitation'][$i] >= 0.1 : null, 'cat' => cat($T['weather_code'][$i] ?? null),
            ];
        }
    }

    // METAR: a *separate* archived forecast, fetched at the station's own coordinates — not the
    // visitor's — so the comparison isn't biased by real weather differences between the two points.
    $station = find_station($lat, $lon);
    $obsRows = []; $stationInfo = null; $obsFc = null; $sPrev = null;
    if ($station) {
        $sFcBody = http_get('https://historical-forecast-api.open-meteo.com/v1/forecast?' . http_build_query($base + ['latitude' => $station['lat'], 'longitude' => $station['lon']] + elev_param($station['elev']) + ['start_date' => $start, 'end_date' => $fcEnd, 'models' => implode(',', $cfg['MODELS'])]), 60);
        $sFc = $sFcBody ? json_decode($sFcBody, true) : null;
        if ($sFc && isset($sFc['hourly']['time'])) {
            $sIdx = array_flip($sFc['hourly']['time']);
            $hourly = metar_hourly($station['id']);
            foreach ($hourly as $hk => $o) { if (isset($sIdx[$hk])) $obsRows[] = ['j' => $sIdx[$hk]] + $o; }
            if (count($obsRows) >= MIN_OBS) {
                $times = array_keys($hourly); sort($times);
                $stationInfo = ['id' => $station['id'], 'name' => $station['name'], 'km' => round($station['km'], 1), 'elev' => $station['elev'],
                    'reports' => count($obsRows), 'start' => substr($times[0], 0, 10), 'end' => substr(end($times), 0, 10)];
            } else { $obsRows = []; }
        }
        $obsFc = $sFc;
        if ($leads && $obsRows) { $pb = http_get(prev_runs_url($cfg, ['latitude' => $station['lat'], 'longitude' => $station['lon'], 'timezone' => 'UTC'] + elev_param($station['elev']), $start, $fcEnd), 120); $sPrev = $pb ? json_decode($pb, true) : null; }
    }

    $eraGroups = $eraRows ? [['fc' => $fc, 'rows' => $eraRows, 'prev' => $prev]] : [];
    $obsGroups = $obsRows ? [['fc' => $obsFc, 'rows' => $obsRows, 'prev' => $sPrev, 'obs' => true]] : [];
    [$models, $wbl] = add_leads($cfg, score_models($cfg, $eraGroups, $obsGroups), $eraGroups, $obsGroups, $leads);
    return [
        'start' => $start, 'end' => $eraEnd, 'hours' => count($eraRows),
        'station' => $stationInfo, 'obs_weight' => $stationInfo ? OBS_WEIGHT : 0,
        'greece' => null,
        'leads' => array_map('intval', array_keys($wbl)),
        'models' => $models, 'weights_by_lead' => $wbl,
    ];
}

/* ---------------------------------------------------------------- local weights */
/* The Greece-wide weights are an average over the whole country. For a visitor, tilt them towards the nearest
   stations: w = alpha * w_local + (1 - alpha) * w_national, with w_local the mean over the LOCAL_K nearest stations
   weighted 1 / distance^2, and alpha = LOCAL_ALPHA when the nearest station is closer than LOCAL_NEAR_KM, falling
   linearly to 0 at LOCAL_FAR_KM. Returned as `local` ({alpha, stations, weights}); the browser applies it (js/app.js leadWeight)
   to every lead as an adjustment alpha * (w_local - w_national at lead 0). */
function local_blend(array $res, float $lat, float $lon): ?array
{
    $st = $res['stations'] ?? null;
    if (!$st) return null;
    foreach ($st as &$s) $s['km'] = haversine($lat, $lon, (float)$s['lat'], (float)$s['lon']);
    unset($s);
    usort($st, fn($a, $b) => $a['km'] <=> $b['km']);
    $near = $st[0]['km'];
    $alpha = $near < LOCAL_NEAR_KM ? LOCAL_ALPHA : ($near >= LOCAL_FAR_KM ? 0.0 : LOCAL_ALPHA * (LOCAL_FAR_KM - $near) / (LOCAL_FAR_KM - LOCAL_NEAR_KM));
    $use = array_values(array_filter(array_slice($st, 0, LOCAL_K), fn($s) => $s['km'] <= LOCAL_FAR_KM));   // a station farther than this says nothing about this place
    if (!$use) return ['alpha' => 0.0, 'stations' => [], 'weights' => []];
    $num = []; $den = [];
    foreach ($use as $s) {
        $k = 1 / max(5.0, $s['km']) ** 2;
        foreach ($s['weights'] as $m => $ws) foreach ($ws as $p => $w) {
            if ($w === null) continue;
            $num[$m][$p] = ($num[$m][$p] ?? 0) + $k * $w; $den[$m][$p] = ($den[$m][$p] ?? 0) + $k;
        }
    }
    $weights = [];
    foreach ($num as $m => $ps) foreach ($ps as $p => $x) $weights[$m][$p] = round($x / $den[$m][$p], 3);
    return ['alpha' => round($alpha, 3), 'stations' => array_map(fn($s) => ['id' => $s['id'], 'name' => $s['name'], 'km' => round($s['km'])], $use), 'weights' => $weights];
}
// What api/verify.php sends: the cached result without the bulky per-station block, plus the `local` blend for this location
function verify_present(array $body, float $lat, float $lon): array
{
    if (!empty($body['stations'])) $body['local'] = local_blend($body, $lat, $lon);
    unset($body['stations']);
    return $body;
}

/* ---------------------------------------------------------------- entry points */
function verify_window(): array
{
    return [gmdate('Y-m-d', time() - (LAG_DAYS + WINDOW_DAYS) * 86400), gmdate('Y-m-d', time() - 86400), gmdate('Y-m-d', time() - LAG_DAYS * 86400)];   // start, fcEnd, eraEnd
}
// Full computation for a location (Greece-wide pool if it is in Greece, else the point itself); null never — falls back to the point.
function verify_compute(PDO $pdo, float $lat, float $lon, bool $leads): array
{
    $cfg = verify_cfg();
    [$start, $fcEnd, $eraEnd] = verify_window();
    $result = in_greece($lat, $lon) ? compute_greece($pdo, $cfg, $start, $fcEnd, $eraEnd, $leads) : null;
    if ($result === null) $result = compute_point($lat, $lon, $cfg, $start, $fcEnd, $eraEnd, $leads);
    $result['computed_at'] = gmdate('c');
    $result['method'] = $result['greece'] ? 'greece' : 'point';
    return $result;
}
function verify_cache_key(float $lat, float $lon): string
{
    return in_greece($lat, $lon) ? VERIFY_KEY . ':greece' : sprintf('%s:%s:%s', VERIFY_KEY, $lat, $lon);
}
function verify_store(PDO $pdo, string $key, array $result): string
{
    $body = json_encode($result, JSON_UNESCAPED_UNICODE);
    $pdo->prepare('INSERT OR REPLACE INTO cache (k, body, fetched_at) VALUES (?, ?, ?)')->execute([$key, $body, time()]);
    return $body;
}
