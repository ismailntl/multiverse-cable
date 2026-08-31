# Streaming to Twitch / Kick / YouTube Live

The site has no discovery surface. Twitch and Kick do. A 24/7 restream with
`multiversecable.com` burned into the corner is the cheapest funnel available.

```bash
# Twitch
node scripts/stream.js \
  --url rtmp://live.twitch.tv/app \
  --key live_XXXXXXXX

# Kick  (key from Kick → Settings → Stream Key)
node scripts/stream.js \
  --url rtmps://fa723fc1b171.global-contribute.live-video.net \
  --key sk_us-west-2_XXXX

# YouTube Live
node scripts/stream.js \
  --url rtmp://a.rtmp.youtube.com/live2 \
  --key xxxx-xxxx-xxxx-xxxx
```

Keep it alive across restarts:

```bash
pm2 start scripts/stream.js --name mc-stream -- --url rtmp://... --key ...
```

## What gets streamed, and why it isn't everything

**By default only generated clips air — the archive is excluded.**

rehan_shei's original interdimensional-cable stream was pulled from *both*
Twitch and Kick over copyright. Their systems fingerprint **audio** aggressively,
and archival footage routinely carries incidental music that trips a match even
when the film itself is public domain. Public domain is a copyright status; it
is not a licence for the music on the soundtrack.

`--include-archive` overrides this. Only use it if you have specifically
verified your archival set's audio, and expect strikes if you haven't.

## How it works

The concat demuxer requires every input to have identical streams, and this
library is mixed — fal clips carry audio, Nova clips are silent, resolutions
differ. So each clip is normalised **once** into `data/stream-cache/`:

- scaled and padded to 1280x720
- stereo 44.1kHz AAC, with silence synthesised where the source has none
- the site name drawn into the top-right corner

The stream then concatenates those with `-c copy`, so the ongoing cost is a
stream copy rather than a re-encode — cheap enough to run beside the generator
on the same box.

Cache notes:
- The first cycle transcodes and is slow (~3s/clip); later cycles reuse it.
- Cache filenames embed a hash of the overlay, so changing `PUBLIC_URL`
  regenerates rather than silently reusing clips burned with the old name.
- `data/stream-cache/` is gitignored. Delete it any time to force a rebuild.
- ~400 generated clips is roughly 77 minutes per loop; clips are reshuffled
  every cycle so the loop isn't identical.

`PUBLIC_URL` drives the on-screen watermark. Only the bare host is used —
scheme, port and path are stripped, and drawtext metacharacters are escaped
(an unescaped `:` is drawtext's own argument separator and truncates the text).
