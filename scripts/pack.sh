#!/usr/bin/env bash
# Pack Firefox (.xpi) + Edge/Chrome (dossier + .zip) → dist/
# Version unique : fichier VERSION (stampée dans les 2 manifests).
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DIST="$ROOT/dist"
VER="$(tr -d '[:space:]' < "$ROOT/VERSION")"

python3 - "$ROOT" "$VER" <<'PY'
import json, pathlib, sys
root, ver = pathlib.Path(sys.argv[1]), sys.argv[2]
for name in ("manifest.json", "manifest.chromium.json"):
    path = root / name
    data = json.loads(path.read_text())
    data["version"] = ver
    path.write_text(json.dumps(data, indent=2, ensure_ascii=False) + "\n")
    print(f"version {ver} → {name}")
PY

rm -rf "$DIST"
mkdir -p "$DIST/firefox" "$DIST/chromium"

SHARED=(background.js content.js popup.html popup.js alert.html alert.js icons sounds)

cp "$ROOT/manifest.json" "$DIST/firefox/manifest.json"
cp "$ROOT/manifest.chromium.json" "$DIST/chromium/manifest.json"
for f in "${SHARED[@]}"; do
  cp -a "$ROOT/$f" "$DIST/firefox/"
  cp -a "$ROOT/$f" "$DIST/chromium/"
done

python3 - "$DIST" "$VER" <<'PY'
import zipfile, os, sys
dist, ver = sys.argv[1], sys.argv[2]

def zip_dir(src, out):
    with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED) as z:
        for root, _, files in os.walk(src):
            for f in files:
                path = os.path.join(root, f)
                z.write(path, os.path.relpath(path, src))
    print(out, os.path.getsize(out))

zip_dir(os.path.join(dist, "firefox"), os.path.join(dist, f"mf-alarm-sound-{ver}.xpi"))
zip_dir(os.path.join(dist, "chromium"), os.path.join(dist, f"mf-alarm-sound-edge-{ver}.zip"))
PY

echo "OK unpacked: $DIST/firefox | $DIST/chromium"
