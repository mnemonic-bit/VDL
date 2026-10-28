`crossfade.webm` is a generated 14-second blue frame with a quiet 440 Hz tone
(VP8 + Opus). It lets the browser tier exercise real media buffering, clocks,
autoplay promises, fullscreen, and source cleanup without ffmpeg at test time.
Regenerate it with:

```sh
ffmpeg -f lavfi -i color=c=blue:s=160x90:r=10 \
    -f lavfi -i sine=frequency=440:sample_rate=24000 -t 14 \
    -c:v libvpx -b:v 25k -g 10 -c:a libopus -b:a 12k crossfade.webm
```

`edges.webm` uses the same generated picture and tone for 30 seconds. It tests
intro/outro start seeks, early finishing, and crossfade using a real browser
media timeline. Regenerate it with the command above using `-t 30` and output
`edges.webm` instead.

The `fit-*.webm` fixtures are silent, 60-second blue pictures with a 40-pixel
white border on every edge. Browser tests sample screenshots at the expected
border and bar positions to detect fullscreen cropping, stretching, or an
off-center picture. Their intrinsic sizes exceed the test viewport to exercise
grid sizing: `fit-4-3` is 1600×1200, `fit-portrait` is 900×1600, `fit-wide` is
1920×800, and `fit-16-9` is 1600×900. Regenerate each with its corresponding
size and filename:

```sh
ffmpeg -f lavfi \
    -i 'color=c=blue:s=1600x1200:r=1,drawbox=x=0:y=0:w=iw:h=ih:color=white:t=40' \
    -t 60 -c:v libvpx -b:v 30k -g 1 -an fit-4-3.webm
```
