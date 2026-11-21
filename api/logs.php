<?php
// Activity log, administrators only.
//   GET api/logs.php?group=all|login|fail|error|job&limit=200&before=<id>
//     -> { rows: [{id, ts, kind, user, ip, message}], counts: {login, login_fail, error, job, ...} (last 24 h), more: bool }
declare(strict_types=1);
require __DIR__ . '/db.php';
require_once __DIR__ . '/auth_lib.php';
auth_require_admin();

const LOG_GROUPS = ['all' => null, 'login' => ['login', 'logout'], 'fail' => ['login_fail'], 'error' => ['error'], 'job' => ['job']];
if ($_SERVER['REQUEST_METHOD'] !== 'GET') json_out(['error' => 'Method not allowed'], 405);

$pdo = db();
$group = (string)($_GET['group'] ?? 'all');
$kinds = LOG_GROUPS[$group] ?? null;
$limit = max(10, min(500, (int)($_GET['limit'] ?? 200)));
$before = (int)($_GET['before'] ?? 0);
$where = []; $args = [];
if ($kinds) { $where[] = 'kind IN (' . implode(',', array_fill(0, count($kinds), '?')) . ')'; $args = array_merge($args, $kinds); }
if ($before > 0) { $where[] = 'id < ?'; $args[] = $before; }
$st = $pdo->prepare('SELECT id, ts, kind, user, ip, message FROM app_log' . ($where ? ' WHERE ' . implode(' AND ', $where) : '') . ' ORDER BY id DESC LIMIT ' . ($limit + 1));
$st->execute($args);
$rows = $st->fetchAll();
$more = count($rows) > $limit;
if ($more) array_pop($rows);
foreach ($rows as &$r) { $r['id'] = (int)$r['id']; $r['ts'] = (int)$r['ts']; } unset($r);

$cs = $pdo->prepare('SELECT kind, COUNT(*) AS n FROM app_log WHERE ts > ? GROUP BY kind');
$cs->execute([time() - 86400]);
$counts = [];
foreach ($cs->fetchAll() as $c) $counts[$c['kind']] = (int)$c['n'];
json_out(['rows' => $rows, 'counts' => (object)$counts, 'more' => $more]);
