#!/usr/bin/env python3
"""
Compute the Allergenic Tree Pollen Index (ATPI) for NYC census tracts from
NYC Parks' 2015 Street Tree Census (data.cityofnewyork.us, dataset uvpi-gqnh).

Genus weights (W_i) are the "pollen release intensity" ratio = (genus share of
measured airborne pollen) / (genus share of street-tree basal area), taken from
Table 1 of Katz et al. 2024, Urban Forestry & Urban Greening 92:128208 -- a
peer-reviewed study built directly on this same NYC Parks tree census plus NYC
airborne pollen monitoring (Fordham/Lincoln Center, NAB-certified). Genera not
covered by that table (minor NYC street-tree genera, each <1% of citywide
basal area and pollen) get a documented low default.

Formulas (as specified):
  BA_i   = pi * (DBH_i * 0.0254 / 2)^2                length in meters
  P_i    = W_i * ln(1 + BA_i / 0.01)
  ATPI_i = min(100, 100 * P_i / Q99(P))
  D_t    = sum(P_i in tract) / area_t (km^2)
  ATPI_t = min(100, 100 * D_t / Q99(D))
"""
import json, math, urllib.parse, time, subprocess

SOCRATA_BASE = "https://data.cityofnewyork.us/resource/uvpi-gqnh.json"
PAGE_SIZE = 50000

# genus -> W_i, derived from Katz et al. 2024 Table 1 (pollen % / i-Tree basal-area %)
GENUS_WEIGHTS = {
    "Platanus": 1.44, "Quercus": 0.90, "Fraxinus": 1.12, "Ginkgo": 1.23,
    "Ulmus": 0.51, "Zelkova": 0.28, "Gleditsia": 0.20, "Liquidambar": 0.14,
    "Prunus": 0.05, "Robinia": 0.02, "Celtis": 0.03, "Tilia": 0.02,
    "Acer": 0.05, "Pyrus": 0.0, "Crataegus": 0.0, "Styphnolobium": 0.0,
    "Sophora": 0.0, "Populus": 0.0,
}
DEFAULT_WEIGHT = 0.02  # documented low default: genus absent from Katz Table 1
                       # (i.e. < 1% of citywide basal area AND < 1% of measured pollen)

BORO_COUNTY_FIPS = {"1": "061", "2": "005", "3": "047", "4": "081", "5": "085"}

def fetch_all_trees():
    trees = []
    offset = 0
    while True:
        q = {
            "$select": "spc_latin,tree_dbh,boro_ct",
            "$where": "status='Alive'",
            "$limit": str(PAGE_SIZE),
            "$offset": str(offset),
        }
        url = SOCRATA_BASE + "?" + urllib.parse.urlencode(q)
        result = subprocess.run(["curl", "-s", "-m", "60", url], capture_output=True, check=True)
        batch = json.loads(result.stdout)
        if not batch:
            break
        trees.extend(batch)
        offset += PAGE_SIZE
        if len(batch) < PAGE_SIZE:
            break
    return trees

def tract_geoid(boro_ct):
    if not boro_ct or len(boro_ct) < 2:
        return None
    boro, tract = boro_ct[0], boro_ct[1:]
    county = BORO_COUNTY_FIPS.get(boro)
    if not county:
        return None
    return "36" + county + tract.rjust(6, "0")

def polygon_area_km2(geometry):
    """Planar (equirectangular) approximation, fine at NYC's latitude/extent."""
    R = 6371.0
    lat0 = 40.7
    coslat = math.cos(math.radians(lat0))

    def ring_area(ring):
        area = 0.0
        n = len(ring)
        for i in range(n - 1):
            x1, y1 = ring[i]
            x2, y2 = ring[i + 1]
            area += math.radians(x1) * coslat * math.radians(y2) - math.radians(x2) * coslat * math.radians(y1)
        return area * (R ** 2) / 2.0

    polys = [geometry["coordinates"]] if geometry["type"] == "Polygon" else geometry["coordinates"]
    total = 0.0
    for poly in polys:
        outer = abs(ring_area(poly[0]))
        holes = sum(abs(ring_area(r)) for r in poly[1:])
        total += outer - holes
    return abs(total)

def main():
    print("Fetching NYC tree census...")
    t0 = time.time()
    trees = fetch_all_trees()
    print(f"  {len(trees)} living trees fetched in {time.time()-t0:.1f}s")

    genus_stats = {}
    tract_sum_p = {}
    tract_tree_count = {}
    tract_species_count = {}
    all_p = []

    for tr in trees:
        try:
            dbh_in = float(tr.get("tree_dbh", 0) or 0)
        except ValueError:
            dbh_in = 0
        if dbh_in <= 0:
            continue
        spc = (tr.get("spc_latin") or "").strip()
        genus = spc.split(" ")[0] if spc else "Unknown"
        w = GENUS_WEIGHTS.get(genus, DEFAULT_WEIGHT)
        dbh_m = dbh_in * 0.0254
        ba = math.pi * (dbh_m / 2) ** 2
        p = w * math.log(1 + ba / 0.01)
        all_p.append(p)

        gs = genus_stats.setdefault(genus, {"count": 0, "basal_area_m2": 0.0, "sum_p": 0.0})
        gs["count"] += 1
        gs["basal_area_m2"] += ba
        gs["sum_p"] += p

        geoid = tract_geoid(tr.get("boro_ct", ""))
        if geoid:
            tract_sum_p[geoid] = tract_sum_p.get(geoid, 0.0) + p
            tract_tree_count[geoid] = tract_tree_count.get(geoid, 0) + 1
            tract_species_count.setdefault(geoid, {})
            tract_species_count[geoid][spc] = tract_species_count[geoid].get(spc, 0) + 1

    all_p.sort()
    q99_p = all_p[int(len(all_p) * 0.99)] if all_p else 1

    print("Loading tract geometry for land area...")
    with open("data/ny-allergy-equity.geojson") as f:
        tract_geo = json.load(f)

    nyc_counties = set(BORO_COUNTY_FIPS.values())
    tract_area_km2 = {}
    for feat in tract_geo["features"]:
        geoid = str(feat["properties"]["GEOID"])
        if geoid[2:5] not in nyc_counties:
            continue
        tract_area_km2[geoid] = polygon_area_km2(feat["geometry"])

    d_values = []
    tract_d = {}
    for geoid, area in tract_area_km2.items():
        sum_p = tract_sum_p.get(geoid, 0.0)
        if area > 0:
            d = sum_p / area
            tract_d[geoid] = d
            if sum_p > 0:
                d_values.append(d)
    d_values.sort()
    q99_d = d_values[int(len(d_values) * 0.99)] if d_values else 1

    tract_output = {}
    for geoid, area in tract_area_km2.items():
        d = tract_d.get(geoid, 0.0)
        atpi = min(100.0, 100.0 * d / q99_d) if q99_d else 0.0
        top_species = None
        if geoid in tract_species_count:
            top_species = max(tract_species_count[geoid].items(), key=lambda kv: kv[1])[0]
        tract_output[geoid] = {
            "tree_count": tract_tree_count.get(geoid, 0),
            "area_km2": round(area, 5),
            "sum_p": round(tract_sum_p.get(geoid, 0.0), 4),
            "D": round(d, 4),
            "ATPI": round(atpi, 2),
            "top_species": top_species,
        }

    with open("data/nyc-tree-atpi-by-tract.json", "w") as f:
        json.dump({
            "method": "ATPI per user-specified formula; genus weights (W_i) = pollen-share / basal-area-share ratios from Katz et al. 2024 (Urban For. Urban Green. 92:128208), computed on this same NYC Parks 2015 Street Tree Census + NYC airborne pollen monitoring.",
            "q99_p": q99_p, "q99_d": q99_d,
            "tract_count": len(tract_output),
            "tracts": tract_output,
        }, f)

    genus_summary = []
    total_trees = sum(g["count"] for g in genus_stats.values())
    total_ba = sum(g["basal_area_m2"] for g in genus_stats.values())
    for genus, gs in sorted(genus_stats.items(), key=lambda kv: -kv[1]["sum_p"]):
        genus_summary.append({
            "genus": genus,
            "count": gs["count"],
            "pct_of_trees": round(100 * gs["count"] / total_trees, 2),
            "basal_area_m2": round(gs["basal_area_m2"], 1),
            "pct_of_basal_area": round(100 * gs["basal_area_m2"] / total_ba, 2),
            "weight": GENUS_WEIGHTS.get(genus, DEFAULT_WEIGHT),
            "sum_p": round(gs["sum_p"], 1),
            "pct_of_total_potential": round(100 * gs["sum_p"] / sum(g["sum_p"] for g in genus_stats.values()), 2),
        })

    with open("data/nyc-tree-species-evidence.json", "w") as f:
        json.dump({
            "total_trees": total_trees,
            "total_basal_area_m2": round(total_ba, 1),
            "genus_summary": genus_summary[:30],
        }, f, indent=2)

    print(f"Done in {time.time()-t0:.1f}s. Tracts: {len(tract_output)}. Top potential genera:")
    for g in genus_summary[:8]:
        print(f"  {g['genus']:<14} trees={g['count']:>7} basalArea%={g['pct_of_basal_area']:>5} W={g['weight']:<5} potential%={g['pct_of_total_potential']}")

if __name__ == "__main__":
    main()
