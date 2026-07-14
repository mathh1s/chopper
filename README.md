# chopper

A sampling bench you host yourself. Paste a link or drop a file, find the grid, cut the
track into slices, and take the timestamps (or the sliced wavs) into FL Studio.

Go + Postgres on the back, Web Audio + canvas on the front. One binary, frontend embedded.

## What it does

- **Load** anything yt-dlp can reach (YouTube, SoundCloud, Bandcamp) or drop a local file.
  Everything gets normalised to 16 bit wav, which is what you want to drag into FL anyway.
- **Find the grid.** Detect BPM and downbeat, or tap it in. Halve and double buttons for
  when the detector locks onto the wrong metre.
- **Chop.** Slice a selection, cut N even chops, cut on every bar or beat, or cut on
  transients. Everything snaps to the grid.
- **Audition.** Sample accurate looping that follows the selection while it plays, pads on
  keys 1 to 9, and a speed slider that shows the semitone shift so you know what pitching it
  to your project tempo will cost.
- **Reverse and pitch.** Reverse is per chop, so it is remembered and it is what gets
  exported. Pitch is in semitones and is free of the speed control by default: the audio is
  time stretched underneath so the pitch moves and the tempo does not. Tick "tie to speed"
  to get the old sampler behaviour where pitching up also speeds up.
- **Layer.** A project is a pad bank, not a single song. Drop as many sources into it as
  you like. Each keeps its own tempo and grid, because two unrelated records will never
  agree on either, and gets warped to the project tempo when its chops are triggered. Pads
  are polyphonic, so chops stack instead of cutting each other off.
- **Record.** Play the pads over a loop and it keeps the take. Overdub by leaving it
  running, with quantize, a metronome and a count in. Then bounce the whole thing to one
  wav, or export it as MIDI and rebuild it in FL from the sliced chops.
- **Export.** Timestamps to clipboard, JSON, Audacity labels, a wav with your slices
  embedded as cue markers and regions, or a zip of one wav per chop.
- **Split stems** into drums, bass, vocals and other, if you install demucs. Each stem
  becomes its own source you can chop separately. This is the single biggest upgrade to
  your sampling if your CPU can take it.

## Run it

### Docker

    ./scripts/gen-env.sh
    docker compose up -d --build

`gen-env.sh` writes a `.env` with random free ports, a random database name, user and
password, a random session secret, and a random sign in password. It prints the port and
the password at the end. Run it once per deployment and do not commit the result.

Nothing in `docker-compose.yml` is hardcoded, so if you want to change a port or a
credential, change `.env` and `docker compose up -d` again.

Stem separation is on by default. That is what the two extra gigabytes in the image are:
demucs drags torch in with it. Set `WITH_DEMUCS=0` and `DEMUCS_BIN=` in `.env` before
building if you would rather have a small image and no stem splitting.

### Bare metal

Needs `ffmpeg`, `ffprobe` and `yt-dlp` on PATH, plus a Postgres database.

    go build -o chopper ./cmd/server
    cp .env.example .env     # fill it in
    set -a; source .env; set +a
    ./chopper

Migrations run on boot. There is nothing to apply by hand.

`deploy/chopper.service` and `deploy/nginx.conf` are there for the systemd + nginx route.
Two things about that nginx config:

- Replace `APP_PORT` in the `proxy_pass` line with whatever `gen-env.sh` put in your `.env`.
  It is random per deployment, so there is nothing sensible to default it to.
- The timeouts in there are not decoration. A yt-dlp fetch of a long track sits silent for
  minutes, and the default 60 second `proxy_read_timeout` kills it mid download.

Keep `APP_BIND=127.0.0.1`. Otherwise the Go server binds every interface and anyone who
can reach the box on that port walks straight past nginx and your SSL.

## Auth

One shared password, two people, no user table. A session is an expiry timestamp signed
with `SESSION_SECRET`. That is the whole thing. It is exactly as much auth as this needs
and no more, so do not put it on a public URL and forget about it.

## Keys

| key | does |
| --- | --- |
| `space` | play / pause (plays the selection if you have one) |
| `L` | toggle loop |
| `R` | toggle reverse |
| `S` | slice the current selection |
| `F` | fit the whole track |
| `1` to `9`, `0` | trigger pad (hold shift to loop it for auditioning) |
| `[` `]` | nudge the selection edges by one snap unit (shift nudges forward) |
| `delete` | delete the selected slice |
| scroll | pan |
| ctrl + scroll | zoom |

## Getting a sample out of a track and into FL Studio

If you have not done this before, the workflow is roughly:

1. **Load the track.** Paste the link, wait for the fetch.
2. **Find the loop.** Zoom out, look at the waveform, and hunt for the section where the
   fewest things are playing at once. Intros, outros, and the bar right after a drop are
   gold, because a sample with the full mix on top of it is very hard to use. This is also
   where stem separation earns its keep: split the track, then chop the bass or the "other"
   stem on its own and you get a clean loop nobody else has.
3. **Set the grid.** Hit detect. Check the bar lines land on the kicks. If the grid is
   drifting, the BPM is slightly off, so tap it in instead. If the grid is at half or double
   speed, hit x2 or /2. Then put the cursor exactly on the first kick of the loop and press
   "Downbeat = cursor" so bar 1 starts where you want it.
4. **Chop.** Drag a selection over the bars you want (snap will lock it to the grid), then
   either slice it whole with `S`, or use "Chop on grid, every beat" to cut it into pieces
   you can rearrange.
5. **Layer and play it.** Set a project tempo, then drop a second source into the bank
   (another record, or a stem of the same one). Its chops get warped to your tempo
   automatically, so two songs at different BPMs lock together. Hit Record, play the pads,
   and it keeps what you played. Leave it looping to overdub more on top.
6. **Export.** "Bounce take (WAV)" gives you the whole performance as one file. "Slice
   WAVs (zip)" gives you one wav per chop plus a timestamps txt, and "MIDI" gives you the
   take as notes starting at C1, so you can load the chops into a sampler in FL and have
   the pattern already played for you.
7. **In FL Studio.** Drag the wavs onto the playlist or into a sampler channel. Set your
   project tempo, then either timestretch each chop to fit (Channel settings, Time
   stretching, mode Auto or Slice Stretch) or let them play at their natural speed and
   build the beat around the sample's own tempo. If you want the sample pitched, the rate
   slider in chopper already told you the semitone cost of any tempo change.
8. **Layer your own drums** over the loop, high pass the sample so it does not fight your
   own kick and bass, and you are basically done.

The "WAV with markers" export is the other route: it gives you the full track with your
chops written in as cue points and regions. Drop that into Edison and the markers show up,
which lets you send the whole thing to Slicex in one go rather than dragging in twenty
files. Support for marker chunks varies by DAW version, so if it does not take, fall back
to the zip.

One boring but real thing: if you plan to release the track, an uncleared sample of a
commercial recording is a copyright problem no matter how chopped it is. Fine for a beat
on your hard drive, not fine for a distributor.
