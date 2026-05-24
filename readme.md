# Simple Network Video Recorder  in Node.js
This is a simple Network Video Recorder (NVR) that is designed to run on cheap hardware, such as a Raspberry Pi with a hard drive. 24/7 video streams from network cameras are saved, and the recorded files are browsable from a basic web interface.

![Camera locations](/images/camera-locations.png)

The project is deliberately bare-bones, and configuration is done through `.json` files.

The camera video streams are saved in 5 minute files (to prevent long periods of video loss should a file become corrupted). At 01:00 UTC, the video files for the previous day are concatinated into a single 24 hour file, and the 5 minute video files are deleted.

`ffmpeg` is used to connect to the camera streams and save the video feeds.


## Set up & configuration
To get started, the following steps must be taken:
1. Install [ffmpeg](https://ffmpeg.org/).
2. Choose where you want video files to be saved, and update the `rootpath` directory in the `/storage.json` configuration file.
   * Optional: set `retentionDays` (default `30`) to automatically delete fully completed day folders older than this many days.
3. Add camera names and RTSP addresses to the `/cameras.json` configuration file.
4. Copy `.env.example` to `.env` and set `CCTV_VIEWER_USERNAME` and `CCTV_VIEWER_PASSWORD` for the web UI login.
5. Start the services with [PM2](https://pm2.keymetrics.io/):

```bash
# Recorder (saves 5-minute MKV clips, runs daily concat at 01:00 UTC)
pm2 start nvr.js --name cctv

# Web browser / iPhone MP4 server (port 3000)
pm2 start nvr-browser.js --name cctv-browser

# Event scanner — see the "Offline event detection" section below
pm2 start event-scanner.js --name event-scanner

pm2 save
```

`nvr.js` records video only. `nvr-browser.js` runs the web UI at `http://localhost:3000`. They are independent processes — you can run one or both.

The `nvr.js` server records in 5-minute clips, combining them at 01:00 UTC every day into a 24-hour file.

![Video example](/images/video-example.png)

If you just want to record video without the browser, you can choose to only run `nvr.js`.

---

## Offline event detection

The optional event scanner samples recorded MKV clips with `ffmpeg`, calls a Python YOLOv8 detector, and logs person and animal (cat/dog) detections to the **Event Log** page in the browser.

Scanning is **offline only** — it processes saved recordings. There is no live inference.

### Python environment setup

This requires Raspberry Pi OS 64-bit. Use a dedicated Python virtualenv to keep Ultralytics isolated from the system Python:

```bash
sudo apt update
sudo apt install -y python3 python3-venv python3-pip python3-opencv ffmpeg
python3 -m venv ~/simple-nvr-yolo
~/simple-nvr-yolo/bin/pip install --upgrade pip
~/simple-nvr-yolo/bin/pip install ultralytics opencv-python-headless
```

> **Important:** Using system `python3` will fail with `No module named ultralytics`. Always use the virtualenv Python, either by activating it or by setting `pythonExecutable` in `event-detection.json` to the full venv path.

### Configuration

All event detection settings live in `event-detection.json`. Recommended configuration:

```json
{
  "enabled": false,
  "rootpath": "/mnt/cctv",
  "camera": "driveway",
  "classes": ["person", "cat", "dog"],
  "scanIntervalSeconds": 300,
  "sampleEverySeconds": 3,
  "maxFramesPerClip": 100,
  "tempFrameDir": "/mnt/cctv/tmp/simple-nvr-events",
  "pythonExecutable": "/home/pi/simple-nvr-yolo/bin/python3",
  "pythonDetectorPath": "scripts/detect-events.py",
  "yoloModel": "yolov8s.pt",
  "yoloImageSize": 960,
  "pythonTimeoutMs": 180000,
  "minConfidence": 0.25,
  "classConfidence": {
    "person": 0.45,
    "cat": 0.15,
    "dog": 0.15
  },
  "eventLogPath": "/mnt/cctv/events/events.jsonl",
  "thumbnailDir": "/mnt/cctv/events/thumbnails",
  "retentionDays": 30,
  "motionDetection": {
    "enabled": false,
    "logMotionEvents": false,
    "minChangedAreaPercent": 0.05,
    "minMotionBlobPixels": 50,
    "maxMotionBlobPercent": 5
  },
  "mockMode": false
}
```

**Key config fields:**

| Field | Description |
|---|---|
| `enabled` | Set `true` to run the automatic scanner daemon |
| `pythonExecutable` | **Full path to virtualenv Python** — e.g. `/home/pi/simple-nvr-yolo/bin/python3`. Required for the automatic service; system `python3` lacks Ultralytics |
| `camera` | Camera subdirectory name under `rootpath` |
| `classConfidence` | Per-class confidence thresholds. Lower catches more detections but increases false positives |
| `minConfidence` | Fallback threshold for any class not listed in `classConfidence` |
| `sampleEverySeconds` | Interval between sampled frames. Lower = more frames per clip, slower scan |
| `maxFramesPerClip` | Hard cap on frames sampled per clip |
| `scanIntervalSeconds` | How often the automatic scanner re-checks for new clips (seconds) |
| `scanLookbackDays` | How many days back the automatic scanner looks. `1` = today + yesterday (default). `0` = today only. Manual `--date` and `--clip` scans ignore this limit and work on any date |
| `yoloImageSize` | YOLO inference image size. `960` catches smaller/distant objects; `640` is faster |
| `pythonTimeoutMs` | Per-clip timeout for the Python detector (milliseconds) |
| `retentionDays` | Event logs and thumbnails older than this many days are deleted automatically |
| `motionDetection.enabled` | Pre-filter clips by motion before running YOLO. Saves CPU on static clips |
| `motionDetection.logMotionEvents` | If `true`, logs a generic `motion` event when YOLO finds nothing classifiable. **Disabled by default** — see note below |

### Local config override

`event-detection.json` is committed to git and contains generic defaults. Machine-specific values (your Pi username, absolute Python path, `"enabled": true`) should go in `event-detection.local.json`, which is **not committed** (it is listed in `.gitignore`).

Any key present in the local file **overwrites** the same key from the base file. You only need to include keys you want to override:

```json
{
  "enabled": true,
  "pythonExecutable": "/home/yourusername/simple-nvr-yolo/bin/python3"
}
```

Create this file on the Pi alongside `event-detection.json`. The scanner logs `✓ Local config override applied` on startup when the file is found.

### Confidence thresholds

Based on real-world testing against a Tapo driveway camera at night and daytime:

- **`person`: 0.45** — Detections below ~45% at night are frequently false positives (flies, headlights, shadows). True persons typically score 50–93%.
- **`cat` / `dog`: 0.15** — Distant cats are often detected as `dog` at low confidence. This is expected and correct; keep this threshold low to catch small/distant animals.

> **Cat/dog label note:** YOLO frequently classifies cats as `dog`. This is acceptable — the Event Log UI displays both as **Animal**, with the raw YOLO type shown as secondary information.

### Motion detection and `logMotionEvents`

When `motionDetection.enabled` is `true`, the Python script analyses frames for motion before loading YOLO. Clips with no motion are skipped entirely (saves significant CPU). If motion is detected, YOLO runs normally.

`logMotionEvents` controls whether a generic `motion` event is logged when YOLO finds motion but no classifiable person/animal:

- **`false` (default):** Only person/cat/dog YOLO detections are logged. Motion events are never created. Recommended for normal use.
- **`true`:** Also logs a `motion` event (with thumbnail of the best motion frame) when YOLO finds nothing classifiable. Useful for debugging missed detections, but produces many noisy events at night (flies, headlights, lighting changes).

### Storage layout

```
/mnt/cctv/events/
  events.jsonl                    # legacy flat log (may be empty)
  YYYY/MM/DD/
    events.jsonl                  # per-day event log (canonical source)
    thumbnails/                   # compressed thumbnails (~300 px wide)
  debug/
    <clip-hash>/                  # debug output (manual --debug runs only)
      frame_00001.jpg             # sampled frames
      raw-detections.json         # all YOLO detections before filtering
      deduped-detections.json     # final events after confidence/dedup
      motion-analysis.json        # motion pre-filter stats (if enabled)
```

### Retention

Event logs and thumbnails follow the same `retentionDays` retention as video recordings. After each scan, the scanner deletes `/mnt/cctv/events/YYYY/MM/DD` folders (including their thumbnails) older than the retention cutoff.

**Debug folders** (`/mnt/cctv/events/debug/`) are **not** created by the automatic scanner and are **not** subject to automatic retention cleanup. They are only created by manual `--debug` runs and must be cleaned up manually if needed.

### Running the scanner automatically

Set `"enabled": true` and set `pythonExecutable` to the full virtualenv Python path, then run:

```bash
pm2 start event-scanner.js --name event-scanner
```

The service does not use `--debug` and never creates debug folders.

#### First-run behaviour

On first startup, `/mnt/cctv/events/scanner-state.json` does not exist. The scanner detects this and **does not backfill** historical clips. Instead it:

1. Marks all existing clips in the lookback window as already processed (directory listing only — no inference)
2. Saves `scanner-state.json` so subsequent restarts behave normally
3. Logs clearly: `No scanner state found — initialising from current time (no automatic backfill)`

Only clips recorded **after** the scanner starts will be automatically detected. Use `--date` or `--clip` to intentionally backfill older recordings.

### Manual scan commands

Scan a single clip:

```bash
node event-scanner.js --clip "/mnt/cctv/driveway/2026/05/15/2026-05-15T12 00 00.mkv"
```

Scan all clips for a specific day:

```bash
node event-scanner.js --date 2026-05-18
```

Add `--debug` to either command to save sampled frames and raw detection JSON for inspection:

```bash
node event-scanner.js --clip "/mnt/cctv/driveway/2026/05/15/2026-05-15T12 00 00.mkv" --debug
node event-scanner.js --date 2026-05-18 --debug
```

> For manual scans, either set `pythonExecutable` to the venv path in `event-detection.json`, or activate the virtualenv before running (`source ~/simple-nvr-yolo/bin/activate`).

### Debug mode

When `--debug` is passed, the scanner:

- Saves sampled frames as JPEGs under `/mnt/cctv/events/debug/<clip-hash>/`
- Writes `raw-detections.json` (all detections before confidence filtering and deduplication)
- Writes `deduped-detections.json` (events that would actually be logged)
- Writes `motion-analysis.json` (motion pre-filter per-frame stats, if motion detection is enabled)
- Keeps the frame directory after scanning (normally cleaned up)

Debug mode is **only** active when `--debug` is explicitly passed on the command line. The automatic daemon never runs in debug mode.

---

## Video player controls

The browser video player supports 10-second skip controls for easier navigation of long recordings:

- **← Left arrow**: skip back 10 seconds
- **→ Right arrow**: skip forward 10 seconds
- **Space**: play / pause
- On-screen **◀◀ 10s** and **10s ▶▶** buttons are shown below the video

These controls apply to all video playback — both individual 5-minute clips and the full-day `output.mkv` recording.

---

## Downloading and sharing clips

### Download MP4 (5-minute clips)

When viewing any individual 5-minute clip, a **Download MP4** button appears below the player. Tapping it on iPhone will save the temporary MP4 to your camera roll. The same MP4 that is generated for iPhone playback is served — no extra processing.

### Extract a short clip from the 24-hour recording

After the daily concat runs at 01:00 UTC, individual 5-minute clips are deleted and only `output.mkv` (the full 24-hour file) remains for that day. The **Extract Clip** panel appears below the player when viewing any `output.mkv`.

**How to use it:**
1. Seek the video to the moment of interest
2. Press **▶ Now** to fill in the start time from the current playback position
3. Set a duration in seconds (default 30 s, max 3600 s / 1 hour)
4. Press **↓ Extract & Download** — the server uses ffmpeg to extract the clip and serve it as a download

**Technical notes:**
- The clip is extracted server-side using `ffmpeg -ss <start> -i <source> -t <duration> -c:v copy -c:a aac -movflags +faststart`
- Video is stream-copied (fast — no re-encoding). Audio is transcoded to AAC for compatibility
- `-movflags +faststart` moves the moov atom to the front of the output file so it plays immediately when shared via WhatsApp or iMessage
- Extraction typically takes 2–10 seconds on a Raspberry Pi for short clips
- Extracted clips are cached in `/mnt/cctv/tmp/simple-nvr-clips/` and purged after 10 minutes of inactivity
- The downloaded file is named `clip-HH-MM-SS-<dur>s.mp4` (start time + duration)

> **Note on seek accuracy:** `-ss` before `-i` performs a fast keyframe seek. The clip will start at the nearest keyframe before the requested time (typically within 1–2 seconds of a GOP boundary). For exact frame accuracy, use the manual ffmpeg command below.

**Manual clip extraction (exact frame accuracy):**
```bash
ffmpeg -i "/mnt/cctv/driveway/2026/05/23/output.mkv" \
  -ss 00:14:30 -t 60 \
  -c:v copy -c:a aac -b:a 128k -movflags +faststart \
  /tmp/clip.mp4
```

---

## Notes about the code and methods used
**Extra details about the implementation and ffmpeg configuration**

### MP4 vs MKV
`mkv` files seem to be more resistent to corruption. When unplugging the camera while an `mp4` file is being written to, the file is un-openable. When recording to an `mkv` file and the camera is unplugged, the files can be played and data is available until nearly the point of unplugging. `mkv` files can be played in the browser in the latest version of Chrome (as of October 2021).

### Temporary storage

All temporary files are stored on the **external drive** (not tmpfs `/tmp`) to avoid filling the SD card or RAM:

| Directory | Contents | Purged after |
|---|---|---|
| `<rootpath>/tmp/simple-nvr-mp4/` | On-demand MP4 conversions for iPhone/Safari playback | 5 min inactivity |
| `<rootpath>/tmp/simple-nvr-clips/` | Extracted clips created by the "Extract Clip" tool | 10 min inactivity |
| `<rootpath>/tmp/simple-nvr-events/` | Sampled frames used during YOLO event scanning | Cleaned up after each clip scan |

These directories are created automatically. The `tmp/` folder is **hidden** from the browser file listing.

> **Note on deleted-but-open files:** on Linux, `unlink()` only removes the directory entry; the data blocks remain until all file descriptors referencing the inode are closed. The server explicitly destroys `ReadStream` instances when the HTTP response closes (`res.on('close', () => stream.destroy())`), so deleted temp files are immediately reclaimed. You can verify with `sudo lsof +L1 | grep cctv-browser` — the output should be empty. 

### Audio in MP4 / iPhone playback

Recordings are saved as `.mkv`. When the browser requests a 5-minute clip as `.mp4` (for iPhone/Safari), the server generates a temporary MP4 on demand and caches it in `/mnt/cctv/tmp/simple-nvr-mp4/` for subsequent requests. Cache files are purged after 5 minutes of inactivity.

- The video codec is **stream-copied** from the MKV (`-c:v copy`) — no re-encoding, fast.
- Audio is **transcoded to AAC** (`-c:a aac -b:a 128k`) to ensure compatibility with iPhone/Safari. Some IP camera audio codecs (e.g. G.711/PCM) are not supported in MP4 by Safari; re-encoding to AAC fixes this.
- **`-movflags +faststart` is intentionally not used.** That flag requires ffmpeg to write the entire file and then read-and-rewrite it a second time to move the moov atom to the front — on a Raspberry Pi this doubles the I/O of a potentially 200 MB+ file and can cause memory pressure or audio corruption when combined with AAC encoding. The server already serves proper HTTP byte-range responses, so Safari can locate the moov atom at the end of the file without faststart.
- **On first access**, the MP4 is generated while the browser waits (typically a few seconds for video-copy + AAC encode on a Pi). Subsequent accesses are served immediately from the cache.

> **If audio is silent on both PC and iPhone:** clear the MP4 cache (`rm /mnt/cctv/tmp/simple-nvr-mp4/*.mp4`) and reload the page to force regeneration with the latest ffmpeg settings.

The recording pipeline captures audio from the camera stream with `-c:a copy`. If the camera produces no audio in its RTSP stream, the MKV and generated MP4 will be silent regardless of the conversion settings.

**Diagnostic — check whether a recording has an audio stream:**

```bash
ffprobe -i "/mnt/cctv/driveway/2026/05/18/2026-05-18T12 00 00.mkv" 2>&1 | grep -E "Audio|Video"
```

Or for full stream details:

```bash
ffprobe -v quiet -print_format json -show_streams "/mnt/cctv/driveway/YYYY/MM/DD/clip.mkv" | python3 -m json.tool
```

If no `Audio` line appears, the camera stream contains no audio and the recordings will always be silent.



### Connecting to camera streams
Using a wireless connection for the cameras appears to work well, and the video feeds very rarely drop connections (usually <60 seconds a day). However using a wireless connection for the Raspberry Pi 3b+ causes many video connection drops, often several minutes a day. For this reason **it is recommended to use a wired network connection for the Raspberry Pi / base station**.

#### TCP vs UDP
UDP was tested for the `ffmpeg` streams, and although it resulted in fewer warning errors from `ffmpeg`, the video files were often corrupted with the video frames being incorrectly ordered when played back, and some files not opening at all. TCP connections do not seem to suffer from this problem. Many `ffmpeg` settings variations (e.g. the buffer size) were used to try to mitigate the UPD corruption problem, but none worked reliably.

### Detecting stream errors
Several methods of detecting when a video feed fails have been tried. Attempting to detect dropped streams by the error events raised by `ffmpeg` gave inconsistent results, and occasionally resulted in either: 
1. The feed not restarting
2. Multiple streams from the same camera

Multiple streams causes further problems, as one or more of the streams creates corrupted files that are difficult to detect programatically.

The best results are achieved with a filewatcher script. The filewatcher looks for constant changes to the raw file that is being streamed to, and when the file is not changed for a set period of time it is assumed that the stream connection has failed. The `ffmpeg` stream is then killed (if it still exists), and the stream is recreated.

### Saving the streams
The streams are saved in 5 minute segments at "regular" 5 minute intervals (i.e. at 00:00:00, 00:05:00, 00:10:00, etc.). The naming configuration offered by `ffmpeg` allows for some customisation of the filenames, but we change the filenames to a "friendlier" UTC-like format of:
```
yyyy-mm-ddThh mm ss.mkv
``` 
This allows easy identification of the file time as a human, and the filename is also easily parsable back to a UTC time. 

#### Saving location

![Camera locations](/images/folders.png)

The file that the stream is currently being written to is located in a `raw` folder. The `ffmpeg` configured datetime pattern does not seem to parse correctly according to `ISO8601` on Windows, with the lower case `z` parsing to a descriptor like `GMT Summer Time` instead of `+0100`. This causes problems with the default `Date()` parsing which the code automatically accounts for on Windows machines.
```
/camera-name/raw/%Y-%m-%dT%H %M %S%z.mkv
```
A file watcher looks for when multiple files exist in the `raw` directory, and moves all but the newest file to the camera's day directory (below), renaming it at the same time.
```
/camera-name/year/month/day/yyyy-mm-ddThh mm ss.mkv
```

### Detecting corrupted video files
Very occasionally a video file becomes corrupted, and causes the concatination script to crash. To avoid this, each video file is scanned before the concatination script runs with `ffprobe`. Corrupted files are _not_ deleted in case they contain important (but corrupted) footage, and fixing the files may be possible.


### Retention behaviour
The recorder keeps continuous recording and only runs cleanup on dated day folders (`/YYYY/MM/DD`).

Default retention is `30` days, configurable via `storage.json` -> `retentionDays`. Cleanup runs daily at `02:00 UTC`, never touches `raw/`, never deletes today or yesterday, and only removes fully completed old day folders older than the retention period. The daily concat job runs at `01:00 UTC` for yesterday's folder, and cleanup never targets yesterday, so there is no overlap on the same day directory.

Daily concatenation still removes source 5-minute clips only after a successful combine.

### Hardware & Cameras
Each camera on a Raspberry Pi 3b+ writing to an external HDD seems to use ~9% CPU.

![CPU use](/images/cpu-use.png)

Two _ieGeek_ cameras bought on Amazon run well when paired with a Raspberry Pi 3+. I suspect the Pi could easily handle more than 2 cameras given the CPU consumption.
