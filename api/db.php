<?php
// Κοινή σύνδεση SQLite + βοηθητικές συναρτήσεις JSON
declare(strict_types=1);

// Ανεκτικότητα σε παλαιότερες εκδόσεις PHP / ελλιπείς επεκτάσεις
if (!function_exists('str_contains')) { function str_contains(string $h, string $n): bool { return $n === '' || strpos($h, $n) !== false; } }
if (!function_exists('str_starts_with')) { function str_starts_with(string $h, string $n): bool { return strncmp($h, $n, strlen($n)) === 0; } }
ini_set('display_errors', '0');
set_exception_handler(function (Throwable $e) {
    http_response_code(500);
    header('Content-Type: application/json; charset=utf-8');
    echo json_encode(['error' => 'Server error: ' . $e->getMessage()], JSON_UNESCAPED_UNICODE);
});
register_shutdown_function(function () {
    $e = error_get_last();
    if ($e && in_array($e['type'], [E_ERROR, E_PARSE, E_CORE_ERROR, E_COMPILE_ERROR], true) && !headers_sent()) {
        http_response_code(500);
        header('Content-Type: application/json; charset=utf-8');
        echo json_encode(['error' => 'PHP error: ' . $e['message']], JSON_UNESCAPED_UNICODE);
    }
});

/* Read one row / one value and CLOSE the statement. A SELECT whose cursor is left open keeps a read snapshot
   alive; with WAL, a later write on the same connection (e.g. the cache INSERT after a slow API call) then fails
   at once with "database is locked" if any other request has committed in the meantime — busy_timeout can't help. */
function fetch_one(PDOStatement $st): ?array
{
    $rows = $st->fetchAll();
    $st->closeCursor();
    return $rows[0] ?? null;
}

function fetch_col(PDOStatement $st)
{
    $rows = $st->fetchAll(PDO::FETCH_COLUMN);
    $st->closeCursor();
    return $rows ? $rows[0] : false;
}

function db(): PDO
{
    static $pdo = null;
    if ($pdo) return $pdo;
    $dir = __DIR__ . '/../data';
    if (!extension_loaded('pdo_sqlite')) {
        json_out(['error' => 'The PHP extension pdo_sqlite is missing (e.g. apt install php-sqlite3)'], 500);
    }
    if (!is_dir($dir) && !@mkdir($dir, 0775, true)) {
        json_out(['error' => 'Cannot create the data/ directory. Grant write permission to the web server user'], 500);
    }
    if (!is_writable($dir)) {
        json_out(['error' => 'The data/ directory is not writable by the web server (chown www-data data && chmod 775 data)'], 500);
    }
    try {
        $pdo = new PDO('sqlite:' . $dir . '/wefo.sqlite');
    } catch (PDOException $e) {
        json_out(['error' => 'Database error: ' . $e->getMessage()], 500);
    }
    $pdo->setAttribute(PDO::ATTR_ERRMODE, PDO::ERRMODE_EXCEPTION);
    $pdo->setAttribute(PDO::ATTR_DEFAULT_FETCH_MODE, PDO::FETCH_ASSOC);
    // Concurrency: wait for a competing writer instead of failing with "database is locked", and
    // use WAL so readers never block the (single) writer and vice versa
    $pdo->exec('PRAGMA busy_timeout = 15000');
    try { $pdo->exec('PRAGMA journal_mode = WAL'); $pdo->exec('PRAGMA synchronous = NORMAL'); } catch (PDOException $e) { /* e.g. read-only/odd filesystem: keep the default mode */ }
    $pdo->exec('CREATE TABLE IF NOT EXISTS locations (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        lat REAL NOT NULL,
        lon REAL NOT NULL,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )');
    // `kind`: 'saved' = added by the admin in Locations & Map (only listed to a logged-in admin),
    // 'city' = the built-in Greek cities (api/cities.php), listed for everybody
    $cols = array_column($pdo->query('PRAGMA table_info(locations)')->fetchAll(), 'name');
    if (!in_array('kind', $cols, true)) $pdo->exec("ALTER TABLE locations ADD COLUMN kind TEXT NOT NULL DEFAULT 'saved'");
    if (!in_array('name_el', $cols, true)) $pdo->exec('ALTER TABLE locations ADD COLUMN name_el TEXT');
    // Bortle dark-sky class 1..9 of the place (NULL = not known), used by the Astronomy tab
    if (!in_array('bortle', $cols, true)) $pdo->exec('ALTER TABLE locations ADD COLUMN bortle INTEGER');
    // 1 = set by an admin (beats the light-pollution atlas); 0 = just the seeded guess for the Greek towns
    if (!in_array('elevation', $cols, true)) $pdo->exec('ALTER TABLE locations ADD COLUMN elevation REAL');   // optional height (m) the forecast is corrected to; null = the model's own terrain
    if (!in_array('bortle_set', $cols, true)) $pdo->exec('ALTER TABLE locations ADD COLUMN bortle_set INTEGER NOT NULL DEFAULT 0');
    $pdo->exec('CREATE TABLE IF NOT EXISTS cache (
        k TEXT PRIMARY KEY,
        body TEXT NOT NULL,
        fetched_at INTEGER NOT NULL
    )');
    // Users, sessions and their cars. Saved locations belong to a user.
    $pdo->exec("CREATE TABLE IF NOT EXISTS users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        username TEXT NOT NULL UNIQUE COLLATE NOCASE,
        pass_hash TEXT NOT NULL,
        role TEXT NOT NULL DEFAULT 'user',
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )");
    $pdo->exec('CREATE TABLE IF NOT EXISTS sessions (
        token_hash TEXT PRIMARY KEY,
        user_id INTEGER NOT NULL,
        expires INTEGER NOT NULL,
        created INTEGER NOT NULL
    ) WITHOUT ROWID');
    $pdo->exec('CREATE TABLE IF NOT EXISTS user_cars (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL,
        name TEXT NOT NULL,
        kind TEXT NOT NULL,
        cons REAL NOT NULL,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )');
    if (!in_array('user_id', $cols, true)) $pdo->exec('ALTER TABLE locations ADD COLUMN user_id INTEGER');
    seed_admin($pdo);
    sync_cities($pdo);
    // Long-term daily history per saved location (downloaded once, then cached here)
    $pdo->exec('CREATE TABLE IF NOT EXISTS history_daily (
        loc_id INTEGER NOT NULL,
        d TEXT NOT NULL,
        tmax REAL, tmin REAL, tmean REAL, prcp REAL, wmax REAL, gust REAL, snow REAL,
        PRIMARY KEY (loc_id, d)
    ) WITHOUT ROWID');
    $pdo->exec('CREATE TABLE IF NOT EXISTS history_meta (
        loc_id INTEGER PRIMARY KEY,
        grid_lat REAL, grid_lon REAL, elevation REAL, timezone TEXT,
        first_date TEXT, last_date TEXT, fetched_at INTEGER NOT NULL
    )');
    return $pdo;
}

// The account that was configured before users existed (api/config.php / WEFO_ADMIN_* env vars) becomes the first administrator and
// takes over the locations saved so far. Only runs while the users table is empty.
function seed_admin(PDO $pdo): void
{
    if ((int)fetch_col($pdo->query('SELECT COUNT(*) FROM users')) > 0) return;
    $c = app_config();
    if (empty($c['admin_user']) || empty($c['admin_password_hash'])) return;
    $pdo->exec('BEGIN IMMEDIATE');
    try {
        if ((int)fetch_col($pdo->query('SELECT COUNT(*) FROM users')) === 0) {
            $pdo->prepare("INSERT INTO users (username, pass_hash, role) VALUES (?, ?, 'admin')")->execute([(string)$c['admin_user'], (string)$c['admin_password_hash']]);
            $id = (int)$pdo->lastInsertId();
            $pdo->prepare("UPDATE locations SET user_id = ? WHERE kind = 'saved' AND user_id IS NULL")->execute([$id]);
        }
        $pdo->exec('COMMIT');
    } catch (Throwable $e) {
        $pdo->exec('ROLLBACK');
        throw $e;
    }
}

// Keeps the built-in Greek cities (api/cities.php) in the locations table. Cheap on every request (one
// SELECT); the real work only happens on first run or after the list file changes. Upserts by English
// name, so a city that is already there keeps its id (and with it its downloaded climate history).
function sync_cities(PDO $pdo): void
{
    $file = __DIR__ . '/cities.php';
    $ver = (string)md5_file($file);
    $cur = $pdo->prepare('SELECT body FROM cache WHERE k = ?');
    $cur->execute(['cities:seed']);
    if (fetch_col($cur) === $ver) return;
    $pdo->exec('BEGIN IMMEDIATE');   // two first requests at once must not both insert
    try {
        $cur->execute(['cities:seed']);
        if (fetch_col($cur) !== $ver) {
            $find = $pdo->prepare("SELECT id FROM locations WHERE kind = 'city' AND name = ?");
            $upd = $pdo->prepare('UPDATE locations SET name_el = ?, lat = ?, lon = ?, bortle = COALESCE(bortle, ?) WHERE id = ?');   // an admin's correction wins over the seed
            $ins = $pdo->prepare("INSERT INTO locations (name, name_el, lat, lon, bortle, kind) VALUES (?, ?, ?, ?, ?, 'city')");
            $cities = require $file;
            foreach ($cities as [$en, $el, $lat, $lon, $bortle]) {
                $find->execute([$en]);
                if (($id = fetch_col($find)) !== false) $upd->execute([$el, $lat, $lon, $bortle, $id]);
                else $ins->execute([$en, $el, $lat, $lon, $bortle]);
            }
            $pdo->prepare('INSERT OR REPLACE INTO cache (k, body, fetched_at) VALUES (?, ?, ?)')->execute(['cities:seed', $ver, time()]);
        }
        $pdo->exec('COMMIT');
    } catch (Throwable $e) {
        $pdo->exec('ROLLBACK');
        throw $e;
    }
}

// Optional local config: api/config.php (git-ignored — see api/config.example.php) and/or environment
// variables (see the "WEFO_" section of api/config.example.php for the exact names and how to set them
// on Apache / Nginx+PHP-FPM / systemd). An env var always wins over the same key from config.php, so you
// can keep secrets out of any file on disk entirely if you prefer. Neither present = no optional
// features enabled; nothing else in the app depends on this.
function app_config(): array
{
    static $cfg = null;
    if ($cfg !== null) return $cfg;
    $f = __DIR__ . '/config.php';
    $file = is_file($f) ? (require $f) : [];
    $cfg = is_array($file) ? $file : [];
    foreach (['google_weather_api_key' => 'WEFO_GOOGLE_WEATHER_API_KEY', 'ssl_verify' => 'WEFO_SSL_VERIFY', 'admin_user' => 'WEFO_ADMIN_USER', 'admin_password_hash' => 'WEFO_ADMIN_PASSWORD_HASH', 'ors_api_key' => 'WEFO_ORS_API_KEY'] as $key => $env) {
        $v = getenv($env);
        if ($v !== false && $v !== '') $cfg[$key] = $v;
    }
    return $cfg;
}

function json_out($data, int $code = 200): void
{
    http_response_code($code);
    header('Content-Type: application/json; charset=utf-8');
    echo json_encode($data, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
    exit;
}

// Should outgoing HTTPS calls verify the server certificate? Yes, unless config.php (or WEFO_SSL_VERIFY) says
// 'ssl_verify' => false / 0 / "false" — only meant for a local Laragon without a CA bundle (see config.example.php).
function ssl_verify(): bool
{
    $v = app_config()['ssl_verify'] ?? true;
    if (is_string($v)) $v = !in_array(strtolower(trim($v)), ['0', 'false', 'off', 'no', ''], true);
    return (bool)$v;
}

function http_get(string $url, int $timeout = 20): ?string
{
    $ch = curl_init($url);
    curl_setopt_array($ch, [
        CURLOPT_RETURNTRANSFER => true,
        CURLOPT_TIMEOUT => $timeout,
        CURLOPT_FOLLOWLOCATION => true,
        CURLOPT_USERAGENT => 'wefo-weather-compare/1.0 (personal project)',
        CURLOPT_ENCODING => '',
        CURLOPT_SSL_VERIFYPEER => ssl_verify(),
    ]);
    $body = curl_exec($ch);
    $status = curl_getinfo($ch, CURLINFO_RESPONSE_CODE);
    curl_close($ch);
    return ($body !== false && $status === 200) ? $body : null;
}

// Every endpoint needs a logged-in user, except the ones that define WEFO_PUBLIC first (api/auth.php) and command-line tools.
if (!defined('WEFO_PUBLIC') && PHP_SAPI !== 'cli') {
    require_once __DIR__ . '/auth_lib.php';
    auth_require();
}
