import json
import os
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse

from parkline.config import (
    FRAME_PATH,
    LIVE_PATH,
    SPACES_PATH,
    STATUS_PATH,
    VIDEO_PATH,
    WEB_DIR,
)
from parkline.detector import (
    auto_detect_spaces,
    extract_first_frame,
    load_spaces,
    run_detector,
    save_spaces,
    split_rows_into_spaces,
)

HOST = "127.0.0.1"
PORT = 8765

MIME_TYPES = {
    ".html": "text/html; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".js": "application/javascript; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".png": "image/png",
    ".svg": "image/svg+xml",
}

detector_lock = threading.Lock()
stop_event = threading.Event()
detector_thread = None


def detector_is_running():
    return detector_thread is not None and detector_thread.is_alive()


def start_detector():
    global detector_thread

    with detector_lock:
        if detector_is_running():
            return False

        if load_spaces() is None:
            return False

        stop_event.clear()
        detector_thread = threading.Thread(
            target=_detector_worker,
            daemon=True,
            name="parkline-detector",
        )
        detector_thread.start()
        return True


def stop_detector():
    global detector_thread

    with detector_lock:
        stop_event.set()
        thread = detector_thread
        detector_thread = None

    if thread is not None:
        thread.join(timeout=4)


def _detector_worker():
    try:
        run_detector(show_window=False, stop_event=stop_event)
    except Exception as error:
        print(f"Detector stopped: {error}")


def read_json_body(handler):
    length = int(handler.headers.get("Content-Length", "0") or 0)
    raw = handler.rfile.read(length) if length else b"{}"
    if not raw:
        return {}
    return json.loads(raw.decode("utf-8"))


def current_state():
    has_spaces = load_spaces() is not None

    if has_spaces and not detector_is_running():
        start_detector()

    return {
        "has_video": os.path.exists(VIDEO_PATH),
        "has_spaces": has_spaces,
        "detector_running": detector_is_running(),
        "has_live_image": os.path.exists(LIVE_PATH),
        "has_status": os.path.exists(STATUS_PATH),
    }


class ParklineHandler(BaseHTTPRequestHandler):
    def log_message(self, format, *args):
        print("[parkline]", self.address_string(), "-", format % args)

    def _send(self, status, body, content_type, cache=False):
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.send_header(
            "Cache-Control",
            "public, max-age=3600" if cache else "no-store, max-age=0",
        )
        self.end_headers()
        self.wfile.write(body)

    def _send_json(self, payload, status=200):
        body = json.dumps(payload).encode("utf-8")
        self._send(status, body, "application/json; charset=utf-8")

    def _send_file(self, path, cache=False):
        if not os.path.exists(path):
            self.send_error(404, "Not found")
            return

        extension = os.path.splitext(path)[1].lower()
        content_type = MIME_TYPES.get(extension, "application/octet-stream")

        with open(path, "rb") as file:
            body = file.read()

        self._send(200, body, content_type, cache=cache)

    def do_GET(self):
        path = urlparse(self.path).path

        if path in {"/", "/index.html"}:
            self._send_file(os.path.join(WEB_DIR, "index.html"))
            return

        if path in {"/styles.css", "/app.js"}:
            self._send_file(os.path.join(WEB_DIR, path.lstrip("/")))
            return

        if path == "/api/state":
            self._send_json(current_state())
            return

        if path == "/api/spaces":
            spaces = load_spaces() or []
            self._send_json({"spaces": spaces, "count": len(spaces)})
            return

        if path == "/status.json":
            self._send_file(STATUS_PATH)
            return

        if path == "/lot_frame.jpg":
            self._send_file(FRAME_PATH)
            return

        if path == "/lot_live.jpg":
            self._send_file(LIVE_PATH)
            return

        self.send_error(404, "Not found")

    def do_POST(self):
        path = urlparse(self.path).path

        try:
            body = read_json_body(self)
        except json.JSONDecodeError:
            self._send_json({"error": "Invalid JSON"}, status=400)
            return

        try:
            if path == "/api/autodetect":
                frame = extract_first_frame(FRAME_PATH)
                spaces = auto_detect_spaces(frame)
                self._send_json({"spaces": spaces, "count": len(spaces)})
                return

            if path == "/api/preview":
                spaces = split_rows_into_spaces(
                    body.get("reference"),
                    body.get("rows") or [],
                )
                self._send_json({"spaces": spaces, "count": len(spaces)})
                return

            if path == "/api/spaces":
                spaces = body.get("spaces")

                if not spaces:
                    spaces = split_rows_into_spaces(
                        body.get("reference"),
                        body.get("rows") or [],
                    )

                save_spaces(spaces)
                stop_detector()
                start_detector()
                self._send_json({
                    "saved": True,
                    "count": len(spaces),
                    "detector_running": detector_is_running(),
                })
                return

            if path == "/api/reset":
                stop_detector()

                for file_path in (SPACES_PATH, STATUS_PATH, LIVE_PATH):
                    if os.path.exists(file_path):
                        os.remove(file_path)

                self._send_json({"reset": True})
                return
        except (ValueError, TypeError, KeyError) as error:
            self._send_json({"error": str(error)}, status=400)
            return

        self.send_error(404, "Not found")


def main():
    if not os.path.exists(VIDEO_PATH):
        raise FileNotFoundError(f"Missing parking video: {VIDEO_PATH}")

    extract_first_frame(FRAME_PATH)

    if load_spaces() is not None:
        start_detector()

    ThreadingHTTPServer.allow_reuse_address = True
    server = ThreadingHTTPServer((HOST, PORT), ParklineHandler)
    print()
    print("Parkline is ready.", flush=True)
    print(f"Open http://{HOST}:{PORT}", flush=True)
    print("Press Ctrl+C to stop.", flush=True)
    print()

    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nStopping Parkline...")
    finally:
        stop_detector()
        server.server_close()


if __name__ == "__main__":
    main()
