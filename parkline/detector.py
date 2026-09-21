import json
import os
import time
from datetime import datetime

import cv2
import numpy as np

from parkline.config import (
    FRAME_PATH,
    LIVE_PATH,
    SPACES_PATH,
    STATUS_PATH,
    VIDEO_PATH,
    ensure_runtime_dir,
)

EDGE_THRESHOLD = 0.080
UPDATE_EVERY_N_FRAMES = 10
MAX_READ_FAILURES = 5


def save_json_safely(data, path):
    ensure_runtime_dir()
    temporary_path = path + ".tmp"

    with open(temporary_path, "w") as file:
        json.dump(data, file, indent=2)

    os.replace(temporary_path, path)


def save_image_safely(image, path):
    ensure_runtime_dir()
    root, extension = os.path.splitext(path)
    temporary_path = root + ".tmp" + extension

    if extension.lower() in {".jpg", ".jpeg"}:
        wrote = cv2.imwrite(temporary_path, image, [int(cv2.IMWRITE_JPEG_QUALITY), 82])
    else:
        wrote = cv2.imwrite(temporary_path, image)

    if not wrote:
        if os.path.exists(temporary_path):
            os.remove(temporary_path)
        return False

    os.replace(temporary_path, path)
    return True


def load_spaces():
    if not os.path.exists(SPACES_PATH):
        return None

    with open(SPACES_PATH, "r") as file:
        spaces = json.load(file)

    if not isinstance(spaces, list) or not spaces:
        return None

    cleaned = []

    for space in spaces:
        if not isinstance(space, (list, tuple)) or len(space) != 4:
            continue

        cleaned.append([int(value) for value in space])

    return cleaned or None


def save_spaces(spaces):
    save_json_safely(spaces, SPACES_PATH)


def split_rows_into_spaces(reference, selected_rows):
    _, _, reference_width, reference_height = [int(value) for value in reference]

    if reference_width <= 0 or reference_height <= 0:
        raise ValueError("No reference space was selected.")

    spaces = []

    for row_number, row in enumerate(selected_rows, start=1):
        row_x, row_y, row_width, row_height = [int(value) for value in row]

        if row_width <= 0 or row_height <= 0:
            continue

        is_horizontal = row_width >= row_height

        if is_horizontal:
            number_of_spaces = max(1, round(row_width / reference_width))
            calculated_width = row_width / number_of_spaces

            for index in range(number_of_spaces):
                x1 = round(row_x + index * calculated_width)
                x2 = round(row_x + (index + 1) * calculated_width)
                spaces.append([x1, row_y, x2 - x1, row_height])
        else:
            number_of_spaces = max(1, round(row_height / reference_height))
            calculated_height = row_height / number_of_spaces

            for index in range(number_of_spaces):
                y1 = round(row_y + index * calculated_height)
                y2 = round(row_y + (index + 1) * calculated_height)
                spaces.append([row_x, y1, row_width, y2 - y1])

        print(f"Row {row_number}: generated {number_of_spaces} parking spaces")

    if not spaces:
        raise ValueError("No parking spaces were generated.")

    return spaces


def auto_detect_spaces(frame):
    height, width = frame.shape[:2]
    gray = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY)
    hsv = cv2.cvtColor(frame, cv2.COLOR_BGR2HSV)

    white_paint = (
        (hsv[:, :, 1] < 45) & (hsv[:, :, 2] > 170)
    ).astype(np.uint8) * 255
    highpass = cv2.subtract(gray, cv2.GaussianBlur(gray, (21, 21), 0))
    _, highpass = cv2.threshold(highpass, 16, 255, cv2.THRESH_BINARY)
    paint = cv2.bitwise_and(white_paint, highpass)
    horizontal_paint = cv2.morphologyEx(
        paint,
        cv2.MORPH_OPEN,
        cv2.getStructuringElement(cv2.MORPH_RECT, (17, 1)),
    )

    top = int(height * 0.08)
    bottom = int(height * 0.94)
    row_profile = horizontal_paint[top:bottom, :].sum(axis=1) / 255.0
    stall_rows = [
        top + peak
        for peak in _profile_peaks(
            row_profile,
            max(12, row_profile.max() * 0.2),
            30,
        )
    ]

    if len(stall_rows) < 3:
        raise ValueError("Could not find painted stall rows in this lot photo.")

    blurred = cv2.GaussianBlur(gray, (5, 5), 0)
    edges = cv2.Canny(blurred, 40, 120)
    column_profile = edges[
        int(height * 0.12) : int(height * 0.88), :
    ].sum(axis=0).astype(np.float32)
    column_profile = np.convolve(
        column_profile,
        np.ones(17) / 17.0,
        mode="same",
    )

    islands = _high_bands(
        column_profile,
        np.percentile(column_profile, 36),
        70,
    )

    columns = []
    for start, end in islands:
        span = end - start
        if span >= 155:
            columns.extend(_split_band(column_profile, start, end))
        elif span >= 70:
            columns.append((start, end))

    if len(columns) < 2:
        raise ValueError("Could not find parking columns in this lot photo.")

    spaces = []

    for x1, x2 in columns:
        x1 += 2
        x2 -= 2

        for y1, y2 in zip(stall_rows, stall_rows[1:]):
            box_width = x2 - x1
            box_height = y2 - y1

            if box_width < 55 or box_width > 170:
                continue
            if box_height < 32 or box_height > 85:
                continue
            if _looks_like_curb(frame[y1:y2, x1:x2]):
                continue

            spaces.append([int(x1), int(y1), int(box_width), int(box_height)])

    if len(spaces) < 6:
        raise ValueError(
            "Auto-detect found too few stalls. Draw them manually instead."
        )

    return spaces


def _profile_peaks(profile, minimum, separation):
    found = []
    index = 0
    length = len(profile)

    while index < length:
        if profile[index] >= minimum:
            end = index
            while end < length and profile[end] >= minimum * 0.55:
                end += 1

            peak = index + int(np.argmax(profile[index:end]))

            if not found or peak - found[-1] >= separation:
                found.append(peak)
            elif profile[peak] > profile[found[-1]]:
                found[-1] = peak

            index = end
        else:
            index += 1

    return found


def _high_bands(profile, threshold, min_width):
    bands = []
    index = 0
    length = len(profile)
    floor = threshold * 0.72

    while index < length:
        if profile[index] > threshold:
            end = index
            while end < length and profile[end] > floor:
                end += 1

            if end - index >= min_width:
                bands.append((index, end))

            index = end
        else:
            index += 1

    return bands


def _split_band(profile, start, end):
    valleys = []

    for x in range(start + 28, end - 28):
        if not (profile[x] <= profile[x - 1] and profile[x] <= profile[x + 1]):
            continue

        prominence = (
            min(profile[start:x].max(), profile[x:end].max()) - profile[x]
        )

        if prominence < profile[start:end].max() * 0.12:
            continue

        if not valleys or x - valleys[-1] >= 55:
            valleys.append(x)
        elif profile[x] < profile[valleys[-1]]:
            valleys[-1] = x

    cuts = [start] + valleys + [end]
    columns = []

    for left, right in zip(cuts, cuts[1:]):
        if right - left >= 70:
            columns.append((left, right))

    return columns or [(start, end)]


def _looks_like_curb(crop):
    if crop.size == 0:
        return True

    gray = cv2.cvtColor(crop, cv2.COLOR_BGR2GRAY)
    edges = cv2.Canny(gray, 50, 150)
    edge_ratio = cv2.countNonZero(edges) / float(gray.size)
    return gray.mean() > 135 and edge_ratio < 0.045


def generate_spaces_from_rows(frame):
    print("Select one complete parking space.")
    print("Press ENTER when finished.")

    reference = cv2.selectROI(
        "Select One Reference Space", frame, showCrosshair=True, fromCenter=False
    )

    cv2.destroyWindow("Select One Reference Space")

    print("Select one large rectangle around each parking row.")
    print("Press ENTER after selecting each row.")
    print("Press ESC when all rows are selected.")

    selected_rows = cv2.selectROIs(
        "Select Parking Rows", frame, showCrosshair=True, fromCenter=False
    )

    cv2.destroyWindow("Select Parking Rows")

    return split_rows_into_spaces(reference, selected_rows)


def preview_spaces(frame, spaces):
    preview = frame.copy()

    for index, (x, y, width, height) in enumerate(spaces, start=1):
        cv2.rectangle(preview, (x, y), (x + width, y + height), (0, 255, 0), 2)
        cv2.putText(
            preview,
            str(index),
            (x + 5, y + 20),
            cv2.FONT_HERSHEY_SIMPLEX,
            0.5,
            (0, 255, 0),
            2,
        )

    cv2.imshow("Generated Parking Spaces", preview)

    print(f"Generated {len(spaces)} total parking spaces.")
    print("Press S to save, or press any other key to cancel.")

    key = cv2.waitKey(0) & 0xFF
    cv2.destroyWindow("Generated Parking Spaces")

    return key in (ord("s"), ord("S"))


def extract_first_frame(output_path=FRAME_PATH):
    video = cv2.VideoCapture(VIDEO_PATH)

    if not video.isOpened():
        raise FileNotFoundError(f"Could not open video: {VIDEO_PATH}")

    success, frame = video.read()
    video.release()

    if not success:
        raise RuntimeError("Could not read the first video frame.")

    save_image_safely(frame, output_path)
    return frame


def analyze_frame(frame, spaces):
    display = frame.copy()
    available = 0
    results = []
    frame_height, frame_width = frame.shape[:2]

    for index, (x, y, width, height) in enumerate(spaces, start=1):
        x1 = max(0, int(x))
        y1 = max(0, int(y))
        x2 = min(frame_width, int(x + width))
        y2 = min(frame_height, int(y + height))

        parking_space = frame[y1:y2, x1:x2]
        box_width = max(0, x2 - x1)
        box_height = max(0, y2 - y1)

        if parking_space.size == 0:
            results.append(
                {
                    "id": index,
                    "space": index,
                    "status": "Unknown",
                    "edge_ratio": 0,
                    "x": x1,
                    "y": y1,
                    "w": box_width,
                    "h": box_height,
                }
            )
            continue

        gray = cv2.cvtColor(parking_space, cv2.COLOR_BGR2GRAY)
        blurred = cv2.GaussianBlur(gray, (5, 5), 0)
        edges = cv2.Canny(blurred, 50, 150)

        edge_pixels = cv2.countNonZero(edges)
        total_pixels = parking_space.shape[0] * parking_space.shape[1]
        edge_ratio = edge_pixels / total_pixels if total_pixels else 0

        is_occupied = edge_ratio > EDGE_THRESHOLD

        if is_occupied:
            status = "Occupied"
            color = (0, 0, 255)
        else:
            status = "Open"
            color = (0, 255, 0)
            available += 1

        results.append(
            {
                "id": index,
                "space": index,
                "status": status,
                "edge_ratio": round(edge_ratio, 4),
                "x": x1,
                "y": y1,
                "w": box_width,
                "h": box_height,
            }
        )

        cv2.rectangle(display, (x1, y1), (x2, y2), color, 2)
        cv2.putText(
            display,
            f"{index}: {status}",
            (x1, max(y1 - 7, 20)),
            cv2.FONT_HERSHEY_SIMPLEX,
            0.45,
            color,
            2,
        )

    total = len(spaces)
    occupied = sum(1 for item in results if item["status"] == "Occupied")

    cv2.putText(
        display,
        f"Available: {available}/{total}",
        (20, 35),
        cv2.FONT_HERSHEY_SIMPLEX,
        1,
        (255, 0, 0),
        2,
    )

    status_data = {
        "available": available,
        "occupied": occupied,
        "total": total,
        "updated_at": datetime.now().isoformat(timespec="seconds"),
        "frame_width": frame_width,
        "frame_height": frame_height,
        "spaces": results,
    }

    return display, status_data


def _wait_or_stop(show_window, delay_ms, stop_event):
    if show_window:
        key = cv2.waitKey(delay_ms) & 0xFF
        return key in (ord("q"), ord("Q"))

    timeout = max(delay_ms, 1) / 1000.0

    if stop_event is not None:
        return stop_event.wait(timeout)

    time.sleep(timeout)
    return False


def run_detector(show_window=True, stop_event=None, spaces=None):
    video = cv2.VideoCapture(VIDEO_PATH)

    if not video.isOpened():
        raise FileNotFoundError(f"Could not open video: {VIDEO_PATH}")

    fps = video.get(cv2.CAP_PROP_FPS) or 24
    delay_ms = max(1, int(1000 / fps))

    try:
        success, first_frame = video.read()

        if not success:
            raise RuntimeError("Could not read the first video frame.")

        save_image_safely(first_frame, FRAME_PATH)

        if spaces is None:
            spaces = load_spaces()

        if spaces is None:
            if not show_window:
                raise RuntimeError(
                    "No parking spaces saved. Open the dashboard to mark stalls."
                )

            spaces = generate_spaces_from_rows(first_frame)

            if not preview_spaces(first_frame, spaces):
                raise RuntimeError("Generated spaces were not saved.")

            save_spaces(spaces)
            print(f"Saved coordinates to: {SPACES_PATH}")
        else:
            print(f"Loaded {len(spaces)} saved parking spaces.")

        video.set(cv2.CAP_PROP_POS_FRAMES, 0)

        frame_number = 0
        failed_reads = 0

        print("Video detector is running.")

        if show_window:
            print("Press Q in the video window to stop.")

        while stop_event is None or not stop_event.is_set():
            success, frame = video.read()

            if not success:
                failed_reads += 1

                if failed_reads > MAX_READ_FAILURES:
                    raise RuntimeError("Could not read video frames.")

                video.set(cv2.CAP_PROP_POS_FRAMES, 0)
                continue

            failed_reads = 0
            display, status_data = analyze_frame(frame, spaces)

            if frame_number % UPDATE_EVERY_N_FRAMES == 0:
                save_json_safely(status_data, STATUS_PATH)
                save_image_safely(frame, LIVE_PATH)

            if show_window:
                cv2.imshow("Live Parking Monitor", display)

            frame_number += 1

            if _wait_or_stop(show_window, delay_ms, stop_event):
                break

    finally:
        video.release()

        if show_window:
            cv2.destroyAllWindows()


if __name__ == "__main__":
    run_detector(show_window=True)
