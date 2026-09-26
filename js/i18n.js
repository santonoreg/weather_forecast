'use strict';
/* Translations (English is the default, Greek is available). Add a language by adding a new key to I18N. */
const I18N = {
  en: {
    'title': 'WeFo · Weather model comparison',
    'brand.sub': 'weather model comparison',
    'nav.forecast': 'Forecast', 'nav.places': 'Locations & Map',
    'tb.location': 'Location', 'tb.step': 'Step', 'tb.models': 'Models',
    'step.1': '1 hour', 'step.3': '3 hours', 'step.6': '6 hours', 'step.12': '12 hours',
    'tb.weight': 'Weight by reliability', 'tb.refresh': '↻ Refresh', 'tb.refresh.title': 'Fetch fresh data',
    'empty.html': 'No saved locations yet. Go to <a href="#" data-goto="places">Locations &amp; Map</a> and add one.',
    'loading': 'Fetching forecasts from all providers…',
    'pl.pick': 'Select an area', 'pl.search': 'Search for a city or area…',
    'pl.lat': 'Latitude', 'pl.lon': 'Longitude', 'pl.name': 'Location name', 'pl.name.ph': 'e.g. Athens',
    'pl.save': 'Save location', 'pl.geo': 'My location',
    'pl.hint': 'Click on the map, enter coordinates or search for an area.', 'pl.saved': 'Saved locations',
    'footer.html': 'Data: <a href="https://open-meteo.com/" target="_blank" rel="noopener">Open-Meteo</a> (ECMWF, GFS, ICON, GEM, Météo-France, UKMO, JMA, CMA, KNMI, DMI, MET Norway) and <a href="https://api.met.no/" target="_blank" rel="noopener">MET Norway / Yr</a>. Map © OpenStreetMap. Probabilities are derived from the agreement between models and are not an official forecast.',
    'today': 'Today',
    'theme.title': 'Switch light / dark theme',
    'saved.history': 'History',
    'h.title': 'Weather history',
    'h.loading.first': 'Downloading the history for the first time (about 1.5 MB, a few seconds) and storing it…',
    'h.loading': 'Loading history…',
    'h.close': 'Close',
    'h.grid': 'Nearest data grid point: {lat}, {lon} ({km} km from the location) · elevation {el} m',
    'h.period': 'Period: {first} – {last} ({days} days)',
    'h.source': 'Source: ERA5 / ERA5-Land reanalysis (Open-Meteo Historical Weather API) – modelled from observations, not station measurements. Stored locally on {date}.',
    'h.status.new': 'Downloaded now and stored – next time it opens instantly.',
    'h.status.cached': 'Loaded from the local cache.',
    'h.update': 'Check for newer data',
    'h.rec.title': 'Records',
    'h.rec.hottest': 'Hottest day', 'h.rec.coldest': 'Coldest night', 'h.rec.wettest': 'Wettest day', 'h.rec.windiest': 'Strongest gust', 'h.rec.snowiest': 'Snowiest day',
    'h.chart.temp': 'Annual mean temperature', 'h.chart.prcp': 'Annual precipitation',
    'h.trend': 'Trend: {v} °C per decade',
    'h.monthly': 'Monthly climate (average over all years)', 'h.annual': 'Year by year',
    'h.col.month': 'Month', 'h.col.year': 'Year', 'h.col.mean': 'Mean °C', 'h.col.max': 'Max °C', 'h.col.min': 'Min °C', 'h.col.prcp': 'Rain mm', 'h.col.rainy': 'Rainy days', 'h.col.gust': 'Gust km/h', 'h.col.snow': 'Snow cm',
    'h.partial': '* incomplete year. “Rainy days” = days with at least 1 mm.',

    'p.weather': 'Weather', 'p.temperature_2m': 'Temperature', 'p.precip': 'Rain', 'p.wind': 'Wind', 'p.storm': 'Thunderstorm',
    'p.cloud_cover': 'Cloud cover', 'p.relative_humidity_2m': 'Humidity', 'p.pressure_msl': 'Pressure', 'p.reliability': 'Reliability',

    'lg.weather': 'The icon in the last row is the most common weather category among the providers; the percentage shows how many providers agree. Where a provider gives no weather code, it is derived from rain and cloud cover.',
    'lg.temperature_2m': 'Agreement = 100% when all providers give the same value and drops to 0% when the standard deviation of the values reaches 4 °C.',
    'lg.precip': 'Chance of rain = share of providers giving at least {thr} mm in the step. Values are rainfall totals (mm) per step.',
    'lg.wind': 'Wind speed at 10 m in km/h (gust in brackets). The arrow points where the wind blows to. Chance = share of providers with ≥ {thr} km/h.',
    'lg.storm': 'Storm signal: weather code 95–99 (full signal) or CAPE ≥ 1000 J/kg (half signal). The chance is the average signal across all providers. CAPE measures the energy available for atmospheric instability.',
    'lg.cloud_cover': 'Agreement = 100% when all providers give the same cloud cover and drops to 0% when the standard deviation reaches 50%.',
    'lg.relative_humidity_2m': 'Agreement = 100% when all providers give the same value and drops to 0% when the standard deviation reaches 25%.',
    'lg.pressure_msl': 'Mean sea level pressure. Agreement = 100% when all providers give the same value and drops to 0% when the standard deviation reaches 4 hPa.',
    'lg.providers': ' Providers with data: {n}.',
    'lg.weighted': ' The last row is weighted by each model\'s reliability (see the Reliability tab).',

    'g.provider': 'Provider / model', 'g.temp_avg': 'Temperature (avg)', 'g.prob_weather': 'Most likely weather',
    'g.avg_mm': 'Average (mm)', 'g.upto': 'up to {v}', 'g.prob_rain': 'Chance of rain',
    'g.avg_kmh': 'Average (km/h)', 'g.prob_wind': 'Chance of strong wind (≥{v})', 'g.gusts': 'gusts ≥60: {v}%',
    'g.storm_yes': 'storm', 'g.storm_maybe': 'possible', 'g.storm_no': 'no',
    'g.cape_avg': 'CAPE average (J/kg)', 'g.prob_storm': 'Chance of thunderstorm',
    'g.avg_pct': 'Average (%)', 'g.avg_c': 'Average (°C)', 'g.avg_hpa': 'Average (hPa)', 'g.avg': 'Average', 'g.agree': 'Model agreement',

    'r.model': 'Model', 'r.score': 'Score', 'r.temp': 'Temperature<br>error °C', 'r.wind': 'Wind<br>error km/h', 'r.cloud': 'Cloud<br>error %',
    'r.hum': 'Humidity<br>error %', 'r.press': 'Pressure<br>error hPa', 'r.rain': 'Rain<br>detection', 'r.code': 'Correct<br>weather',
    'r.bias': '{v} bias', 'r.disabled': '(disabled)', 'r.loading': 'Loading verification data…', 'r.unavailable': 'Verification unavailable: {e}',
    'r.badge': 'Model reliability score (0–100)',
    'r.legend': 'Verification: each model\'s archived forecasts (Open-Meteo Historical Forecast) are compared with the ERA5 reanalysis for {start} – {end} ({hours} hours) at "{loc}" and, where available, with real METAR observations from the nearest airport. The score (0–100) is the average skill across parameters (METAR counts {w}%, ERA5 the rest) and yields the weights (0.5–1.8) that weight the forecast when weighting is enabled. Each cell shows the error against ERA5 and, in blue, against METAR.',
    'r.limits': '<b>Limitations:</b> ERA5 is a reanalysis produced with ECMWF\'s model, so it slightly favours ECMWF – this is why real observations get the larger weight when available. An airport station is a point measurement: distance, elevation and local effects (sea breeze, urban heat) create errors that hit every model similarly. Pressure comes from the METAR sea-level or altimeter value, and rain/weather from the present-weather code at report time, so rain detection is approximate. Archived forecasts mostly reflect short lead times. Models that do not cover the area (e.g. KNMI, DMI, MET Norway Nordic) and Yr are not scored and count with weight 1.',
    'r.station': '<b>Real observations:</b> METAR {id} – {name}, {km} km from the location, {n} hourly reports ({start} – {end}).',
    'r.nostation': '<b>Real observations:</b> no METAR station with enough recent reports within {km} km – ERA5 only.',
    'r.obs': 'METAR {v}',
    'r.howto': '<b>How to read it:</b> in each cell <b>ERA5</b> is the model’s error against the ERA5 reanalysis and <b>METAR</b> (blue) is its error against real airport measurements. Lower is better. In the rain and weather columns the values are the share of correct detections – higher is better. The score combines both sources.',
    'vf.loading': '· loading reliability…', 'vf.unavail': '· unavailable',

    'm.active': '{a}/{n} active', 'm.dup': 'Same data as {n} (outside its coverage) – not counted twice',
    'm.missing': 'No coverage for this location', 'm.all': 'Enable all',
    'mn.jma_seamless': 'JMA (Japan)', 'mn.cma_grapes_global': 'CMA GRAPES (China)', 'mn.bom_access_global': 'BOM ACCESS (Australia)',
    'mn.knmi_seamless': 'KNMI (Netherlands)', 'mn.dmi_seamless': 'DMI (Denmark)', 'mn.metno_seamless': 'MET Norway (Nordic)',
    'mi.ecmwf_ifs025': 'Global · generally the most accurate at medium range',
    'mi.gfs_seamless': 'Global · strongest in North America',
    'mi.icon_seamless': 'Global · excellent for Europe (ICON-EU), especially Germany / Central Europe',
    'mi.gem_seamless': 'Global · strongest in Canada and North America',
    'mi.meteofrance_seamless': 'Europe · ideal for France and Western Europe (AROME/ARPEGE)',
    'mi.ukmo_seamless': 'Global · ideal for the UK and Northern Europe',
    'mi.jma_seamless': 'Global · ideal for Japan and East Asia',
    'mi.cma_grapes_global': 'Global · ideal for China and East Asia',
    'mi.bom_access_global': 'Australia and Oceania',
    'mi.knmi_seamless': 'North-West Europe only (Netherlands, Belgium, Northern Germany)',
    'mi.dmi_seamless': 'Northern Europe only (Denmark, Scandinavia, Baltic)',
    'mi.metno_seamless': 'Scandinavia / Northern Europe only',
    'mi.yr': 'Global · ideal for Norway and Scandinavia',

    'cat.clear': 'Clear', 'cat.partly': 'Partly cloudy', 'cat.cloudy': 'Overcast', 'cat.fog': 'Fog', 'cat.drizzle': 'Drizzle',
    'cat.rain': 'Rain', 'cat.snow': 'Snow', 'cat.thunder': 'Thunderstorm',
    'wx.0': 'Clear sky', 'wx.1': 'Mostly clear', 'wx.2': 'Partly cloudy', 'wx.3': 'Overcast', 'wx.45': 'Fog', 'wx.48': 'Freezing fog',
    'wx.51': 'Light drizzle', 'wx.53': 'Drizzle', 'wx.55': 'Heavy drizzle', 'wx.56': 'Freezing drizzle', 'wx.57': 'Freezing drizzle',
    'wx.61': 'Light rain', 'wx.63': 'Rain', 'wx.65': 'Heavy rain', 'wx.66': 'Freezing rain', 'wx.67': 'Freezing rain',
    'wx.71': 'Light snow', 'wx.73': 'Snow', 'wx.75': 'Heavy snow', 'wx.77': 'Snow grains',
    'wx.80': 'Light showers', 'wx.81': 'Showers', 'wx.82': 'Heavy showers', 'wx.85': 'Snow showers', 'wx.86': 'Heavy snow showers',
    'wx.95': 'Thunderstorm', 'wx.96': 'Thunderstorm with hail', 'wx.99': 'Severe thunderstorm with hail', 'wx.unknown': 'Unknown',

    'meta': '{name} · {lat}, {lon} · elev. {el} m · {a}/{n} providers · updated {time}',
    'err.http': 'Error {s}',
    'err.pick': 'First pick a point on the map or enter coordinates.', 'err.name': 'Enter a name for the location.',
    'ok.saved': 'Location "{n}" saved.',
    'err.geo.unsupported': 'Your browser does not support geolocation.', 'err.geo.fail': 'Could not determine your location.',
    'search.none': 'No results found',
    'saved.forecast': 'Forecast', 'saved.delete': 'Delete', 'saved.none': 'No saved locations yet.',
    'confirm.delete': 'Delete the location "{n}"?',
  },

  el: {
    'title': 'WeFo · Σύγκριση προγνώσεων καιρού',
    'brand.sub': 'σύγκριση μοντέλων καιρού',
    'nav.forecast': 'Πρόγνωση', 'nav.places': 'Τοποθεσίες & Χάρτης',
    'tb.location': 'Τοποθεσία', 'tb.step': 'Βήμα', 'tb.models': 'Μοντέλα',
    'step.1': '1 ώρα', 'step.3': '3 ώρες', 'step.6': '6 ώρες', 'step.12': '12 ώρες',
    'tb.weight': 'Στάθμιση με αξιοπιστία', 'tb.refresh': '↻ Ανανέωση', 'tb.refresh.title': 'Νέα λήψη δεδομένων',
    'empty.html': 'Δεν υπάρχουν αποθηκευμένες τοποθεσίες. Πήγαινε στις <a href="#" data-goto="places">Τοποθεσίες &amp; Χάρτης</a> και πρόσθεσε μία.',
    'loading': 'Λήψη προβλέψεων από όλους τους παρόχους…',
    'pl.pick': 'Επιλογή περιοχής', 'pl.search': 'Αναζήτηση πόλης ή περιοχής…',
    'pl.lat': 'Γεωγρ. πλάτος', 'pl.lon': 'Γεωγρ. μήκος', 'pl.name': 'Όνομα τοποθεσίας', 'pl.name.ph': 'π.χ. Αθήνα',
    'pl.save': 'Αποθήκευση τοποθεσίας', 'pl.geo': 'Η θέση μου',
    'pl.hint': 'Κάνε κλικ στον χάρτη, γράψε συντεταγμένες ή αναζήτησε μια περιοχή.', 'pl.saved': 'Αποθηκευμένες τοποθεσίες',
    'footer.html': 'Δεδομένα: <a href="https://open-meteo.com/" target="_blank" rel="noopener">Open-Meteo</a> (ECMWF, GFS, ICON, GEM, Météo-France, UKMO, JMA, CMA, KNMI, DMI, MET Norway) και <a href="https://api.met.no/" target="_blank" rel="noopener">MET Norway / Yr</a>. Χάρτης © OpenStreetMap. Οι πιθανότητες προκύπτουν από τη συμφωνία των μοντέλων και δεν αποτελούν επίσημη πρόγνωση.',
    'today': 'Σήμερα',
    'theme.title': 'Εναλλαγή φωτεινού / σκούρου θέματος',
    'saved.history': 'Ιστορικό',
    'h.title': 'Ιστορικό καιρού',
    'h.loading.first': 'Λήψη του ιστορικού για πρώτη φορά (περίπου 1,5 MB, λίγα δευτερόλεπτα) και αποθήκευση…',
    'h.loading': 'Φόρτωση ιστορικού…',
    'h.close': 'Κλείσιμο',
    'h.grid': 'Πλησιέστερο σημείο δεδομένων: {lat}, {lon} ({km} km από την τοποθεσία) · υψόμετρο {el} m',
    'h.period': 'Περίοδος: {first} – {last} ({days} ημέρες)',
    'h.source': 'Πηγή: επανανάλυση ERA5 / ERA5-Land (Open-Meteo Historical Weather API) – προκύπτει από μοντέλο με βάση παρατηρήσεις, δεν είναι μετρήσεις σταθμού. Αποθηκεύτηκε τοπικά στις {date}.',
    'h.status.new': 'Λήφθηκε τώρα και αποθηκεύτηκε – την επόμενη φορά ανοίγει αμέσως.',
    'h.status.cached': 'Φορτώθηκε από την τοπική αποθήκευση.',
    'h.update': 'Έλεγχος για νεότερα δεδομένα',
    'h.rec.title': 'Ρεκόρ',
    'h.rec.hottest': 'Θερμότερη ημέρα', 'h.rec.coldest': 'Ψυχρότερη νύχτα', 'h.rec.wettest': 'Πιο βροχερή ημέρα', 'h.rec.windiest': 'Ισχυρότερη ριπή', 'h.rec.snowiest': 'Πιο χιονισμένη ημέρα',
    'h.chart.temp': 'Μέση ετήσια θερμοκρασία', 'h.chart.prcp': 'Ετήσια βροχόπτωση',
    'h.trend': 'Τάση: {v} °C ανά δεκαετία',
    'h.monthly': 'Κλίμα ανά μήνα (μέσος όρος όλων των ετών)', 'h.annual': 'Έτος προς έτος',
    'h.col.month': 'Μήνας', 'h.col.year': 'Έτος', 'h.col.mean': 'Μέση °C', 'h.col.max': 'Μέγ. °C', 'h.col.min': 'Ελάχ. °C', 'h.col.prcp': 'Βροχή mm', 'h.col.rainy': 'Βροχερές ημέρες', 'h.col.gust': 'Ριπή km/h', 'h.col.snow': 'Χιόνι cm',
    'h.partial': '* ημιτελές έτος. «Βροχερές ημέρες» = ημέρες με τουλάχιστον 1 mm.',

    'p.weather': 'Καιρός', 'p.temperature_2m': 'Θερμοκρασία', 'p.precip': 'Βροχή', 'p.wind': 'Άνεμος', 'p.storm': 'Καταιγίδα',
    'p.cloud_cover': 'Νεφοκάλυψη', 'p.relative_humidity_2m': 'Υγρασία', 'p.pressure_msl': 'Πίεση', 'p.reliability': 'Αξιοπιστία',

    'lg.weather': 'Το εικονίδιο της τελευταίας γραμμής είναι η πιο συχνή κατηγορία καιρού ανάμεσα στους παρόχους· το ποσοστό δείχνει πόσοι πάροχοι συμφωνούν. Όπου ένας πάροχος δεν δίνει κωδικό καιρού, προκύπτει από τη βροχή και τη νέφωση.',
    'lg.temperature_2m': 'Συμφωνία = 100% όταν όλοι οι πάροχοι δίνουν την ίδια τιμή και μηδενίζεται όταν η τυπική απόκλιση των τιμών φτάνει τους 4 °C.',
    'lg.precip': 'Πιθανότητα βροχής = ποσοστό των παρόχων που δίνουν τουλάχιστον {thr} mm στο βήμα. Οι τιμές είναι αθροίσματα mm ανά βήμα.',
    'lg.wind': 'Ταχύτητα ανέμου 10 m σε km/h (ριπή σε παρένθεση). Το βέλος δείχνει προς πού φυσά. Πιθανότητα = ποσοστό παρόχων με ≥ {thr} km/h.',
    'lg.storm': 'Ένδειξη καταιγίδας: κωδικός καιρού 95–99 (πλήρης ένδειξη) ή CAPE ≥ 1000 J/kg (μισή ένδειξη). Η πιθανότητα είναι ο μέσος όρος των ενδείξεων όλων των παρόχων. Το CAPE μετρά την ενέργεια αστάθειας της ατμόσφαιρας.',
    'lg.cloud_cover': 'Συμφωνία = 100% όταν όλοι οι πάροχοι δίνουν την ίδια νεφοκάλυψη και μηδενίζεται όταν η τυπική απόκλιση φτάνει το 50%.',
    'lg.relative_humidity_2m': 'Συμφωνία = 100% όταν όλοι οι πάροχοι δίνουν την ίδια τιμή και μηδενίζεται όταν η τυπική απόκλιση φτάνει το 25%.',
    'lg.pressure_msl': 'Πίεση στη στάθμη της θάλασσας. Συμφωνία = 100% όταν όλοι οι πάροχοι δίνουν την ίδια τιμή και μηδενίζεται όταν η τυπική απόκλιση φτάνει τα 4 hPa.',
    'lg.providers': ' Πάροχοι με δεδομένα: {n}.',
    'lg.weighted': ' Η τελευταία γραμμή στηρίζεται σε στάθμιση με την αξιοπιστία κάθε μοντέλου (καρτέλα Αξιοπιστία).',

    'g.provider': 'Πάροχος / μοντέλο', 'g.temp_avg': 'Θερμοκρασία (μ.ο.)', 'g.prob_weather': 'Πιθανότερος καιρός',
    'g.avg_mm': 'Μέσος όρος (mm)', 'g.upto': 'έως {v}', 'g.prob_rain': 'Πιθανότητα βροχής',
    'g.avg_kmh': 'Μέσος όρος (km/h)', 'g.prob_wind': 'Πιθανότητα ισχυρού ανέμου (≥{v})', 'g.gusts': 'ριπές ≥60: {v}%',
    'g.storm_yes': 'καταιγίδα', 'g.storm_maybe': 'πιθανή', 'g.storm_no': 'όχι',
    'g.cape_avg': 'CAPE μέσος όρος (J/kg)', 'g.prob_storm': 'Πιθανότητα καταιγίδας',
    'g.avg_pct': 'Μέσος όρος (%)', 'g.avg_c': 'Μέσος όρος (°C)', 'g.avg_hpa': 'Μέσος όρος (hPa)', 'g.avg': 'Μέσος όρος', 'g.agree': 'Συμφωνία μοντέλων',

    'r.model': 'Μοντέλο', 'r.score': 'Βαθμός', 'r.temp': 'Θερμοκρασία<br>σφάλμα °C', 'r.wind': 'Άνεμος<br>σφάλμα km/h', 'r.cloud': 'Νέφωση<br>σφάλμα %',
    'r.hum': 'Υγρασία<br>σφάλμα %', 'r.press': 'Πίεση<br>σφάλμα hPa', 'r.rain': 'Εντοπισμός<br>βροχής', 'r.code': 'Σωστός<br>καιρός',
    'r.bias': '{v} μεροληψία', 'r.disabled': '(ανενεργό)', 'r.loading': 'Φόρτωση δεδομένων επαλήθευσης…', 'r.unavailable': 'Η επαλήθευση δεν ήταν διαθέσιμη: {e}',
    'r.badge': 'Βαθμός αξιοπιστίας μοντέλου (0–100)',
    'r.legend': 'Επαλήθευση: οι αρχειοθετημένες προβλέψεις κάθε μοντέλου (Open-Meteo Historical Forecast) συγκρίνονται με την ανάλυση ERA5 για την περίοδο {start} – {end} ({hours} ώρες) στην τοποθεσία «{loc}» και, όπου υπάρχουν, με πραγματικές μετρήσεις METAR του κοντινότερου αεροδρομίου. Ο βαθμός (0–100) είναι ο μέσος όρος της επίδοσης ανά παράμετρο (το METAR μετράει {w}%, το ERA5 το υπόλοιπο) και από αυτόν προκύπτουν τα βάρη (0,5–1,8) που ζυγίζουν την πρόβλεψη όταν είναι ενεργή η στάθμιση. Κάθε κελί δείχνει το σφάλμα ως προς το ERA5 και, με μπλε, ως προς το METAR.',
    'r.limits': '<b>Περιορισμοί:</b> το ERA5 είναι επανανάλυση που παράγεται με το μοντέλο του ECMWF, άρα ευνοεί ελαφρά το ECMWF – γι\' αυτό οι πραγματικές μετρήσεις παίρνουν το μεγαλύτερο βάρος όταν υπάρχουν. Ένας σταθμός αεροδρομίου είναι σημειακή μέτρηση: η απόσταση, το υψόμετρο και τοπικά φαινόμενα (θαλάσσια αύρα, αστική θερμότητα) προκαλούν σφάλματα που επηρεάζουν όλα τα μοντέλα παρόμοια. Η πίεση προέρχεται από την τιμή στάθμης θάλασσας ή altimeter του METAR και η βροχή/καιρός από τον κωδικό παρόντος καιρού τη στιγμή της αναφοράς, οπότε ο εντοπισμός βροχής είναι προσεγγιστικός. Οι αρχειοθετημένες προβλέψεις αφορούν κυρίως βραχυπρόθεσμο ορίζοντα. Μοντέλα που δεν καλύπτουν την περιοχή (π.χ. KNMI, DMI, MET Norway Nordic) και το Yr δεν αξιολογούνται και μετρούν με βάρος 1.',
    'r.station': '<b>Πραγματικές μετρήσεις:</b> METAR {id} – {name}, {km} km από την τοποθεσία, {n} ωριαίες αναφορές ({start} – {end}).',
    'r.nostation': '<b>Πραγματικές μετρήσεις:</b> δεν υπάρχει σταθμός METAR με αρκετές πρόσφατες αναφορές σε απόσταση {km} km – χρησιμοποιείται μόνο το ERA5.',
    'r.obs': 'METAR {v}',
    'r.howto': '<b>Πώς διαβάζεται:</b> σε κάθε κελί το <b>ERA5</b> είναι το σφάλμα του μοντέλου ως προς την ανάλυση ERA5 και το <b>METAR</b> (μπλε) το σφάλμα ως προς πραγματικές μετρήσεις αεροδρομίου. Όσο μικρότερο τόσο καλύτερο. Στις στήλες βροχής και καιρού οι τιμές είναι το ποσοστό σωστών εντοπισμών – όσο μεγαλύτερο τόσο καλύτερο. Ο βαθμός συνδυάζει και τις δύο πηγές.',
    'vf.loading': '· φόρτωση αξιοπιστίας…', 'vf.unavail': '· μη διαθέσιμη',

    'm.active': '{a}/{n} ενεργά', 'm.dup': 'Ίδια δεδομένα με {n} (εκτός περιοχής κάλυψης) – δεν μετράει διπλά',
    'm.missing': 'Χωρίς κάλυψη για αυτή την τοποθεσία', 'm.all': 'Ενεργοποίηση όλων',
    'mn.jma_seamless': 'JMA (Ιαπωνία)', 'mn.cma_grapes_global': 'CMA GRAPES (Κίνα)', 'mn.bom_access_global': 'BOM ACCESS (Αυστραλία)',
    'mn.knmi_seamless': 'KNMI (Ολλανδία)', 'mn.dmi_seamless': 'DMI (Δανία)', 'mn.metno_seamless': 'MET Norway (Nordic)',
    'mi.ecmwf_ifs025': 'Παγκόσμιο · γενικά το πιο ακριβές σε μεσοπρόθεσμο ορίζοντα',
    'mi.gfs_seamless': 'Παγκόσμιο · ισχυρότερο στη Β. Αμερική',
    'mi.icon_seamless': 'Παγκόσμιο · εξαιρετικό για Ευρώπη (ICON-EU), κυρίως Γερμανία/Κεντρική Ευρώπη',
    'mi.gem_seamless': 'Παγκόσμιο · ισχυρότερο σε Καναδά και Β. Αμερική',
    'mi.meteofrance_seamless': 'Ευρώπη · ιδανικό για Γαλλία και Δυτική Ευρώπη (AROME/ARPEGE)',
    'mi.ukmo_seamless': 'Παγκόσμιο · ιδανικό για Βρετανία και Βόρεια Ευρώπη',
    'mi.jma_seamless': 'Παγκόσμιο · ιδανικό για Ιαπωνία και Ανατολική Ασία',
    'mi.cma_grapes_global': 'Παγκόσμιο · ιδανικό για Κίνα και Ανατολική Ασία',
    'mi.bom_access_global': 'Αυστραλία και Ωκεανία',
    'mi.knmi_seamless': 'Μόνο Βορειοδυτική Ευρώπη (Ολλανδία, Βέλγιο, Βόρεια Γερμανία)',
    'mi.dmi_seamless': 'Μόνο Βόρεια Ευρώπη (Δανία, Σκανδιναβία, Βαλτική)',
    'mi.metno_seamless': 'Μόνο Σκανδιναβία / Βόρεια Ευρώπη',
    'mi.yr': 'Παγκόσμιο · ιδανικό για Νορβηγία και Σκανδιναβία',

    'cat.clear': 'Αίθριος', 'cat.partly': 'Λίγες νεφώσεις', 'cat.cloudy': 'Συννεφιά', 'cat.fog': 'Ομίχλη', 'cat.drizzle': 'Ψιχάλες',
    'cat.rain': 'Βροχή', 'cat.snow': 'Χιόνι', 'cat.thunder': 'Καταιγίδα',
    'wx.0': 'Αίθριος', 'wx.1': 'Κυρίως αίθριος', 'wx.2': 'Λίγες νεφώσεις', 'wx.3': 'Συννεφιά', 'wx.45': 'Ομίχλη', 'wx.48': 'Παγωμένη ομίχλη',
    'wx.51': 'Ελαφριές ψιχάλες', 'wx.53': 'Ψιχάλες', 'wx.55': 'Έντονες ψιχάλες', 'wx.56': 'Παγωμένες ψιχάλες', 'wx.57': 'Παγωμένες ψιχάλες',
    'wx.61': 'Ασθενής βροχή', 'wx.63': 'Βροχή', 'wx.65': 'Έντονη βροχή', 'wx.66': 'Παγωμένη βροχή', 'wx.67': 'Παγωμένη βροχή',
    'wx.71': 'Ασθενής χιονόπτωση', 'wx.73': 'Χιονόπτωση', 'wx.75': 'Έντονη χιονόπτωση', 'wx.77': 'Κόκκοι χιονιού',
    'wx.80': 'Ασθενείς μπόρες', 'wx.81': 'Μπόρες', 'wx.82': 'Ισχυρές μπόρες', 'wx.85': 'Χιονομπόρες', 'wx.86': 'Έντονες χιονομπόρες',
    'wx.95': 'Καταιγίδα', 'wx.96': 'Καταιγίδα με χαλάζι', 'wx.99': 'Ισχυρή καταιγίδα με χαλάζι', 'wx.unknown': 'Άγνωστο',

    'meta': '{name} · {lat}, {lon} · υψόμ. {el} m · {a}/{n} πάροχοι · ενημέρωση {time}',
    'err.http': 'Σφάλμα {s}',
    'err.pick': 'Διάλεξε πρώτα σημείο στον χάρτη ή γράψε συντεταγμένες.', 'err.name': 'Δώσε ένα όνομα για την τοποθεσία.',
    'ok.saved': 'Η τοποθεσία «{n}» αποθηκεύτηκε.',
    'err.geo.unsupported': 'Ο browser δεν υποστηρίζει εντοπισμό θέσης.', 'err.geo.fail': 'Δεν ήταν δυνατός ο εντοπισμός της θέσης σου.',
    'search.none': 'Δεν βρέθηκαν αποτελέσματα',
    'saved.forecast': 'Πρόγνωση', 'saved.delete': 'Διαγραφή', 'saved.none': 'Καμία αποθηκευμένη τοποθεσία ακόμη.',
    'confirm.delete': 'Διαγραφή της τοποθεσίας «{n}»;',
  },
};

let LANG = 'en';
try { const s = localStorage.getItem('wefo.lang'); if (s && I18N[s]) LANG = s; } catch (e) { /* ignore */ }

/* t('key', {var: value}) – falls back to English, then to the key itself */
function t(key, vars) {
  let s = (I18N[LANG] && I18N[LANG][key]) ?? I18N.en[key] ?? key;
  if (vars) for (const k in vars) s = s.split('{' + k + '}').join(vars[k]);
  return s;
}
const hasT = (key) => !!(I18N[LANG] && I18N[LANG][key]) || !!I18N.en[key];
const dateLocale = () => (LANG === 'el' ? 'el-GR' : 'en-GB');

/* Static texts in index.html: data-i18n (text), data-i18n-html, data-i18n-ph (placeholder), data-i18n-title */
function applyStaticI18n() {
  document.documentElement.lang = LANG;
  document.title = t('title');
  document.querySelectorAll('[data-i18n]').forEach((el) => { el.textContent = t(el.dataset.i18n); });
  document.querySelectorAll('[data-i18n-html]').forEach((el) => { el.innerHTML = t(el.dataset.i18nHtml); });
  document.querySelectorAll('[data-i18n-ph]').forEach((el) => { el.placeholder = t(el.dataset.i18nPh); });
  document.querySelectorAll('[data-i18n-title]').forEach((el) => { el.title = t(el.dataset.i18nTitle); });
  document.querySelectorAll('[data-lang]').forEach((b) => b.classList.toggle('active', b.dataset.lang === LANG));
}

function setLang(lang) {
  if (!I18N[lang]) return;
  LANG = lang;
  try { localStorage.setItem('wefo.lang', lang); } catch (e) { /* ignore */ }
  applyStaticI18n();
  if (typeof onLangChange === 'function') onLangChange();
}
