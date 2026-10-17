<?php
// Real airport observations (METAR) and forecasts (TAF) near a list of points, from aviationweather.gov.
// Used by the "Sunset & sunrise" view: stations along the Sun's azimuth tell what the horizon is doing right now (METAR)
// and, for roughly the next 9–30 hours, what the airport forecasters expect (TAF). Cloud only below ~12 000 ft is reported
// by automatic stations, so this says nothing reliable about high cirrus.
declare(strict_types=1);
require __DIR__ . '/db.php';

const AV_TTL = 900;             // METAR arrives every 30–60 min, TAF every 3–6 h
const AV_MAX_POINTS = 24;
const AV_METAR_KM = 70;         // a station farther than this does not represent the point
const AV_TAF_KM = 90;           // TAF stations are fewer and their forecast is about a 9 km circle: allow a bit more

function av_km(float $la1, float $lo1, float $la2, float $lo2): float
{
    $dLa = deg2rad($la2 - $la1); $dLo = deg2rad($lo2 - $lo1);
    $a = sin($dLa / 2) ** 2 + cos(deg2rad($la1)) * cos(deg2rad($la2)) * sin($dLo / 2) ** 2;
    return 6371.0 * 2 * atan2(sqrt($a), sqrt(1 - $a));
}

$pts = [];
foreach (explode(';', (string)($_GET['pts'] ?? '')) as $p) {
    $ll = explode(',', $p);
    if (count($ll) !== 2) continue;
    $la = filter_var($ll[0], FILTER_VALIDATE_FLOAT); $lo = filter_var($ll[1], FILTER_VALIDATE_FLOAT);
    if ($la === false || $lo === false || abs($la) > 90 || abs($lo) > 180) continue;
    $pts[] = [round($la, 2), round($lo, 2)];
}
if (!$pts || count($pts) > AV_MAX_POINTS) json_out(['error' => 'Invalid points'], 400);
$la0 = min(array_column($pts, 0)) - 1.0; $la1 = max(array_column($pts, 0)) + 1.0;
$lo0 = min(array_column($pts, 1)) - 1.0; $lo1 = max(array_column($pts, 1)) + 1.0;
if ($la1 - $la0 > 8 || $lo1 - $lo0 > 8) json_out(['error' => 'Points too far apart'], 400);

$pdo = db();
$key = 'av:' . md5(json_encode($pts));
$st = $pdo->prepare('SELECT body, fetched_at FROM cache WHERE k = ?');
$st->execute([$key]);
if (empty($_GET['refresh']) && ($row = fetch_one($st)) && time() - (int)$row['fetched_at'] < AV_TTL) {
    header('Content-Type: application/json; charset=utf-8');
    header('X-Cache: HIT');
    echo $row['body'];
    exit;
}

$bbox = sprintf('%.2f,%.2f,%.2f,%.2f', $la0, $lo0, $la1, $lo1);
$mj = http_get('https://aviationweather.gov/api/data/metar?format=json&hours=3&bbox=' . $bbox, 20);
$tj = http_get('https://aviationweather.gov/api/data/taf?format=json&bbox=' . $bbox, 20);
$metarList = $mj ? json_decode($mj, true) : null;
$tafList = $tj ? json_decode($tj, true) : null;
if (!is_array($metarList) && !is_array($tafList)) json_out(['error' => 'aviationweather.gov did not answer'], 502);

$clouds = function ($arr): array {
    $out = [];
    foreach (is_array($arr) ? $arr : [] as $c) {
        if (!isset($c['cover'])) continue;
        $out[] = [(string)$c['cover'], isset($c['base']) && $c['base'] !== null ? (int)$c['base'] : null];
    }
    return $out;
};

// latest METAR per station
$metar = [];
foreach (is_array($metarList) ? $metarList : [] as $o) {
    if (!isset($o['icaoId'], $o['lat'], $o['lon'], $o['obsTime'])) continue;
    $id = (string)$o['icaoId'];
    if (isset($metar[$id]) && $metar[$id]['time'] >= (int)$o['obsTime']) continue;
    $raw = (string)($o['rawOb'] ?? '');
    $metar[$id] = [
        'name' => (string)($o['name'] ?? $id), 'lat' => (float)$o['lat'], 'lon' => (float)$o['lon'], 'time' => (int)$o['obsTime'],
        'clouds' => $clouds($o['clouds'] ?? []), 'cavok' => (bool)preg_match('/\bCAVOK\b/', $raw), 'wx' => (string)($o['wxString'] ?? ''),
    ];
}
$taf = [];
foreach (is_array($tafList) ? $tafList : [] as $t) {
    if (!isset($t['icaoId'], $t['lat'], $t['lon'])) continue;
    $f = [];
    foreach ($t['fcsts'] ?? [] as $x) {
        $f[] = ['from' => (int)($x['timeFrom'] ?? 0), 'to' => (int)($x['timeTo'] ?? 0), 'change' => $x['fcstChange'] ?? null, 'prob' => $x['probability'] ?? null,
                'clouds' => $clouds($x['clouds'] ?? []), 'wx' => (string)($x['wxString'] ?? '')];
    }
    $taf[(string)$t['icaoId']] = ['name' => (string)($t['name'] ?? $t['icaoId']), 'lat' => (float)$t['lat'], 'lon' => (float)$t['lon'],
        'from' => (int)($t['validTimeFrom'] ?? 0), 'to' => (int)($t['validTimeTo'] ?? 0), 'fcsts' => $f];
}

// per requested point: the nearest representative METAR station and TAF station
$nearest = function (array $set, float $la, float $lo, float $maxKm): ?array {
    $best = null;
    foreach ($set as $id => $s) {
        $km = av_km($la, $lo, $s['lat'], $s['lon']);
        if ($km <= $maxKm && ($best === null || $km < $best['km'])) $best = ['id' => $id, 'km' => round($km, 1)];
    }
    return $best;
};
$points = [];
$usedM = $usedT = [];
foreach ($pts as [$la, $lo]) {
    $m = $nearest($metar, $la, $lo, AV_METAR_KM);
    $f = $nearest($taf, $la, $lo, AV_TAF_KM);
    if ($m) $usedM[$m['id']] = $metar[$m['id']];
    if ($f) $usedT[$f['id']] = $taf[$f['id']];
    $points[] = ['metar' => $m, 'taf' => $f];
}
$out = json_encode(['now' => time(), 'points' => $points, 'metar' => (object)$usedM, 'taf' => (object)$usedT], JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
$pdo->prepare('INSERT OR REPLACE INTO cache (k, body, fetched_at) VALUES (?, ?, ?)')->execute([$key, $out, time()]);
header('Content-Type: application/json; charset=utf-8');
header('X-Cache: MISS');
echo $out;
