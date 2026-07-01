# Downloaded Research Data

Run this from the repository root:

```bash
npm run build:data
```

The script downloads and joins:

- U.S. Census TIGERweb census tract boundaries for New York State.
- ACS 2023 5-year tract-level social and housing variables.
- Open-Meteo 7-day pollen, PM2.5, AQI, and ozone samples for selected New York locations.

Generated files:

- `ny-allergy-equity.geojson` — tract geometry plus exposure, vulnerability, and equity-risk fields.
- `ny-allergy-equity-summary.json` — source notes, method notes, statewide averages, sample locations, and top-risk tracts.
- `exposure-samples.geojson` — original Open-Meteo exposure sample points used to estimate tract-level exposure by inverse-distance weighted averaging. The current file uses 2,700 cached API sample points from a 0.25-degree statewide grid plus small-tract centroid samples.
- `exposure-raw-points.geojson` — raw point-shaped Open-Meteo API results. Each feature is one queried coordinate and includes the hourly arrays returned by the API.

The indices are research proxies for spatial exposure and social vulnerability. They are not medical diagnoses or direct measurements of personal allergy outcomes.
