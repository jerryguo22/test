#!/usr/bin/env bash
# Refresh pre-downloaded data files.
# Run this periodically to update pollen data (changes daily) or ACS data (annual release).
#
# Usage:
#   CENSUS_KEY=your_key GOOGLE_KEY=your_key bash scripts/refresh-data.sh

set -e
mkdir -p data

CENSUS_KEY="${CENSUS_KEY:?Set CENSUS_KEY env var}"
GOOGLE_KEY="${GOOGLE_KEY:?Set GOOGLE_KEY env var}"

echo "Downloading ACS 2023 tract data for New York State..."
curl -sf "https://api.census.gov/data/2023/acs/acs5?get=NAME,B19013_001E,B17001_002E,B17001_001E,B25035_001E&for=tract:*&in=state:36&key=${CENSUS_KEY}" \
  -o data/acs.json
echo "  Saved data/acs.json ($(wc -c < data/acs.json | tr -d ' ') bytes)"

echo "Downloading Google Pollen forecast for 23 NY cities..."
python3 scripts/fetch-pollen.py "${GOOGLE_KEY}"
echo "  Saved data/pollen.json"
