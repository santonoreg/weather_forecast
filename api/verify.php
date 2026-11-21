<?php
// Model verification endpoint: GET api/verify.php?lat=&lon=
//
// The heavy work (dozens of stations x models x lead times) lives in api/verify_lib.php and is meant to be done
// once a night by `php tools/verify-cron.php`, which fills the cache. This endpoint only SERVES the cache:
//   fresh cache            -> returned as is;
//   stale cache            -> still returned at once (marked "stale": true), and, where PHP-FPM allows it, refreshed in the
//                             background after the response has been sent — the visitor never waits for it;
//   no cache at all        -> computed now, lead 0 only (the old behaviour: it can take a few minutes the first time).
declare(strict_types=1);
require __DIR__ . '/verify_lib.php';

$lat = filter_var($_GET['lat'] ?? null, FILTER_VALIDATE_FLOAT);
$lon = filter_var($_GET['lon'] ?? null, FILTER_VALIDATE_FLOAT);
if ($lat === false || $lon === false || abs($lat) > 90 || abs($lon) > 180) json_out(['error' => 'Invalid coordinates'], 400);
$lat = round($lat, 2);
$lon = round($lon, 2);

$pdo = db();
$key = verify_cache_key($lat, $lon);
$get = function (string $k) use ($pdo): ?array {
    $st = $pdo->prepare('SELECT body, fetched_at FROM cache WHERE k = ?');
    $st->execute([$k]);
    return fetch_one($st) ?: null;
};
header('Content-Type: application/json; charset=utf-8');

$row = $get($key);
// fresh or stale, the per-station block is replaced by the weights tilted towards the stations near this location
$send = function (string $json, bool $stale, int $fetchedAt) use ($lat, $lon): void {
    $body = json_decode($json, true);
    if (!is_array($body)) { echo $json; return; }
    if ($stale) { $body['stale'] = true; $body['computed_at'] = $body['computed_at'] ?? gmdate('c', $fetchedAt); }
    echo json_encode(verify_present($body, $lat, $lon), JSON_UNESCAPED_UNICODE);
};
if ($row && time() - (int)$row['fetched_at'] < VERIFY_TTL) { $send($row['body'], false, (int)$row['fetched_at']); exit; }

// the result format before lead times (vf3) is still good data while nothing newer exists
if (!$row) {
    $old = $get(in_greece($lat, $lon) ? 'vf3:greece' : "vf3:$lat:$lon");
    if ($old) $row = $old + ['legacy' => true];
}

if ($row) {
    $send($row['body'], true, (int)$row['fetched_at']);
    // refresh after the answer has gone out (PHP-FPM only), unless another refresh is already running
    if (function_exists('fastcgi_finish_request')) {
        $lock = $get('vf4:lock:' . $key);
        if (!$lock || time() - (int)$lock['fetched_at'] > LOCK_TTL) {
            $pdo->prepare('INSERT OR REPLACE INTO cache (k, body, fetched_at) VALUES (?, ?, ?)')->execute(['vf4:lock:' . $key, '1', time()]);
            fastcgi_finish_request();
            set_time_limit(600);
            try { verify_store($pdo, $key, verify_compute($pdo, $lat, $lon, true)); } catch (Throwable $e) { /* keep serving the stale copy */ }
            $pdo->prepare('DELETE FROM cache WHERE k = ?')->execute(['vf4:lock:' . $key]);
        }
    }
    exit;
}

// nothing cached anywhere: compute now, as before (lead 0 only — the nightly job adds the lead times)
set_time_limit(280);
$res = verify_compute($pdo, $lat, $lon, false);
verify_store($pdo, $key, $res);
echo json_encode(verify_present($res, $lat, $lon), JSON_UNESCAPED_UNICODE);
