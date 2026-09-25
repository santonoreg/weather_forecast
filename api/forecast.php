<?php
// Συγκεντρώνει προβλέψεις από πολλά μοντέλα και τις επιστρέφει σε ενιαία μορφή
declare(strict_types=1);
require __DIR__ . '/db.php';

const CACHE_TTL = 1800; // 30 λεπτά

$MODELS = [
    'ecmwf_ifs025'      => 'ECMWF IFS',
    'gfs_seamless'      => 'NOAA GFS',
    'icon_seamless'     => 'DWD ICON',
    'gem_seamless'      => 'Environment Canada GEM',
    'meteofrance_seamless' => 'Météo-France',
    'ukmo_seamless'     => 'UK Met Office',
    'jma_seamless'      => 'JMA (Ιαπωνία)',
    'cma_grapes_global' => 'CMA GRAPES (Κίνα)',
    'bom_access_global' => 'BOM ACCESS (Αυστραλία)',
    'knmi_seamless'     => 'KNMI (Ολλανδία)',
    'dmi_seamless'      => 'DMI (Δανία)',
    'metno_seamless'    => 'MET Norway (Nordic)',
];
$VARS = ['temperature_2m', 'apparent_temperature', 'precipitation', 'wind_speed_10m', 'wind_gusts_10m',
         'wind_direction_10m', 'cloud_cover', 'relative_humidity_2m', 'pressure_msl', 'weather_code', 'cape', 'is_day'];

$lat = filter_var($_GET['lat'] ?? null, FILTER_VALIDATE_FLOAT);
$lon = filter_var($_GET['lon'] ?? null, FILTER_VALIDATE_FLOAT);
if ($lat === false || $lon === false || abs($lat) > 90 || abs($lon) > 180) json_out(['error' => 'Μη έγκυρες συντεταγμένες'], 400);
$lat = round($lat, 3);
$lon = round($lon, 3);

$pdo = db();
$key = "fc:$lat:$lon";
if (empty($_GET['refresh'])) {
    $st = $pdo->prepare('SELECT body, fetched_at FROM cache WHERE k = ?');
    $st->execute([$key]);
    if (($row = $st->fetch()) && time() - (int)$row['fetched_at'] < CACHE_TTL) {
        header('Content-Type: application/json; charset=utf-8');
        header('X-Cache: HIT');
        echo $row['body'];
        exit;
    }
}

$url = 'https://api.open-meteo.com/v1/forecast?' . http_build_query([
    'latitude' => $lat, 'longitude' => $lon,
    'hourly' => implode(',', $VARS),
    'models' => implode(',', array_keys($MODELS)),
    'timezone' => 'auto', 'forecast_days' => 7,
]);
$body = http_get($url);
$om = $body ? json_decode($body, true) : null;
if (!$om || !isset($om['hourly']['time'])) json_out(['error' => 'Αποτυχία λήψης δεδομένων από Open-Meteo'], 502);

$time = $om['hourly']['time'];
$offset = (int)($om['utc_offset_seconds'] ?? 0);
$providers = [];

foreach ($MODELS as $id => $name) {
    $h = [];
    $has = false;
    foreach ($VARS as $v) {
        $arr = $om['hourly']["{$v}_{$id}"] ?? array_fill(0, count($time), null);
        $h[$v] = $arr;
        if ($v !== 'is_day' && array_filter($arr, fn($x) => $x !== null)) $has = true;
    }
    if ($has) $providers[] = ['id' => $id, 'name' => $name, 'hourly' => $h];
}

// Άμεσα από MET Norway (Yr) – ανεξάρτητος πάροχος με παγκόσμια κάλυψη
function yr_code(string $s): int
{
    $heavy = str_contains($s, 'heavy');
    if (str_contains($s, 'thunder')) return 95;
    if (str_contains($s, 'snow')) return $heavy ? 75 : (str_contains($s, 'showers') ? 85 : 73);
    if (str_contains($s, 'sleet')) return 68;
    if (str_contains($s, 'showers')) return $heavy ? 82 : 80;
    if (str_contains($s, 'rain')) return $heavy ? 65 : (str_contains($s, 'light') ? 61 : 63);
    if (str_contains($s, 'fog')) return 45;
    if (str_starts_with($s, 'cloudy')) return 3;
    if (str_starts_with($s, 'partlycloudy')) return 2;
    if (str_starts_with($s, 'fair')) return 1;
    return 0;
}

$yrBody = http_get("https://api.met.no/weatherapi/locationforecast/2.0/compact?lat=$lat&lon=$lon");
$yr = $yrBody ? json_decode($yrBody, true) : null;
if ($yr && !empty($yr['properties']['timeseries'])) {
    $pts = [];
    foreach ($yr['properties']['timeseries'] as $p) {
        $pts[] = ['t' => strtotime($p['time']), 'd' => $p['data']];
    }
    $h = array_fill_keys($VARS, []);
    $j = 0;
    foreach ($time as $localStr) {
        $t = strtotime($localStr . ' UTC') - $offset; // τοπική ώρα -> UTC
        while ($j + 1 < count($pts) && $pts[$j + 1]['t'] <= $t) $j++;
        $p = $pts[$j];
        if ($t < $pts[0]['t'] || $t - $p['t'] > 6 * 3600) {
            foreach ($VARS as $v) $h[$v][] = null;
            continue;
        }
        $d = $p['d'];
        $i = $d['instant']['details'];
        $hasHour = isset($d['next_1_hours']);
        $blk = $d['next_1_hours'] ?? $d['next_6_hours'] ?? null;
        $prec = null;
        if ($hasHour && $p['t'] === $t) $prec = $d['next_1_hours']['details']['precipitation_amount'] ?? null;
        elseif (isset($d['next_6_hours']['details']['precipitation_amount'])) $prec = $d['next_6_hours']['details']['precipitation_amount'] / 6;
        elseif ($hasHour) $prec = $d['next_1_hours']['details']['precipitation_amount'] ?? null;
        $sym = $blk['summary']['symbol_code'] ?? null;
        $h['temperature_2m'][] = $i['air_temperature'] ?? null;
        $h['apparent_temperature'][] = null;
        $h['precipitation'][] = $prec !== null ? round($prec, 2) : null;
        $h['wind_speed_10m'][] = isset($i['wind_speed']) ? round($i['wind_speed'] * 3.6, 1) : null;
        $h['wind_gusts_10m'][] = isset($i['wind_speed_of_gust']) ? round($i['wind_speed_of_gust'] * 3.6, 1) : null;
        $h['wind_direction_10m'][] = $i['wind_from_direction'] ?? null;
        $h['cloud_cover'][] = $i['cloud_area_fraction'] ?? null;
        $h['relative_humidity_2m'][] = $i['relative_humidity'] ?? null;
        $h['pressure_msl'][] = $i['air_pressure_at_sea_level'] ?? null;
        $h['weather_code'][] = $sym ? yr_code($sym) : null;
        $h['cape'][] = null;
        $h['is_day'][] = null;
    }
    $providers[] = ['id' => 'yr', 'name' => 'MET Norway / Yr', 'hourly' => $h];
}

$out = json_encode([
    'lat' => $lat, 'lon' => $lon,
    'timezone' => $om['timezone'] ?? null,
    'utc_offset_seconds' => $offset,
    'elevation' => $om['elevation'] ?? null,
    'generated' => gmdate('c'),
    'time' => $time,
    'providers' => $providers,
], JSON_UNESCAPED_UNICODE);

$pdo->prepare('INSERT OR REPLACE INTO cache (k, body, fetched_at) VALUES (?, ?, ?)')->execute([$key, $out, time()]);
header('Content-Type: application/json; charset=utf-8');
header('X-Cache: MISS');
echo $out;
