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
    $pdo->exec('CREATE TABLE IF NOT EXISTS cache (
        k TEXT PRIMARY KEY,
        body TEXT NOT NULL,
        fetched_at INTEGER NOT NULL
    )');
    return $pdo;
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
