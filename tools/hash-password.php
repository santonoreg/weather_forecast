<?php
// Command-line only: turns an admin password into the hash that goes into api/config.php
// (admin_password_hash) or the WEFO_ADMIN_PASSWORD_HASH env var.
//   php tools/hash-password.php
// The password is read from standard input (not from an argument, so it stays out of your shell
// history) and is never written anywhere — only its hash is printed.
if (PHP_SAPI !== 'cli') { http_response_code(404); exit; }

fwrite(STDERR, "Admin password: ");
$pass = rtrim((string)fgets(STDIN), "\r\n");
if (strlen($pass) < 10) { fwrite(STDERR, "Use at least 10 characters.\n"); exit(1); }
fwrite(STDERR, "\nPaste this into api/config.php as 'admin_password_hash' (single quotes are fine, it has no quote characters):\n\n");
echo password_hash($pass, PASSWORD_DEFAULT), PHP_EOL;
