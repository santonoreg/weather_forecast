<?php
declare(strict_types=1);
require __DIR__ . '/db.php';

$pdo = db();
$method = $_SERVER['REQUEST_METHOD'];

if ($method === 'GET') {
    json_out($pdo->query('SELECT id, name, lat, lon FROM locations ORDER BY name COLLATE NOCASE')->fetchAll());
}

if ($method === 'POST') {
    $in = json_decode(file_get_contents('php://input'), true) ?: [];
    $name = trim((string)($in['name'] ?? ''));
    $lat = filter_var($in['lat'] ?? null, FILTER_VALIDATE_FLOAT);
    $lon = filter_var($in['lon'] ?? null, FILTER_VALIDATE_FLOAT);
    if ($name === '' || $lat === false || $lon === false || abs($lat) > 90 || abs($lon) > 180) {
        json_out(['error' => 'Μη έγκυρα στοιχεία τοποθεσίας'], 400);
    }
    $st = $pdo->prepare('INSERT INTO locations (name, lat, lon) VALUES (?, ?, ?)');
    $st->execute([mb_substr($name, 0, 120), round($lat, 5), round($lon, 5)]);
    json_out(['id' => (int)$pdo->lastInsertId(), 'name' => $name, 'lat' => $lat, 'lon' => $lon], 201);
}

if ($method === 'DELETE') {
    $id = (int)($_GET['id'] ?? 0);
    $pdo->prepare('DELETE FROM locations WHERE id = ?')->execute([$id]);
    json_out(['ok' => true]);
}

json_out(['error' => 'Μη υποστηριζόμενη μέθοδος'], 405);
