#!/usr/bin/env bash
# Builds the background loop from a source clip: a contiguous segment played forward then reversed
# (boomerang), so neither turn has a seam or a repeated frame. Output: no audio, no cover art, no metadata.
# Usage: scripts/build-hero-video.sh <source.mp4>   (the source is never committed)
# Tunables via env: SEG_START (s), SEG_FRAMES, CRF_1088, CRF_720.
set -euo pipefail
SRC=${1:?usage: build-hero-video.sh <source.mp4>}
cd "$(dirname "$0")/.."
OUT=public/media
SEG_START=${SEG_START:-0}
SEG_FRAMES=${SEG_FRAMES:-145}
CRF_1088=${CRF_1088:-27}
CRF_720=${CRF_720:-27}
mkdir -p "$OUT"

# Forward frames f0..f(N-1), then reversed f(N-2)..f1: the loop wraps f1 -> f0 and the turn is f(N-2) -> f(N-1) -> f(N-2).
graph() { # extra scale filter
  echo "[0:v]trim=start=${SEG_START}:end_frame=$((SEG_FRAMES + $(awk "BEGIN{print int(${SEG_START}*24)}"))),setpts=PTS-STARTPTS,fps=24${1}[s];\
[s]split[a][b];\
[b]reverse,select='gt(n\,0)*lt(n\,$((SEG_FRAMES - 1)))',setpts=N/(24*TB)[r];\
[a][r]concat=n=2:v=1:a=0,setpts=N/(24*TB),format=yuv420p[v]"
}
enc() { # width crf outfile
  local w=$1 crf=$2 out=$3 scale=""
  [[ $w -ne 1088 ]] && scale=",scale=${w}:-2:flags=lanczos"
  ffmpeg -v error -y -i "$SRC" -filter_complex "$(graph "$scale")" -map "[v]" -an -sn -dn \
    -map_metadata -1 -map_chapters -1 -fflags +bitexact -flags:v +bitexact \
    -c:v libx264 -profile:v high -preset slow -crf "$crf" -pix_fmt yuv420p -r 24 -movflags +faststart "$out"
}
enc 1088 "$CRF_1088" "$OUT/hero-loop-v1-1088.mp4"
enc 720  "$CRF_720"  "$OUT/hero-loop-v1-720.mp4"
# Poster = the loop's first frame (f0), full size, lossless PNG -> webp via cwebp (ffmpeg here has no libwebp).
TMP=$(mktemp -d); trap 'rm -rf "$TMP"' EXIT
ffmpeg -v error -y -i "$OUT/hero-loop-v1-1088.mp4" -frames:v 1 "$TMP/f0.png"
cwebp -quiet -q "${POSTER_Q:-80}" -m 6 "$TMP/f0.png" -o "$OUT/hero-poster-v1.webp"
ls -l "$OUT"
