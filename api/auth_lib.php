<?php
// Admin login helpers. One admin account, configured in api/config.php (git-ignored) or env vars:
//   admin_user / WEFO_ADMIN_USER, admin_password_hash / WEFO_ADMIN_PASSWORD_HASH
// The password itself is never stored — only a password_hash() hash (see tools/hash-password.php).
// With nothing configured nobody can log in, so the locations manager simply stays locked.
//
// The session is a stateless signed cookie: payload "user|expiry" + HMAC keyed from the password hash,
// so changing the password invalidates every existing login and no server-side session files are needed.
declare(strict_types=1);

const AUTH_COOKIE = 'wefo_auth';
const AUTH_TTL = 14 * 86400;

function auth_configured(): bool
{
    $c = app_config();
    return !empty($c['admin_user']) && !empty($c['admin_password_hash']);
}

function auth_secret(): string
{
    return hash('sha256', 'wefo-auth-v1|' . (string)(app_config()['admin_password_hash'] ?? ''));
}

function auth_b64(string $s): string { return rtrim(strtr(base64_encode($s), '+/', '-_'), '='); }
function auth_unb64(string $s): string { return (string)base64_decode(strtr($s, '-_', '+/')); }

function auth_make_token(string $user, int $exp): string
{
    $p = auth_b64($user . '|' . $exp);
    return $p . '.' . hash_hmac('sha256', $p, auth_secret());
}

function auth_is_admin(): bool
{
    if (!auth_configured()) return false;
    $v = $_COOKIE[AUTH_COOKIE] ?? '';
    if (!is_string($v) || substr_count($v, '.') !== 1) return false;
    [$p, $sig] = explode('.', $v);
    if (!hash_equals(hash_hmac('sha256', $p, auth_secret()), $sig)) return false;
    $parts = explode('|', auth_unb64($p), 2);
    return count($parts) === 2 && hash_equals((string)app_config()['admin_user'], $parts[0]) && (int)$parts[1] > time();
}

function auth_require(): void
{
    if (!auth_is_admin()) json_out(['error' => 'Login required', 'code' => 'login_required'], 401);
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
    $row = $st->fetch();
    return ($row && time() - (int)$row['fetched_at'] < AUTH_FAIL_WINDOW) ? (int)$row['body'] : 0;
}

function auth_fail_bump(PDO $pdo, string $key): void
{
    $st = $pdo->prepare('SELECT body, fetched_at FROM cache WHERE k = ?');
    $st->execute([$key]);
    $row = $st->fetch();
    $fresh = $row && time() - (int)$row['fetched_at'] < AUTH_FAIL_WINDOW;
    // fetched_at marks the start of the window: only reset it when the previous window has expired
    $pdo->prepare('INSERT OR REPLACE INTO cache (k, body, fetched_at) VALUES (?, ?, ?)')
        ->execute([$key, (string)($fresh ? (int)$row['body'] + 1 : 1), $fresh ? (int)$row['fetched_at'] : time()]);
}

function auth_locked(PDO $pdo): bool
{
    return auth_fail_count($pdo, 'authfail:' . auth_ip()) >= AUTH_FAIL_MAX_IP || auth_fail_count($pdo, 'authfail:*') >= AUTH_FAIL_MAX_ALL;
}
