<?php
// Model verification.
// Archived forecasts of every model (Open-Meteo Historical Forecast API) are compared with
//   1. the ERA5 reanalysis (Open-Meteo Archive API) over the last ~4 weeks, and
//   2. real METAR observations of the nearest airport station (aviationweather.gov) over the last ~1-2 weeks.
// When both references exist the skill is a blend (observations weigh more, because ERA5 is produced by an ECMWF model
// and slightly favours ECMWF). The resulting scores are converted to per-parameter weights.
declare(strict_types=1);
require __DIR__ . '/db.php';

const VERIFY_TTL = 86400;    // cache: 24 hours
const WINDOW_DAYS = 28;      // ERA5 comparison window
const LAG_DAYS = 6;          // ERA5 is published with a delay of a few days
const METAR_HOURS = 360;     // how far back to ask for METAR reports (the API caps the number of reports)
const MAX_STATION_KM = 60;   // farthest METAR station that is still considered representative
const MIN_OBS = 48;          // minimum number of matched hourly observations
const OBS_WEIGHT = 0.6;      // share of METAR in the blended skill (rest = ERA5)

$MODELS = ['ecmwf_ifs025', 'gfs_seamless', 'icon_seamless', 'gem_seamless', 'meteofrance_seamless', 'ukmo_seamless',
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

$pdo = db();
$key = "vf2:$lat:$lon";
$st = $pdo->prepare('SELECT body, fetched_at FROM cache WHERE k = ?');
$st->execute([$key]);
if (($row = $st->fetch()) && time() - (int)$row['fetched_at'] < VERIFY_TTL) {
    header('Content-Type: application/json; charset=utf-8');
    echo $row['body'];
    exit;
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

// Nearest METAR station that reported recently
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

// Hourly observations (UTC hour key => values) from METAR reports
function metar_hourly(string $icao): array
{
    $body = http_get('https://aviationweather.gov/api/data/metar?format=json&hours=' . METAR_HOURS . '&ids=' . rawurlencode($icao), 40);
    $list = $body ? json_decode($body, true) : null;
    if (!is_array($list)) return [];
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
            'dt' => $dt,
            't' => $temp,
            'w' => isset($o['wspd']) ? (float)$o['wspd'] * 1.852 : null,   // knots -> km/h
            'c' => $cloud,
            'h' => $rh,
            'p' => isset($o['slp']) ? (float)$o['slp'] : (isset($o['altim']) ? (float)$o['altim'] : null),
            'wet' => $wet,
            'cat' => $c,
        ];
    }
    return $best;
}

/* Compares one model with a list of truth rows [{j: forecast index, t,w,c,h,p, wet, cat}] */
function evaluate(array $fc, string $m, array $rows, array $KEYS): array
{
    $s = ['mae' => [], 'bias' => [], 'n' => 0];
    foreach ($KEYS as $var => $k) {
        $a = $fc['hourly']["{$var}_{$m}"] ?? null;
        if (!$a) continue;
        $sum = 0.0; $bias = 0.0; $cnt = 0;
        foreach ($rows as $r) {
            if (!isset($a[$r['j']]) || $r[$k] === null) continue;
            $d = $a[$r['j']] - $r[$k];
            $sum += abs($d); $bias += $d; $cnt++;
        }
        if ($cnt >= 24) { $s['mae'][$var] = $sum / $cnt; $s['bias'][$var] = $bias / $cnt; $s['n'] = max($s['n'], $cnt); }
    }
    // Rain: critical success index over wet hours (model >= 0.1 mm)
    $p = $fc['hourly']["precipitation_{$m}"] ?? null;
    if ($p) {
        $hit = $miss = $fa = 0;
        foreach ($rows as $r) {
            if (!isset($p[$r['j']]) || $r['wet'] === null) continue;
            $f = $p[$r['j']] >= 0.1;
            if ($r['wet'] && $f) $hit++; elseif ($r['wet']) $miss++; elseif ($f) $fa++;
        }
        if ($hit + $miss + $fa > 0) $s['csi'] = $hit / ($hit + $miss + $fa);
        $s['rain_events'] = $hit + $miss;
    }
    // Weather category agreement
    $c = $fc['hourly']["weather_code_{$m}"] ?? null;
    if ($c) {
        $ok = $tot = 0;
        foreach ($rows as $r) {
            if (!isset($c[$r['j']]) || $r['cat'] === null) continue;
            $tot++;
            if (cat($c[$r['j']]) === $r['cat']) $ok++;
        }
        if ($tot >= 24) $s['code_acc'] = $ok / $tot;
    }
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

/* ---------------------------------------------------------------- data */
$fcEnd = gmdate('Y-m-d', time() - 86400);
$eraEnd = gmdate('Y-m-d', time() - LAG_DAYS * 86400);
$start = gmdate('Y-m-d', time() - (LAG_DAYS + WINDOW_DAYS) * 86400);
$base = ['latitude' => $lat, 'longitude' => $lon, 'hourly' => implode(',', $VARS), 'timezone' => 'UTC'];

$fcBody = http_get('https://historical-forecast-api.open-meteo.com/v1/forecast?' . http_build_query($base + ['start_date' => $start, 'end_date' => $fcEnd, 'models' => implode(',', $MODELS)]), 60);
$truthBody = http_get('https://archive-api.open-meteo.com/v1/archive?' . http_build_query($base + ['start_date' => $start, 'end_date' => $eraEnd]), 40);
$fc = $fcBody ? json_decode($fcBody, true) : null;
$truth = $truthBody ? json_decode($truthBody, true) : null;
if (!$fc || !isset($fc['hourly']['time'])) json_out(['error' => 'Could not fetch historical data for verification'], 502);

$fIdx = array_flip($fc['hourly']['time']);

// ERA5 rows
$eraRows = [];
if ($truth && isset($truth['hourly']['time'])) {
    $T = $truth['hourly'];
    foreach ($T['time'] as $i => $tm) {
        if (!isset($fIdx[$tm])) continue;
        $eraRows[] = [
            'j' => $fIdx[$tm],
            't' => $T['temperature_2m'][$i] ?? null, 'w' => $T['wind_speed_10m'][$i] ?? null, 'c' => $T['cloud_cover'][$i] ?? null,
            'h' => $T['relative_humidity_2m'][$i] ?? null, 'p' => $T['pressure_msl'][$i] ?? null,
            'wet' => isset($T['precipitation'][$i]) ? $T['precipitation'][$i] >= 0.1 : null,
            'cat' => cat($T['weather_code'][$i] ?? null),
        ];
    }
}

// METAR rows
$station = find_station($lat, $lon);
$obsRows = [];
$stationInfo = null;
if ($station) {
    $hourly = metar_hourly($station['id']);
    foreach ($hourly as $hk => $o) {
        if (!isset($fIdx[$hk])) continue;
        $obsRows[] = ['j' => $fIdx[$hk]] + $o;
    }
    if (count($obsRows) >= MIN_OBS) {
        $times = array_keys($hourly);
        sort($times);
        $stationInfo = [
            'id' => $station['id'], 'name' => $station['name'], 'km' => round($station['km'], 1), 'elev' => $station['elev'],
            'reports' => count($obsRows), 'start' => substr($times[0], 0, 10), 'end' => substr(end($times), 0, 10),
        ];
    } else {
        $obsRows = [];
    }
}

/* ---------------------------------------------------------------- per model */
$out = [];
$blend = [];
foreach ($MODELS as $m) {
    $era = $eraRows ? evaluate($fc, $m, $eraRows, $KEYS) : ['mae' => []];
    if (!$era['mae'] || array_sum($era['mae']) < 0.001) continue;   // outside coverage: the archive returns a copy of ERA5 (error 0)
    $obs = $obsRows ? evaluate($fc, $m, $obsRows, $KEYS) : null;

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

// Weights (mean = 1, limited to [0.5, 1.8] so that no model dominates)
function norm_weights(array $vals): array
{
    if (!$vals) return [];
    $raw = array_map(fn($x) => $x + 0.15, $vals);
    $mean = array_sum($raw) / count($raw);
    return array_map(fn($x) => round(min(1.8, max(0.5, $x / $mean)), 3), $raw);
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

$body = json_encode([
    'start' => $start, 'end' => $eraEnd, 'hours' => count($eraRows),
    'station' => $stationInfo, 'obs_weight' => $stationInfo ? OBS_WEIGHT : 0,
    'models' => $out,
], JSON_UNESCAPED_UNICODE);
$pdo->prepare('INSERT OR REPLACE INTO cache (k, body, fetched_at) VALUES (?, ?, ?)')->execute([$key, $body, time()]);
header('Content-Type: application/json; charset=utf-8');
echo $body;
