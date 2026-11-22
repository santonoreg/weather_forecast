<?php
// POSEIDON weather forecasting system of the Hellenic Centre for Marine Research (HCMR), as one more model in the comparison.
// Included by api/forecast.php. It is the SKIRON/Eta non-hydrostatic model run by HCMR with the University of Athens and Harokopio
// University: 1/20° (~5 km), 3-hourly output, 5.5 days, domain Mediterranean / Europe / N. Africa, own LAPS data assimilation
// (METAR, SYNOP, RAOB); the GFS gives the first guess and the boundary conditions. https://poseidon.hcmr.gr/components/forecasting-components/meteo
//
// WHERE THE DATA COMES FROM — read this before relying on it. The documented POSEIDON API (api.poseidon.hcmr.gr, swagger) serves
// OBSERVATIONS only and needs credentials. The forecast comes from the point endpoint that the website's own map uses,
//     https://nodejs.hcmr.gr/forB/METEO/<lat>/<lon>
// which is NOT documented. It can change without notice (then this source silently disappears), and the site's terms say the content is
// for personal use and that any other use needs HCMR's permission (https://poseidon.hcmr.gr/terms-use-disclaimer): ask poseidon@hcmr.gr
// if WeFO is used beyond a personal installation. It can be switched off with 'poseidon_enabled' => false (api/config.php) or WEFO_POSEIDON_ENABLED=0.
//
// What the endpoint returns: 45 entries { date: UTC, data: "t2m,w10,wangle,cloud,snow,rain,seag" } (field names from the website's own code):
//   t2m °C · w10 m/s (10 m wind) · wangle = wind direction + 180 deg (so the "from" direction is wangle + 180; checked against ECMWF and GFS at
//   8 Greek places: mean error 16°, against 149° without the +180) · cloud = an index 0 … ~17, not a percentage (the site's icons: > 2 not clear,
//   ≤ 4 partly cloudy, ≤ 8 cloudy, ≥ 9 overcast; it correlates 0.5 with the cloud cover of ECMWF/GFS) · snow, rain = mm per 3 h
//   (about the same total as ECMWF/GFS) · seag = sea-level pressure hPa.
// Not provided: humidity, gusts, CAPE, visibility, a weather code. There is no height correction: it is the value of the ~5 km grid cell.
declare(strict_types=1);

const POSEIDON_URL = 'https://nodejs.hcmr.gr/forB/METEO';
const POSEIDON_TIMEOUT = 15;
const POSEIDON_STEP_H = 3;            // hours between the entries (and the length of the rain block)
const POSEIDON_CLOUD_SCALE = 10;      // cloud % = index * this, limited to 100 (an approximation: the index is not documented)

function poseidon_enabled(): bool
{
    $v = app_config()['poseidon_enabled'] ?? true;
    if (is_string($v)) $v = !in_array(strtolower(trim($v)), ['0', 'false', 'off', 'no', ''], true);
    return (bool)$v;
}

/* The WMO-style code of an hour from what POSEIDON gives (it has none): precipitation first, then the site's own cloud thresholds */
function poseidon_code(float $rain, float $snow, float $temp, float $cloud): int
{
    if ($snow > 0.2) return 73;
    if ($rain >= 0.1) return $temp <= 0.5 ? 73 : ($rain >= 4 ? 65 : ($rain >= 0.3 ? 61 : 51));
    return $cloud <= 2 ? 0 : ($cloud <= 4 ? 1 : ($cloud <= 8 ? 2 : 3));
}

/* Returns a provider block in api/forecast.php's format (hourly arrays aligned with $time, local time, $offset seconds from UTC), or null. */
function fetch_poseidon(float $lat, float $lon, array $time, int $offset, array $vars): ?array
{
    $body = http_get(POSEIDON_URL . '/' . number_format($lat, 4, '.', '') . '/' . number_format($lon, 4, '.', ''), POSEIDON_TIMEOUT);
    $j = $body ? json_decode($body, true) : null;
    if (!is_array($j)) return null;
    $pts = [];
    foreach ($j as $r) {
        if (!is_array($r) || empty($r['date']) || !isset($r['data']) || !is_string($r['data'])) continue;   // outside the domain: no "data"
        $p = explode(',', $r['data']);
        if (count($p) < 7) continue;
        foreach ($p as $x) if (!is_numeric($x)) continue 2;
        $t = strtotime((string)$r['date']);
        if ($t === false) continue;
        $v = array_map('floatval', $p);
        $sp = $v[1]; $dir = fmod($v[2] + 180 + 720, 360);
        $pts[] = ['t' => $t, 'T' => $v[0], 'ws' => $sp, 'u' => $sp * sin(deg2rad($dir)), 'v' => $sp * cos(deg2rad($dir)), 'c' => $v[3], 'sn' => $v[4], 'r' => $v[5], 'p' => $v[6]];
    }
    if (count($pts) < 3) return null;
    usort($pts, fn($a, $b) => $a['t'] <=> $b['t']);

    $h = array_fill_keys($vars, []);
    $h['precip_3h_block'] = [];       // 1 = this hour's rain is a 3 h total split evenly, not a real hourly value (the UI ignores it for steps shorter than 3 h)
    $n = count($pts);
    $k = 0;
    foreach ($time as $localStr) {
        $t = strtotime($localStr . ' UTC') - $offset;       // local time -> UTC
        if ($t < $pts[0]['t'] || $t > $pts[$n - 1]['t']) {
            foreach ($vars as $x) $h[$x][] = null;
            $h['precip_3h_block'][] = 0;
            continue;
        }
        while ($k + 1 < $n && $pts[$k + 1]['t'] < $t) $k++;   // pts[k].t <= t (or t is inside the first block), pts[k+1].t >= t
        $a = $pts[$k]; $b = $pts[min($k + 1, $n - 1)];
        $f = $b['t'] > $a['t'] ? max(0.0, min(1.0, ($t - $a['t']) / ($b['t'] - $a['t']))) : 0.0;
        $lerp = fn(string $key) => $a[$key] + ($b[$key] - $a[$key]) * $f;
        // the rain of the block that ENDS at the first entry at or after t (the entries are accumulations of the preceding 3 h; checked: correlation 0.85 with ECMWF/GFS, 0.81 the other way)
        $e = ($a['t'] === $t) ? $a : $b;
        $hasBlock = $e['t'] > $pts[0]['t'];                 // the first entry has no preceding block
        $gap = max(1.0, ($e['t'] - ($a['t'] === $t ? ($k > 0 ? $pts[$k - 1]['t'] : $e['t'] - POSEIDON_STEP_H * 3600) : $a['t'])) / 3600);
        $rain = $hasBlock ? $e['r'] / $gap : null; $snow = $hasBlock ? $e['sn'] / $gap : null;
        $temp = $lerp('T'); $cloud = $lerp('c');
        $spd = hypot($lerp('u'), $lerp('v'));
        $dirOut = $spd > 0.05 ? (int)round(fmod(rad2deg(atan2($lerp('u'), $lerp('v'))) + 360, 360)) : null;
        $h['temperature_2m'][] = round($temp, 1);
        $h['apparent_temperature'][] = null;
        $h['precipitation'][] = $hasBlock ? round($rain + $snow, 2) : null;
        $h['wind_speed_10m'][] = round($lerp('ws') * 3.6, 1);
        $h['wind_gusts_10m'][] = null;
        $h['wind_direction_10m'][] = $dirOut;
        $h['cloud_cover'][] = (int)round(max(0.0, min(100.0, $cloud * POSEIDON_CLOUD_SCALE)));
        $h['relative_humidity_2m'][] = null;
        $h['pressure_msl'][] = round($lerp('p'), 1);
        $h['weather_code'][] = poseidon_code($rain ?? 0.0, $snow ?? 0.0, $temp, $cloud);
        $h['cape'][] = null;
        $h['lifted_index'][] = null;
        $h['convective_inhibition'][] = null;
        $h['is_day'][] = null;
        $h['precip_3h_block'][] = $hasBlock ? 1 : 0;
    }
    return ['id' => 'poseidon_meteo', 'hourly' => $h];
}
