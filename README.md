# Allergen Intensity Map — Harrison, NY

A MapLibre GL JS map visualizing allergen source intensity around Harrison, NY (40.9676°N, 73.7124°W), using a combination of pollen, air quality, weather, and vegetation data.

---

## Key Factors

- **Pollen** — direct allergen counts by species
- **Air quality / pollution** — PM2.5, PM10, ozone amplify allergen effects
- **Weather** — wind speed/direction drives dispersal; humidity and precipitation suppress airborne pollen; temperature accelerates bloom seasons
- **Vegetation / land cover** — identifies where allergen sources (oak, birch, ragweed, grass) are concentrated

---

## Data Sources

### Pollen

| Source | What it provides | Cost | API key? |
|---|---|---|---|
| [Open-Meteo Air Quality API](https://open-meteo.com/en/docs/air-quality-api) | Grass, birch, alder, ragweed pollen counts (hourly, 5-day forecast) | Free | No |
| [Google Pollen API](https://developers.google.com/maps/documentation/pollen/overview) | Hyperlocal pollen by plant type, 5-day forecast, 65+ countries | 5,000 free calls/mo, then $10/1K | Yes (Google Cloud) |
| [Ambee Pollen API](https://www.getambee.com/api/pollen) | Pollen counts by species, real-time | 15-day trial (100 calls/day), then paid | Yes |

### Air Quality / Pollution

| Source | What it provides | Cost | API key? |
|---|---|---|---|
| [Open-Meteo Air Quality API](https://open-meteo.com/en/docs/air-quality-api) | PM2.5, PM10, NO₂, O₃, SO₂, CO, UV index (modeled) | Free | No |
| [EPA AirNow API](https://docs.airnowapi.org/) | Real-time AQI from ground monitoring stations in Westchester County | Free | Yes (free registration) |
| [NYSDEC Air Quality](https://dec.ny.gov/environmental-protection/air-quality/monitoring) | NY-specific real-time AQI and forecasts | Free (web) | No public API |

### Weather

| Source | What it provides | Cost | API key? |
|---|---|---|---|
| [Open-Meteo Forecast API](https://open-meteo.com/) | Wind speed/direction, humidity, temperature, precipitation (hourly) | Free | No |

### Vegetation / Allergen Sources (static layers)

| Source | What it provides | Cost |
|---|---|---|
| [USDA Forest Service Tree Canopy Cover](https://data.fs.usda.gov/geodata/rastergateway/treecanopycover/) | Raster data showing tree density per area | Free |
| [USDA PLANTS Database API](https://plants.usda.gov/) | Plant species info and allergenicity ratings | Free |
| [IQAir Westchester County](https://www.iqair.com/us/pollen/usa/new-york/westchester-county) | Pollen count and allergy info for Westchester County | Free (web) |

---

## Recommended Starter Stack (no API key required)

### Open-Meteo — Pollen + Air Quality + Weather

```
GET https://air-quality-api.open-meteo.com/v1/air-quality
  ?latitude=40.9676
  &longitude=-73.7124
  &hourly=pm2_5,pm10,ozone,grass_pollen,birch_pollen,alder_pollen,ragweed_pollen
```

### EPA AirNow — Ground Station AQI for Westchester County

Register for a free key at [docs.airnowapi.org](https://docs.airnowapi.org/), then query by zip code or lat/lng for real-time AQI readings from local monitoring stations.

### USDA Tree Canopy — Static Vegetation Layer

Download GeoTIFF rasters from the [USDA Forest Service Geodata Clearinghouse](https://data.fs.usda.gov/geodata/rastergateway/treecanopycover/) to identify high tree-density zones correlating to pollen source intensity.

---

## Upgrade Path

Add **Google Pollen API** (5,000 free calls/mo) for hyperlocal, species-level pollen detail once the prototype is working.
