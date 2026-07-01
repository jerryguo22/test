import { mkdir, readFile, writeFile } from "node:fs/promises";

const DATA_DIR = new URL("../data/", import.meta.url);
const TRACT_FILE = new URL("ny-allergy-equity.geojson", DATA_DIR);
const SUMMARY_FILE = new URL("ny-allergy-equity-summary.json", DATA_DIR);
const SAMPLE_FILE = new URL("exposure-samples.geojson", DATA_DIR);
const RAW_SAMPLE_FILE = new URL("exposure-raw-points.geojson", DATA_DIR);
const CACHE_DIR = new URL("exposure-cache/", DATA_DIR);
const GRID_STEP_DEGREES = Number(process.env.EXPOSURE_GRID_STEP || 0.25);
const CONCURRENCY = Number(process.env.EXPOSURE_FETCH_CONCURRENCY || 1);
const BATCH_SIZE = Number(process.env.EXPOSURE_BATCH_SIZE || 25);
const BATCH_DELAY_MS = Number(process.env.EXPOSURE_BATCH_DELAY_MS || 700);
const USE_CACHE_ONLY = process.env.EXPOSURE_USE_CACHE_ONLY === "1";
const SMALL_TRACT_AREA_KM2 = Number(process.env.EXPOSURE_SMALL_TRACT_AREA_KM2 || 1);
const IDW_NEIGHBORS = Number(process.env.EXPOSURE_IDW_NEIGHBORS || 8);
const IDW_POWER = Number(process.env.EXPOSURE_IDW_POWER || 2);
const RETRY_DELAYS_MS = [3000, 8000, 16000, 30000, 60000];

function number(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : -1;
}

function compact(num, digits = 4) {
  return Number.isFinite(num) ? Number(num.toFixed(digits)) : -1;
}

function clamp(value, min = 0, max = 1) {
  return Math.max(min, Math.min(max, value));
}

function normalize(value, low, high) {
  if (!Number.isFinite(value) || value < 0) return 0;
  return clamp((value - low) / (high - low));
}

function average(values) {
  const clean = values.filter((value) => Number.isFinite(value));
  return clean.length ? clean.reduce((sum, value) => sum + value, 0) / clean.length : 0;
}

function maxValue(values) {
  const clean = values.filter((value) => Number.isFinite(value));
  return clean.length ? Math.max(...clean) : 0;
}

function featureBbox(feature) {
  let minLng = Infinity;
  let minLat = Infinity;
  let maxLng = -Infinity;
  let maxLat = -Infinity;
  visitCoordinates(feature.geometry.coordinates, ([lng, lat]) => {
    minLng = Math.min(minLng, lng);
    minLat = Math.min(minLat, lat);
    maxLng = Math.max(maxLng, lng);
    maxLat = Math.max(maxLat, lat);
  });
  return [minLng, minLat, maxLng, maxLat];
}

function visitCoordinates(coords, visitor) {
  if (typeof coords[0] === "number") {
    visitor(coords);
    return;
  }
  coords.forEach((child) => visitCoordinates(child, visitor));
}

function ringsForFeature(feature) {
  if (feature.geometry.type === "Polygon") return feature.geometry.coordinates;
  if (feature.geometry.type === "MultiPolygon") return feature.geometry.coordinates.flat();
  return [];
}

function pointInRing(point, ring) {
  const [x, y] = point;
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i, i += 1) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    const intersects = ((yi > y) !== (yj > y))
      && (x < ((xj - xi) * (y - yi)) / ((yj - yi) || Number.EPSILON) + xi);
    if (intersects) inside = !inside;
  }
  return inside;
}

function pointInFeature(point, preparedFeature) {
  if (
    point[0] < preparedFeature.bbox[0]
    || point[0] > preparedFeature.bbox[2]
    || point[1] < preparedFeature.bbox[1]
    || point[1] > preparedFeature.bbox[3]
  ) return false;
  return preparedFeature.rings.some((ring) => pointInRing(point, ring));
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

function ringAreaKm2(ring, lat0) {
  const metersPerLat = 111320;
  const metersPerLng = 111320 * Math.cos((lat0 * Math.PI) / 180);
  let sum = 0;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i, i += 1) {
    const [x1, y1] = [ring[j][0] * metersPerLng, ring[j][1] * metersPerLat];
    const [x2, y2] = [ring[i][0] * metersPerLng, ring[i][1] * metersPerLat];
    sum += x1 * y2 - x2 * y1;
  }
  return Math.abs(sum) / 2 / 1_000_000;
}

function tractAreaKm2(feature) {
  const [, lat] = tractCentroid(feature);
  if (feature.geometry.type === "Polygon") {
    return feature.geometry.coordinates.reduce((sum, ring, index) => (
      sum + (index === 0 ? 1 : -1) * ringAreaKm2(ring, lat)
    ), 0);
  }
  if (feature.geometry.type === "MultiPolygon") {
    return feature.geometry.coordinates.reduce((total, polygon) => (
      total + polygon.reduce((sum, ring, index) => (
        sum + (index === 0 ? 1 : -1) * ringAreaKm2(ring, lat)
      ), 0)
    ), 0);
  }
  return 0;
}

function makeDenseGrid(tractGeojson) {
  const prepared = tractGeojson.features.map((feature) => ({
    bbox: featureBbox(feature),
    rings: ringsForFeature(feature)
  }));
  const stateBbox = prepared.reduce((bbox, feature) => [
    Math.min(bbox[0], feature.bbox[0]),
    Math.min(bbox[1], feature.bbox[1]),
    Math.max(bbox[2], feature.bbox[2]),
    Math.max(bbox[3], feature.bbox[3])
  ], [Infinity, Infinity, -Infinity, -Infinity]);

  const points = [];
  let id = 1;
  for (let lat = stateBbox[1]; lat <= stateBbox[3]; lat += GRID_STEP_DEGREES) {
    for (let lng = stateBbox[0]; lng <= stateBbox[2]; lng += GRID_STEP_DEGREES) {
      const point = [compact(lng), compact(lat)];
      if (prepared.some((feature) => pointInFeature(point, feature))) {
        points.push({
          name: `NY grid ${String(id).padStart(3, "0")}`,
          lat: point[1],
          lng: point[0],
          sample_source: "state_grid",
          tract_geoid: ""
        });
        id += 1;
      }
    }
  }

  return points;
}

function makeAdaptiveSampleLocations(tractGeojson) {
  const baseGrid = makeDenseGrid(tractGeojson);
  const samples = [...baseGrid];
  const seen = new Set(baseGrid.map((point) => `${point.lat.toFixed(4)},${point.lng.toFixed(4)}`));
  let smallTractCount = 0;

  for (const feature of tractGeojson.features) {
    const area = tractAreaKm2(feature);
    if (area > SMALL_TRACT_AREA_KM2) continue;
    const [lng, lat] = tractCentroid(feature);
    const key = `${lat.toFixed(4)},${lng.toFixed(4)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    smallTractCount += 1;
    samples.push({
      name: `Small tract ${feature.properties.GEOID}`,
      lat: compact(lat),
      lng: compact(lng),
      sample_source: "small_tract_centroid",
      tract_geoid: String(feature.properties.GEOID),
      tract_area_km2: compact(area)
    });
  }

  return {
    samples,
    base_grid_count: baseGrid.length,
    small_tract_centroid_count: smallTractCount
  };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchJson(url, label) {
  const response = await fetch(url);
  if (response.status === 429) {
    throw new Error(`${label} failed with HTTP 429`);
  }
  if (!response.ok) throw new Error(`${label} failed with HTTP ${response.status}`);
  return response.json();
}

async function fetchJsonWithRetry(url, label) {
  let lastError;
  for (let attempt = 0; attempt <= RETRY_DELAYS_MS.length; attempt += 1) {
    try {
      return await fetchJson(url, label);
    } catch (error) {
      lastError = error;
      if (!String(error.message).includes("HTTP 429") || attempt === RETRY_DELAYS_MS.length) break;
      await sleep(RETRY_DELAYS_MS[attempt]);
    }
  }
  throw lastError;
}

async function fetchOpenMeteoSample(location) {
  const url = "https://air-quality-api.open-meteo.com/v1/air-quality"
    + `?latitude=${location.lat.toFixed(4)}&longitude=${location.lng.toFixed(4)}`
    + "&hourly=pm2_5,us_aqi,ozone,grass_pollen,birch_pollen,alder_pollen,ragweed_pollen"
    + "&forecast_days=7&timezone=America%2FNew_York";
  const data = await fetchJsonWithRetry(url, `Open-Meteo ${location.name}`);
  const hourly = data.hourly || {};
  const pollenValues = [
    ...(hourly.grass_pollen || []),
    ...(hourly.birch_pollen || []),
    ...(hourly.alder_pollen || []),
    ...(hourly.ragweed_pollen || [])
  ].map(number);
  const pollenPeak = maxValue(pollenValues);
  const pollenAverage = average(pollenValues);
  const pm25Average = average((hourly.pm2_5 || []).map(number));
  const aqiAverage = average((hourly.us_aqi || []).map(number));
  const ozoneAverage = average((hourly.ozone || []).map(number));
  const exposureRaw = (
    normalize(pollenPeak, 0, 12) * 0.5
    + normalize(pm25Average, 0, 35) * 0.25
    + normalize(aqiAverage, 0, 100) * 0.15
    + normalize(ozoneAverage, 0, 140) * 0.1
  );

  return {
    ...location,
    source_url: url,
    api_latitude: data.latitude,
    api_longitude: data.longitude,
    timezone: data.timezone,
    pollen_peak: compact(pollenPeak),
    pollen_average: compact(pollenAverage),
    pm25_average: compact(pm25Average),
    aqi_average: compact(aqiAverage),
    ozone_average: compact(ozoneAverage),
    exposure_raw: compact(exposureRaw),
    hourly: {
      time: hourly.time || [],
      grass_pollen: hourly.grass_pollen || [],
      birch_pollen: hourly.birch_pollen || [],
      alder_pollen: hourly.alder_pollen || [],
      ragweed_pollen: hourly.ragweed_pollen || [],
      pm2_5: hourly.pm2_5 || [],
      us_aqi: hourly.us_aqi || [],
      ozone: hourly.ozone || []
    }
  };
}

function summarizeOpenMeteoResponse(location, data, sourceUrl) {
  const hourly = data.hourly || {};
  const pollenValues = [
    ...(hourly.grass_pollen || []),
    ...(hourly.birch_pollen || []),
    ...(hourly.alder_pollen || []),
    ...(hourly.ragweed_pollen || [])
  ].map(number);
  const pollenPeak = maxValue(pollenValues);
  const pollenAverage = average(pollenValues);
  const pm25Average = average((hourly.pm2_5 || []).map(number));
  const aqiAverage = average((hourly.us_aqi || []).map(number));
  const ozoneAverage = average((hourly.ozone || []).map(number));
  const exposureRaw = (
    normalize(pollenPeak, 0, 12) * 0.5
    + normalize(pm25Average, 0, 35) * 0.25
    + normalize(aqiAverage, 0, 100) * 0.15
    + normalize(ozoneAverage, 0, 140) * 0.1
  );

  return {
    ...location,
    source_url: sourceUrl,
    api_latitude: data.latitude,
    api_longitude: data.longitude,
    timezone: data.timezone,
    pollen_peak: compact(pollenPeak),
    pollen_average: compact(pollenAverage),
    pm25_average: compact(pm25Average),
    aqi_average: compact(aqiAverage),
    ozone_average: compact(ozoneAverage),
    exposure_raw: compact(exposureRaw),
    hourly: {
      time: hourly.time || [],
      grass_pollen: hourly.grass_pollen || [],
      birch_pollen: hourly.birch_pollen || [],
      alder_pollen: hourly.alder_pollen || [],
      ragweed_pollen: hourly.ragweed_pollen || [],
      pm2_5: hourly.pm2_5 || [],
      us_aqi: hourly.us_aqi || [],
      ozone: hourly.ozone || []
    }
  };
}

async function fetchOpenMeteoBatch(locations) {
  const url = "https://air-quality-api.open-meteo.com/v1/air-quality"
    + `?latitude=${locations.map((location) => location.lat.toFixed(4)).join(",")}`
    + `&longitude=${locations.map((location) => location.lng.toFixed(4)).join(",")}`
    + "&hourly=pm2_5,us_aqi,ozone,grass_pollen,birch_pollen,alder_pollen,ragweed_pollen"
    + "&forecast_days=7&timezone=America%2FNew_York";
  let data;
  try {
    data = await fetchJsonWithRetry(url, `Open-Meteo batch of ${locations.length}`);
  } catch (error) {
    if (locations.length > 1 && String(error.message).includes("HTTP 429")) {
      const midpoint = Math.ceil(locations.length / 2);
      await sleep(15000);
      const left = await fetchOpenMeteoBatch(locations.slice(0, midpoint));
      await sleep(15000);
      const right = await fetchOpenMeteoBatch(locations.slice(midpoint));
      return [...left, ...right];
    }
    throw error;
  }
  const records = Array.isArray(data) ? data : [data];
  return locations.map((location, index) => summarizeOpenMeteoResponse(location, records[index], url));
}

async function mapConcurrent(items, mapper, concurrency) {
  const results = new Array(items.length);
  let nextIndex = 0;
  const workers = Array.from({ length: concurrency }, async () => {
    while (nextIndex < items.length) {
      const index = nextIndex;
      nextIndex += 1;
      results[index] = await mapper(items[index], index);
    }
  });
  await Promise.all(workers);
  return results;
}

async function readJsonIfExists(url) {
  try {
    return JSON.parse(await readFile(url, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

function idwEstimate(lng, lat, samples) {
  const neighbors = samples
    .map((sample) => ({
      sample,
      distance: Math.hypot(lng - sample.lng, lat - sample.lat)
    }))
    .sort((a, b) => a.distance - b.distance)
    .slice(0, IDW_NEIGHBORS);

  const weighted = {
    exposure: 0,
    pollen_peak: 0,
    pollen_average: 0,
    pm25_average: 0,
    aqi_average: 0,
    ozone_average: 0
  };
  let weightTotal = 0;

  for (const { sample, distance } of neighbors) {
    const weight = 1 / Math.max(distance, 0.01) ** IDW_POWER;
    weightTotal += weight;
    weighted.exposure += sample.exposure_raw * weight;
    weighted.pollen_peak += sample.pollen_peak * weight;
    weighted.pollen_average += sample.pollen_average * weight;
    weighted.pm25_average += sample.pm25_average * weight;
    weighted.aqi_average += sample.aqi_average * weight;
    weighted.ozone_average += sample.ozone_average * weight;
  }

  return {
    samples_used: neighbors.length,
    nearest_sample: neighbors[0].sample.name,
    nearest_sample_distance_degrees: compact(neighbors[0].distance, 5),
    exposure: weighted.exposure / weightTotal,
    pollen_peak: weighted.pollen_peak / weightTotal,
    pollen_average: weighted.pollen_average / weightTotal,
    pm25_average: weighted.pm25_average / weightTotal,
    aqi_average: weighted.aqi_average / weightTotal,
    ozone_average: weighted.ozone_average / weightTotal
  };
}

function attachEstimatedExposure(tractGeojson, samples) {
  for (const feature of tractGeojson.features) {
    const [lng, lat] = tractCentroid(feature);
    const estimate = idwEstimate(lng, lat, samples);
    const exposure = estimate.exposure || 0;
    const vulnerability = feature.properties.vulnerability || 0;
    feature.properties.allergen = compact(exposure);
    feature.properties.exposure = compact(exposure);
    feature.properties.equity_risk = compact(exposure * 0.55 + vulnerability * 0.45);
    feature.properties.exposure_estimation = `IDW average of ${estimate.samples_used} nearest API sample points`;
    feature.properties.exposure_samples_used = estimate.samples_used;
    feature.properties.nearest_sample = estimate.nearest_sample;
    feature.properties.nearest_sample_distance_degrees = estimate.nearest_sample_distance_degrees;
    feature.properties.estimated_pollen_peak = compact(estimate.pollen_peak);
    feature.properties.estimated_pollen_average = compact(estimate.pollen_average);
    feature.properties.estimated_pm25_average = compact(estimate.pm25_average);
    feature.properties.estimated_aqi_average = compact(estimate.aqi_average);
    feature.properties.estimated_ozone_average = compact(estimate.ozone_average);
    feature.properties.sample_pollen_peak = compact(estimate.pollen_peak);
    feature.properties.sample_pm25_average = compact(estimate.pm25_average);
    feature.properties.sample_aqi_average = compact(estimate.aqi_average);
  }
}

function sampleFeatureCollection(samples) {
  return {
    type: "FeatureCollection",
    features: samples.map((sample) => ({
      type: "Feature",
      geometry: { type: "Point", coordinates: [sample.lng, sample.lat] },
      properties: {
        name: sample.name,
        latitude: sample.lat,
        longitude: sample.lng,
        sample_source: sample.sample_source,
        tract_geoid: sample.tract_geoid,
        tract_area_km2: sample.tract_area_km2,
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

function rawSampleFeatureCollection(samples) {
  return {
    type: "FeatureCollection",
    name: "Open-Meteo raw pollen and air-quality point time series",
    features: samples.map((sample) => ({
      type: "Feature",
      geometry: { type: "Point", coordinates: [sample.lng, sample.lat] },
      properties: {
        name: sample.name,
        requested_latitude: sample.lat,
        requested_longitude: sample.lng,
        api_latitude: sample.api_latitude,
        api_longitude: sample.api_longitude,
        timezone: sample.timezone,
        source_url: sample.source_url,
        sample_source: sample.sample_source,
        tract_geoid: sample.tract_geoid,
        tract_area_km2: sample.tract_area_km2,
        exposure_raw: sample.exposure_raw,
        pollen_peak: sample.pollen_peak,
        pollen_average: sample.pollen_average,
        pm25_average: sample.pm25_average,
        aqi_average: sample.aqi_average,
        ozone_average: sample.ozone_average,
        hourly: sample.hourly
      }
    }))
  };
}

function summarizeSample(sample) {
  return {
    name: sample.name,
    lat: sample.lat,
    lng: sample.lng,
    sample_source: sample.sample_source,
    tract_geoid: sample.tract_geoid,
    api_latitude: sample.api_latitude,
    api_longitude: sample.api_longitude,
    pollen_peak: sample.pollen_peak,
    pollen_average: sample.pollen_average,
    pm25_average: sample.pm25_average,
    aqi_average: sample.aqi_average,
    ozone_average: sample.ozone_average,
    exposure_raw: sample.exposure_raw
  };
}

function refreshSummary(summary, tractGeojson, samples, samplePlan) {
  const rows = tractGeojson.features.map((feature) => feature.properties).filter((row) => row.population > 0);
  summary.generated_at = new Date().toISOString();
  summary.sample_locations = samples.map(summarizeSample);
  summary.sample_grid = {
    step_degrees: GRID_STEP_DEGREES,
    point_count: samples.length,
    base_grid_count: samplePlan.base_grid_count,
    small_tract_centroid_count: samplePlan.small_tract_centroid_count,
    small_tract_area_threshold_km2: SMALL_TRACT_AREA_KM2,
    note: "Adaptive Open-Meteo exposure samples: statewide grid plus added centroid samples for small census tracts."
  };
  summary.tract_exposure_estimation = {
    method: "Inverse distance weighted average from nearby Open-Meteo API sample points",
    neighbors: IDW_NEIGHBORS,
    power: IDW_POWER,
    fields_assigned_to_each_tract: [
      "exposure",
      "estimated_pollen_peak",
      "estimated_pollen_average",
      "estimated_pm25_average",
      "estimated_aqi_average",
      "estimated_ozone_average"
    ]
  };
  summary.averages = {
    exposure: compact(average(rows.map((row) => row.exposure))),
    vulnerability: compact(average(rows.map((row) => row.vulnerability))),
    equity_risk: compact(average(rows.map((row) => row.equity_risk))),
    poverty_rate: compact(average(rows.map((row) => row.poverty_rate))),
    people_of_color_pct: compact(average(rows.map((row) => row.people_of_color_pct)))
  };
  summary.top_equity_risk = [...rows]
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
}

async function main() {
  await mkdir(CACHE_DIR, { recursive: true });
  const tractGeojson = JSON.parse(await readFile(TRACT_FILE, "utf8"));
  const summary = JSON.parse(await readFile(SUMMARY_FILE, "utf8"));
  const samplePlan = makeAdaptiveSampleLocations(tractGeojson);
  const chunks = [];
  for (let index = 0; index < samplePlan.samples.length; index += BATCH_SIZE) {
    chunks.push(samplePlan.samples.slice(index, index + BATCH_SIZE));
  }
  console.log(
    `Generated ${samplePlan.samples.length} adaptive sample locations: `
    + `${samplePlan.base_grid_count} grid + ${samplePlan.small_tract_centroid_count} small-tract centroids.`
  );

  const chunkResults = await mapConcurrent(chunks, async (chunk, index) => {
    const cacheFile = new URL(`batch-${String(index).padStart(4, "0")}.json`, CACHE_DIR);
    const cached = await readJsonIfExists(cacheFile);
    if (cached) {
      const downloaded = Math.min((index + 1) * BATCH_SIZE, samplePlan.samples.length);
      if ((index + 1) % 5 === 0 || index === chunks.length - 1) {
        console.log(`Loaded cached ${downloaded}/${samplePlan.samples.length} exposure samples`);
      }
      return cached;
    }
    if (USE_CACHE_ONLY) {
      console.log(`Skipping uncached batch ${index + 1}/${chunks.length}`);
      return [];
    }
    if (index > 0 && BATCH_DELAY_MS > 0) await sleep(BATCH_DELAY_MS);
    const batch = await fetchOpenMeteoBatch(chunk);
    await writeFile(cacheFile, JSON.stringify(batch));
    const downloaded = Math.min((index + 1) * BATCH_SIZE, samplePlan.samples.length);
    if ((index + 1) % 5 === 0 || index === chunks.length - 1) {
      console.log(`Downloaded ${downloaded}/${samplePlan.samples.length} exposure samples`);
    }
    return batch;
  }, CONCURRENCY);
  const samples = chunkResults.flat();
  if (!samples.length) throw new Error("No exposure samples available. Run without EXPOSURE_USE_CACHE_ONLY first.");

  attachEstimatedExposure(tractGeojson, samples);
  refreshSummary(summary, tractGeojson, samples, samplePlan);
  await writeFile(TRACT_FILE, JSON.stringify(tractGeojson));
  await writeFile(SUMMARY_FILE, JSON.stringify(summary, null, 2));
  await writeFile(SAMPLE_FILE, JSON.stringify(sampleFeatureCollection(samples), null, 2));
  await writeFile(RAW_SAMPLE_FILE, JSON.stringify(rawSampleFeatureCollection(samples), null, 2));
  console.log(`Wrote dense exposure data for ${samples.length} sample points.`);
  console.log("Wrote data/exposure-raw-points.geojson");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
