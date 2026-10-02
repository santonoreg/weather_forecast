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
    $pdo->exec('CREATE TABLE IF NOT EXISTS cache (
        k TEXT PRIMARY KEY,
        body TEXT NOT NULL,
        fetched_at INTEGER NOT NULL
    )');
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

// Keeps the built-in Greek cities (api/cities.php) in the locations table. Cheap on every request (one
// SELECT); the real work only happens on first run or after the list file changes. Upserts by English
// name, so a city that is already there keeps its id (and with it its downloaded climate history).
function sync_cities(PDO $pdo): void
{
    $file = __DIR__ . '/cities.php';
    $ver = (string)md5_file($file);
    $cur = $pdo->prepare('SELECT body FROM cache WHERE k = ?');
    $cur->execute(['cities:seed']);
    if ($cur->fetchColumn() === $ver) return;
    $pdo->exec('BEGIN IMMEDIATE');   // two first requests at once must not both insert
    try {
        $cur->execute(['cities:seed']);
        if ($cur->fetchColumn() !== $ver) {
            $find = $pdo->prepare("SELECT id FROM locations WHERE kind = 'city' AND name = ?");
            $upd = $pdo->prepare('UPDATE locations SET name_el = ?, lat = ?, lon = ? WHERE id = ?');
            $ins = $pdo->prepare("INSERT INTO locations (name, name_el, lat, lon, kind) VALUES (?, ?, ?, ?, 'city')");
            $cities = require $file;
            foreach ($cities as [$en, $el, $lat, $lon]) {
                $find->execute([$en]);
                if (($id = $find->fetchColumn()) !== false) $upd->execute([$el, $lat, $lon, $id]);
                else $ins->execute([$en, $el, $lat, $lon]);
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
    foreach (['google_weather_api_key' => 'WEFO_GOOGLE_WEATHER_API_KEY', 'admin_user' => 'WEFO_ADMIN_USER', 'admin_password_hash' => 'WEFO_ADMIN_PASSWORD_HASH'] as $key => $env) {
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

function http_get(string $url, int $timeout = 20): ?string
{
    $ch = curl_init($url);
    curl_setopt_array($ch, [
        CURLOPT_RETURNTRANSFER => true,
        CURLOPT_TIMEOUT => $timeout,
        CURLOPT_FOLLOWLOCATION => true,
        CURLOPT_USERAGENT => 'wefo-weather-compare/1.0 (personal project)',
        CURLOPT_ENCODING => '',
        CURLOPT_SSL_VERIFYPEER => false, // τοπικό Laragon χωρίς CA bundle
    ]);
    $body = curl_exec($ch);
    $status = curl_getinfo($ch, CURLINFO_RESPONSE_CODE);
    curl_close($ch);
    return ($body !== false && $status === 200) ? $body : null;
}
