#!/bin/bash
# Stage the deployable static site into ./build
#
#   ./build.sh                 full build, including a fresh data snapshot
#   ./build.sh --skip-snapshot reuse the snapshot already in build/
set -e
cd "$(dirname "$0")"

rm -rf build
mkdir -p build
cp -r site/. build/
rm -f build/README.md build/CHANGELOG.md

if [ "$1" != "--skip-snapshot" ]; then
  echo "baking data snapshot…"
  python3 tools/bake_snapshot.py --out site/data/snapshot.json \
    || echo "WARNING: snapshot bake failed — the site will fall back to live relays"
fi

echo "staged: $(find build -type f | wc -l) files -> $(pwd)/build"
