<?php
// Real probabilities from ensemble forecasts (Open-Meteo Ensemble API): GET api/ensemble.php?lat=&lon=[&elevation=][&refresh=1]
//
// An ensemble system runs the same model many times from slightly different starts; the share of members that
// rain, blow hard, etc. is a genuine probability — unlike "how many models agree", which is only a vote.
// Systems: ECMWF IFS (51 members), NOAA GEFS (31), DWD ICON (40), Environment Canada GEM (21), UK Met Office (18).
// Each SYSTEM counts once (equal weight), so ECMWF's 51 members cannot drown the others.
//
// The raw output is huge (hundreds of members x 168 hours), so it is reduced here and only this goes to the browser:
//   time[]                       the hours, same convention as api/forecast.php (local time, timezone=auto)
//   systems[]                    [{id, members}] that really answered
//   p_rain / p_wind / p_gust     probability per block for each step in STEPS (1, 3, 6, 12, 24 h; blocks start at 00:00 like the table's columns):
//                                p_rain = block rain total >= rain threshold of that step (same as RAIN_THR_BY_HOURS in js/app.js),
//                                p_wind = mean wind speed >= WIND_THR, p_gust = strongest gust >= GUST_THR
//   t_p10/p50/p90, r_p10/p50/p90 hourly temperature and precipitation percentiles over all members (systems weighted equally)
// Any failure answers {"error": ...} and the app silently keeps the deterministic consensus.
declare(strict_types=1);
require __DIR__ . '/db.php';

const ENS_TTL = 7200;                       // cache: 2 hours (ensembles are updated every 6-12 h)
const ENS_MODELS = ['ecmwf_ifs025', 'gfs025', 'icon_seamless', 'gem_global', 'ukmo_global_ensemble_20km'];
const ENS_VARS = ['temperature_2m', 'precipitation', 'wind_speed_10m', 'wind_gusts_10m'];
const STEPS = [1, 3, 6, 12, 24];
const WIND_THR = 30.0;                      // km/h, as in js/app.js
const GUST_THR = 60.0;                      // km/h, as in js/app.js ("gusts >= 60")
function rain_thr(int $hours): float { return $hours <= 1 ? 0.2 : ($hours <= 3 ? 0.5 : 1.0); }   // as rainThr() in js/app.js

/* weighted quantile (0..1) of [value, weight] pairs */
function wquantile(array $vw, float $q): ?float
{
    if (!$vw) return null;
    usort($vw, fn($a, $b) => $a[0] <=> $b[0]);
    $tot = array_sum(array_column($vw, 1));
    $acc = 0.0;
    foreach ($vw as [$v, $w]) { $acc += $w; if ($acc >= $q * $tot - 1e-9) return $v; }
    return $vw[count($vw) - 1][0];
}

$lat = filter_var($_GET['lat'] ?? null, FILTER_VALIDATE_FLOAT);
$lon = filter_var($_GET['lon'] ?? null, FILTER_VALIDATE_FLOAT);
if ($lat === false || $lon === false || abs($lat) > 90 || abs($lon) > 180) json_out(['error' => 'Invalid coordinates'], 400);
$lat = round($lat, 3); $lon = round($lon, 3);
$elevRaw = $_GET['elevation'] ?? null;
$elev = ($elevRaw !== null && $elevRaw !== '' && is_numeric($elevRaw) && $elevRaw >= -500 && $elevRaw <= 9000) ? round((float)$elevRaw) : null;

$pdo = db();
$key = "ens:$lat:$lon" . ($elev !== null ? ":e$elev" : '');
if (empty($_GET['refresh'])) {
    $st = $pdo->prepare('SELECT body, fetched_at FROM cache WHERE k = ?');
    $st->execute([$key]);
    if (($row = fetch_one($st)) && time() - (int)$row['fetched_at'] < ENS_TTL) {
        header('Content-Type: application/json; charset=utf-8');
        echo $row['body'];
        exit;
    }
}

set_time_limit(60);
$url = 'https://ensemble-api.open-meteo.com/v1/ensemble?' . http_build_query([
    'latitude' => $lat, 'longitude' => $lon, 'hourly' => implode(',', ENS_VARS), 'models' => implode(',', ENS_MODELS),
    'timezone' => 'auto', 'forecast_days' => 7,
] + ($elev !== null ? ['elevation' => $elev] : []));
$body = http_get($url, 45);
$om = $body ? json_decode($body, true) : null;
if (!$om || !isset($om['hourly']['time'])) json_out(['error' => 'Ensemble data unavailable'], 502);
$H = $om['hourly'];
$time = $H['time'];
$n = count($time);

// group the series: [variable][system] => list of member series (the un-numbered key is the control run — a member too)
$series = [];
foreach ($H as $k => $arr) {
    if ($k === 'time' || !is_array($arr)) continue;
    foreach (ENS_VARS as $v) {
        if (!str_starts_with($k, $v . '_')) continue;
        $rest = substr($k, strlen($v) + 1);
        $rest = preg_replace('/^member\d+_/', '', $rest);   // member07_ecmwf_ifs025_ensemble -> ecmwf_ifs025_ensemble
        if (array_filter($arr, fn($x) => $x !== null)) $series[$v][$rest][] = $arr;
        break;
    }
}
// a system counts only if it has every variable
$systems = [];
foreach (array_keys($series['temperature_2m'] ?? []) as $sys) {
    $ok = true; foreach (['temperature_2m', 'precipitation', 'wind_speed_10m'] as $v) if (empty($series[$v][$sys])) $ok = false;   // gusts are optional (GEM has none)
    if ($ok) $systems[] = $sys;
}
if (!$systems) json_out(['error' => 'No ensemble system returned data'], 502);

$out = ['lat' => $lat, 'lon' => $lon, 'generated' => gmdate('c'), 'time' => $time, 'systems' => [], 'p_rain' => [], 'p_wind' => [], 'p_gust' => []];
foreach ($systems as $s) $out['systems'][] = ['id' => $s, 'members' => count($series['temperature_2m'][$s])];

// probability per block, averaged over systems (each system = the share of its members that exceed the threshold)
foreach (STEPS as $step) {
    $blocks = intdiv($n + $step - 1, $step);
    $pr = $pw = $pg = array_fill(0, $blocks, null);
    for ($b = 0; $b < $blocks; $b++) {
        $a0 = $b * $step; $a1 = min($a0 + $step, $n);
        $thr = rain_thr($step);
        $sr = []; $sw = []; $sg = [];
        foreach ($systems as $s) {
            $hit = $cnt = 0;
            foreach ($series['precipitation'][$s] as $m) { $v = array_filter(array_slice($m, $a0, $a1 - $a0), fn($x) => $x !== null); if (!$v) continue; $cnt++; if (array_sum($v) >= $thr) $hit++; }
            if ($cnt) $sr[] = $hit / $cnt;
            $hit = $cnt = 0;
            foreach ($series['wind_speed_10m'][$s] as $m) { $v = array_filter(array_slice($m, $a0, $a1 - $a0), fn($x) => $x !== null); if (!$v) continue; $cnt++; if (array_sum($v) / count($v) >= WIND_THR) $hit++; }
            if ($cnt) $sw[] = $hit / $cnt;
            $hit = $cnt = 0;
            foreach ($series['wind_gusts_10m'][$s] ?? [] as $m) { $v = array_filter(array_slice($m, $a0, $a1 - $a0), fn($x) => $x !== null); if (!$v) continue; $cnt++; if (max($v) >= GUST_THR) $hit++; }
            if ($cnt) $sg[] = $hit / $cnt;
        }
        if ($sr) $pr[$b] = round(array_sum($sr) / count($sr), 3);
        if ($sw) $pw[$b] = round(array_sum($sw) / count($sw), 3);
        if ($sg) $pg[$b] = round(array_sum($sg) / count($sg), 3);
    }
    $out['p_rain'][$step] = $pr; $out['p_wind'][$step] = $pw; $out['p_gust'][$step] = $pg;
}

// hourly percentiles over all members, each system carrying the same total weight
foreach (['t' => 'temperature_2m', 'r' => 'precipitation'] as $short => $v) {
    foreach (['p10' => 0.1, 'p50' => 0.5, 'p90' => 0.9] as $pn => $q) $out["{$short}_$pn"] = [];
    for ($i = 0; $i < $n; $i++) {
        $vw = [];
        foreach ($systems as $s) {
            $mem = $series[$v][$s]; $w = 1 / count($mem);
            foreach ($mem as $m) if (($m[$i] ?? null) !== null) $vw[] = [(float)$m[$i], $w];
        }
        foreach (['p10' => 0.1, 'p50' => 0.5, 'p90' => 0.9] as $pn => $q) {
            $x = wquantile($vw, $q);
            $out["{$short}_$pn"][] = $x === null ? null : round($x, 2);
        }
    }
}

$json = json_encode($out, JSON_UNESCAPED_UNICODE);
$pdo->prepare('INSERT OR REPLACE INTO cache (k, body, fetched_at) VALUES (?, ?, ?)')->execute([$key, $json, time()]);
header('Content-Type: application/json; charset=utf-8');
echo $json;
