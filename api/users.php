<?php
// User management, administrators only.
//   GET                                   -> { users: [{id, name, role, created, locations, cars}] }
//   POST {action:"create", name, password, role}
//   POST {action:"password", id, password}   reset somebody's password (their sessions end)
//   POST {action:"role", id, role}
//   DELETE ?id=                           delete a user with their sessions, cars and saved locations
declare(strict_types=1);
require __DIR__ . '/db.php';
require_once __DIR__ . '/auth_lib.php';
auth_require_admin();

$pdo = db();
$me = auth_user();
$method = $_SERVER['REQUEST_METHOD'];

function admins_left(PDO $pdo, int $except): int
{
    $st = $pdo->prepare("SELECT COUNT(*) FROM users WHERE role = 'admin' AND id <> ?");
    $st->execute([$except]);
    return (int)fetch_col($st);
}

if ($method === 'GET') {
    $rows = $pdo->query("SELECT u.id, u.username AS name, u.role, u.created_at AS created,
        (SELECT COUNT(*) FROM locations l WHERE l.kind = 'saved' AND l.user_id = u.id) AS locations,
        (SELECT COUNT(*) FROM user_cars c WHERE c.user_id = u.id) AS cars
        FROM users u ORDER BY u.username COLLATE NOCASE")->fetchAll();
    json_out(['users' => $rows, 'me' => $me['id']]);
}

if ($method === 'POST') {
    $in = json_decode(file_get_contents('php://input'), true) ?: [];
    $action = (string)($in['action'] ?? '');
    if ($action === 'create') {
        $name = trim((string)($in['name'] ?? ''));
        $pass = (string)($in['password'] ?? '');
        $role = ($in['role'] ?? 'user') === 'admin' ? 'admin' : 'user';
        if (!auth_valid_name($name)) json_out(['error' => 'User name: 3-40 letters, digits or . _ @ -', 'code' => 'bad_name'], 400);
        if (strlen($pass) < 8) json_out(['error' => 'The password needs at least 8 characters', 'code' => 'weak'], 400);
        $dup = $pdo->prepare('SELECT 1 FROM users WHERE username = ? COLLATE NOCASE');
        $dup->execute([$name]);
        if (fetch_one($dup)) json_out(['error' => 'That user name already exists', 'code' => 'exists'], 409);
        $pdo->prepare('INSERT INTO users (username, pass_hash, role) VALUES (?, ?, ?)')->execute([$name, password_hash($pass, PASSWORD_DEFAULT), $role]);
        json_out(['id' => (int)$pdo->lastInsertId()], 201);
    }
    $id = (int)($in['id'] ?? 0);
    $st = $pdo->prepare('SELECT id, role FROM users WHERE id = ?');
    $st->execute([$id]);
    $u = fetch_one($st);
    if (!$u) json_out(['error' => 'No such user'], 404);
    if ($action === 'password') {
        $pass = (string)($in['password'] ?? '');
        if (strlen($pass) < 8) json_out(['error' => 'The password needs at least 8 characters', 'code' => 'weak'], 400);
        $pdo->prepare('UPDATE users SET pass_hash = ? WHERE id = ?')->execute([password_hash($pass, PASSWORD_DEFAULT), $id]);
        $keep = $id === $me['id'] ? hash('sha256', (string)($_COOKIE[AUTH_COOKIE] ?? '')) : '';
        $pdo->prepare('DELETE FROM sessions WHERE user_id = ? AND token_hash <> ?')->execute([$id, $keep]);
        json_out(['ok' => true]);
    }
    if ($action === 'role') {
        $role = ($in['role'] ?? '') === 'admin' ? 'admin' : 'user';
        if ($role === 'user' && $u['role'] === 'admin' && admins_left($pdo, $id) === 0) json_out(['error' => 'There must be at least one administrator', 'code' => 'last_admin'], 400);
        $pdo->prepare('UPDATE users SET role = ? WHERE id = ?')->execute([$role, $id]);
        json_out(['ok' => true]);
    }
    json_out(['error' => 'Unknown action'], 400);
}

if ($method === 'DELETE') {
    $id = (int)($_GET['id'] ?? 0);
    if ($id === $me['id']) json_out(['error' => 'You cannot delete your own account', 'code' => 'self'], 400);
    $st = $pdo->prepare('SELECT role FROM users WHERE id = ?');
    $st->execute([$id]);
    $u = fetch_one($st);
    if (!$u) json_out(['ok' => true]);
    if ($u['role'] === 'admin' && admins_left($pdo, $id) === 0) json_out(['error' => 'There must be at least one administrator', 'code' => 'last_admin'], 400);
    $pdo->exec('BEGIN IMMEDIATE');
    try {
        $ids = $pdo->prepare("SELECT id FROM locations WHERE kind = 'saved' AND user_id = ?");
        $ids->execute([$id]);
        foreach ($ids->fetchAll(PDO::FETCH_COLUMN) as $lid) {
            $pdo->prepare('DELETE FROM history_daily WHERE loc_id = ?')->execute([$lid]);
            $pdo->prepare('DELETE FROM history_meta WHERE loc_id = ?')->execute([$lid]);
        }
        $pdo->prepare("DELETE FROM locations WHERE kind = 'saved' AND user_id = ?")->execute([$id]);
        $pdo->prepare('DELETE FROM user_cars WHERE user_id = ?')->execute([$id]);
        $pdo->prepare('DELETE FROM user_prefs WHERE user_id = ?')->execute([$id]);
        $pdo->prepare('DELETE FROM sessions WHERE user_id = ?')->execute([$id]);
        $pdo->prepare('DELETE FROM users WHERE id = ?')->execute([$id]);
        $pdo->exec('COMMIT');
    } catch (Throwable $e) {
        $pdo->exec('ROLLBACK');
        throw $e;
    }
    json_out(['ok' => true]);
}

json_out(['error' => 'Method not allowed'], 405);
