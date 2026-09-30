<?php
// "Measured now": the latest real METAR observation from the nearest airport station
// (aviationweather.gov) — actually measured data, not a model forecast. Used for the hero card's
// "Measured now around X" line. Independent of api/verify.php (which needs a longer METAR history for
// scoring); this only wants the single most recent report.
declare(strict_types=1);
require __DIR__ . '/db.php';

const OBS_TTL = 900;          // cache: 15 minutes (METAR reports arrive roughly hourly/half-hourly)
const MAX_STATION_KM = 60;    // farthest station still considered representative of the place

function haversine(float $la1, float $lo1, float $la2, float $lo2): float
{
    $r = 6371.0;
    $dLa = deg2rad($la2 - $la1);
    $dLo = deg2rad($lo2 - $lo1);
    $a = sin($dLa / 2) ** 2 + cos(deg2rad($la1)) * cos(deg2rad($la2)) * sin($dLo / 2) ** 2;
    return $r * 2 * atan2(sqrt($a), sqrt(1 - $a));
}

function find_station(float $lat, float $lon): ?array
{
    foreach ([1.0, 2.5] as $d) {
        $bbox = sprintf('%.3f,%.3f,%.3f,%.3f', $lat - $d, $lon - $d, $lat + $d, $lon + $d);
        $body = http_get('https://aviationweather.gov/api/data/metar?format=json&hours=2&bbox=' . $bbox, 20);
        $list = $body ? json_decode($body, true) : null;
        if (!is_array($list) || !$list) continue;
        $best = null;
        foreach ($list as $o) {
            if (!isset($o['icaoId'], $o['lat'], $o['lon'])) continue;
            $km = haversine($lat, $lon, (float)$o['lat'], (float)$o['lon']);
            if ($best === null || $km < $best['km']) {
                $best = ['id' => $o['icaoId'], 'name' => $o['name'] ?? $o['icaoId'], 'km' => $km, 'raw' => $o];
            }
        }
        if ($best && $best['km'] <= MAX_STATION_KM) return $best;
    }
    return null;
}

$lat = filter_var($_GET['lat'] ?? null, FILTER_VALIDATE_FLOAT);
$lon = filter_var($_GET['lon'] ?? null, FILTER_VALIDATE_FLOAT);
if ($lat === false || $lon === false || abs($lat) > 90 || abs($lon) > 180) json_out(['error' => 'Invalid coordinates'], 400);
$lat = round($lat, 2);
$lon = round($lon, 2);

$pdo = db();
$key = "obs:$lat:$lon";
$st = $pdo->prepare('SELECT body, fetched_at FROM cache WHERE k = ?');
$st->execute([$key]);
if (($row = $st->fetch()) && time() - (int)$row['fetched_at'] < OBS_TTL) {
    header('Content-Type: application/json; charset=utf-8');
    header('X-Cache: HIT');
    echo $row['body'];
    exit;
}

$station = find_station($lat, $lon);
$out = null;
if ($station) {
    $o = $station['raw'];
    $temp = isset($o['temp']) ? (float)$o['temp'] : null;
    $dew = isset($o['dewp']) ? (float)$o['dewp'] : null;
    $rh = null;
    if ($temp !== null && $dew !== null) {
        $rh = 100 * exp(17.625 * $dew / (243.04 + $dew)) / exp(17.625 * $temp / (243.04 + $temp));
        $rh = max(0.0, min(100.0, $rh));
    }
    $wx = strtoupper((string)($o['wxString'] ?? ''));
    $wet = (bool)preg_match('/(RA|DZ|SN|SG|PL|GR|GS|SH|TS|UP)/', $wx);
    $out = [
        'station' => ['id' => $station['id'], 'name' => $station['name'], 'km' => round($station['km'], 1)],
        'time' => isset($o['obsTime']) ? gmdate('c', (int)$o['obsTime']) : null,
        'temp' => $temp,
        'wind_kmh' => isset($o['wspd']) ? round((float)$o['wspd'] * 1.852, 1) : null,
        'humidity' => $rh === null ? null : round($rh),
        'rain' => $wet,
    ];
}

$body = json_encode(['observed' => $out], JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
$pdo->prepare('INSERT OR REPLACE INTO cache (k, body, fetched_at) VALUES (?, ?, ?)')->execute([$key, $body, time()]);
header('Content-Type: application/json; charset=utf-8');
header('X-Cache: MISS');
echo $body;
