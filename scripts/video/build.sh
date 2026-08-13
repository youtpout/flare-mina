#!/usr/bin/env bash
# Build the narrated slide segment of the demo video.
#
#   ./scripts/video/build.sh            # everything
#   ./scripts/video/build.sh shots      # re-shoot the cards only
#   ./scripts/video/build.sh voice      # re-record narration only
#
# Output: scripts/video/out/slides.mp4 — 1920x1080, H.264, AAC.
#
# The live-demo shots are NOT here and cannot be: they need a wallet to sign,
# which is a human with a password. Film those and cut them in.
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"
OUT="$HERE/out"
CARDS="$ROOT/docs/demo-cards.html"
CHROME="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"

mkdir -p "$OUT/png" "$OUT/mp3" "$OUT/seg"

step="${1:-all}"

# --- 1. One PNG per card -----------------------------------------------------
# Chrome renders the deck and advances with a hash, so each card is a clean
# 1080p still with no cursor and no chrome around it.
if [[ "$step" == "all" || "$step" == "shots" ]]; then
  echo "==> shooting cards"
  n=$(grep -c '<section class="card"' "$CARDS")
  for ((i=0; i<n; i++)); do
    "$CHROME" --headless --disable-gpu --hide-scrollbars \
      --window-size=1920,1080 --force-device-scale-factor=1 \
      --virtual-time-budget=1200 \
      --screenshot="$OUT/png/$(printf '%02d' $((i+1))).png" \
      "file://$CARDS?video#$i" > /dev/null 2>&1
  done
  echo "    $n cards -> $OUT/png"
fi

# --- 2. Narration ------------------------------------------------------------
if [[ "$step" == "all" || "$step" == "voice" ]]; then
  echo "==> recording narration"
  python3 "$HERE/say.py" "$HERE/narration.json" "$OUT/mp3"
fi

# --- 3. One segment per card, then concatenate -------------------------------
# Each still is held for exactly as long as its narration plus the hold, so
# picture and voice can never drift.
echo "==> assembling"
: > "$OUT/list.txt"
for png in "$OUT/png"/*.png; do
  id=$(basename "$png" .png)
  mp3=$(ls "$OUT/mp3/$id"-*.mp3 2>/dev/null | head -1 || true)
  if [[ -z "$mp3" ]]; then
    echo "    !! no narration for card $id — holding 3s silent"
    ffmpeg -y -loglevel error -loop 1 -i "$png" -f lavfi -i anullsrc=r=48000:cl=stereo \
      -t 3 -c:v libx264 -pix_fmt yuv420p -r 30 -c:a aac -shortest "$OUT/seg/$id.mp4"
  else
    ffmpeg -y -loglevel error -loop 1 -i "$png" -i "$mp3" \
      -c:v libx264 -pix_fmt yuv420p -r 30 -tune stillimage \
      -c:a aac -b:a 160k -shortest "$OUT/seg/$id.mp4"
  fi
  echo "file '$OUT/seg/$id.mp4'" >> "$OUT/list.txt"
done

ffmpeg -y -loglevel error -f concat -safe 0 -i "$OUT/list.txt" \
  -c:v libx264 -pix_fmt yuv420p -crf 18 -preset slow -c:a aac -b:a 160k \
  "$OUT/slides.mp4"

# The three pieces the edit actually wants. Cards 3 and 4 stay loose: they are
# cutaways dropped into the live demo, not part of either bookend.
group() {
  local name="$1"; shift
  local list="$OUT/list-$name.txt"
  : > "$list"
  for id in "$@"; do echo "file '$OUT/seg/$id.mp4'" >> "$list"; done
  ffmpeg -y -loglevel error -f concat -safe 0 -i "$list" \
    -c:v libx264 -pix_fmt yuv420p -crf 18 -preset slow -c:a aac -b:a 160k \
    "$OUT/$name.mp4"
  export LC_NUMERIC=C
  printf "    %-14s %5.1fs\n" "$name.mp4" \
    "$(ffprobe -v error -show_entries format=duration -of csv=p=0 "$OUT/$name.mp4")"
}

echo "==> pieces"
group opening 01 02
group fdc 03 04 05
group closing 07 08 09
for id in 06; do
  cp "$OUT/seg/$id.mp4" "$OUT/cutaway-$id.mp4"
  export LC_NUMERIC=C
  printf "    %-14s %5.1fs\n" "cutaway-$id.mp4" \
    "$(ffprobe -v error -show_entries format=duration -of csv=p=0 "$OUT/cutaway-$id.mp4")"
done

export LC_NUMERIC=C
dur=$(ffprobe -v error -show_entries format=duration -of csv=p=0 "$OUT/slides.mp4")
printf "\ndone: %s  (%.1fs)\n" "$OUT/slides.mp4" "$dur"
