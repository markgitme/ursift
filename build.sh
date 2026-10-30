#!/bin/bash
# Stage the deployable static site into ./build
#
# The site is static and self-contained. There is no snapshot to bake: nothing
# is preloaded, and every result comes from a live feed at the moment the user
# asks for it.
set -e
cd "$(dirname "$0")"

rm -rf build
mkdir -p build
cp -r site/. build/
rm -f build/README.md build/CHANGELOG.md

echo "staged: $(find build -type f | wc -l) files -> $(pwd)/build"
