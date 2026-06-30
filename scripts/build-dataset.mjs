import { mkdir, writeFile } from "node:fs/promises";

const STATE = "36";
const OUTPUT_DIR = new URL("../data/", import.meta.url);
const GENERATED_AT = new Date().toISOString();

const SAMPLE_LOCATIONS = [
  { name: "New York City", lat: 40.7128, lng: -74.0060 },
  { name: "Buffalo", lat: 42.8864, lng: -78.8784 },
  { name: "Rochester", lat: 43.1566, lng: -77.6088 },
  { name: "Syracuse", lat: 43.0481, lng: -76.1474 },
  { name: "Albany", lat: 42.6526, lng: -73.7562 },
  { name: "Yonkers", lat: 40.9312, lng: -73.8988 },
  { name: "White Plains", lat: 41.0340, lng: -73.7629 },
  { name: "Poughkeepsie", lat: 41.7004, lng: -73.9209 },
  { name: "Ithaca", lat: 42.4440, lng: -76.5021 },
  { name: "Watertown", lat: 43.9748, lng: -75.9107 },
  { name: "Plattsburgh", lat: 44.6995, lng: -73.4529 },
  { name: "Jamestown", lat: 42.0970, lng: -79.2353 },
  { name: "Harrison", lat: 40.9676, lng: -73.7124 }
];

const ACS_VARS = [
  "B19013_001E", // median household income
  "B17001_001E", // poverty universe
  "B17001_002E", // below poverty
  "B25035_001E", // median year built
  "B25003_001E", // occupied housing units
  "B25003_003E", // renter occupied
  "B01003_001E", // total population
  "B03002_001E", // race/ethnicity total
  "B03002_003E", // non-Hispanic white alone
  "B01001_003E",
  "B01001_004E",
  "B01001_005E",
  "B01001_006E",
  "B01001_027E",
  "B01001_028E",
  "B01001_029E",
  "B01001_030E",
  "B01001_020E",
  "B01001_021E",
  "B01001_022E",
  "B01001_023E",
  "B01001_024E",
  "B01001_025E",
  "B01001_044E",
  "B01001_045E",
  "B01001_046E",
  "B01001_047E",
  "B01001_048E",
  "B01001_049E"
];

function assertOk(response, label) {
  if (!response.ok) {
    throw new Error(`${label} failed with HTTP ${response.status}`);
  }
  return response;
}

async function fetchJson(url, label) {
  const response = await fetch(url);
  assertOk(response, label);
  const contentType = response.headers.get("content-type") || "";
  const text = await response.text();
  if (!contentType.includes("json")) {
    throw new Error(`${label} did not return JSON: ${text.replace(/\s+/g, " ").slice(0, 180)}`);
  }
  const json = JSON.parse(text);
  if (json.error) throw new Error(`${label}: ${json.error.message || JSON.stringify(json.error)}`);
  return json;
}

function number(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : -1;
}

function clamp(value, min = 0, max = 1) {
  return Math.max(min, Math.min(max, value));
}

function normalize(value, low, high) {
  if (!Number.isFinite(value) || value < 0) return 0;
  return clamp((value - low) / (high - low));
}

function inverseNormalize(value, low, high) {
  if (!Number.isFinite(value) || value < 0) return 0;
  return 1 - normalize(value, low, high);
}

function average(values) {
  const clean = values.filter((value) => Number.isFinite(value));
  return clean.length ? clean.reduce((sum, value) => sum + value, 0) / clean.length : 0;
}

function maxValue(values) {
  const clean = values.filter((value) => Number.isFinite(value));
  return clean.length ? Math.max(...clean) : 0;
}

function compact(num, digits = 4) {
  return Number.isFinite(num) ? Number(num.toFixed(digits)) : -1;
}

function tractCentroid(feature) {
  const geom = feature.geometry;
  const ring = geom.type === "Polygon" ? geom.coordinates[0] : geom.coordinates[0][0];
  let lngSum = 0;
  let latSum = 0;
  for (const [lng, lat] of ring) {
    lngSum += lng;
    latSum += lat;
  }
  return [lngSum / ring.length, latSum / ring.length];
}

async function fetchTractBoundaries() {
  const where = `STATE%3D%27${STATE}%27`;
  const endpoint = "https://tigerweb.geo.census.gov/arcgis/rest/services/TIGERweb/Tracts_Blocks/MapServer/0/query";
  const countUrl = `${endpoint}?where=${where}&returnCountOnly=true&f=json`;
  const countJson = await fetchJson(countUrl, "TIGERweb tract count");
  const pages = Math.ceil(countJson.count / 2000);
  const base = `${endpoint}?where=${where}&outFields=TRACT,GEOID,NAME&outSR=4326&f=geojson&returnGeometry=true&resultRecordCount=2000`;
  const batches = [];
  for (let page = 0; page < pages; page += 1) {
    const json = await fetchJson(`${base}&resultOffset=${page * 2000}`, `TIGERweb tract page ${page + 1}`);
    batches.push(...(json.features || []));
    console.log(`Downloaded tract geometry page ${page + 1}/${pages}`);
  }
  return { type: "FeatureCollection", features: batches };
}

async function fetchACSData() {
  const censusKey = process.env.CENSUS_API_KEY;
  if (!censusKey) {
    throw new Error("Set CENSUS_API_KEY before running npm run build:data. The Census ACS API requires a key.");
  }
  const url = "https://api.census.gov/data/2023/acs/acs5"
    + `?get=NAME,${ACS_VARS.join(",")}&for=tract:*&in=state:${STATE}`
    + `&key=${encodeURIComponent(censusKey)}`;
  const rows = await fetchJson(url, "ACS 2023 5-year tract data");
  const headers = rows[0];
  const acs = new Map();

  for (const row of rows.slice(1)) {
    const obj = Object.fromEntries(headers.map((header, index) => [header, row[index]]));
    const geoid = `${String(obj.state).padStart(2, "0")}${String(obj.county).padStart(3, "0")}${String(obj.tract).padStart(6, "0")}`;
    const population = number(obj.B01003_001E);
    const povertyDenominator = number(obj.B17001_001E);
    const occupiedUnits = number(obj.B25003_001E);
    const raceTotal = number(obj.B03002_001E);
    const nonHispanicWhite = number(obj.B03002_003E);
    const under18 = [
      "B01001_003E", "B01001_004E", "B01001_005E", "B01001_006E",
      "B01001_027E", "B01001_028E", "B01001_029E", "B01001_030E"
    ].reduce((sum, key) => sum + Math.max(0, number(obj[key])), 0);
    const over65 = [
      "B01001_020E", "B01001_021E", "B01001_022E", "B01001_023E", "B01001_024E", "B01001_025E",
      "B01001_044E", "B01001_045E", "B01001_046E", "B01001_047E", "B01001_048E", "B01001_049E"
    ].reduce((sum, key) => sum + Math.max(0, number(obj[key])), 0);

    const income = number(obj.B19013_001E);
    const povertyRate = povertyDenominator > 0 ? number(obj.B17001_002E) / povertyDenominator : -1;
    const renterPct = occupiedUnits > 0 ? number(obj.B25003_003E) / occupiedUnits : -1;
    const under18Pct = population > 0 ? under18 / population : -1;
    const over65Pct = population > 0 ? over65 / population : -1;
    const ageSensitivePct = population > 0 ? (under18 + over65) / population : -1;
    const peopleOfColorPct = raceTotal > 0 ? 1 - nonHispanicWhite / raceTotal : -1;
    const yearBuilt = number(obj.B25035_001E);

    const vulnerability = (
      inverseNormalize(income, 30000, 150000) * 0.32
      + normalize(povertyRate, 0, 0.3) * 0.28
      + inverseNormalize(yearBuilt, 1940, 2010) * 0.16
      + normalize(renterPct, 0, 0.8) * 0.12
      + normalize(ageSensitivePct, 0.2, 0.55) * 0.12
    );

    acs.set(geoid, {
      name: obj.NAME,
      population,
      income: income > 0 ? income : -1,
      poverty_rate: compact(povertyRate),
      year_built: yearBuilt > 0 ? yearBuilt : -1,
      renter_pct: compact(renterPct),
      under18_pct: compact(under18Pct),
      over65_pct: compact(over65Pct),
      age_sensitive_pct: compact(ageSensitivePct),
      people_of_color_pct: compact(peopleOfColorPct),
      vulnerability: compact(vulnerability)
    });
  }

  return acs;
}

async function fetchOpenMeteoSample(location) {
  const url = "https://air-quality-api.open-meteo.com/v1/air-quality"
    + `?latitude=${location.lat.toFixed(4)}&longitude=${location.lng.toFixed(4)}`
    + "&hourly=pm2_5,us_aqi,ozone,grass_pollen,birch_pollen,alder_pollen,ragweed_pollen"
    + "&forecast_days=7&timezone=America%2FNew_York";
  const data = await fetchJson(url, `Open-Meteo ${location.name}`);
  const hourly = data.hourly || {};
  const pollenValues = [
    ...(hourly.grass_pollen || []),
    ...(hourly.birch_pollen || []),
    ...(hourly.alder_pollen || []),
    ...(hourly.ragweed_pollen || [])
  ];
  const pollenPeak = maxValue(pollenValues);
  const pollenAverage = average(pollenValues);
  const pm25Average = average(hourly.pm2_5 || []);
  const aqiAverage = average(hourly.us_aqi || []);
  const ozoneAverage = average(hourly.ozone || []);
  const exposureRaw = (
    normalize(pollenPeak, 0, 12) * 0.5
    + normalize(pm25Average, 0, 35) * 0.25
    + normalize(aqiAverage, 0, 100) * 0.15
    + normalize(ozoneAverage, 0, 140) * 0.1
  );

  return {
    ...location,
    pollen_peak: compact(pollenPeak),
    pollen_average: compact(pollenAverage),
    pm25_average: compact(pm25Average),
    aqi_average: compact(aqiAverage),
    ozone_average: compact(ozoneAverage),
    exposure_raw: compact(exposureRaw)
  };
}

async function fetchOpenMeteoSamples() {
  const samples = [];
  for (const location of SAMPLE_LOCATIONS) {
    const sample = await fetchOpenMeteoSample(location);
    samples.push(sample);
    console.log(`Downloaded Open-Meteo sample for ${location.name}`);
  }
  return samples;
}

function attachResearchMetrics(geojson, acs, samples) {
  for (const feature of geojson.features) {
    const geoid = String(feature.properties.GEOID).padStart(11, "0");
    const acsRow = acs.get(geoid);
    Object.assign(feature.properties, acsRow || {
      population: -1,
      income: -1,
      poverty_rate: -1,
      year_built: -1,
      renter_pct: -1,
      under18_pct: -1,
      over65_pct: -1,
      age_sensitive_pct: -1,
      people_of_color_pct: -1,
      vulnerability: 0
    });

    const [lng, lat] = tractCentroid(feature);
    let nearestSample = samples[0];
    let nearestDistance = Infinity;
    for (const sample of samples) {
      const distance = (lng - sample.lng) ** 2 + (lat - sample.lat) ** 2;
      if (distance < nearestDistance) {
        nearestDistance = distance;
        nearestSample = sample;
      }
    }

    const exposure = nearestSample?.exposure_raw || 0;
    const vulnerability = feature.properties.vulnerability || 0;
    const equityRisk = exposure * 0.55 + vulnerability * 0.45;
    Object.assign(feature.properties, {
      allergen: compact(exposure),
      exposure: compact(exposure),
      equity_risk: compact(equityRisk),
      nearest_sample: nearestSample.name,
      sample_pollen_peak: nearestSample.pollen_peak,
      sample_pm25_average: nearestSample.pm25_average,
      sample_aqi_average: nearestSample.aqi_average
    });
  }
}

function summarize(geojson, samples) {
  const rows = geojson.features.map((feature) => feature.properties);
  const valid = rows.filter((row) => row.population > 0);
  const topEquityRisk = [...valid]
    .sort((a, b) => b.equity_risk - a.equity_risk)
    .slice(0, 25)
    .map((row) => ({
      geoid: row.GEOID,
      name: row.name,
      equity_risk: row.equity_risk,
      exposure: row.exposure,
      vulnerability: row.vulnerability,
      income: row.income,
      poverty_rate: row.poverty_rate,
      nearest_sample: row.nearest_sample
    }));

  return {
    generated_at: GENERATED_AT,
    geography: "New York State census tracts",
    tract_count: geojson.features.length,
    data_sources: [
      "U.S. Census TIGERweb tract boundaries",
      "U.S. Census ACS 2023 5-year tract socioeconomic variables",
      "Open-Meteo Air Quality API 7-day pollen, PM2.5, AQI, and ozone forecasts"
    ],
    methods: {
      exposure: "Each tract inherits the 7-day Open-Meteo exposure proxy from the nearest New York sample city. Exposure combines pollen peak, PM2.5, AQI, and ozone.",
      vulnerability: "Composite of lower median income, poverty rate, older median housing year, renter share, and child/older-adult population share. Race/ethnicity is retained as equity context but not used in the vulnerability score.",
      equity_risk: "0.55 * exposure + 0.45 * social vulnerability. This is an environmental exposure proxy, not a medical diagnosis."
    },
    sample_locations: samples,
    averages: {
      exposure: compact(average(valid.map((row) => row.exposure))),
      vulnerability: compact(average(valid.map((row) => row.vulnerability))),
      equity_risk: compact(average(valid.map((row) => row.equity_risk))),
      poverty_rate: compact(average(valid.map((row) => row.poverty_rate))),
      people_of_color_pct: compact(average(valid.map((row) => row.people_of_color_pct)))
    },
    top_equity_risk: topEquityRisk
  };
}

function sampleFeatureCollection(samples) {
  return {
    type: "FeatureCollection",
    features: samples.map((sample) => ({
      type: "Feature",
      geometry: {
        type: "Point",
        coordinates: [sample.lng, sample.lat]
      },
      properties: {
        name: sample.name,
        latitude: sample.lat,
        longitude: sample.lng,
        pollen_peak: sample.pollen_peak,
        pollen_average: sample.pollen_average,
        pm25_average: sample.pm25_average,
        aqi_average: sample.aqi_average,
        ozone_average: sample.ozone_average,
        exposure_raw: sample.exposure_raw
      }
    }))
  };
}

async function main() {
  await mkdir(OUTPUT_DIR, { recursive: true });
  console.log("Downloading New York tract boundaries...");
  const tractGeojson = await fetchTractBoundaries();
  console.log("Downloading ACS social vulnerability variables...");
  const acs = await fetchACSData();
  console.log("Downloading Open-Meteo allergen and air-quality samples...");
  const samples = await fetchOpenMeteoSamples();
  attachResearchMetrics(tractGeojson, acs, samples);
  const summary = summarize(tractGeojson, samples);
  const sampleGeojson = sampleFeatureCollection(samples);

  await writeFile(new URL("ny-allergy-equity.geojson", OUTPUT_DIR), JSON.stringify(tractGeojson));
  await writeFile(new URL("ny-allergy-equity-summary.json", OUTPUT_DIR), JSON.stringify(summary, null, 2));
  await writeFile(new URL("exposure-samples.geojson", OUTPUT_DIR), JSON.stringify(sampleGeojson, null, 2));
  console.log(`Wrote ${tractGeojson.features.length} tracts to data/ny-allergy-equity.geojson`);
  console.log("Wrote data/ny-allergy-equity-summary.json");
  console.log("Wrote data/exposure-samples.geojson");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
