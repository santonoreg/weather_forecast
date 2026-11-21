<?php
// GET  -> { configured, user: {id,name,role}|null, admin }
// POST -> { action: "login", user, password, remember } | { action: "logout" } | { action: "password", old, new }
declare(strict_types=1);
define('WEFO_PUBLIC', true);   // the only endpoint that does not need a login
require __DIR__ . '/db.php';
require __DIR__ . '/auth_lib.php';

$method = $_SERVER['REQUEST_METHOD'];
$me = auth_user();
if ($method === 'GET') json_out(['configured' => auth_configured(), 'user' => $me, 'admin' => $me !== null && $me['role'] === 'admin']);
if ($method !== 'POST') json_out(['error' => 'Method not allowed'], 405);

$in = json_decode(file_get_contents('php://input'), true) ?: [];
$action = (string)($in['action'] ?? '');
$pdo = db();

if ($action === 'logout') {
    if ($me) app_log('logout', 'Logged out', $me['name']);
    auth_end_session();
    json_out(['user' => null, 'admin' => false]);
}

if ($action === 'password') {                                  // change your own password (your other sessions end, this one stays)
    auth_require();
    $new = (string)($in['new'] ?? '');
    if (strlen($new) < 8) json_out(['error' => 'The new password needs at least 8 characters', 'code' => 'weak'], 400);
    $st = $pdo->prepare('SELECT pass_hash FROM users WHERE id = ?');
    $st->execute([$me['id']]);
    $row = fetch_one($st);
    if (!$row || !password_verify((string)($in['old'] ?? ''), (string)$row['pass_hash'])) { usleep(400000); json_out(['error' => 'Wrong current password', 'code' => 'bad_credentials'], 401); }
    $pdo->prepare('UPDATE users SET pass_hash = ? WHERE id = ?')->execute([password_hash($new, PASSWORD_DEFAULT), $me['id']]);
    $keep = hash('sha256', (string)($_COOKIE[AUTH_COOKIE] ?? ''));
    $pdo->prepare('DELETE FROM sessions WHERE user_id = ? AND token_hash <> ?')->execute([$me['id'], $keep]);
    json_out(['ok' => true]);
}

if ($action !== 'login') json_out(['error' => 'Unknown action'], 400);

if (!auth_configured()) json_out(['error' => 'Login is not configured on this server', 'code' => 'not_configured'], 503);

if (auth_locked($pdo)) {
    app_log('login_fail', 'Blocked: too many attempts', trim((string)($in['user'] ?? '')));
    header('Retry-After: ' . AUTH_FAIL_WINDOW);
    json_out(['error' => 'Too many attempts, try again later', 'code' => 'locked'], 429);
}

$name = trim((string)($in['user'] ?? ''));
$pass = (string)($in['password'] ?? '');
$st = $pdo->prepare('SELECT id, username, role, pass_hash FROM users WHERE username = ? COLLATE NOCASE');
$st->execute([$name]);
$row = fetch_one($st);
// Always run the (deliberately slow) hash check, so an unknown user name takes as long as a wrong password
$hash = $row ? (string)$row['pass_hash'] : '$2y$10$abcdefghijklmnopqrstuuMo1nJm7iXr0FeS9Sx0b3hP3N5Qvq9uy';
$ok = password_verify($pass, $hash) && $row;

if (!$ok) {
    app_log('login_fail', $row ? 'Wrong password' : 'Unknown user name', $name);
    auth_fail_bump($pdo, 'authfail:' . auth_ip());
    auth_fail_bump($pdo, 'authfail:*');
    usleep(400000);
    json_out(['error' => 'Wrong username or password', 'code' => 'bad_credentials'], 401);
}

$pdo->prepare('DELETE FROM cache WHERE k = ?')->execute(['authfail:' . auth_ip()]);
auth_start_session((int)$row['id'], !empty($in['remember']));
app_log('login', 'Logged in' . (!empty($in['remember']) ? ' (remember me)' : ''), (string)$row['username']);
json_out(['user' => ['id' => (int)$row['id'], 'name' => $row['username'], 'role' => $row['role']], 'admin' => $row['role'] === 'admin']);
