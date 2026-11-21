<?php
// Single source of truth for the weather models WeFO knows about.
//
// Read by api/forecast.php (what to request + the metadata sent to the UI), api/verify.php (which models
// get a reliability score), api/astro.php / api/skypoints.php / api/tripweather.php (their small subsets,
// via the 'use' flags) and — through the forecast response — js/app.js (display names, resolution, family).
//
// Fields:
//   name     display name (the UI has its own translated names for some, in js/i18n.js "mn.<id>")
//   res      native grid resolution, for information only
//   area     where the model is genuinely good: 'global' or a short text for a regional model
//   region   [south, north, west, east] box of a regional model's own domain (null = global); outside of it a
//            "seamless" product silently returns another model's data (see 'fallback')
//   family   models of one family are not independent opinions (shared initial conditions / physics):
//            'ecmwf' = IFS, AIFS and everything that is ECMWF output underneath
//   fallback the family a regional "seamless" model turns into outside its domain (null = none)
//   verify   scored by api/verify.php (needs the model in the Open-Meteo Historical Forecast API)
//   use      small subsets: astro (api/astro.php, api/skypoints.php), trip (api/tripweather.php)
//
// Adding a model: confirm first with a real Open-Meteo call that it returns data for Greece.
return [
    'ecmwf_aifs025_single' => ['name' => 'ECMWF AIFS (AI)', 'res' => '0.25° (~25 km)', 'area' => 'global', 'region' => null, 'family' => 'ecmwf', 'fallback' => null, 'verify' => true, 'use' => ['trip']],
    'ecmwf_ifs025'         => ['name' => 'ECMWF IFS', 'res' => '0.25° (~25 km)', 'area' => 'global', 'region' => null, 'family' => 'ecmwf', 'fallback' => null, 'verify' => true, 'use' => ['astro', 'trip']],
    // 9 km HRES (the 0.25° line above is the open-data version of the same model). Confirmed to return data for Athens and Thessaloniki;
    // 'verify' stays false until the Historical Forecast / Previous Runs APIs have been confirmed to accept it (an unknown model name would fail the whole request).
    'ecmwf_ifs'            => ['name' => 'ECMWF IFS HRES (9 km)', 'res' => '9 km', 'area' => 'global', 'region' => null, 'family' => 'ecmwf', 'fallback' => null, 'verify' => false, 'use' => []],
    'gfs_seamless'         => ['name' => 'NOAA GFS', 'res' => '0.11–0.25° (11–25 km)', 'area' => 'global (HRRR over the USA)', 'region' => null, 'family' => 'gfs', 'fallback' => null, 'verify' => true, 'use' => ['astro', 'trip']],
    'icon_seamless'        => ['name' => 'DWD ICON', 'res' => '2 / 7 / 11 km', 'area' => 'global (ICON-D2 over Germany, ICON-EU over Europe)', 'region' => null, 'family' => 'icon', 'fallback' => null, 'verify' => true, 'use' => ['astro', 'trip']],
    'gem_seamless'         => ['name' => 'Environment Canada GEM', 'res' => '2.5–15 km', 'area' => 'global (finer over North America)', 'region' => null, 'family' => 'gem', 'fallback' => null, 'verify' => true, 'use' => ['trip']],
    'meteofrance_seamless' => ['name' => 'Météo-France', 'res' => '1.3–25 km', 'area' => 'global (AROME over France / W. Europe)', 'region' => null, 'family' => 'arpege', 'fallback' => null, 'verify' => true, 'use' => ['trip']],
    'ukmo_seamless'        => ['name' => 'UK Met Office', 'res' => '2–10 km', 'area' => 'global (UKV over the UK)', 'region' => null, 'family' => 'ukmo', 'fallback' => null, 'verify' => true, 'use' => ['trip']],
    'jma_seamless'         => ['name' => 'JMA (Japan)', 'res' => '5–55 km', 'area' => 'global (finer over Japan)', 'region' => null, 'family' => 'jma', 'fallback' => null, 'verify' => true, 'use' => []],
    'cma_grapes_global'    => ['name' => 'CMA GRAPES (China)', 'res' => '0.15° (~15 km)', 'area' => 'global', 'region' => null, 'family' => 'cma', 'fallback' => null, 'verify' => true, 'use' => []],
    'bom_access_global'    => ['name' => 'BOM ACCESS (Australia)', 'res' => '0.15° (~15 km)', 'area' => 'global', 'region' => null, 'family' => 'bom', 'fallback' => null, 'verify' => true, 'use' => []],
    'knmi_seamless'        => ['name' => 'KNMI (Netherlands)', 'res' => '2 km (Harmonie), then ECMWF', 'area' => 'NW Europe', 'region' => [46.0, 58.0, -6.0, 12.0], 'family' => 'knmi', 'fallback' => 'ecmwf', 'verify' => true, 'use' => []],
    'dmi_seamless'         => ['name' => 'DMI (Denmark)', 'res' => '2 km (Harmonie), then ECMWF', 'area' => 'Northern Europe', 'region' => [49.0, 66.0, -12.0, 25.0], 'family' => 'dmi', 'fallback' => 'ecmwf', 'verify' => true, 'use' => []],
    'metno_seamless'       => ['name' => 'MET Norway (Nordic)', 'res' => '1 km, then ECMWF', 'area' => 'Nordic countries', 'region' => [54.0, 72.0, 0.0, 35.0], 'family' => 'metno', 'fallback' => 'ecmwf', 'verify' => true, 'use' => []],
];
