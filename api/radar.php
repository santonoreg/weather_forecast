<?php
// "Next break" / "starts in": a short-term rain nowcast from RainViewer's public radar composite
// (https://www.rainviewer.com), sampled at the exact point rather than shown as a map — real radar
// data, not a model forecast. Free, global, no API key. Degrades gracefully: if RainViewer has no
// nowcast frames available right now (it sometimes doesn't), we still report whether it's raining
// right now per the latest radar frame, just without a "changes at" prediction.
declare(strict_types=1);
require __DIR__ . '/db.php';

const RADAR_META_TTL = 150;   // the frame list itself (same for every location)
const RADAR_TILE_TTL = 900;   // one decoded point-sample per (frame, tile)
const RADAR_ZOOM = 7;         // ~1 pixel per ~1.1 km at the equator — plenty for a point sample

function tile_xy(float $lat, float $lon, int $zoom): array
{
    $n = 2 ** $zoom;
    $fx = ($lon + 180) / 360 * $n;
    $latRad = deg2rad(max(-85.05, min(85.05, $lat)));
    $fy = (1 - log(tan($latRad) + 1 / cos($latRad)) / M_PI) / 2 * $n;
    return [(int)floor($fx), (int)floor($fy), (int)floor(($fx - floor($fx)) * 256), (int)floor(($fy - floor($fy)) * 256)];
}

// Sample one frame's tile at our point: true = precipitation, false = clear, null = fetch/decode failed
function sample_frame(PDO $pdo, string $host, string $path, int $x, int $y, int $px, int $py): ?bool
{
    $key = "rv:$path:$x:$y";
    $st = $pdo->prepare('SELECT body, fetched_at FROM cache WHERE k = ?');
    $st->execute([$key]);
    if (($row = $st->fetch()) && time() - (int)$row['fetched_at'] < RADAR_TILE_TTL) {
        return $row['body'] === '' ? null : $row['body'] === '1';
    }
    $url = "$host$path/256/" . RADAR_ZOOM . "/$x/$y/2/1_1.png";
    $body = http_get($url, 15);
    $wet = null;
    if ($body !== null && ($im = @imagecreatefromstring($body))) {
        $idx = imagecolorat($im, $px, $py);
        $c = imagecolorsforindex($im, $idx);
        // Real precipitation echoes are saturated colour (blue/green/yellow/red) and reasonably opaque;
        // basemap overlay lines (coastlines, borders) are near-grey/black and much more transparent.
        $sat = max($c['red'], $c['green'], $c['blue']) - min($c['red'], $c['green'], $c['blue']);
        $wet = $c['alpha'] < 110 && $sat > 20;
    }
    $pdo->prepare('INSERT OR REPLACE INTO cache (k, body, fetched_at) VALUES (?, ?, ?)')->execute([$key, $wet === null ? '' : ($wet ? '1' : '0'), time()]);
    return $wet;
}

$lat = filter_var($_GET['lat'] ?? null, FILTER_VALIDATE_FLOAT);
$lon = filter_var($_GET['lon'] ?? null, FILTER_VALIDATE_FLOAT);
if ($lat === false || $lon === false || abs($lat) > 90 || abs($lon) > 180) json_out(['error' => 'Invalid coordinates'], 400);

$pdo = db();

$metaKey = 'rv:meta';
$st = $pdo->prepare('SELECT body, fetched_at FROM cache WHERE k = ?');
$st->execute([$metaKey]);
if (($row = $st->fetch()) && time() - (int)$row['fetched_at'] < RADAR_META_TTL) {
    $meta = json_decode($row['body'], true);
} else {
    $body = http_get('https://api.rainviewer.com/public/weather-maps.json', 15);
    $meta = $body ? json_decode($body, true) : null;
    if ($meta) $pdo->prepare('INSERT OR REPLACE INTO cache (k, body, fetched_at) VALUES (?, ?, ?)')->execute([$metaKey, $body, time()]);
}

$past = $meta['radar']['past'] ?? [];
$nowcast = $meta['radar']['nowcast'] ?? [];
if (!$past || !isset($meta['host'])) json_out(['radar' => null]);

[$x, $y, $px, $py] = tile_xy($lat, $lon, RADAR_ZOOM);
$host = $meta['host'];

$nowFrame = end($past);
$nowWet = sample_frame($pdo, $host, $nowFrame['path'], $x, $y, $px, $py);
if ($nowWet === null) json_out(['radar' => null]);

$changeAt = null;
$horizonMin = 0;
foreach ($nowcast as $f) {
    $wet = sample_frame($pdo, $host, $f['path'], $x, $y, $px, $py);
    $horizonMin = (int)round(((int)$f['time'] - (int)$nowFrame['time']) / 60);
    if ($wet === null) break;
    if ($wet !== $nowWet) { $changeAt = (int)$f['time']; break; }
}

json_out(['radar' => [
    'now' => $nowWet,
    'changeAt' => $changeAt ? gmdate('c', $changeAt) : null,
    'horizonMin' => $horizonMin,
]]);
