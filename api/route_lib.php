<?php
// Helpers for the Trip tab's route search (api/route.php): the OpenRouteService answer → the compact route format the page uses,
// and the toll plazas a route passes (our own table for Greece, data/tolls_gr.json).
declare(strict_types=1);

function route_km(float $la1, float $lo1, float $la2, float $lo2): float
{
    $dLa = deg2rad($la2 - $la1);
    $dLo = deg2rad($lo2 - $lo1);
    $a = sin($dLa / 2) ** 2 + cos(deg2rad($la1)) * cos(deg2rad($la2)) * sin($dLo / 2) ** 2;
    return 6371.0 * 2 * atan2(sqrt($a), sqrt(1 - $a));
}

/* total climb / descent with a 10 m hysteresis, so elevation noise does not add up */
function route_climb(array $ele): array
{
    $up = 0.0;
    $down = 0.0;
    $ref = null;
    foreach ($ele as $e) {
        if ($e === null) continue;
        if ($ref === null) { $ref = $e; continue; }
        if ($e - $ref >= 10) { $up += $e - $ref; $ref = $e; }
        elseif ($ref - $e >= 10) { $down += $ref - $e; $ref = $e; }
    }
    return [(int)round($up), (int)round($down)];
}

/* distance in km from a point to the segment a–b (flat approximation, fine at plaza scale) */
function seg_dist_km(float $la, float $lo, float $la1, float $lo1, float $la2, float $lo2): float
{
    $k = cos(deg2rad($la));
    $x = ($lo - $lo1) * $k; $y = $la - $la1;
    $dx = ($lo2 - $lo1) * $k; $dy = $la2 - $la1;
    $l2 = $dx * $dx + $dy * $dy;
    $t = $l2 > 0 ? max(0.0, min(1.0, ($x * $dx + $y * $dy) / $l2)) : 0.0;
    return 111.195 * hypot($x - $t * $dx, $y - $t * $dy);
}

/* The toll plazas on a route. $plazas = [{name, lat, lon, price, road}]; a plaza counts when the route passes within $maxKm of it
   (once, however many route points are near it), and is placed at its distance along the route. */
function route_tolls(array $pts, array $cum, array $plazas, float $maxKm = 0.12): array
{
    $found = [];
    $n = count($pts);
    foreach ($plazas as $p) {
        $best = null;
        for ($i = 1; $i < $n; $i++) {
            // quick reject: far away in latitude
            if (abs($pts[$i][0] - $p['lat']) > 0.02 && abs($pts[$i - 1][0] - $p['lat']) > 0.02) continue;
            $d = seg_dist_km((float)$p['lat'], (float)$p['lon'], $pts[$i - 1][0], $pts[$i - 1][1], $pts[$i][0], $pts[$i][1]);
            if ($d <= $maxKm && ($best === null || $d < $best[0])) $best = [$d, $cum[$i]];
        }
        if ($best) $found[] = ['n' => (string)$p['name'], 'lat' => (float)$p['lat'], 'lon' => (float)$p['lon'], 'p' => isset($p['price']) ? (float)$p['price'] : null, 'c' => 'EUR', 'r' => (string)($p['road'] ?? ''), 'km' => $best[1]];
    }
    usort($found, fn($a, $b) => $a['km'] <=> $b['km']);
    return $found;
}

/* OpenRouteService geojson (alternatives, elevation, instructions, tollways extra) → compact routes */
function ors_routes(array $j): array
{
    $routes = [];
    foreach ($j['features'] ?? [] as $f) {
        $co = $f['geometry']['coordinates'] ?? [];
        if (count($co) < 2) continue;
        $pr = $f['properties'];
        $totalKm = (float)($pr['summary']['distance'] ?? 0);
        $cum = [0.0];
        for ($i = 1; $i < count($co); $i++) $cum[] = $cum[$i - 1] + route_km($co[$i - 1][1], $co[$i - 1][0], $co[$i][1], $co[$i][0]);
        $last = count($cum) - 1;
        $scale = $cum[$last] > 0 && $totalKm > 0 ? $totalKm / $cum[$last] : 1.0;     // match ORS's own total
        if ($totalKm <= 0) $totalKm = $cum[$last];
        $gap = max(0.25, $totalKm / 1600);
        $keep = [0];
        $prev = 0.0;
        for ($i = 1; $i < $last; $i++) if (($cum[$i] - $prev) * $scale >= $gap) { $keep[] = $i; $prev = $cum[$i]; }
        $keep[] = $last;
        $pts = []; $kmArr = []; $el = [];
        foreach ($keep as $i) {
            $pts[] = [round($co[$i][1], 5), round($co[$i][0], 5)];
            $kmArr[] = round($cum[$i] * $scale, 2);
            $el[] = isset($co[$i][2]) ? (int)round($co[$i][2]) : null;
        }
        $steps = [];
        foreach ($pr['segments'] ?? [] as $sg) {
            foreach ($sg['steps'] ?? [] as $s) {
                $w = $s['way_points'] ?? [0, 0];
                $steps[] = [round($cum[min($w[0], $last)] * $scale, 2), round($cum[min($w[1], $last)] * $scale, 2), (int)round($s['duration'] ?? 0), (string)($s['name'] ?? '')];
            }
        }
        $toll = [];
        foreach ($pr['extras']['tollways']['values'] ?? [] as $r) {
            if ((int)$r[2] === 1) $toll[] = [round($cum[min($r[0], $last)] * $scale, 2), round($cum[min($r[1], $last)] * $scale, 2)];
        }
        $hasEle = isset($co[0][2]);
        [$up, $down] = route_climb(array_map(fn($p) => $p[2] ?? null, $co));
        $routes[] = [
            'km' => round($totalKm, 1), 'sec' => (int)round($pr['summary']['duration'] ?? 0),
            'ascent' => isset($pr['ascent']) ? (int)round($pr['ascent']) : ($hasEle ? $up : null), 'descent' => isset($pr['descent']) ? (int)round($pr['descent']) : ($hasEle ? $down : null),
            'pts' => $pts, 'cum' => $kmArr, 'ele' => $el, 'steps' => $steps, 'toll' => $toll,
        ];
    }
    return $routes;
}
