<?php
// The logged-in user's own cars: GET list · POST {name, kind p|d|h|e, cons} · DELETE ?id=
declare(strict_types=1);
require __DIR__ . '/db.php';
require_once __DIR__ . '/auth_lib.php';

$pdo = db();
$me = auth_user();
$method = $_SERVER['REQUEST_METHOD'];

if ($method === 'GET') {
    $st = $pdo->prepare('SELECT id, name, kind, cons FROM user_cars WHERE user_id = ? ORDER BY name COLLATE NOCASE');
    $st->execute([$me['id']]);
    json_out(['cars' => $st->fetchAll()]);
}
if ($method === 'POST') {
    $in = json_decode(file_get_contents('php://input'), true) ?: [];
    $name = trim((string)($in['name'] ?? ''));
    $kind = (string)($in['kind'] ?? '');
    $cons = filter_var($in['cons'] ?? null, FILTER_VALIDATE_FLOAT);
    if ($name === '' || !in_array($kind, ['p', 'd', 'h', 'e'], true) || $cons === false || $cons <= 0 || $cons > 100) json_out(['error' => 'Invalid car data'], 400);
    $name = function_exists('mb_substr') ? mb_substr($name, 0, 80) : substr($name, 0, 120);
    $cnt = $pdo->prepare('SELECT COUNT(*) FROM user_cars WHERE user_id = ?');
    $cnt->execute([$me['id']]);
    if ((int)fetch_col($cnt) >= 50) json_out(['error' => 'Too many cars (50 at most)'], 400);
    $pdo->prepare('INSERT INTO user_cars (user_id, name, kind, cons) VALUES (?, ?, ?, ?)')->execute([$me['id'], $name, $kind, round($cons, 2)]);
    json_out(['id' => (int)$pdo->lastInsertId(), 'name' => $name, 'kind' => $kind, 'cons' => round($cons, 2)], 201);
}
if ($method === 'DELETE') {
    $pdo->prepare('DELETE FROM user_cars WHERE id = ? AND user_id = ?')->execute([(int)($_GET['id'] ?? 0), $me['id']]);
    json_out(['ok' => true]);
}
json_out(['error' => 'Method not allowed'], 405);
