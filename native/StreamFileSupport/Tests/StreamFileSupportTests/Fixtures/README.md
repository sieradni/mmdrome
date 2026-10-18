# Growing-file fixtures

These generated 40-second, mono 48 kHz sine waves contain no third-party media.
Reproduce with FFmpeg (tests check readable growth, not exact encoded bytes):

```sh
ffmpeg -f lavfi -i 'sine=frequency=440:sample_rate=48000:duration=40' -ac 1 -c:a libopus -b:a 128k growth.opus
ffmpeg -f lavfi -i 'sine=frequency=440:sample_rate=48000:duration=40' -ac 1 -c:a flac header.flac
```

Tests append prefixes without waiting on wall-clock network timing and reopen
through the same observation adapter as the iOS plugin. Host decoder support
and readable prefix behavior are required; unsupported fixtures fail explicitly.
