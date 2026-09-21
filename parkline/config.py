import os

PACKAGE_DIR = os.path.dirname(os.path.abspath(__file__))
PROJECT_ROOT = os.path.dirname(PACKAGE_DIR)

DATA_DIR = os.path.join(PROJECT_ROOT, "data")
RUNTIME_DIR = os.path.join(PROJECT_ROOT, "runtime")
WEB_DIR = os.path.join(PROJECT_ROOT, "web")

VIDEO_PATH = os.path.join(DATA_DIR, "parking_video.mp4")
SPACES_PATH = os.path.join(RUNTIME_DIR, "video_spaces.json")
STATUS_PATH = os.path.join(RUNTIME_DIR, "status.json")
LIVE_PATH = os.path.join(RUNTIME_DIR, "lot_live.jpg")
FRAME_PATH = os.path.join(RUNTIME_DIR, "lot_frame.jpg")


def ensure_runtime_dir():
    os.makedirs(RUNTIME_DIR, exist_ok=True)
