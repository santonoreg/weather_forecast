<?php
// GET  -> { configured, admin }   (is there an admin account, and is this browser logged in as it)
// POST -> { action: "login", user, password } | { action: "logout" }
declare(strict_types=1);
require __DIR__ . '/db.php';
require __DIR__ . '/auth_lib.php';

$method = $_SERVER['REQUEST_METHOD'];
if ($method === 'GET') json_out(['configured' => auth_configured(), 'admin' => auth_is_admin()]);
if ($method !== 'POST') json_out(['error' => 'Method not allowed'], 405);

$in = json_decode(file_get_contents('php://input'), true) ?: [];
$action = (string)($in['action'] ?? '');

if ($action === 'logout') {
    auth_set_cookie('', time() - 3600);
    json_out(['admin' => false]);
}
if ($action !== 'login') json_out(['error' => 'Unknown action'], 400);

if (!auth_configured()) json_out(['error' => 'Login is not configured on this server', 'code' => 'not_configured'], 503);

$pdo = db();
if (auth_locked($pdo)) {
    header('Retry-After: ' . AUTH_FAIL_WINDOW);
    json_out(['error' => 'Too many attempts, try again later', 'code' => 'locked'], 429);
}

$cfg = app_config();
$user = (string)($in['user'] ?? '');
$pass = (string)($in['password'] ?? '');
// Always run the (deliberately slow) hash check, so a wrong username takes as long as a wrong password
$passOk = password_verify($pass, (string)$cfg['admin_password_hash']);
$userOk = hash_equals((string)$cfg['admin_user'], $user);

if (!($passOk && $userOk)) {
    auth_fail_bump($pdo, 'authfail:' . auth_ip());
    auth_fail_bump($pdo, 'authfail:*');
    usleep(400000);
    json_out(['error' => 'Wrong username or password', 'code' => 'bad_credentials'], 401);
}

$pdo->prepare('DELETE FROM cache WHERE k = ?')->execute(['authfail:' . auth_ip()]);
$exp = time() + AUTH_TTL;
auth_set_cookie(auth_make_token($user, $exp), $exp);
json_out(['admin' => true]);
