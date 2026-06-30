import { readFile, writeFile } from "node:fs/promises";

const DATA_FILE = new URL("../data/ny-allergy-equity.geojson", import.meta.url);
const CENSUS_REPORTER_URL =
  "https://api.censusreporter.org/1.0/data/show/latest?table_ids=B01001&geo_ids=140|04000US36";

const UNDER_18_KEYS = [
  "B01001003", "B01001004", "B01001005", "B01001006",
  "B01001027", "B01001028", "B01001029", "B01001030"
];

const OVER_65_KEYS = [
  "B01001020", "B01001021", "B01001022", "B01001023", "B01001024", "B01001025",
  "B01001044", "B01001045", "B01001046", "B01001047", "B01001048", "B01001049"
];

function compact(value, digits = 4) {
  return Number.isFinite(value) ? Number(value.toFixed(digits)) : -1;
}

function sumFields(row, keys) {
  return keys.reduce((sum, key) => sum + Math.max(0, Number(row[key]) || 0), 0);
}

async function main() {
  const [geojson, ageResponse] = await Promise.all([
    readFile(DATA_FILE, "utf8").then(JSON.parse),
    fetch(CENSUS_REPORTER_URL).then((response) => {
      if (!response.ok) throw new Error(`Census Reporter failed with HTTP ${response.status}`);
      return response.json();
    })
  ]);

  let updated = 0;
  for (const feature of geojson.features) {
    const geoid = String(feature.properties.GEOID).padStart(11, "0");
    const estimate = ageResponse.data?.[`14000US${geoid}`]?.B01001?.estimate;
    if (!estimate) {
      feature.properties.under18_pct = -1;
      feature.properties.over65_pct = -1;
      continue;
    }
    const population = Number(estimate.B01001001) || Number(feature.properties.population) || 0;
    const under18 = sumFields(estimate, UNDER_18_KEYS);
    const over65 = sumFields(estimate, OVER_65_KEYS);
    feature.properties.under18_pct = population > 0 ? compact(under18 / population) : -1;
    feature.properties.over65_pct = population > 0 ? compact(over65 / population) : -1;
    updated += 1;
  }

  await writeFile(DATA_FILE, JSON.stringify(geojson));
  console.log(`Added under18_pct and over65_pct to ${updated.toLocaleString()} tracts.`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
