# Allergy Equity Map — New York State

A static MapLibre GL JS research prototype for studying the relationship between environmental allergy exposure and social equity across New York State census tracts.

---

## Research Question

Are socially vulnerable communities disproportionately exposed to higher local allergy risk when pollen, air pollution, and census-tract vulnerability indicators are combined?

The current prototype treats this as an environmental exposure and vulnerability mapping problem, not as a medical diagnosis.

## What The Page Shows

- A New York State tract map with 5,411 census tracts.
- An **Allergy Equity Risk** layer combining exposure and social vulnerability.
- Separate layers for exposure proxy, social vulnerability, income, poverty, and demographic equity context.
- A scatter plot comparing allergen exposure with social vulnerability.
- Raw Open-Meteo exposure sample points shown directly on the map as a dense 0.25-degree grid clipped to New York State tracts.
- Clickable tract details with IDW-estimated pollen, PM2.5, AQI, ozone, income, poverty, renter share, age-sensitive population, and people-of-color share.
- A separate `correlation.html` page for interactive correlation analysis across tract variables.

## Downloaded Data

Generated files live in `data/`:

- `data/ny-allergy-equity.geojson` — tract geometry plus joined research variables.
- `data/ny-allergy-equity-summary.json` — method notes, sample locations, averages, and top equity-risk tracts.
- `data/exposure-samples.geojson` — 2,700 Open-Meteo exposure sample points displayed on the map.
- `data/exposure-raw-points.geojson` — raw point-shaped Open-Meteo API results with hourly pollen and air-quality time series.

The download script uses:

- U.S. Census TIGERweb tract boundaries.
- ACS 2023 5-year socioeconomic and housing variables.
- Open-Meteo Air Quality API pollen, PM2.5, AQI, and ozone forecasts.

## Index Method

**Exposure proxy** is estimated for each tract from nearby Open-Meteo sample points using inverse-distance weighted averaging. The assigned tract fields include pollen peak, pollen average, PM2.5 average, AQI average, ozone average, and the combined exposure score.

**Social vulnerability** combines lower median household income, poverty rate, older median housing year, renter share, and child/older-adult population share.

**Allergy equity risk** is:

```text
0.55 * exposure + 0.45 * social vulnerability
```

Race/ethnicity is included as demographic equity context, but it is not used inside the vulnerability score.

## Rebuild Data

The Census ACS API requires a free key:

```bash
export CENSUS_API_KEY="your-census-key"
npm run build:data
```

Refresh only the Open-Meteo exposure grid and tract exposure assignment:

```bash
npm run refresh:exposure
```

For a different grid density:

```bash
EXPOSURE_GRID_STEP=0.25 npm run refresh:exposure
```

## Run Locally

Open `index.html` directly in a browser, or use:

```bash
npm run serve
```

Then open `http://localhost:4173`.

Open `http://localhost:4173/correlation.html` for the dedicated correlation analysis page.
