<?php
// Command-line only: creates a user (or resets the password of an existing one) straight in the database.
//   php tools/add-user.php <name> [admin|user]
// Useful for the very first administrator when api/config.php has no admin_user / admin_password_hash, or when an admin
// has forgotten their password. The password is read from standard input, so it stays out of your shell history.
if (PHP_SAPI !== 'cli') { http_response_code(404); exit; }
define('WEFO_PUBLIC', true);
require __DIR__ . '/../api/db.php';
require __DIR__ . '/../api/auth_lib.php';

$name = $argv[1] ?? '';
$role = ($argv[2] ?? 'user') === 'admin' ? 'admin' : 'user';
if (!auth_valid_name($name)) { fwrite(STDERR, "Usage: php tools/add-user.php <name 3-40 chars: letters, digits . _ @ -> [admin|user]\n"); exit(1); }
fwrite(STDERR, "Password for $name: ");
$pass = rtrim((string)fgets(STDIN), "\r\n");
if (strlen($pass) < 8) { fwrite(STDERR, "Use at least 8 characters.\n"); exit(1); }
$pdo = db();
$st = $pdo->prepare('SELECT id FROM users WHERE username = ? COLLATE NOCASE');
$st->execute([$name]);
$id = fetch_col($st);
if ($id !== false) {
    $pdo->prepare('UPDATE users SET pass_hash = ?, role = ? WHERE id = ?')->execute([password_hash($pass, PASSWORD_DEFAULT), $role, $id]);
    $pdo->prepare('DELETE FROM sessions WHERE user_id = ?')->execute([$id]);
    echo "Updated $name ($role); their sessions were ended.\n";
} else {
    $pdo->prepare('INSERT INTO users (username, pass_hash, role) VALUES (?, ?, ?)')->execute([$name, password_hash($pass, PASSWORD_DEFAULT), $role]);
    if ($role === 'admin') {   // the first administrator takes over locations saved before users existed
        $pdo->prepare("UPDATE locations SET user_id = ? WHERE kind = 'saved' AND user_id IS NULL")->execute([(int)$pdo->lastInsertId()]);
    }
    echo "Created $name ($role).\n";
}
