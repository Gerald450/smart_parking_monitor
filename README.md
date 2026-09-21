# Parkline — Smart Parking Monitor

Detects occupied and open parking stalls from a lot video and shows them on a local dashboard.

## Layout

```
app.py                 # start the dashboard
parkline/              # detector and HTTP server
web/                   # dashboard UI
data/                  # input video (parking_video.mp4)
runtime/               # generated frames, stall map, and status
samples/               # local reference clone (not part of the app)
```

## Setup

Python 3.9 or newer.

```bash
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
```

Place your lot recording at `data/parking_video.mp4`.

## Run

```bash
python app.py
```

Then open http://127.0.0.1:8765

You can also run `python -m parkline`.
# smart_parking_monitor
