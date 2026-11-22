<?php
// Personal, local configuration. Copy this file to config.php (same folder) and fill in your own
// values there — config.php is listed in .gitignore, so it is never committed or pushed.
// If config.php does not exist, or a key is left empty, the matching optional feature is simply
// disabled: nothing else in the app requires this file.
//
// Prefer not to keep secrets in a file at all? Every key here can instead be set as an environment
// variable — see the WEFO_* name next to each one below — which always takes priority over the value
// here. That's the "WEFO_GOOGLE_WEATHER_API_KEY" line in the README's setup instructions for Apache,
// Nginx+PHP-FPM and systemd. You can use config.php, an env var, or both (env wins); config.php can
// stay empty either way.
return [

    // Google Maps Platform "Weather API" key (Google DeepMind's WeatherNext 3 AI forecast), used to
    // add "Google WeatherNext 3" as one more model in the comparison.
    //   Env var: WEFO_GOOGLE_WEATHER_API_KEY (takes priority over the line below if set)
    //   Docs:    https://developers.google.com/maps/documentation/weather/overview
    //   Get a key: https://console.cloud.google.com/ → create a project → enable billing
    //              (required even for the free tier) → enable the "Weather API" → create an API key
    //              → restrict it to the Weather API.
    //   Cost:    the first 10,000 calls/month are free, then pay-as-you-go (see the docs above). Cap
    //            the API's own daily quota in Google Cloud Console (APIs & Services → Weather API →
    //            Quotas) so Google itself refuses calls past whatever limit you set — see the README.
    //            api/google_weather.php also caches responses for a few hours and caps its own daily
    //            calls (see the constants at the top of that file), but you are responsible for your
    //            own Google Cloud billing either way.
    //   Leave empty (and the env var unset) to disable this feature entirely — nothing else in the
    //   app is affected.
    'google_weather_api_key' => '',

    // Optional: the account that becomes the first ADMINISTRATOR the first time the app runs with no users yet (it also takes over the
    // locations saved so far). Leave empty and create the first administrator with `php tools/add-user.php <name> admin` instead.
    // Later users are created in the app (Users page, administrators only). Only a hash of the password is stored:
    //   1. php tools/hash-password.php        (type the password when asked; prints the hash)
    //   2. paste the user name and that hash below, or set the env vars instead
    //   Env vars: WEFO_ADMIN_USER, WEFO_ADMIN_PASSWORD_HASH (take priority over the lines below)
    // OpenRouteService key for the "Trip" tab (driving routes in Greece: distance, time, elevation, toll roads).
    //   Env var: WEFO_ORS_API_KEY (takes priority over the line below if set)
    //   Get a key: https://openrouteservice.org/dev/#/signup -> sign up (free, no card) -> "Request a token" (Standard / Free plan:
    //              2,000 route requests a day, 40 a minute). Routes are cached for 6 hours, so repeating a search costs nothing.
    //   Leave empty to disable the Trip tab route search - nothing else in the app is affected.
    'ors_api_key' => '',

    // Verify the TLS certificates of the services WeFO calls (Open-Meteo, MET Norway, aviationweather.gov …).
    // Keep it true (the default) on a server. On a local Laragon/XAMPP whose PHP has no CA bundle every call fails with
    // "SSL certificate problem": the proper fix is a bundle (download cacert.pem from https://curl.se/ca/cacert.pem and point
    // `curl.cainfo` and `openssl.cafile` at it in php.ini); only as a last resort set this to false for local development.
    //   Env var: WEFO_SSL_VERIFY (0 / false disables)
    'ssl_verify' => true,

    // POSEIDON (HCMR, Hellenic Centre for Marine Research): a separate regional weather model (SKIRON/Eta, ~5 km) added to the comparison. WeFO reads
    // the point endpoint that poseidon.hcmr.gr's own map uses (undocumented; the documented API is for observations only). The site's terms allow
    // personal use and ask for permission for any other use (poseidon@hcmr.gr). Set false (or env WEFO_POSEIDON_ENABLED=0) to leave it out.
    'poseidon_enabled' => true,

    'admin_user' => '',
    'admin_password_hash' => '',

];
