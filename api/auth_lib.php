<?php
// Users, roles and sessions.
//   users     : id, username (unique, case-insensitive), pass_hash (password_hash), role 'admin' | 'user'
//   sessions  : server-side, so deleting a user or changing a password logs them out at once. The cookie holds a random token;
//               only its sha256 is stored. "Remember me" keeps the session 30 days (persistent cookie), otherwise it ends when the
//               browser closes (and after one day at the latest).
// The first admin is seeded from api/config.php (admin_user / admin_password_hash) or the WEFO_ADMIN_* env vars when the users table is
// still empty, so the account that existed before becomes the administrator. More users: Users page (admin) or tools/add-user.php.
// Every API endpoint requires a login (see the bottom of db.php) except api/auth.php.
declare(strict_types=1);

const AUTH_COOKIE = 'wefo_sid';
const AUTH_TTL_REMEMBER = 30 * 86400;
const AUTH_TTL_SESSION = 86400;

function auth_configured(): bool
{
    return (int)fetch_col(db()->query('SELECT COUNT(*) FROM users')) > 0;
}

function auth_https(): bool
{
    return (!empty($_SERVER['HTTPS']) && $_SERVER['HTTPS'] !== 'off') || strtolower((string)($_SERVER['HTTP_X_FORWARDED_PROTO'] ?? '')) === 'https';
}

// The cookie only needs to reach this app (e.g. /forecast/), not the whole domain
function auth_cookie_path(): string
{
    $dir = str_replace('\\', '/', dirname(dirname((string)($_SERVER['SCRIPT_NAME'] ?? '/api/x.php'))));
    return rtrim($dir, '/') . '/';
}

function auth_set_cookie(string $value, int $expires): void
{
    setcookie(AUTH_COOKIE, $value, ['expires' => $expires, 'path' => auth_cookie_path(), 'secure' => auth_https(), 'httponly' => true, 'samesite' => 'Lax']);
}

/* The logged-in user: ['id','name','role'] or null */
function auth_user(): ?array
{
    static $u = false;
    if ($u !== false) return $u;
    $u = null;
    $tok = $_COOKIE[AUTH_COOKIE] ?? '';
    if (!is_string($tok) || !preg_match('/^[0-9a-f]{64}$/', $tok)) return $u;
    $st = db()->prepare('SELECT u.id, u.username, u.role FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = ? AND s.expires > ?');
    $st->execute([hash('sha256', $tok), time()]);
    $row = fetch_one($st);
    if ($row) $u = ['id' => (int)$row['id'], 'name' => (string)$row['username'], 'role' => (string)$row['role']];
    return $u;
}

function auth_is_user(): bool { return auth_user() !== null; }
function auth_is_admin(): bool { $u = auth_user(); return $u !== null && $u['role'] === 'admin'; }

function auth_require(): void
{
    if (!auth_is_user()) json_out(['error' => 'Login required', 'code' => 'login_required'], 401);
}

function auth_require_admin(): void
{
    auth_require();
    if (!auth_is_admin()) json_out(['error' => 'Administrator only', 'code' => 'admin_required'], 403);
}

function auth_start_session(int $userId, bool $remember): void
{
    $pdo = db();
    $pdo->prepare('DELETE FROM sessions WHERE expires < ?')->execute([time()]);
    $tok = bin2hex(random_bytes(32));
    $ttl = $remember ? AUTH_TTL_REMEMBER : AUTH_TTL_SESSION;
    $pdo->prepare('INSERT INTO sessions (token_hash, user_id, expires, created) VALUES (?, ?, ?, ?)')->execute([hash('sha256', $tok), $userId, time() + $ttl, time()]);
    auth_set_cookie($tok, $remember ? time() + $ttl : 0);
}

function auth_end_session(): void
{
    $tok = $_COOKIE[AUTH_COOKIE] ?? '';
    if (is_string($tok) && preg_match('/^[0-9a-f]{64}$/', $tok)) db()->prepare('DELETE FROM sessions WHERE token_hash = ?')->execute([hash('sha256', $tok)]);
    auth_set_cookie('', time() - 3600);
}

function auth_valid_name(string $n): bool { return (bool)preg_match('/^[A-Za-z0-9._@-]{3,40}$/', $n); }

/* ---- brute-force throttle: a few failures per IP per window, plus a looser global cap ---- */
const AUTH_FAIL_WINDOW = 900;
const AUTH_FAIL_MAX_IP = 5;
const AUTH_FAIL_MAX_ALL = 40;

function auth_ip(): string
{
    $ip = (string)($_SERVER['HTTP_CF_CONNECTING_IP'] ?? $_SERVER['REMOTE_ADDR'] ?? '?');   // behind Cloudflare REMOTE_ADDR is Cloudflare's own
    return substr(preg_replace('/[^0-9a-fA-F:.]/', '', $ip) ?: '?', 0, 45);
}

function auth_fail_count(PDO $pdo, string $key): int
{
    $st = $pdo->prepare('SELECT body, fetched_at FROM cache WHERE k = ?');
    $st->execute([$key]);
    $row = fetch_one($st);
    return ($row && time() - (int)$row['fetched_at'] < AUTH_FAIL_WINDOW) ? (int)$row['body'] : 0;
}

function auth_fail_bump(PDO $pdo, string $key): void
{
    $st = $pdo->prepare('SELECT body, fetched_at FROM cache WHERE k = ?');
    $st->execute([$key]);
    $row = fetch_one($st);
    $fresh = $row && time() - (int)$row['fetched_at'] < AUTH_FAIL_WINDOW;
    // fetched_at marks the start of the window: only reset it when the previous window has expired
    $pdo->prepare('INSERT OR REPLACE INTO cache (k, body, fetched_at) VALUES (?, ?, ?)')
        ->execute([$key, (string)($fresh ? (int)$row['body'] + 1 : 1), $fresh ? (int)$row['fetched_at'] : time()]);
}

function auth_locked(PDO $pdo): bool
{
    return auth_fail_count($pdo, 'authfail:' . auth_ip()) >= AUTH_FAIL_MAX_IP || auth_fail_count($pdo, 'authfail:*') >= AUTH_FAIL_MAX_ALL;
}
