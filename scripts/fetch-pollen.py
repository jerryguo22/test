#!/usr/bin/env python3
"""Fetch Google Pollen forecast for 23 NY cities and write data/pollen.json."""
import sys, json, datetime, time
import urllib.request, ssl

KEY = sys.argv[1] if len(sys.argv) > 1 else sys.exit("Usage: fetch-pollen.py <GOOGLE_KEY>")
ctx = ssl.create_default_context()

CITIES = [
    {"name": "New York City",    "lat": 40.7128, "lng": -74.0060},
    {"name": "Buffalo",          "lat": 42.8864, "lng": -78.8784},
    {"name": "Rochester",        "lat": 43.1566, "lng": -77.6088},
    {"name": "Syracuse",         "lat": 43.0481, "lng": -76.1474},
    {"name": "Albany",           "lat": 42.6526, "lng": -73.7562},
    {"name": "Yonkers",          "lat": 40.9312, "lng": -73.8988},
    {"name": "Schenectady",      "lat": 42.8142, "lng": -73.9396},
    {"name": "Utica",            "lat": 43.1009, "lng": -75.2327},
    {"name": "White Plains",     "lat": 41.0340, "lng": -73.7629},
    {"name": "Troy",             "lat": 42.7284, "lng": -73.6918},
    {"name": "Binghamton",       "lat": 42.0987, "lng": -75.9180},
    {"name": "Niagara Falls",    "lat": 43.0962, "lng": -79.0377},
    {"name": "Ithaca",           "lat": 42.4440, "lng": -76.5021},
    {"name": "Poughkeepsie",     "lat": 41.7004, "lng": -73.9209},
    {"name": "Watertown",        "lat": 43.9748, "lng": -75.9107},
    {"name": "Saratoga Springs", "lat": 43.0831, "lng": -73.7846},
    {"name": "Kingston",         "lat": 41.9270, "lng": -73.9974},
    {"name": "Elmira",           "lat": 42.0898, "lng": -76.8077},
    {"name": "Plattsburgh",      "lat": 44.6995, "lng": -73.4529},
    {"name": "Glens Falls",      "lat": 43.3095, "lng": -73.6440},
    {"name": "Jamestown",        "lat": 42.0970, "lng": -79.2353},
    {"name": "Ogdensburg",       "lat": 44.6945, "lng": -75.4874},
    {"name": "Harrison",         "lat": 40.9676, "lng": -73.7124},
]

results = []
for c in CITIES:
    url = (f"https://pollen.googleapis.com/v1/forecast:lookup"
           f"?location.latitude={c['lat']:.4f}&location.longitude={c['lng']:.4f}"
           f"&days=1&plantsDescription=false&key={KEY}")
    try:
        with urllib.request.urlopen(url, timeout=10, context=ctx) as r:
            data = json.loads(r.read())
        day = data.get("dailyInfo", [{}])[0]
        def get_upi(code):
            for pt in day.get("pollenTypeInfo", []):
                if pt.get("code") == code:
                    return pt.get("indexInfo", {}).get("value", 0)
            return 0
        tree, grass, weed = get_upi("TREE"), get_upi("GRASS"), get_upi("WEED")
        results.append({**c, "tree": tree, "grass": grass, "weed": weed,
                        "composite": round((tree + grass + weed) / 3, 4)})
    except Exception as e:
        print(f"  WARNING: failed {c['name']}: {e}", file=sys.stderr)
    time.sleep(0.1)

with open("data/pollen.json", "w") as f:
    json.dump({"fetched": datetime.date.today().isoformat(), "cities": results}, f, indent=2)
