# Downloaded Research Data

Run this from the repository root:

```bash
npm run build:data
```

The script downloads and joins:

- U.S. Census TIGERweb census tract boundaries for New York State.
- ACS 2023 5-year tract-level social and housing variables.
- Open-Meteo 7-day pollen, PM2.5, AQI, and ozone samples for selected New York locations.

Generated files (trimmed to NYC's five boroughs to keep page-load size down):

- `ny-allergy-equity.geojson` — tract geometry plus exposure, vulnerability, equity-risk, and ATPI fields.
- `ny-allergy-equity-summary.json` — source notes, method notes, statewide averages, and top-risk tracts.
- `exposure-samples.geojson` — Open-Meteo exposure sample points (NYC bounding box) used to estimate tract-level exposure by inverse-distance weighted averaging.
- `nyc-tree-atpi-by-tract.json` — per-tract Allergenic Tree Pollen Index, computed from NYC Parks' 2015 Street Tree Census (see `scripts/compute-atpi.py`).
- `nyc-tree-species-evidence.json` — genus-level pollen-potential summary backing the Species Evidence section.

Two large source-only files (`exposure-raw-points.geojson`, the raw statewide Open-Meteo point dump, and `mappinginequality.gpkg`, the source HOLC GeoPackage) were removed since neither is fetched by any page — they were only inputs to `scripts/refresh-exposure-samples.mjs` and `scripts/export-ny-holc.mjs`. Re-running those scripts requires re-fetching/re-downloading the source data first.

The indices are research proxies for spatial exposure and social vulnerability, and ATPI is a relative source-potential estimate. None of this is a medical diagnosis or a direct measurement of personal allergy outcomes.
