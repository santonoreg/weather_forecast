<?php
// Model verification.
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
declare(strict_types=1);
require __DIR__ . '/db.php';

const VERIFY_TTL = 86400;          // cache: 24 hours
const WINDOW_DAYS = 28;            // ERA5 comparison window
const LAG_DAYS = 6;                // ERA5 is published with a delay of a few days
const METAR_HOURS = 360;           // how far back to ask for METAR reports (the API caps the number of reports)
const MAX_STATION_KM = 60;         // farthest METAR station that is still considered representative (non-Greek fallback)
const MIN_OBS = 48;                // minimum number of matched hourly observations for a station to count
const OBS_WEIGHT = 0.6;            // share of METAR in the blended skill (rest = ERA5)
const GREECE_STATIONS_TTL = 7 * 86400;  // the set of reporting stations barely changes; cache it for a week
const GREECE_MAX_STATIONS = 40;    // safety cap on how many stations one verification run fetches
const MIN_GREECE_STATIONS = 3;     // fall back to the single-point method if fewer than this report

$MODELS = ['ecmwf_aifs025_single', 'ecmwf_ifs025', 'gfs_seamless', 'icon_seamless', 'gem_seamless', 'meteofrance_seamless', 'ukmo_seamless',
           'jma_seamless', 'cma_grapes_global', 'knmi_seamless', 'dmi_seamless', 'metno_seamless'];
$VARS = ['temperature_2m', 'precipitation', 'wind_speed_10m', 'cloud_cover', 'relative_humidity_2m', 'pressure_msl', 'weather_code'];
// Error at which the skill of a continuous parameter drops to 0
$TOL = ['temperature_2m' => 4.0, 'wind_speed_10m' => 15.0, 'cloud_cover' => 50.0, 'relative_humidity_2m' => 25.0, 'pressure_msl' => 4.0];
// model variable => key inside a truth row
$KEYS = ['temperature_2m' => 't', 'wind_speed_10m' => 'w', 'cloud_cover' => 'c', 'relative_humidity_2m' => 'h', 'pressure_msl' => 'p'];

$lat = filter_var($_GET['lat'] ?? null, FILTER_VALIDATE_FLOAT);
$lon = filter_var($_GET['lon'] ?? null, FILTER_VALIDATE_FLOAT);
if ($lat === false || $lon === false || abs($lat) > 90 || abs($lon) > 180) json_out(['error' => 'Invalid coordinates'], 400);
$lat = round($lat, 2);
$lon = round($lon, 2);

function in_greece(float $lat, float $lon): bool
{
    return $lat >= 34.0 && $lat <= 41.8 && $lon >= 19.0 && $lon <= 29.8;
}

$pdo = db();
$greece = in_greece($lat, $lon);
$key = $greece ? 'vf3:greece' : "vf3:$lat:$lon";
$st = $pdo->prepare('SELECT body, fetched_at FROM cache WHERE k = ?');
$st->execute([$key]);
if (($row = $st->fetch()) && time() - (int)$row['fetched_at'] < VERIFY_TTL) {
    header('Content-Type: application/json; charset=utf-8');
    echo $row['body'];
    exit;
}
set_time_limit(280);   // the Greece-wide pass fetches dozens of stations; only the first request of the day pays for it

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
            CURLOPT_SSL_VERIFYPEER => false,
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
    if (($row = $st->fetch()) && time() - (int)$row['fetched_at'] < GREECE_STATIONS_TTL) {
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

        $best[$hk] = [
            'dt' => $dt, 't' => $temp, 'w' => isset($o['wspd']) ? (float)$o['wspd'] * 1.852 : null, 'c' => $cloud, 'h' => $rh,
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
            if ($r['wet'] && $f) $hit++; elseif ($r['wet']) $miss++; elseif ($f) $fa++;
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
function score_models(array $MODELS, array $KEYS, array $TOL, array $eraGroupsByStation, array $obsGroupsByStation): array
{
    $out = []; $blend = [];
    foreach ($MODELS as $m) {
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
            if (isset($skE[$v], $skO[$v])) $sk[$v] = OBS_WEIGHT * $skO[$v] + (1 - OBS_WEIGHT) * $skE[$v];
            else $sk[$v] = $skO[$v] ?? $skE[$v];
        }
        $blend[$m] = $sk;
        $out[$m] = [
            'score' => $sk ? (int)round(array_sum($sk) / count($sk) * 100) : null,
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

$fcEnd = gmdate('Y-m-d', time() - 86400);
$eraEnd = gmdate('Y-m-d', time() - LAG_DAYS * 86400);
$start = gmdate('Y-m-d', time() - (LAG_DAYS + WINDOW_DAYS) * 86400);

/* ---------------------------------------------------------------- Greece-wide ---------------------------------------------------------------- */
function compute_greece(PDO $pdo, array $MODELS, array $VARS, array $KEYS, array $TOL, string $start, string $fcEnd, string $eraEnd): ?array
{
    $stations = greece_stations($pdo);
    if (count($stations) < MIN_GREECE_STATIONS) return null;   // station discovery had a bad day — caller falls back

    $base = ['hourly' => implode(',', $VARS), 'timezone' => 'UTC'];
    $fcUrls = []; $eraUrls = []; $metarUrls = [];
    foreach ($stations as $i => $stn) {
        $q = $base + ['latitude' => $stn['lat'], 'longitude' => $stn['lon']];
        $fcUrls[$i] = 'https://historical-forecast-api.open-meteo.com/v1/forecast?' . http_build_query($q + ['start_date' => $start, 'end_date' => $fcEnd, 'models' => implode(',', $MODELS)]);
        $eraUrls[$i] = 'https://archive-api.open-meteo.com/v1/archive?' . http_build_query($q + ['start_date' => $start, 'end_date' => $eraEnd]);
        $metarUrls[$i] = 'https://aviationweather.gov/api/data/metar?format=json&hours=' . METAR_HOURS . '&ids=' . rawurlencode($stn['id']);
    }
    $fcBodies = http_get_throttled($fcUrls, 90);
    $eraBodies = http_get_throttled($eraUrls, 60);
    $metarBodies = http_get_throttled($metarUrls, 40);

    $eraGroups = []; $obsGroups = []; $used = []; $totalEraRows = 0;
    foreach ($stations as $i => $stn) {
        $fc = $fcBodies[$i] ? json_decode($fcBodies[$i], true) : null;
        if (!$fc || !isset($fc['hourly']['time'])) continue;
        $fIdx = array_flip($fc['hourly']['time']);

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
        if ($eraRows) { $eraGroups[] = ['fc' => $fc, 'rows' => $eraRows]; $totalEraRows += count($eraRows); }

        $metarList = $metarBodies[$i] ? json_decode($metarBodies[$i], true) : null;
        $hourly = is_array($metarList) ? metar_hourly_from($metarList) : [];
        $obsRows = [];
        foreach ($hourly as $hk => $o) { if (isset($fIdx[$hk])) $obsRows[] = ['j' => $fIdx[$hk]] + $o; }
        if (count($obsRows) >= MIN_OBS) { $obsGroups[] = ['fc' => $fc, 'rows' => $obsRows]; $used[] = $stn['name']; }
    }
    if (!$eraGroups) return null;

    $out = score_models($MODELS, $KEYS, $TOL, $eraGroups, $obsGroups);
    return [
        'start' => $start, 'end' => $eraEnd, 'hours' => $totalEraRows,
        'station' => null, 'obs_weight' => $obsGroups ? OBS_WEIGHT : 0,
        'greece' => ['stations' => count($obsGroups), 'names' => $used],
        'models' => $out,
    ];
}

/* ---------------------------------------------------------------- single location (non-Greek) ---------------------------------------------------------------- */
function compute_point(float $lat, float $lon, array $MODELS, array $VARS, array $KEYS, array $TOL, string $start, string $fcEnd, string $eraEnd): array
{
    $base = ['hourly' => implode(',', $VARS), 'timezone' => 'UTC'];
    $q = $base + ['latitude' => $lat, 'longitude' => $lon];
    $fcBody = http_get('https://historical-forecast-api.open-meteo.com/v1/forecast?' . http_build_query($q + ['start_date' => $start, 'end_date' => $fcEnd, 'models' => implode(',', $MODELS)]), 60);
    $truthBody = http_get('https://archive-api.open-meteo.com/v1/archive?' . http_build_query($q + ['start_date' => $start, 'end_date' => $eraEnd]), 40);
    $fc = $fcBody ? json_decode($fcBody, true) : null;
    $truth = $truthBody ? json_decode($truthBody, true) : null;
    if (!$fc || !isset($fc['hourly']['time'])) json_out(['error' => 'Could not fetch historical data for verification'], 502);
    $fIdx = array_flip($fc['hourly']['time']);

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
    $obsRows = []; $stationInfo = null;
    if ($station) {
        $sFcBody = http_get('https://historical-forecast-api.open-meteo.com/v1/forecast?' . http_build_query($base + ['latitude' => $station['lat'], 'longitude' => $station['lon'], 'start_date' => $start, 'end_date' => $fcEnd, 'models' => implode(',', $MODELS)]), 60);
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
    }

    $eraGroups = $eraRows ? [['fc' => $fc, 'rows' => $eraRows]] : [];
    $obsGroups = $obsRows ? [['fc' => $obsFc, 'rows' => $obsRows]] : [];
    $out = score_models($MODELS, $KEYS, $TOL, $eraGroups, $obsGroups);
    return [
        'start' => $start, 'end' => $eraEnd, 'hours' => count($eraRows),
        'station' => $stationInfo, 'obs_weight' => $stationInfo ? OBS_WEIGHT : 0,
        'greece' => null,
        'models' => $out,
    ];
}

$result = $greece ? compute_greece($pdo, $MODELS, $VARS, $KEYS, $TOL, $start, $fcEnd, $eraEnd) : null;
if ($result === null) $result = compute_point($lat, $lon, $MODELS, $VARS, $KEYS, $TOL, $start, $fcEnd, $eraEnd);

$body = json_encode($result, JSON_UNESCAPED_UNICODE);
$pdo->prepare('INSERT OR REPLACE INTO cache (k, body, fetched_at) VALUES (?, ?, ?)')->execute([$key, $body, time()]);
header('Content-Type: application/json; charset=utf-8');
echo $body;
