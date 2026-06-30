import { readFile, writeFile } from "node:fs/promises";

const DATA_FILE = new URL("../data/ny-allergy-equity.geojson", import.meta.url);
const CENSUS_REPORTER_URL =
  "https://api.censusreporter.org/1.0/data/show/latest?table_ids=B25077&geo_ids=140|04000US36";

async function main() {
  const [geojson, response] = await Promise.all([
    readFile(DATA_FILE, "utf8").then(JSON.parse),
    fetch(CENSUS_REPORTER_URL).then((res) => {
      if (!res.ok) throw new Error(`Census Reporter failed with HTTP ${res.status}`);
      return res.json();
    })
  ]);

  let updated = 0;
  for (const feature of geojson.features) {
    const geoid = String(feature.properties.GEOID).padStart(11, "0");
    const estimate = response.data?.[`14000US${geoid}`]?.B25077?.estimate;
    const value = Number(estimate?.B25077001);
    feature.properties.median_home_value = Number.isFinite(value) && value > 0 ? value : -1;
    if (feature.properties.median_home_value > 0) updated += 1;
  }

  await writeFile(DATA_FILE, JSON.stringify(geojson));
  console.log(`Added median_home_value to ${updated.toLocaleString()} tracts.`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
