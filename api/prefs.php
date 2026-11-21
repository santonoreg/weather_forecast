<?php
// The logged-in user's own settings, kept on the server so they follow the user to another browser or device.
//   GET  api/prefs.php                    -> {"prefs": {"wefo.disabled": "[\"jma_seamless\"]", "wefo.weighted": "1", ...}}
//   POST api/prefs.php  {"prefs": {key: value, ...}}   (keys from PREF_KEYS only; a value is a short string)
// The app keeps working from localStorage if this endpoint fails; localStorage stays the first source on the page.
declare(strict_types=1);
require __DIR__ . '/db.php';
require_once __DIR__ . '/auth_lib.php';

const PREF_KEYS = ['wefo.disabled', 'wefo.weighted', 'wefo.bias', 'wefo.oneVote'];   // js/app.js PREF_KEYS: the same names as in localStorage
const PREF_MAX_LEN = 2000;

$pdo = db();
$me = auth_user();
$method = $_SERVER['REQUEST_METHOD'];

if ($method === 'GET') {
    $st = $pdo->prepare('SELECT k, v FROM user_prefs WHERE user_id = ?');
    $st->execute([$me['id']]);
    $prefs = [];
    foreach ($st->fetchAll() as $r) $prefs[$r['k']] = $r['v'];
    json_out(['prefs' => (object)$prefs]);
}
if ($method === 'POST') {
    $in = json_decode(file_get_contents('php://input'), true);
    $set = is_array($in) && is_array($in['prefs'] ?? null) ? $in['prefs'] : null;
    if ($set === null) json_out(['error' => 'Invalid data'], 400);
    $ins = $pdo->prepare('INSERT OR REPLACE INTO user_prefs (user_id, k, v) VALUES (?, ?, ?)');
    foreach ($set as $k => $v) {
        if (!in_array($k, PREF_KEYS, true) || !is_string($v) || strlen($v) > PREF_MAX_LEN) continue;
        $ins->execute([$me['id'], $k, $v]);
    }
    json_out(['ok' => true]);
}
json_out(['error' => 'Method not allowed'], 405);
