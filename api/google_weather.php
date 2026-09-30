<?php
// Optional: Google Maps Platform "Weather API" (Google DeepMind's WeatherNext 3 AI forecast) as one
// more model in the comparison. Included by api/forecast.php; does nothing unless a key is configured
// in api/config.php (see api/config.example.php). Requires a Google Cloud project with billing enabled;
// the first 10,000 calls/month are free (https://developers.google.com/maps/documentation/weather).
declare(strict_types=1);

// Temporary kill switch: flip to true to resume. Doesn't touch the configured key or any of the cost
// caps below — just short-circuits before any Google call is made, so it costs nothing while off.
const GOOGLE_WEATHER_ENABLED = false;

const GOOGLE_CACHE_TTL = 3 * 3600;    // reuse a fetch for this many seconds before asking Google again
const GOOGLE_HOURS = 72;              // how many hours of hourly forecast to request (3 days = 3 API calls,
                                       // Google caps pageSize at 24h/call); increase for a longer comparison
                                       // window at the cost of more calls per fetch
const GOOGLE_PAGE_SIZE = 24;          // Google's maximum allowed page size
const GOOGLE_DAILY_CALL_CAP = 300;    // hard safety cap (≈9,000/month) so a bug or heavy use can't run up
                                       // an unexpected bill; once hit, Google is simply left out until
                                       // the next UTC day
const GOOGLE_FAIL_COOLDOWN = 900;     // seconds to back off after a failed request (bad/expired key,
                                       // billing disabled, quota exceeded, network error) before retrying

/* Small generic helpers on top of the shared `cache` table (k, body, fetched_at) */
function cache_read(PDO $pdo, string $key): ?array
{
    $st = $pdo->prepare('SELECT body, fetched_at FROM cache WHERE k = ?');
    $st->execute([$key]);
    return $st->fetch() ?: null;
}
function cache_write(PDO $pdo, string $key, string $body): void
{
    $pdo->prepare('INSERT OR REPLACE INTO cache (k, body, fetched_at) VALUES (?, ?, ?)')->execute([$key, $body, time()]);
}

/* Google's weatherCondition.type -> the WMO-ish code this app uses elsewhere. Approximate: Google's
   condition set is finer-grained (e.g. several rain-intensity steps) than WMO codes, so some detail is
   collapsed; the closest bucket is used. */
function google_wmo_code(string $type, int $cloudCover): int
{
    static $map = [
        'CLEAR' => 0, 'MOSTLY_CLEAR' => 1, 'PARTLY_CLOUDY' => 2, 'MOSTLY_CLOUDY' => 3, 'CLOUDY' => 3,
        'LIGHT_RAIN_SHOWERS' => 80, 'CHANCE_OF_SHOWERS' => 80, 'SCATTERED_SHOWERS' => 80, 'RAIN_SHOWERS' => 81, 'HEAVY_RAIN_SHOWERS' => 82,
        'LIGHT_TO_MODERATE_RAIN' => 61, 'LIGHT_RAIN' => 61,
        'MODERATE_TO_HEAVY_RAIN' => 63, 'RAIN' => 63, 'RAIN_PERIODICALLY_HEAVY' => 63, 'WIND_AND_RAIN' => 63,
        'HEAVY_RAIN' => 65,
        'LIGHT_SNOW_SHOWERS' => 85, 'CHANCE_OF_SNOW_SHOWERS' => 85, 'SCATTERED_SNOW_SHOWERS' => 85, 'SNOW_SHOWERS' => 85, 'HEAVY_SNOW_SHOWERS' => 86,
        'LIGHT_TO_MODERATE_SNOW' => 71, 'LIGHT_SNOW' => 71,
        'MODERATE_TO_HEAVY_SNOW' => 73, 'SNOW' => 73, 'SNOW_PERIODICALLY_HEAVY' => 73,
        'HEAVY_SNOW' => 75, 'HEAVY_SNOW_STORM' => 75, 'SNOWSTORM' => 75, 'BLOWING_SNOW' => 75,
        'RAIN_AND_SNOW' => 67,
        'HAIL' => 96, 'HAIL_SHOWERS' => 96,
        'THUNDERSTORM' => 95, 'THUNDERSHOWER' => 95, 'LIGHT_THUNDERSTORM_RAIN' => 95, 'SCATTERED_THUNDERSTORMS' => 95, 'HEAVY_THUNDERSTORM' => 99,
    ];
    if (isset($map[$type])) return $map[$type];
    // WINDY and anything unrecognised: fall back to cloud cover, like the app does for other providers
    return $cloudCover < 20 ? 0 : ($cloudCover < 45 ? 1 : ($cloudCover < 75 ? 2 : 3));
}

/**
 * Fetches (or reuses the cached) Google WeatherNext 3 hourly forecast for one location and returns it
 * already normalised to this app's provider shape, or null if unavailable for any reason (no key, no
 * quota left, request failed, etc.) — callers should treat null exactly like "this model has no data
 * for this location".
 */
function fetch_google_weathernext(PDO $pdo, float $lat, float $lon, string $key, array $time, int $offsetSeconds): ?array
{
    if (!GOOGLE_WEATHER_ENABLED) return null;
    $cacheKey = "goo:$lat:$lon";
    $cached = cache_read($pdo, $cacheKey);
    if ($cached && time() - (int)$cached['fetched_at'] < GOOGLE_CACHE_TTL) {
        $hourly = json_decode($cached['body'], true);
        return $hourly ? ['id' => 'google_weathernext', 'name' => 'Google WeatherNext 3', 'hourly' => $hourly] : null;
    }

    $cooldown = cache_read($pdo, "goo:cooldown:$lat:$lon");
    if ($cooldown && time() - (int)$cooldown['fetched_at'] < GOOGLE_FAIL_COOLDOWN) {
        // Recently failed (bad key, billing/quota issue, network) — don't hammer the API; fall back to
        // whatever we had cached before (may be stale, still better than nothing) or give up quietly.
        if ($cached) { $hourly = json_decode($cached['body'], true); return $hourly ? ['id' => 'google_weathernext', 'name' => 'Google WeatherNext 3', 'hourly' => $hourly] : null; }
        return null;
    }

    $today = gmdate('Y-m-d');
    $quotaKey = "goo:quota:$today";
    $used = (int)(cache_read($pdo, $quotaKey)['body'] ?? '0');
    if ($used >= GOOGLE_DAILY_CALL_CAP) {
        if ($cached) { $hourly = json_decode($cached['body'], true); return $hourly ? ['id' => 'google_weathernext', 'name' => 'Google WeatherNext 3', 'hourly' => $hourly] : null; }
        return null;
    }

    $all = [];
    $calls = 0;
    $pageToken = null;
    do {
        $url = 'https://weather.googleapis.com/v1/forecast/hours:lookup?' . http_build_query([
            'key' => $key, 'location.latitude' => $lat, 'location.longitude' => $lon,
            'hours' => GOOGLE_HOURS, 'pageSize' => GOOGLE_PAGE_SIZE,
        ] + ($pageToken ? ['pageToken' => $pageToken] : []));
        $body = http_get($url, 20);
        $calls++;
        $j = $body ? json_decode($body, true) : null;
        if (!$j || !isset($j['forecastHours'])) break;   // bad key, billing disabled, quota exceeded, network error, ...
        foreach ($j['forecastHours'] as $fh) $all[] = $fh;
        $pageToken = $j['nextPageToken'] ?? null;
    } while ($pageToken && $calls < 10 && count($all) < GOOGLE_HOURS);

    cache_write($pdo, $quotaKey, (string)($used + $calls));

    if (!$all) {
        cache_write($pdo, "goo:cooldown:$lat:$lon", '1');
        if ($cached) { $hourly = json_decode($cached['body'], true); return $hourly ? ['id' => 'google_weathernext', 'name' => 'Google WeatherNext 3', 'hourly' => $hourly] : null; }
        return null;
    }

    $byHour = [];
    foreach ($all as $fh) {
        $start = $fh['interval']['startTime'] ?? null;
        if (!$start) continue;
        $localTs = strtotime($start) + $offsetSeconds;
        $byHour[gmdate('Y-m-d\TH:00', $localTs)] = $fh;
    }

    $cols = ['temperature_2m', 'apparent_temperature', 'precipitation', 'wind_speed_10m', 'wind_gusts_10m',
             'wind_direction_10m', 'cloud_cover', 'relative_humidity_2m', 'pressure_msl', 'weather_code', 'cape', 'is_day'];
    $h = array_fill_keys($cols, []);
    foreach ($time as $t) {
        $fh = $byHour[$t] ?? null;
        if (!$fh) { foreach ($cols as $c) $h[$c][] = null; continue; }
        $cloud = $fh['cloudCover'] ?? 50;
        $h['temperature_2m'][] = $fh['temperature']['degrees'] ?? null;
        $h['apparent_temperature'][] = $fh['feelsLikeTemperature']['degrees'] ?? null;
        $h['precipitation'][] = $fh['precipitation']['qpf']['quantity'] ?? null;
        $h['wind_speed_10m'][] = $fh['wind']['speed']['value'] ?? null;
        $h['wind_gusts_10m'][] = $fh['wind']['gust']['value'] ?? null;
        $h['wind_direction_10m'][] = $fh['wind']['direction']['degrees'] ?? null;
        $h['cloud_cover'][] = $cloud;
        $h['relative_humidity_2m'][] = $fh['relativeHumidity'] ?? null;
        $h['pressure_msl'][] = $fh['airPressure']['meanSeaLevelMillibars'] ?? null;
        $h['weather_code'][] = isset($fh['weatherCondition']['type']) ? google_wmo_code($fh['weatherCondition']['type'], (int)$cloud) : null;
        $h['cape'][] = null;   // not provided by this API
        $h['is_day'][] = isset($fh['isDaytime']) ? ($fh['isDaytime'] ? 1 : 0) : null;
    }

    cache_write($pdo, $cacheKey, json_encode($h));
    return ['id' => 'google_weathernext', 'name' => 'Google WeatherNext 3', 'hourly' => $h];
}
