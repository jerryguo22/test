import { execFile } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const GPKG_FILE = new URL("../data/mappinginequality.gpkg", import.meta.url);
const HOLC_OUTPUT = new URL("../data/ny-holc-redlining.geojson", import.meta.url);
const TRACT_INPUT = new URL("../data/ny-allergy-equity.geojson", import.meta.url);
const TRACT_OUTPUT = new URL("../data/ny-allergy-equity.geojson", import.meta.url);
const HISTORY_OUTPUT = new URL("../data/historical-equity-summary.json", import.meta.url);

const GRADE_SCORE = { A: 1, B: 2, C: 3, D: 4 };

function parseGpkgGeometry(hex) {
  const buffer = Buffer.from(hex, "hex");
  if (buffer.toString("ascii", 0, 2) !== "GP") throw new Error("Invalid GeoPackage geometry magic");
  const flags = buffer.readUInt8(3);
  const littleEndian = (flags & 1) === 1;
  if (!littleEndian) throw new Error("Big-endian GeoPackage geometry is not supported");
  const envelopeCode = (flags >> 1) & 7;
  const envelopeBytes = [0, 32, 48, 48, 64][envelopeCode] || 0;
  const offset = 8 + envelopeBytes;
  return parseWkb(buffer, offset).geometry;
}

function parseWkb(buffer, offset) {
  const little = buffer.readUInt8(offset) === 1;
  if (!little) throw new Error("Big-endian WKB is not supported");
  const type = buffer.readUInt32LE(offset + 1);
  let cursor = offset + 5;

  if (type === 3) {
    const ringCount = buffer.readUInt32LE(cursor);
    cursor += 4;
    const coordinates = [];
    for (let r = 0; r < ringCount; r += 1) {
      const pointCount = buffer.readUInt32LE(cursor);
      cursor += 4;
      const ring = [];
      for (let p = 0; p < pointCount; p += 1) {
        ring.push([buffer.readDoubleLE(cursor), buffer.readDoubleLE(cursor + 8)]);
        cursor += 16;
      }
      coordinates.push(ring);
    }
    return { geometry: { type: "Polygon", coordinates }, offset: cursor };
  }

  if (type === 6) {
    const polygonCount = buffer.readUInt32LE(cursor);
    cursor += 4;
    const coordinates = [];
    for (let p = 0; p < polygonCount; p += 1) {
      const parsed = parseWkb(buffer, cursor);
      if (parsed.geometry.type !== "Polygon") throw new Error("Expected Polygon inside MultiPolygon");
      coordinates.push(parsed.geometry.coordinates);
      cursor = parsed.offset;
    }
    return { geometry: { type: "MultiPolygon", coordinates }, offset: cursor };
  }

  throw new Error(`Unsupported WKB geometry type ${type}`);
}

function visitCoordinates(coords, visitor) {
  if (typeof coords[0] === "number") {
    visitor(coords);
    return;
  }
  coords.forEach((child) => visitCoordinates(child, visitor));
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

function centroid(feature) {
  const ring = feature.geometry.type === "Polygon"
    ? feature.geometry.coordinates[0]
    : feature.geometry.coordinates[0][0];
  const sum = ring.reduce((acc, [lng, lat]) => [acc[0] + lng, acc[1] + lat], [0, 0]);
  return [sum[0] / ring.length, sum[1] / ring.length];
}

function average(values) {
  const clean = values.filter((value) => Number.isFinite(value) && value >= 0);
  return clean.length ? clean.reduce((sum, value) => sum + value, 0) / clean.length : -1;
}

function compact(value, digits = 4) {
  return Number.isFinite(value) ? Number(value.toFixed(digits)) : -1;
}

async function loadHolcRows() {
  const sql = "select fid, hex(geom) as geom_hex, area_id, city, state, category, grade, label, fill from mappinginequality where state='NY';";
  const { stdout } = await execFileAsync("sqlite3", ["-json", GPKG_FILE.pathname, sql], { maxBuffer: 20 * 1024 * 1024 });
  return JSON.parse(stdout);
}

async function main() {
  const rows = await loadHolcRows();
  const holc = {
    type: "FeatureCollection",
    features: rows.map((row) => ({
      type: "Feature",
      geometry: parseGpkgGeometry(row.geom_hex),
      properties: {
        fid: row.fid,
        area_id: row.area_id,
        city: row.city,
        state: row.state,
        category: row.category,
        grade: row.grade,
        grade_score: GRADE_SCORE[row.grade] || -1,
        label: row.label,
        fill: row.fill
      }
    }))
  };

  const preparedHolc = holc.features.map((feature) => ({
    feature,
    bbox: featureBbox(feature),
    rings: ringsForFeature(feature)
  }));

  const tracts = JSON.parse(await readFile(TRACT_INPUT, "utf8"));
  for (const tract of tracts.features) {
    const point = centroid(tract);
    const matches = preparedHolc.filter((holcFeature) => pointInFeature(point, holcFeature));
    matches.sort((a, b) => (GRADE_SCORE[b.feature.properties.grade] || 0) - (GRADE_SCORE[a.feature.properties.grade] || 0));
    const match = matches[0]?.feature?.properties;
    Object.assign(tract.properties, {
      holc_grade: match?.grade || "None",
      holc_grade_score: match ? GRADE_SCORE[match.grade] : -1,
      holc_city: match?.city || "",
      holc_category: match?.category || "",
      holc_label: match?.label || ""
    });
  }

  const gradeSummary = {};
  for (const grade of ["A", "B", "C", "D", "None"]) {
    const rowsForGrade = tracts.features.map((f) => f.properties).filter((p) => p.holc_grade === grade);
    gradeSummary[grade] = {
      tract_count: rowsForGrade.length,
      avg_exposure: compact(average(rowsForGrade.map((p) => p.exposure))),
      avg_people_of_color_pct: compact(average(rowsForGrade.map((p) => p.people_of_color_pct))),
      avg_poverty_rate: compact(average(rowsForGrade.map((p) => p.poverty_rate))),
      avg_renter_pct: compact(average(rowsForGrade.map((p) => p.renter_pct)))
    };
  }

  await writeFile(HOLC_OUTPUT, JSON.stringify(holc));
  await writeFile(TRACT_OUTPUT, JSON.stringify(tracts));
  await writeFile(HISTORY_OUTPUT, JSON.stringify({
    generated_at: new Date().toISOString(),
    holc_feature_count: holc.features.length,
    source: "Mapping Inequality: Redlining in New Deal America, University of Richmond Digital Scholarship Lab",
    method: "HOLC grade is assigned to a census tract when the tract centroid falls inside a New York HOLC area. This is a historical spatial overlay, not causal proof.",
    grade_summary: gradeSummary
  }, null, 2));
  console.log(`Wrote ${holc.features.length} NY HOLC polygons to data/ny-holc-redlining.geojson`);
  console.log("Updated data/ny-allergy-equity.geojson with holc_* fields");
  console.log("Wrote data/historical-equity-summary.json");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
