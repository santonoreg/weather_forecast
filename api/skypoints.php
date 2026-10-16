<?php
// Cloud layers (low / mid / high, mean of ECMWF IFS, NOAA GFS, DWD ICON) at several points, hour by hour for 7 days, plus
// aerosols, visibility, humidity and rain at the FIRST point. Used by the "Sunset & sunrise" view: the points lie along the
// Sun's azimuth, so the forecast says what the horizon will look like, not only the sky above you.
declare(strict_types=1);
require __DIR__ . '/db.php';

const SKY_TTL = 1800;
const SKY_MODELS = ['ecmwf_ifs025', 'gfs_seamless', 'icon_seamless'];
const SKY_MAX_POINTS = 64;

$raw = (string)($_GET['pts'] ?? '');
$pts = [];
foreach (explode(';', $raw) as $p) {
    $ll = explode(',', $p);
    if (count($ll) !== 2) continue;
    $la = filter_var($ll[0], FILTER_VALIDATE_FLOAT);
    $lo = filter_var($ll[1], FILTER_VALIDATE_FLOAT);
    if ($la === false || $lo === false || abs($la) > 90 || abs($lo) > 180) continue;
    $pts[] = [round($la, 2), round($lo, 2)];
}
if (!$pts || count($pts) > SKY_MAX_POINTS) json_out(['error' => 'Invalid points'], 400);

$pdo = db();
$key = 'sky:' . md5(json_encode($pts));
$st = $pdo->prepare('SELECT body, fetched_at FROM cache WHERE k = ?');
$st->execute([$key]);
if (empty($_GET['refresh']) && ($row = fetch_one($st)) && time() - (int)$row['fetched_at'] < SKY_TTL) {
    header('Content-Type: application/json; charset=utf-8');
    header('X-Cache: HIT');
    echo $row['body'];
    exit;
}

$lat = implode(',', array_column($pts, 0));
$lon = implode(',', array_column($pts, 1));
$vars = ['cloud_cover_low', 'cloud_cover_mid', 'cloud_cover_high', 'precipitation', 'relative_humidity_2m', 'visibility'];
$body = http_get('https://api.open-meteo.com/v1/forecast?' . http_build_query([
    'latitude' => $lat, 'longitude' => $lon, 'hourly' => implode(',', $vars),
    'models' => implode(',', SKY_MODELS), 'timezone' => 'auto', 'forecast_days' => 7,
]), 30);
$om = $body ? json_decode($body, true) : null;
if (!$om) json_out(['error' => 'Failed to fetch data from Open-Meteo'], 502);
if (isset($om['hourly'])) $om = [$om];            // a single location comes back as an object, several as a list
if (!isset($om[0]['hourly']['time'])) json_out(['error' => 'Failed to fetch data from Open-Meteo'], 502);

$time = $om[0]['hourly']['time'];
$n = count($time);
$mean = function (array $h, string $v, int $i): ?float {
    $a = [];
    foreach (SKY_MODELS as $m) { $x = $h["{$v}_{$m}"][$i] ?? null; if ($x !== null) $a[] = (float)$x; }
    if (!$a && isset($h[$v][$i]) && $h[$v][$i] !== null) $a[] = (float)$h[$v][$i];
    return $a ? array_sum($a) / count($a) : null;
};
$points = [];
foreach ($om as $k => $loc) {
    $h = $loc['hourly'] ?? [];
    $o = ['lat' => $pts[$k][0], 'lon' => $pts[$k][1], 'low' => [], 'mid' => [], 'high' => []];
    for ($i = 0; $i < $n; $i++) {
        foreach (['low' => 'cloud_cover_low', 'mid' => 'cloud_cover_mid', 'high' => 'cloud_cover_high'] as $name => $v) {
            $m = $mean($h, $v, $i);
            $o[$name][] = $m === null ? null : round($m);
        }
    }
    if ($k === 0) {
        foreach (['precip' => 'precipitation', 'rh' => 'relative_humidity_2m', 'vis' => 'visibility'] as $name => $v) {
            $o[$name] = [];
            for ($i = 0; $i < $n; $i++) { $m = $mean($h, $v, $i); $o[$name][] = $m === null ? null : round($m, 1); }
        }
    }
    $points[] = $o;
}

// CAMS aerosols for the first point (optional)
$aod = array_fill(0, $n, null);
$aq = http_get('https://air-quality-api.open-meteo.com/v1/air-quality?' . http_build_query([
    'latitude' => $pts[0][0], 'longitude' => $pts[0][1], 'hourly' => 'aerosol_optical_depth', 'timezone' => 'auto', 'forecast_days' => 7,
]), 20);
$aqj = $aq ? json_decode($aq, true) : null;
if ($aqj && isset($aqj['hourly']['time'])) {
    $idx = array_flip($aqj['hourly']['time']);
    foreach ($time as $i => $ts) { $j = $idx[$ts] ?? null; if ($j !== null) $aod[$i] = $aqj['hourly']['aerosol_optical_depth'][$j] ?? null; }
}

$out = json_encode([
    'utc_offset_seconds' => (int)($om[0]['utc_offset_seconds'] ?? 0),
    'time' => $time, 'points' => $points, 'aod' => $aod,
], JSON_UNESCAPED_SLASHES);
$pdo->prepare('INSERT OR REPLACE INTO cache (k, body, fetched_at) VALUES (?, ?, ?)')->execute([$key, $out, time()]);
header('Content-Type: application/json; charset=utf-8');
header('X-Cache: MISS');
echo $out;
