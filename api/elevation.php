<?php
// Terrain height (m) of a point from Open-Meteo's elevation API — the default shown in the "Elevation" field of the Locations form.
// GET api/elevation.php?lat=..&lon=..  ->  {"elevation": 99}  (null when the service does not answer)
declare(strict_types=1);
require __DIR__ . '/db.php';
$lat = filter_var($_GET['lat'] ?? null, FILTER_VALIDATE_FLOAT);
$lon = filter_var($_GET['lon'] ?? null, FILTER_VALIDATE_FLOAT);
if ($lat === false || $lon === false || abs($lat) > 90 || abs($lon) > 180) json_out(['error' => 'Invalid coordinates'], 400);
$body = http_get('https://api.open-meteo.com/v1/elevation?' . http_build_query(['latitude' => round($lat, 4), 'longitude' => round($lon, 4)]), 8);
$j = $body ? json_decode($body, true) : null;
json_out(['elevation' => isset($j['elevation'][0]) && is_numeric($j['elevation'][0]) ? (float)$j['elevation'][0] : null]);
