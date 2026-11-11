<?php
// Multi-model forecast at several points of a route, each for the moment you reach it. pts = "lat,lon,epochSeconds;…".
// For every point only the two hours around the arrival time are returned (per model), so the answer stays small.
declare(strict_types=1);
require __DIR__ . '/db.php';

const TRIP_TTL = 1800;
const TRIP_MAX_POINTS = 40;
const TRIP_MODELS = ['ecmwf_ifs025', 'ecmwf_aifs025_single', 'gfs_seamless', 'icon_seamless', 'meteofrance_seamless', 'ukmo_seamless', 'gem_seamless'];
const TRIP_VARS = ['temperature_2m', 'precipitation', 'wind_gusts_10m', 'wind_speed_10m', 'weather_code', 'cloud_cover', 'cape', 'relative_humidity_2m', 'is_day'];

$pts = [];
foreach (explode(';', (string)($_GET['pts'] ?? '')) as $p) {
    $a = explode(',', $p);
    if (count($a) !== 3) continue;
    $la = filter_var($a[0], FILTER_VALIDATE_FLOAT);
    $lo = filter_var($a[1], FILTER_VALIDATE_FLOAT);
    $t = filter_var($a[2], FILTER_VALIDATE_INT);
    if ($la === false || $lo === false || $t === false || abs($la) > 90 || abs($lo) > 180) continue;
    $pts[] = [round($la, 2), round($lo, 2), (int)$t];
}
if (!$pts || count($pts) > TRIP_MAX_POINTS) json_out(['error' => 'Invalid points'], 400);
$now = time();
$tMax = max(array_column($pts, 2));
if ($tMax > $now + 7 * 86400) json_out(['error' => 'too_far'], 400);

$pdo = db();
$ck = 'trip:' . md5(json_encode($pts));
$st = $pdo->prepare('SELECT body, fetched_at FROM cache WHERE k = ?');
$st->execute([$ck]);
if (empty($_GET['refresh']) && ($row = fetch_one($st)) && time() - (int)$row['fetched_at'] < TRIP_TTL) {
    header('Content-Type: application/json; charset=utf-8');
    header('X-Cache: HIT');
    echo $row['body'];
    exit;
}

$days = (int)ceil(($tMax - $now) / 86400) + 2;                      // enough to cover the last arrival
$body = http_get('https://api.open-meteo.com/v1/forecast?' . http_build_query([
    'latitude' => implode(',', array_column($pts, 0)), 'longitude' => implode(',', array_column($pts, 1)),
    'hourly' => implode(',', TRIP_VARS), 'models' => implode(',', TRIP_MODELS), 'timezone' => 'GMT', 'forecast_days' => min(8, max(2, $days)),
]), 40);
$om = $body ? json_decode($body, true) : null;
if (!$om) json_out(['error' => 'Failed to fetch data from Open-Meteo'], 502);
if (isset($om['hourly'])) $om = [$om];                               // one location comes back as an object, several as a list
if (!isset($om[0]['hourly']['time'])) json_out(['error' => 'Failed to fetch data from Open-Meteo'], 502);

$time = array_map(fn($s) => strtotime($s . ' UTC'), $om[0]['hourly']['time']);
$out = [];
foreach ($pts as $k => [$la, $lo, $t]) {
    $h0 = intdiv($t, 3600) * 3600;
    $i = array_search($h0, $time, true);
    if ($i === false) { $out[] = null; continue; }
    $j = min($i + 1, count($time) - 1);
    $models = [];
    foreach (TRIP_MODELS as $m) {
        $row = [];
        $has = false;
        foreach (TRIP_VARS as $v) {
            $arr = $om[$k]['hourly']["{$v}_{$m}"] ?? null;
            $a = $arr[$i] ?? null;
            $b = $arr[$j] ?? null;
            $row[$v] = [$a, $b];
            if ($v !== 'is_day' && ($a !== null || $b !== null)) $has = true;
        }
        if ($has) $models[$m] = $row;
    }
    $out[] = ['f' => ($t - $h0) / 3600, 'm' => $models];
}
$json = json_encode(['pts' => $out], JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
$pdo->prepare('INSERT OR REPLACE INTO cache (k, body, fetched_at) VALUES (?, ?, ?)')->execute([$ck, $json, time()]);
header('Content-Type: application/json; charset=utf-8');
header('X-Cache: MISS');
echo $json;
