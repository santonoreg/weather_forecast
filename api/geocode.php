<?php
// Αναζήτηση τοποθεσίας (Open-Meteo Geocoding) και αντίστροφη ονομασία από συντεταγμένες (Nominatim)
declare(strict_types=1);
require __DIR__ . '/db.php';

if (isset($_GET['q'])) {
    $q = trim((string)$_GET['q']);
    if (mb_strlen($q) < 2) json_out([]);
    $body = http_get('https://geocoding-api.open-meteo.com/v1/search?count=8&language=el&name=' . rawurlencode($q));
    $res = $body ? (json_decode($body, true)['results'] ?? []) : [];
    json_out(array_map(fn($r) => [
        'name' => trim($r['name'] . (isset($r['admin1']) ? ', ' . $r['admin1'] : '') . (isset($r['country']) ? ', ' . $r['country'] : '')),
        'lat' => $r['latitude'],
        'lon' => $r['longitude'],
    ], $res));
}

if (isset($_GET['lat'], $_GET['lon'])) {
    $lat = (float)$_GET['lat'];
    $lon = (float)$_GET['lon'];
    $body = http_get("https://nominatim.openstreetmap.org/reverse?format=jsonv2&zoom=12&accept-language=el&lat=$lat&lon=$lon");
    $j = $body ? json_decode($body, true) : null;
    $a = $j['address'] ?? [];
    $place = $a['city'] ?? $a['town'] ?? $a['village'] ?? $a['municipality'] ?? $a['county'] ?? null;
    json_out(['name' => $place ? $place . (isset($a['country']) ? ', ' . $a['country'] : '') : null]);
}

json_out(['error' => 'Λείπουν παράμετροι'], 400);
