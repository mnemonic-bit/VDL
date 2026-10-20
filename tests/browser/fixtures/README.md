`crossfade.webm` is a generated 14-second blue frame with a quiet 440 Hz tone
(VP8 + Opus). It lets the browser tier exercise real media buffering, clocks,
autoplay promises, fullscreen, and source cleanup without ffmpeg at test time.
Regenerate it with:

```sh
ffmpeg -f lavfi -i color=c=blue:s=160x90:r=10 \
    -f lavfi -i sine=frequency=440:sample_rate=24000 -t 14 \
    -c:v libvpx -b:v 25k -g 10 -c:a libopus -b:a 12k crossfade.webm
```
