#!/bin/sh
# One-off: generate placeholder montages + posters for data/manifest.placeholder.json.
set -e
cd "$(dirname "$0")/.."
FONT=/System/Library/Fonts/Helvetica.ttc
mk() { id=$1; name=$2; c0=$3; c1=$4; hz=$5
  d=data/placeholder/$id/2026-09-25; mkdir -p "$d"
  ffmpeg -loglevel error -y \
    -f lavfi -i "gradients=s=1280x720:c0=$c0:c1=$c1:x0=0:y0=0:x1=1280:y1=720:speed=0.012:d=10:r=30" \
    -f lavfi -i "sine=f=$hz:d=10,volume=0.06" \
    -vf "drawtext=fontfile=$FONT:text='$name':fontcolor=white@0.92:fontsize=64:x=(w-text_w)/2:y=(h-text_h)/2-12,drawtext=fontfile=$FONT:text='placeholder clip':fontcolor=white@0.55:fontsize=22:x=(w-text_w)/2:y=(h/2)+48" \
    -c:v libx264 -pix_fmt yuv420p -profile:v high -crf 30 -preset slow -movflags +faststart -c:a aac -b:a 64k -shortest "$d/montage.mp4"
  ffmpeg -loglevel error -y -ss 1 -i "$d/montage.mp4" -frames:v 1 -q:v 5 "$d/poster.jpg"
}
mk jp-tokyo "Tokyo" 0x1d2b3a 0x6b4e71 196
mk ng-lagos "Lagos" 0x2e2a1d 0x7a5a2b 220
mk br-sao-paulo "São Paulo" 0x1f3325 0x4f6b3a 247
mk is-reykjavik "Reykjavík" 0x17262e 0x4d6f78 174
mk in-mumbai "Mumbai" 0x3a1f1f 0x8a5a3a 262
mk us-san-francisco "San Francisco" 0x22252e 0x6a6f82 147
