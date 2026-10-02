<?php
declare(strict_types=1);
require __DIR__ . '/db.php';
require __DIR__ . '/auth_lib.php';

$pdo = db();
$method = $_SERVER['REQUEST_METHOD'];

if ($method === 'GET') {
    // Built-in Greek cities for everybody; the saved locations only for a logged-in admin
    $list = fn(string $kind) => $pdo->query("SELECT id, name, name_el, lat, lon FROM locations WHERE kind = '$kind' ORDER BY name COLLATE NOCASE")->fetchAll();
    json_out(['cities' => $list('city'), 'saved' => auth_is_admin() ? $list('saved') : []]);
}

auth_require();   // saving and deleting locations is admin-only

if ($method === 'POST') {
    $in = json_decode(file_get_contents('php://input'), true) ?: [];
    $name = trim((string)($in['name'] ?? ''));
    $lat = filter_var($in['lat'] ?? null, FILTER_VALIDATE_FLOAT);
    $lon = filter_var($in['lon'] ?? null, FILTER_VALIDATE_FLOAT);
    if ($name === '' || $lat === false || $lon === false || abs($lat) > 90 || abs($lon) > 180) {
        json_out(['error' => 'Invalid location data'], 400);
    }
    $st = $pdo->prepare("INSERT INTO locations (name, lat, lon, kind) VALUES (?, ?, ?, 'saved')");
    $st->execute([(function_exists('mb_substr') ? mb_substr($name, 0, 120) : substr($name, 0, 200)), round($lat, 5), round($lon, 5)]);
    json_out(['id' => (int)$pdo->lastInsertId(), 'name' => $name, 'lat' => $lat, 'lon' => $lon], 201);
}

if ($method === 'DELETE') {
    $id = (int)($_GET['id'] ?? 0);
    $del = $pdo->prepare("DELETE FROM locations WHERE id = ? AND kind = 'saved'");   // the built-in cities can't be deleted
    $del->execute([$id]);
    if ($del->rowCount()) {
        $pdo->prepare('DELETE FROM history_daily WHERE loc_id = ?')->execute([$id]);
        $pdo->prepare('DELETE FROM history_meta WHERE loc_id = ?')->execute([$id]);
    }
    json_out(['ok' => true]);
}

json_out(['error' => 'Method not allowed'], 405);
