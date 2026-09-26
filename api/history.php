<?php
// Long-term daily weather history for a saved location.
// First request: downloads the whole ERA5 / ERA5-Land archive (1940 -> today-6 days) from the Open-Meteo Historical
// Weather API for the grid point nearest to the location and stores it in SQLite. Later requests are served from the
// database; every time the history is opened only the days that are not stored yet are downloaded and appended
// (at most one check per HIST_CHECK_SECONDS, or immediately with refresh=1).
declare(strict_types=1);
require __DIR__ . '/db.php';
set_time_limit(240);

const HIST_START = '1940-01-01';
const HIST_LAG_DAYS = 6;          // the archive is published with a delay of a few days
const HIST_CHECK_SECONDS = 6 * 3600;   // do not ask the API again more often than this (unless refresh=1)

$id = (int)($_GET['id'] ?? 0);
$pdo = db();
$st = $pdo->prepare('SELECT id, name, lat, lon FROM locations WHERE id = ?');
$st->execute([$id]);
$loc = $st->fetch();
if (!$loc) json_out(['error' => 'Location not found'], 404);

$mt = $pdo->prepare('SELECT * FROM history_meta WHERE loc_id = ?');
$mt->execute([$id]);
$meta = $mt->fetch() ?: null;

$end = gmdate('Y-m-d', time() - HIST_LAG_DAYS * 86400);
$refresh = !empty($_GET['refresh']);
$downloaded = false;
$added = 0;

$prevLast = $meta['last_date'] ?? null;
$needFetch = !$meta || ($meta['last_date'] < $end && ($refresh || time() - (int)$meta['fetched_at'] > HIST_CHECK_SECONDS));
if ($needFetch) {
    $from = $meta ? gmdate('Y-m-d', strtotime($meta['last_date'] . ' UTC') - 3 * 86400) : HIST_START;
    $url = 'https://archive-api.open-meteo.com/v1/archive?' . http_build_query([
        'latitude' => $loc['lat'], 'longitude' => $loc['lon'], 'start_date' => $from, 'end_date' => $end, 'timezone' => 'auto',
        'daily' => 'temperature_2m_max,temperature_2m_min,temperature_2m_mean,precipitation_sum,wind_speed_10m_max,wind_gusts_10m_max,snowfall_sum',
    ]);
    $body = http_get($url, 120);
    $j = $body ? json_decode($body, true) : null;
    if (!$j || !isset($j['daily']['time'])) {
        if (!$meta) json_out(['error' => 'Could not download the history from Open-Meteo (try again in a moment)'], 502);
        // otherwise keep serving the stored data
    } else {
        $D = $j['daily'];
        $ins = $pdo->prepare('INSERT OR REPLACE INTO history_daily (loc_id, d, tmax, tmin, tmean, prcp, wmax, gust, snow) VALUES (?,?,?,?,?,?,?,?,?)');
        $pdo->beginTransaction();
        $first = null;
        $last = null;
        foreach ($D['time'] as $i => $d) {
            $row = [$D['temperature_2m_max'][$i] ?? null, $D['temperature_2m_min'][$i] ?? null, $D['temperature_2m_mean'][$i] ?? null,
                    $D['precipitation_sum'][$i] ?? null, $D['wind_speed_10m_max'][$i] ?? null, $D['wind_gusts_10m_max'][$i] ?? null, $D['snowfall_sum'][$i] ?? null];
            if ($row[0] === null && $row[1] === null && $row[3] === null) continue;   // not published yet
            $ins->execute(array_merge([$id, $d], $row));
            if ($prevLast === null || $d > $prevLast) $added++;
            $first = $first ?? $d;
            $last = $d;
        }
        $pdo->commit();
        $pdo->prepare('INSERT OR REPLACE INTO history_meta (loc_id, grid_lat, grid_lon, elevation, timezone, first_date, last_date, fetched_at) VALUES (?,?,?,?,?,?,?,?)')
            ->execute([$id, $j['latitude'] ?? null, $j['longitude'] ?? null, $j['elevation'] ?? null, $j['timezone'] ?? null,
                       $meta['first_date'] ?? $first, $last ?? ($meta['last_date'] ?? null), time()]);
        $downloaded = !$prevLast;   // true only for the very first download
        $mt->execute([$id]);
        $meta = $mt->fetch();
    }
}

function haversine_km(float $la1, float $lo1, float $la2, float $lo2): float
{
    $dLa = deg2rad($la2 - $la1);
    $dLo = deg2rad($lo2 - $lo1);
    $a = sin($dLa / 2) ** 2 + cos(deg2rad($la1)) * cos(deg2rad($la2)) * sin($dLo / 2) ** 2;
    return 2 * 6371.0 * asin(min(1.0, sqrt($a)));
}
function one(PDO $pdo, string $sql, array $args): ?array
{
    $s = $pdo->prepare($sql);
    $s->execute($args);
    return $s->fetch() ?: null;
}
function rows(PDO $pdo, string $sql, array $args): array
{
    $s = $pdo->prepare($sql);
    $s->execute($args);
    return $s->fetchAll();
}
function rnd($v, int $d = 1)
{
    return $v === null ? null : round((float)$v, $d);
}

$cnt = one($pdo, 'SELECT COUNT(*) c FROM history_daily WHERE loc_id = ?', [$id]);

// Records
$rec = [];
foreach (['hottest' => ['tmax', 'DESC'], 'coldest' => ['tmin', 'ASC'], 'wettest' => ['prcp', 'DESC'], 'windiest' => ['gust', 'DESC'], 'snowiest' => ['snow', 'DESC']] as $k => [$col, $ord]) {
    $r = one($pdo, "SELECT d, $col v FROM history_daily WHERE loc_id = ? AND $col IS NOT NULL ORDER BY $col $ord LIMIT 1", [$id]);
    $rec[$k] = $r ? ['d' => $r['d'], 'v' => rnd($r['v'])] : null;
}

// Monthly climate (averages over all stored years, complete months only)
$monthly = [];
foreach (rows($pdo, "SELECT m, AVG(tmean) tmean, AVG(tmax) tmax, AVG(tmin) tmin, AVG(p) prcp, AVG(rd) rainy FROM (
        SELECT substr(d,6,2) m, substr(d,1,4) y, AVG(tmean) tmean, AVG(tmax) tmax, AVG(tmin) tmin, SUM(prcp) p, SUM(CASE WHEN prcp >= 1 THEN 1 ELSE 0 END) rd
        FROM history_daily WHERE loc_id = ? GROUP BY y, m HAVING COUNT(*) >= 25) GROUP BY m ORDER BY m", [$id]) as $r) {
    $monthly[] = ['m' => (int)$r['m'], 'tmean' => rnd($r['tmean']), 'tmax' => rnd($r['tmax']), 'tmin' => rnd($r['tmin']), 'prcp' => rnd($r['prcp']), 'rainy' => rnd($r['rainy'])];
}

// Month-by-month series [year, month, mean temperature, precipitation, days] (used by the period selector)
$series = [];
foreach (rows($pdo, "SELECT CAST(substr(d,1,4) AS INTEGER) y, CAST(substr(d,6,2) AS INTEGER) m, AVG(tmean) t, SUM(prcp) p, COUNT(*) n
        FROM history_daily WHERE loc_id = ? GROUP BY y, m ORDER BY y, m", [$id]) as $r) {
    $series[] = [(int)$r['y'], (int)$r['m'], rnd($r['t']), rnd($r['p'], 0), (int)$r['n']];
}

// Annual summary
$annual = [];
foreach (rows($pdo, "SELECT substr(d,1,4) y, COUNT(*) n, AVG(tmean) tmean, MAX(tmax) tmax, MIN(tmin) tmin, SUM(prcp) prcp,
        SUM(CASE WHEN prcp >= 1 THEN 1 ELSE 0 END) rainy, MAX(gust) gust, SUM(snow) snow
        FROM history_daily WHERE loc_id = ? GROUP BY y ORDER BY y", [$id]) as $r) {
    $annual[] = ['y' => (int)$r['y'], 'n' => (int)$r['n'], 'tmean' => rnd($r['tmean']), 'tmax' => rnd($r['tmax']), 'tmin' => rnd($r['tmin']),
                 'prcp' => rnd($r['prcp'], 0), 'rainy' => (int)$r['rainy'], 'gust' => rnd($r['gust'], 0), 'snow' => rnd($r['snow'])];
}

json_out([
    'location' => ['id' => (int)$loc['id'], 'name' => $loc['name'], 'lat' => (float)$loc['lat'], 'lon' => (float)$loc['lon']],
    'meta' => $meta ? [
        'grid_lat' => (float)$meta['grid_lat'], 'grid_lon' => (float)$meta['grid_lon'], 'elevation' => $meta['elevation'] !== null ? (float)$meta['elevation'] : null,
        'distance_km' => round(haversine_km((float)$loc['lat'], (float)$loc['lon'], (float)$meta['grid_lat'], (float)$meta['grid_lon']), 1),
        'first' => $meta['first_date'], 'last' => $meta['last_date'], 'days' => (int)$cnt['c'], 'fetched_at' => (int)$meta['fetched_at'],
    ] : null,
    'downloaded' => $downloaded,
    'added' => $added,
    'records' => $rec,
    'monthly' => $monthly,
    'series' => $series,
    'annual' => $annual,
]);
