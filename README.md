# WeFo – σύγκριση προγνώσεων καιρού

PHP + SQLite + vanilla JS. Συγκρίνει δωρεάν μοντέλα καιρού (Open-Meteo: ECMWF, GFS, ICON, GEM, Météo-France, UKMO, JMA, CMA, KNMI, DMI, MET Norway, καθώς και MET Norway/Yr) και δίνει πιθανότητα βάσει της συμφωνίας τους.

Εκτέλεση: τοποθέτησε τον φάκελο στο webroot (π.χ. Laragon `www/wefo`) ή τρέξε `php -S 127.0.0.1:8099`. Απαιτεί PHP με `pdo_sqlite` και `curl`. Η βάση δημιουργείται αυτόματα στο `data/`.
