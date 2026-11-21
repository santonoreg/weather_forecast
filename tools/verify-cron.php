<?php
// Nightly model-verification job (command line only):   php tools/verify-cron.php [lat lon]
//
// Does the heavy computation of api/verify_lib.php — the Greece-wide pool of METAR stations, every model, and every
// lead time from the Previous Runs API — and stores it in the cache, so that api/verify.php never has to make a visitor wait.
// With no arguments it refreshes the Greece-wide result; with "lat lon" it refreshes that one point instead (a place outside Greece).
// crontab example (03:15 every night):   15 3 * * * php /var/www/wefo/tools/verify-cron.php >> /var/log/wefo-verify.log 2>&1
if (PHP_SAPI !== 'cli') { http_response_code(404); exit; }
require __DIR__ . '/../api/verify_lib.php';
set_time_limit(0);
$lat = isset($argv[1]) ? (float)$argv[1] : 37.98;   // Athens: anywhere in Greece gives the Greece-wide pool
$lon = isset($argv[2]) ? (float)$argv[2] : 23.73;
$t0 = microtime(true);
$pdo = db();
$key = verify_cache_key($lat, $lon);
try {
    $r = verify_compute($pdo, $lat, $lon, true);
} catch (Throwable $e) {
    fwrite(STDERR, gmdate('c') . " verify failed: " . $e->getMessage() . "\n");
    exit(1);
}
verify_store($pdo, $key, $r);
printf("%s %s ok: %d models, leads [%s], %d hours, %.0f s\n", gmdate('c'), $key, count($r['models']), implode(',', $r['leads']), $r['hours'], microtime(true) - $t0);
