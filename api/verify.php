<?php
// Επαλήθευση μοντέλων: συγκρίνει αρχειοθετημένες προβλέψεις κάθε μοντέλου (Open-Meteo Historical Forecast API)
// με την πραγματική εικόνα του καιρού (ERA5 reanalysis, Open-Meteo Archive API) για τις τελευταίες ~4 εβδομάδες
// και υπολογίζει βαθμολογία και βάρη αξιοπιστίας ανά παράμετρο.
declare(strict_types=1);
require __DIR__ . '/db.php';

const VERIFY_TTL = 86400;   // 24 ώρες
const WINDOW_DAYS = 28;
const LAG_DAYS = 6;         // το ERA5 καθυστερεί λίγες ημέρες

$MODELS = ['ecmwf_ifs025', 'gfs_seamless', 'icon_seamless', 'gem_seamless', 'meteofrance_seamless', 'ukmo_seamless',
           'jma_seamless', 'cma_grapes_global', 'knmi_seamless', 'dmi_seamless', 'metno_seamless'];
$VARS = ['temperature_2m', 'precipitation', 'wind_speed_10m', 'cloud_cover', 'relative_humidity_2m', 'pressure_msl', 'weather_code'];
// Τυπικό σφάλμα στο οποίο η «βαθμολογία» της παραμέτρου μηδενίζεται
$TOL = ['temperature_2m' => 4.0, 'wind_speed_10m' => 15.0, 'cloud_cover' => 50.0, 'relative_humidity_2m' => 25.0, 'pressure_msl' => 4.0];

$lat = filter_var($_GET['lat'] ?? null, FILTER_VALIDATE_FLOAT);
$lon = filter_var($_GET['lon'] ?? null, FILTER_VALIDATE_FLOAT);
if ($lat === false || $lon === false || abs($lat) > 90 || abs($lon) > 180) json_out(['error' => 'Invalid coordinates'], 400);
$lat = round($lat, 2);
$lon = round($lon, 2);

$pdo = db();
$key = "vf:$lat:$lon";
$st = $pdo->prepare('SELECT body, fetched_at FROM cache WHERE k = ?');
$st->execute([$key]);
if (($row = $st->fetch()) && time() - (int)$row['fetched_at'] < VERIFY_TTL) {
    header('Content-Type: application/json; charset=utf-8');
    echo $row['body'];
    exit;
}

$end = gmdate('Y-m-d', time() - LAG_DAYS * 86400);
$start = gmdate('Y-m-d', time() - (LAG_DAYS + WINDOW_DAYS) * 86400);
$common = ['latitude' => $lat, 'longitude' => $lon, 'start_date' => $start, 'end_date' => $end,
           'hourly' => implode(',', $VARS), 'timezone' => 'UTC'];

$truthBody = http_get('https://archive-api.open-meteo.com/v1/archive?' . http_build_query($common), 40);
$fcBody = http_get('https://historical-forecast-api.open-meteo.com/v1/forecast?' . http_build_query($common + ['models' => implode(',', $MODELS)]), 60);
$truth = $truthBody ? json_decode($truthBody, true) : null;
$fc = $fcBody ? json_decode($fcBody, true) : null;
if (!$truth || !$fc || !isset($truth['hourly']['time'], $fc['hourly']['time'])) {
    json_out(['error' => 'Could not fetch historical data for verification'], 502);
}

function cat($c): ?string
{
    if ($c === null) return null;
    $c = (int)$c;
    if ($c <= 1) return 'clear';
    if ($c === 2) return 'partly';
    if ($c === 3) return 'cloudy';
    if ($c === 45 || $c === 48) return 'fog';
    if ($c >= 51 && $c <= 57) return 'drizzle';
    if (($c >= 61 && $c <= 67) || ($c >= 80 && $c <= 82)) return 'rain';
    if (($c >= 71 && $c <= 77) || $c === 85 || $c === 86) return 'snow';
    if ($c >= 95) return 'thunder';
    return 'cloudy';
}

$T = $truth['hourly'];
$n = count($T['time']);
$stats = [];

foreach ($MODELS as $m) {
    $s = ['mae' => [], 'bias' => [], 'n' => 0];
    foreach (['temperature_2m', 'wind_speed_10m', 'cloud_cover', 'relative_humidity_2m', 'pressure_msl'] as $v) {
        $a = $fc['hourly']["{$v}_{$m}"] ?? null;
        if (!$a) continue;
        $sum = 0.0; $bias = 0.0; $cnt = 0;
        for ($i = 0; $i < $n; $i++) {
            if (!isset($a[$i], $T[$v][$i])) continue;
            $d = $a[$i] - $T[$v][$i];
            $sum += abs($d); $bias += $d; $cnt++;
        }
        if ($cnt > 24) { $s['mae'][$v] = $sum / $cnt; $s['bias'][$v] = $bias / $cnt; $s['n'] = max($s['n'], $cnt); }
    }
    // Βροχή: επιτυχία εντοπισμού βρεχόμενων ωρών (CSI) και σφάλμα συνολικού ύψους
    $p = $fc['hourly']["precipitation_{$m}"] ?? null;
    if ($p) {
        $hit = $miss = $fa = 0;
        for ($i = 0; $i < $n; $i++) {
            if (!isset($p[$i], $T['precipitation'][$i])) continue;
            $o = $T['precipitation'][$i] >= 0.1; $f = $p[$i] >= 0.1;
            if ($o && $f) $hit++; elseif ($o) $miss++; elseif ($f) $fa++;
        }
        $den = $hit + $miss + $fa;
        if ($den > 0) $s['csi'] = $hit / $den;
        $s['rain_events'] = $hit + $miss;
    }
    // Κατηγορία καιρού
    $c = $fc['hourly']["weather_code_{$m}"] ?? null;
    if ($c) {
        $ok = $tot = 0;
        for ($i = 0; $i < $n; $i++) {
            if (!isset($c[$i], $T['weather_code'][$i])) continue;
            $tot++;
            if (cat($c[$i]) === cat($T['weather_code'][$i])) $ok++;
        }
        if ($tot > 24) $s['code_acc'] = $ok / $tot;
    }
    // Μοντέλα εκτός περιοχής κάλυψης επιστρέφουν αντίγραφο του ERA5 (σφάλμα 0) – δεν αξιολογούνται
    if (!$s['mae'] || array_sum($s['mae']) < 0.001) continue;
    $stats[$m] = $s;
}

// Βαθμολογίες 0..1 ανά παράμετρο
$skill = [];
foreach ($stats as $m => $s) {
    foreach ($TOL as $v => $tol) if (isset($s['mae'][$v])) $skill[$m][$v] = max(0.0, 1 - $s['mae'][$v] / $tol);
    if (isset($s['csi']) && ($s['rain_events'] ?? 0) >= 15) $skill[$m]['precip'] = $s['csi'];   // αρκετά επεισόδια βροχής για στατιστική αξία
    if (isset($s['code_acc'])) $skill[$m]['code'] = $s['code_acc'];
}

// Κανονικοποιημένα βάρη (μέσος όρος = 1), περιορισμένα στο [0.5, 1.8] ώστε κανένα μοντέλο να μην κυριαρχεί
function norm_weights(array $vals): array
{
    if (!$vals) return [];
    $raw = array_map(fn($x) => $x + 0.15, $vals);
    $mean = array_sum($raw) / count($raw);
    return array_map(fn($x) => round(min(1.8, max(0.5, $x / $mean)), 3), $raw);
}
$byParam = [];
foreach ($skill as $m => $ps) foreach ($ps as $v => $x) $byParam[$v][$m] = $x;
$W = [];
foreach ($byParam as $v => $vals) foreach (norm_weights($vals) as $m => $w) $W[$m][$v] = $w;

// Αντιστοίχιση παραμέτρων της εφαρμογής -> βάρη
$out = [];
foreach ($stats as $m => $s) {
    $w = $W[$m] ?? [];
    $sk = $skill[$m] ?? [];
    $out[$m] = [
        'score' => $sk ? (int)round(array_sum($sk) / count($sk) * 100) : null,
        'skill' => array_map(fn($x) => round($x, 3), $sk),
        'mae' => array_map(fn($x) => round($x, 2), $s['mae']),
        'bias' => array_map(fn($x) => round($x, 2), $s['bias']),
        'csi' => isset($s['csi']) ? round($s['csi'], 3) : null,
        'code_acc' => isset($s['code_acc']) ? round($s['code_acc'], 3) : null,
        'weights' => [
            'weather' => $w['code'] ?? null,
            'temperature_2m' => $w['temperature_2m'] ?? null,
            'precip' => $w['precipitation'] ?? $w['precip'] ?? null,
            'wind' => $w['wind_speed_10m'] ?? null,
            'storm' => $w['code'] ?? null,
            'cloud_cover' => $w['cloud_cover'] ?? null,
            'relative_humidity_2m' => $w['relative_humidity_2m'] ?? null,
            'pressure_msl' => $w['pressure_msl'] ?? null,
        ],
    ];
}
// Το precip skill αποθηκεύεται ως 'precip'
foreach ($out as $m => &$o) $o['weights']['precip'] = $W[$m]['precip'] ?? null;
unset($o);

$body = json_encode(['start' => $start, 'end' => $end, 'hours' => $n, 'models' => $out], JSON_UNESCAPED_UNICODE);
$pdo->prepare('INSERT OR REPLACE INTO cache (k, body, fetched_at) VALUES (?, ?, ?)')->execute([$key, $body, time()]);
header('Content-Type: application/json; charset=utf-8');
echo $body;
