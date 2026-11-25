<?php
// Checks the outgoing HTTPS calls exactly as the app makes them (same options as http_get in api/db.php) and prints
// the status, the curl error and the start of the answer. Run on the server:  sudo -u www-data php tools/diag-http.php
declare(strict_types=1);
require __DIR__ . '/../api/db.php';

function diag(string $label, string $url, array $extra = []): void
{
    $ch = curl_init($url);
    curl_setopt_array($ch, $extra + [
        CURLOPT_RETURNTRANSFER => true, CURLOPT_TIMEOUT => 40, CURLOPT_FOLLOWLOCATION => true,
        CURLOPT_USERAGENT => 'wefo-weather-compare/1.0 (personal project)', CURLOPT_ENCODING => '',
        CURLOPT_SSL_VERIFYPEER => ssl_verify(),
    ]);
    $t = microtime(true);
    $body = curl_exec($ch);
    printf("%-22s HTTP %s  %.1fs  %s\n    %s\n", $label, curl_getinfo($ch, CURLINFO_RESPONSE_CODE), microtime(true) - $t,
        curl_error($ch), substr(preg_replace('/\s+/', ' ', (string)$body), 0, 220));
    curl_close($ch);
}

echo 'ssl_verify=', ssl_verify() ? 'on' : 'off', '  curl ', curl_version()['version'], '  ', curl_version()['ssl_version'], "\n";
$t = time() + 3600;
$models = array_keys(array_filter(require __DIR__ . '/../api/models.php', fn($m) => in_array('trip', $m['use'], true)));
diag('open-meteo simple', 'https://api.open-meteo.com/v1/forecast?latitude=38&longitude=23&hourly=temperature_2m');
diag('open-meteo trip', 'https://api.open-meteo.com/v1/forecast?' . http_build_query([
    'latitude' => '39.17,38.25', 'longitude' => '21.03,21.73',
    'hourly' => 'temperature_2m,precipitation,wind_gusts_10m,wind_speed_10m,weather_code,cloud_cover,cape,relative_humidity_2m,is_day',
    'models' => implode(',', $models), 'timezone' => 'GMT', 'forecast_days' => 2]));
$key = (string)(app_config()['ors_api_key'] ?? '');
echo 'ors key: ', $key === '' ? 'MISSING' : 'set (' . strlen($key) . ' chars)', "\n";
if ($key !== '') diag('openrouteservice', 'https://api.openrouteservice.org/v2/directions/driving-car/geojson', [
    CURLOPT_POST => true, CURLOPT_POSTFIELDS => json_encode(['coordinates' => [[21.03, 39.17], [21.7346, 38.2466]], 'radiuses' => [3000, 3000]]),
    CURLOPT_HTTPHEADER => ['Authorization: ' . $key, 'Content-Type: application/json; charset=utf-8', 'Accept: application/geo+json'],
]);
