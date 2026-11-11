<?php
// Driving route between two points in Greece from OpenRouteService (https://openrouteservice.org): up to three alternatives with
// distance, duration, elevation, the stretches on toll roads and a duration timetable (so the weather can be looked up at the time
// you really pass each place). The toll plazas on the route and their prices come from our own table (data/tolls_gr.json).
// The key never leaves the server; results are cached for 6 hours.
declare(strict_types=1);
require __DIR__ . '/db.php';
require __DIR__ . '/route_lib.php';

const ROUTE_TTL = 21600;
const GR_BOX = [34.5, 42.0, 19.0, 30.0];          // lat min, lat max, lon min, lon max: Greece with its islands

function route_ll(string $s): ?array
{
    $p = explode(',', $s);
    if (count($p) !== 2) return null;
    $la = filter_var($p[0], FILTER_VALIDATE_FLOAT);
    $lo = filter_var($p[1], FILTER_VALIDATE_FLOAT);
    if ($la === false || $lo === false || abs($la) > 90 || abs($lo) > 180) return null;
    return [round($la, 4), round($lo, 4)];
}
$from = route_ll((string)($_GET['from'] ?? ''));
$to = route_ll((string)($_GET['to'] ?? ''));
if (!$from || !$to) json_out(['error' => 'Invalid points'], 400);
foreach ([$from, $to] as $p) {
    if ($p[0] < GR_BOX[0] || $p[0] > GR_BOX[1] || $p[1] < GR_BOX[2] || $p[1] > GR_BOX[3]) json_out(['error' => 'not_greece'], 400);
}
if (abs($from[0] - $to[0]) < 0.001 && abs($from[1] - $to[1]) < 0.001) json_out(['error' => 'same_point'], 400);
$key = (string)(app_config()['ors_api_key'] ?? '');
if ($key === '') json_out(['error' => 'no_key'], 503);

$tollFile = __DIR__ . '/../data/tolls_gr.json';
$tollData = is_file($tollFile) ? json_decode((string)file_get_contents($tollFile), true) : null;

$pdo = db();
$ck = 'route:gr:' . md5(json_encode([$from, $to, $tollData['asof'] ?? '']));
$st = $pdo->prepare('SELECT body, fetched_at FROM cache WHERE k = ?');
$st->execute([$ck]);
if (empty($_GET['refresh']) && ($row = fetch_one($st)) && time() - (int)$row['fetched_at'] < ROUTE_TTL) {
    header('Content-Type: application/json; charset=utf-8');
    header('X-Cache: HIT');
    echo $row['body'];
    exit;
}

function ors_directions(string $key, array $body): array
{
    $ch = curl_init('https://api.openrouteservice.org/v2/directions/driving-car/geojson');
    curl_setopt_array($ch, [
        CURLOPT_RETURNTRANSFER => true, CURLOPT_TIMEOUT => 40, CURLOPT_POST => true, CURLOPT_ENCODING => '',
        CURLOPT_POSTFIELDS => json_encode($body),
        CURLOPT_HTTPHEADER => ['Authorization: ' . $key, 'Content-Type: application/json; charset=utf-8', 'Accept: application/geo+json'],
        CURLOPT_USERAGENT => 'wefo-weather-compare/1.0 (personal project)',
        CURLOPT_SSL_VERIFYPEER => false,
    ]);
    $out = curl_exec($ch);
    $code = (int)curl_getinfo($ch, CURLINFO_RESPONSE_CODE);
    curl_close($ch);
    return [$code, $out === false ? null : json_decode((string)$out, true)];
}

$req = [
    'coordinates' => [[$from[1], $from[0]], [$to[1], $to[0]]],
    'elevation' => true, 'instructions' => true, 'units' => 'km', 'language' => 'en',
    'extra_info' => ['tollways'], 'radiuses' => [3000, 3000],
];
[$code, $j] = ors_directions($key, $req + ['alternative_routes' => ['target_count' => 3, 'share_factor' => 0.6, 'weight_factor' => 1.6]]);
// alternatives are refused for very long routes: ask again for the single best one
if ($code >= 400 && $code < 500 && !in_array($code, [401, 403, 404, 429], true)) [$code, $j] = ors_directions($key, $req);
if ($code === 401 || $code === 403) json_out(['error' => 'bad_key'], 502);
if ($code === 429) json_out(['error' => 'quota'], 429);
$routes = $code === 200 && is_array($j) ? ors_routes($j) : [];
if (!$routes) {
    $msg = is_array($j) ? (is_array($j['error'] ?? null) ? (string)($j['error']['message'] ?? '') : (string)($j['error'] ?? '')) : '';
    json_out(['error' => 'no_route', 'detail' => $msg], 502);
}
$plazas = $tollData['plazas'] ?? [];
foreach ($routes as &$r) {
    $r['tolls'] = route_tolls($r['pts'], $r['cum'], $plazas);
    $priced = array_filter($r['tolls'], fn($t) => $t['p'] !== null);
    $r['tollCost'] = round(array_sum(array_column($priced, 'p')), 2);
    $r['tollCur'] = 'EUR';
}
unset($r);
$out = json_encode(['from' => $from, 'to' => $to, 'tollAsOf' => $tollData['asof'] ?? null, 'routes' => $routes], JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
$pdo->prepare('INSERT OR REPLACE INTO cache (k, body, fetched_at) VALUES (?, ?, ?)')->execute([$ck, $out, time()]);
header('Content-Type: application/json; charset=utf-8');
header('X-Cache: MISS');
echo $out;
