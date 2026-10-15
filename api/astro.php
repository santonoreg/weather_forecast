<?php
// Atmospheric inputs for the Astronomy tab: a multi-model mean (ECMWF IFS, NOAA GFS, DWD ICON) of cloud
// layers, humidity, wind at several pressure levels (jet stream) and CAPE, plus CAMS aerosols/dust.
// Moon/Sun positions are computed in the browser (js/astro.js); seeing/transparency are derived there too.
declare(strict_types=1);
require __DIR__ . '/db.php';

const ASTRO_TTL = 1800;   // 30 minutes, like the forecast
const ASTRO_MODELS = ['ecmwf_ifs025', 'gfs_seamless', 'icon_seamless'];
const ASTRO_LEVELS = [850, 700, 500, 300, 250];

$lat = filter_var($_GET['lat'] ?? null, FILTER_VALIDATE_FLOAT);
$lon = filter_var($_GET['lon'] ?? null, FILTER_VALIDATE_FLOAT);
if ($lat === false || $lon === false || abs($lat) > 90 || abs($lon) > 180) json_out(['error' => 'Invalid coordinates'], 400);
$lat = round($lat, 3);
$lon = round($lon, 3);

$pdo = db();
$key = "astro:$lat:$lon";
if (empty($_GET['refresh'])) {
    $st = $pdo->prepare('SELECT body, fetched_at FROM cache WHERE k = ?');
    $st->execute([$key]);
    if (($row = fetch_one($st)) && time() - (int)$row['fetched_at'] < ASTRO_TTL) {
        header('Content-Type: application/json; charset=utf-8');
        header('X-Cache: HIT');
        echo $row['body'];
        exit;
    }
}

$scalar = ['temperature_2m', 'relative_humidity_2m', 'dew_point_2m', 'cloud_cover', 'cloud_cover_low', 'cloud_cover_mid',
           'cloud_cover_high', 'visibility', 'wind_speed_10m', 'wind_gusts_10m', 'precipitation', 'cape',
           'temperature_850hPa', 'temperature_700hPa', 'temperature_500hPa', 'relative_humidity_700hPa'];
$vars = $scalar;
foreach (ASTRO_LEVELS as $l) { $vars[] = "wind_speed_{$l}hPa"; $vars[] = "wind_direction_{$l}hPa"; }

$body = http_get('https://api.open-meteo.com/v1/forecast?' . http_build_query([
    'latitude' => $lat, 'longitude' => $lon, 'hourly' => implode(',', $vars),
    'models' => implode(',', ASTRO_MODELS), 'timezone' => 'auto', 'forecast_days' => 5,
]), 25);
$om = $body ? json_decode($body, true) : null;
if (!$om || !isset($om['hourly']['time'])) json_out(['error' => 'Failed to fetch data from Open-Meteo'], 502);

$time = $om['hourly']['time'];
$n = count($time);
$H = $om['hourly'];

// values of one variable from every model that has it, at hour $i
$vals = function (string $v, int $i) use ($H): array {
    $out = [];
    foreach (ASTRO_MODELS as $m) {
        $x = $H["{$v}_{$m}"][$i] ?? null;
        if ($x !== null) $out[] = (float)$x;
    }
    if (!$out && isset($H[$v][$i]) && $H[$v][$i] !== null) $out[] = (float)$H[$v][$i];   // single-model response shape
    return $out;
};
$mean = fn(array $a): ?float => $a ? array_sum($a) / count($a) : null;

$hourly = [];
foreach ($scalar as $v) {
    $col = [];
    for ($i = 0; $i < $n; $i++) { $m = $mean($vals($v, $i)); $col[] = $m === null ? null : round($m, 1); }
    $hourly[$v] = $col;
}
// disagreement between models on total cloud: the tab shows it as an uncertainty hint
$cmin = $cmax = [];
for ($i = 0; $i < $n; $i++) {
    $c = $vals('cloud_cover', $i);
    $cmin[] = $c ? round(min($c)) : null;
    $cmax[] = $c ? round(max($c)) : null;
}
$hourly['cloud_cover_min'] = $cmin;
$hourly['cloud_cover_max'] = $cmax;
// wind: mean speed and circular-mean direction per pressure level
foreach (ASTRO_LEVELS as $l) {
    $sp = $di = [];
    for ($i = 0; $i < $n; $i++) {
        $s = $vals("wind_speed_{$l}hPa", $i);
        $d = $vals("wind_direction_{$l}hPa", $i);
        $sp[] = $s ? round(array_sum($s) / count($s), 1) : null;
        if ($d) {
            $x = $y = 0.0;
            foreach ($d as $deg) { $x += cos(deg2rad($deg)); $y += sin(deg2rad($deg)); }
            $di[] = (int)round(fmod(rad2deg(atan2($y, $x)) + 360, 360));
        } else $di[] = null;
    }
    $hourly["wind_speed_{$l}hPa"] = $sp;
    $hourly["wind_direction_{$l}hPa"] = $di;
}

// CAMS aerosols (optional: the tab still works without them)
$aq = ['aerosol_optical_depth' => array_fill(0, $n, null), 'dust' => array_fill(0, $n, null), 'pm10' => array_fill(0, $n, null)];
$aqBody = http_get('https://air-quality-api.open-meteo.com/v1/air-quality?' . http_build_query([
    'latitude' => $lat, 'longitude' => $lon, 'hourly' => implode(',', array_keys($aq)), 'timezone' => 'auto', 'forecast_days' => 5,
]), 20);
$aqj = $aqBody ? json_decode($aqBody, true) : null;
if ($aqj && isset($aqj['hourly']['time'])) {
    $idx = array_flip($aqj['hourly']['time']);
    foreach ($aq as $v => $_) {
        foreach ($time as $i => $ts) {
            $j = $idx[$ts] ?? null;
            if ($j !== null) $aq[$v][$i] = $aqj['hourly'][$v][$j] ?? null;
        }
    }
}
$hourly += $aq;

$out = json_encode([
    'lat' => $lat, 'lon' => $lon,
    'timezone' => $om['timezone'] ?? null,
    'utc_offset_seconds' => (int)($om['utc_offset_seconds'] ?? 0),
    'elevation' => $om['elevation'] ?? null,
    'models' => ASTRO_MODELS,
    'aerosols' => (bool)($aqj && isset($aqj['hourly']['time'])),
    'time' => $time,
    'hourly' => $hourly,
    'fetched_at' => time(),
], JSON_UNESCAPED_SLASHES);

$pdo->prepare('INSERT OR REPLACE INTO cache (k, body, fetched_at) VALUES (?, ?, ?)')->execute([$key, $out, time()]);
header('Content-Type: application/json; charset=utf-8');
header('X-Cache: MISS');
echo $out;
