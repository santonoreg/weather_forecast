<?php
// Driving route between two points from OpenRouteService (https://openrouteservice.org): up to three alternatives with
// distance, duration, elevation, the stretches on toll roads and a duration timetable (so the weather can be looked up at the
// time you really pass each place). The key never leaves the server; results are cached for 6 hours.
declare(strict_types=1);
require __DIR__ . '/db.php';

const ROUTE_TTL = 21600;

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
if (abs($from[0] - $to[0]) < 0.001 && abs($from[1] - $to[1]) < 0.001) json_out(['error' => 'same_point'], 400);
$key = (string)(app_config()['ors_api_key'] ?? '');
if ($key === '') json_out(['error' => 'no_key'], 503);

$pdo = db();
$ck = 'route:' . md5(json_encode([$from, $to]));
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
if ($code !== 200 || !isset($j['features'][0])) {
    $msg = is_array($j['error'] ?? null) ? ($j['error']['message'] ?? '') : (string)($j['error'] ?? '');
    json_out(['error' => 'no_route', 'detail' => $msg], 502);
}

$routes = [];
foreach ($j['features'] as $f) {
    $co = $f['geometry']['coordinates'] ?? [];
    if (count($co) < 2) continue;
    $pr = $f['properties'];
    $totalKm = (float)($pr['summary']['distance'] ?? 0);
    // cumulative distance along the line, then thin it out (about 1 600 points at most)
    $cum = [0.0];
    for ($i = 1; $i < count($co); $i++) {
        $dLa = deg2rad($co[$i][1] - $co[$i - 1][1]);
        $dLo = deg2rad($co[$i][0] - $co[$i - 1][0]);
        $a = sin($dLa / 2) ** 2 + cos(deg2rad($co[$i - 1][1])) * cos(deg2rad($co[$i][1])) * sin($dLo / 2) ** 2;
        $cum[] = $cum[$i - 1] + 6371.0 * 2 * atan2(sqrt($a), sqrt(1 - $a));
    }
    $last = count($cum) - 1;
    $scale = $cum[$last] > 0 ? $totalKm / $cum[$last] : 1.0;     // match ORS's own total
    $gap = max(0.25, $totalKm / 1600);
    $keep = [0];
    $prev = 0.0;
    for ($i = 1; $i < $last; $i++) {
        if ($cum[$i] - $prev >= $gap) { $keep[] = $i; $prev = $cum[$i]; }
    }
    $keep[] = $last;
    $pts = []; $kmArr = []; $el = [];
    foreach ($keep as $i) {
        $pts[] = [round($co[$i][1], 5), round($co[$i][0], 5)];
        $kmArr[] = round($cum[$i] * $scale, 2);
        $el[] = isset($co[$i][2]) ? (int)round($co[$i][2]) : null;
    }
    // timetable and road names from the steps
    $steps = [];
    foreach ($pr['segments'] ?? [] as $sg) {
        foreach ($sg['steps'] ?? [] as $s) {
            $w = $s['way_points'] ?? [0, 0];
            $steps[] = [round($cum[min($w[0], $last)] * $scale, 2), round($cum[min($w[1], $last)] * $scale, 2), (int)round($s['duration'] ?? 0), (string)($s['name'] ?? '')];
        }
    }
    // toll roads: ranges of coordinate indices flagged 1
    $toll = [];
    foreach ($pr['extras']['tollways']['values'] ?? [] as $r) {
        if ((int)$r[2] === 1) $toll[] = [round($cum[min($r[0], $last)] * $scale, 2), round($cum[min($r[1], $last)] * $scale, 2)];
    }
    $routes[] = [
        'km' => round($totalKm, 1), 'sec' => (int)round($pr['summary']['duration'] ?? 0),
        'ascent' => isset($pr['ascent']) ? (int)round($pr['ascent']) : null, 'descent' => isset($pr['descent']) ? (int)round($pr['descent']) : null,
        'pts' => $pts, 'cum' => $kmArr, 'ele' => $el, 'steps' => $steps, 'toll' => $toll,
    ];
}
if (!$routes) json_out(['error' => 'no_route'], 502);
$out = json_encode(['from' => $from, 'to' => $to, 'routes' => $routes], JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
$pdo->prepare('INSERT OR REPLACE INTO cache (k, body, fetched_at) VALUES (?, ?, ?)')->execute([$ck, $out, time()]);
header('Content-Type: application/json; charset=utf-8');
header('X-Cache: MISS');
echo $out;
