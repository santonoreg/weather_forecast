<?php
// Active weather warnings of the Hellenic National Meteorological Service (EMY), through MeteoAlarm's free CAP feed.
//   GET api/warnings.php  ->  {"warnings": [{"type": 3, "level": 2, "area": "Epirus", "area_el": "...", "event": "...", "onset": "...", "expires": "..."}], "fetched": "..."}
// Feed: https://feeds.meteoalarm.org/api/v1/warnings/feeds-greece  (the Atom version is feeds.meteoalarm.org/feeds/meteoalarm-legacy-atom-greece).
// The feed names regions only by an EMMA_ID code and a name — it carries no polygons, and MeteoAlarm publishes none for the EMMA regions —
// so a warning cannot be matched to a map point here: this lists the warnings that are in force somewhere in Greece, with their region names.
// Cached for 30 minutes; any failure answers {"warnings": []} (the hero card then simply shows no line), like the radar line.
declare(strict_types=1);
require __DIR__ . '/db.php';

const WARN_TTL = 1800;
const WARN_URL = 'https://feeds.meteoalarm.org/api/v1/warnings/feeds-greece';
const WARN_HORIZON = 48 * 3600;   // warnings that start within this many seconds are shown too

/* The Greek texts of this feed used to arrive as UTF-8 that had been read as Windows-1252 once too often ("Ήπειρος" -> "Î‰Ï€..."); today they are
   correct. Keep text that already contains Greek letters as it is, undo the double encoding when that is what it is, and give up (null: the
   English name is shown) otherwise. */
function unmangle(string $s): ?string
{
    if (preg_match('/\p{Greek}/u', $s)) return $s;
    $b = @mb_convert_encoding($s, 'Windows-1252', 'UTF-8');
    return ($b !== false && $b !== '' && mb_check_encoding($b, 'UTF-8') && preg_match('/\p{Greek}/u', $b)) ? $b : null;
}

$pdo = db();
$key = 'warn:gr';
$st = $pdo->prepare('SELECT body, fetched_at FROM cache WHERE k = ?');
$st->execute([$key]);
$row = fetch_one($st);
header('Content-Type: application/json; charset=utf-8');
if ($row && time() - (int)$row['fetched_at'] < WARN_TTL) { echo $row['body']; exit; }

$out = ['warnings' => [], 'fetched' => gmdate('c')];
$body = http_get(WARN_URL, 12);
$j = $body ? json_decode($body, true) : null;
if (is_array($j) && isset($j['warnings'])) {
    $now = time(); $seen = [];
    foreach ($j['warnings'] as $w) {
        $infos = $w['alert']['info'] ?? [];
        // the feed repeats every warning once per language: take the English one for the structure, the Greek area name as a bonus
        $el = [];
        foreach ($infos as $i) if (str_starts_with((string)($i['language'] ?? ''), 'el')) foreach ($i['area'] ?? [] as $a) $el[$a['geocode'][0]['value'] ?? ''] = unmangle((string)($a['areaDesc'] ?? ''));
        foreach ($infos as $i) {
            if (!str_starts_with((string)($i['language'] ?? ''), 'en')) continue;
            $exp = strtotime((string)($i['expires'] ?? '')); $on = strtotime((string)($i['onset'] ?? $i['effective'] ?? ''));
            if (!$exp || $exp <= $now || ($on && $on > $now + WARN_HORIZON)) continue;
            $type = $level = null;
            foreach ($i['parameter'] ?? [] as $p) {
                if (($p['valueName'] ?? '') === 'awareness_type') $type = (int)$p['value'];
                if (($p['valueName'] ?? '') === 'awareness_level') $level = (int)$p['value'];
            }
            if ($type === null || $level === null || $level < 2) continue;   // level 1 = green = no warning
            foreach ($i['area'] ?? [] as $a) {
                $code = $a['geocode'][0]['value'] ?? '';
                $k = "$type|$level|$code";
                if (isset($seen[$k])) continue;
                $seen[$k] = true;
                $out['warnings'][] = ['type' => $type, 'level' => $level, 'area' => (string)($a['areaDesc'] ?? ''), 'area_el' => $el[$code] ?? null,
                    'event' => (string)($i['event'] ?? ''), 'onset' => $i['onset'] ?? null, 'expires' => $i['expires'] ?? null];
            }
        }
    }
    usort($out['warnings'], fn($a, $b) => $b['level'] <=> $a['level']);
    $json = json_encode($out, JSON_UNESCAPED_UNICODE);
    $pdo->prepare('INSERT OR REPLACE INTO cache (k, body, fetched_at) VALUES (?, ?, ?)')->execute([$key, $json, time()]);
    echo $json;
    exit;
}
echo $row ? $row['body'] : json_encode($out);   // the feed did not answer: the last good copy, or nothing
