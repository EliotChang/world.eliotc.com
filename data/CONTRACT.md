# Atlas data contract (shared by page, anchors, pipeline)

One-time snapshot: every place is stamped asOf "2026-09-25" and shown as "as of Sep 25, 2026". No refresh.
Never depict real, recognizable people; names appear only in on-page captions.

## data/anchors.json  (owned by the anchors task)
Array, ~600 entries (countries, regions of big countries, major cities, a few ocean points), sorted by id:
{ "id": "jp-tokyo",            // kebab, unique, stable forever (cache key)
  "name": "Tokyo",             // display name
  "country": "Japan",          // display country (short name)
  "region": "Kanto",           // optional
  "lat": 35.68, "lng": 139.69, // WGS84, 2 decimals
  "kind": "city",              // country | region | city | ocean
  "query": "Tokyo Japan"       // news search phrase
}

## manifest.json  (owned by the pipeline; lives on the CDN, pilot copy at data/manifest.pilot.json)
{ "version": "2026-09-25", "generatedAt": "<ISO>",
  "cdn": "https://<cloudfront host>/eliotc/atlas/",
  "places": [
    { "id": "jp-tokyo", "name": "Tokyo", "country": "Japan", "lat": 35.68, "lng": 139.69,
      "asOf": "2026-09-25",
      "video": "jp-tokyo/2026-09-25/montage.mp4",   // relative to cdn
      "poster": "jp-tokyo/2026-09-25/poster.jpg",
      "durationS": 30,
      "captions": [ { "start": 0.0, "end": 5.0, "text": "..." } ],
      "sources":  [ { "outlet": "BBC", "title": "...", "url": "https://..." } ] } ] }

Videos: H.264 MP4, 16:9, 768P, muted-safe (narration on the audio track), served with
CORS `Access-Control-Allow-Origin: *` so the page can use them as WebGL textures.
