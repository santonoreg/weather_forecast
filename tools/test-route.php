<?php
// php tools/test-route.php — checks api/route_lib.php (OpenRouteService answer → Trip route format, toll plaza matching) and
// data/tolls_gr.json against hand-made data. No network, no key needed.
declare(strict_types=1);
require __DIR__ . '/../api/route_lib.php';

$fail = 0;
function check(string $what, bool $ok, string $extra = ''): void
{
    global $fail;
    echo ($ok ? 'ok   ' : 'FAIL ') . $what . ($ok ? '' : ' ' . $extra) . "\n";
    if (!$ok) $fail++;
}

// ---- the toll table itself
$tb = json_decode((string)file_get_contents(__DIR__ . '/../data/tolls_gr.json'), true);
$pl = $tb['plazas'] ?? [];
check('toll table loads, has an as-of date', count($pl) > 80 && !empty($tb['asof']), (string)count($pl));
$bad = array_filter($pl, fn($p) => $p['lat'] < 34.5 || $p['lat'] > 42 || $p['lon'] < 19 || $p['lon'] > 28.5 || ($p['price'] !== null && ($p['price'] <= 0 || $p['price'] > 20)));
check('every plaza is inside Greece with a sane price', !$bad, json_encode(array_values($bad)));

// ---- ORS geojson → compact route (one route, 5 points, elevation, tollways flag on the middle)
$ors = ['features' => [[
    'geometry' => ['coordinates' => [[22.94, 40.64, 10], [22.7, 40.60, 90], [22.57, 40.52, 300], [22.0, 39.9, 150], [23.73, 37.98, 100]]],
    'properties' => [
        'summary' => ['distance' => 400.0, 'duration' => 14400.0], 'ascent' => 300.0, 'descent' => 210.0,
        'segments' => [['steps' => [['way_points' => [0, 2], 'duration' => 3000.0, 'name' => 'Egnatia'], ['way_points' => [2, 4], 'duration' => 11400.0, 'name' => 'E75']]]],
        'extras' => ['tollways' => ['values' => [[0, 2, 0], [2, 4, 1]]]],
    ],
]]];
$r = ors_routes($ors);
check('one route', count($r) === 1);
$o = $r[0];
check('distance, time, climb from ORS', $o['km'] === 400.0 && $o['sec'] === 14400 && $o['ascent'] === 300 && $o['descent'] === 210);
check('points are [lat, lon] and the km table ends at the total', $o['pts'][0] === [40.64, 22.94] && abs($o['cum'][count($o['cum']) - 1] - 400.0) < 0.01, json_encode([$o['pts'][0], $o['cum']]));
check('steps keep duration and road name', count($o['steps']) === 2 && $o['steps'][0][2] === 3000 && $o['steps'][1][3] === 'E75' && $o['steps'][0][1] === $o['steps'][1][0], json_encode($o['steps']));
check('toll road stretch from the extra info', count($o['toll']) === 1 && $o['toll'][0][1] > $o['toll'][0][0], json_encode($o['toll']));

// ---- toll plazas on a route: it passes Malgara and Kleidi, but not Thessaloniki-Egnatia or the Rio bridge
$by = [];
foreach ($pl as $p) $by[$p['name']] = $p;
$route = [[40.70, 22.9], [$by['Malgara']['lat'], $by['Malgara']['lon']], [40.55, 22.6], [$by['Kleidi']['lat'], $by['Kleidi']['lon']], [40.3, 22.4]];
$cum = [0.0, 20.0, 50.0, 60.0, 90.0];
$t = route_tolls($route, $cum, $pl);
$names = array_column($t, 'n');
check('Malgara and Kleidi are found, in route order', $names === ['Malgara', 'Kleidi'], json_encode($names));
check('their prices and km along the route', $t[0]['p'] === 1.15 && $t[1]['p'] === 2.6 && $t[0]['km'] === 20.0 && $t[1]['km'] === 60.0, json_encode($t));
// a route that only runs nearby (about 400 m away) does not pay
$near = [[$by['Kleidi']['lat'] + 0.004, $by['Kleidi']['lon'] - 0.01], [$by['Kleidi']['lat'] + 0.004, $by['Kleidi']['lon'] + 0.01]];
check('a parallel road 400 m away is not charged', route_tolls($near, [0.0, 1.7], $pl) === []);
exit($fail ? 1 : 0);
