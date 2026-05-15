#!/usr/bin/env python3
import argparse
import contextlib
import json
import re
import sys
from pathlib import Path

import cv2
from ultralytics import YOLO


YOLO_CLASS_NAMES = {
    0: "person",
    15: "cat",
}


def parse_args():
    parser = argparse.ArgumentParser(description="Detect simple-nvr events in sampled frames.")
    parser.add_argument("--frame-dir", required=True, help="Directory containing sampled JPEG frames.")
    parser.add_argument("--min-confidence", type=float, default=0.5)
    parser.add_argument("--sample-every-seconds", type=float, default=10.0)
    parser.add_argument("--classes", nargs="+", default=["person", "cat"])
    parser.add_argument("--model", default="yolov8n.pt")
    return parser.parse_args()


def frame_index(frame_path):
    match = re.search(r"frame_(\d+)\.jpg$", frame_path.name)
    if not match:
        return 1
    return int(match.group(1))


def main():
    args = parse_args()
    wanted_classes = set(args.classes)
    frame_dir = Path(args.frame_dir)
    frames = sorted(frame_dir.glob("frame_*.jpg"))

    with contextlib.redirect_stdout(sys.stderr):
        model = YOLO(args.model)
    detections = []

    for frame_path in frames:
        image = cv2.imread(str(frame_path))
        if image is None:
            continue

        with contextlib.redirect_stdout(sys.stderr):
            results = model.predict(
                source=image,
                conf=args.min_confidence,
                classes=list(YOLO_CLASS_NAMES.keys()),
                verbose=False,
            )

        index = frame_index(frame_path)
        frame_timestamp_seconds = (index - 1) * args.sample_every_seconds

        for result in results:
            for box in result.boxes:
                class_id = int(box.cls[0])
                event_type = YOLO_CLASS_NAMES.get(class_id)
                if event_type not in wanted_classes:
                    continue

                detections.append({
                    "type": event_type,
                    "confidence": round(float(box.conf[0]), 4),
                    "colour": "unknown",
                    "framePath": str(frame_path),
                    "frameIndex": index,
                    "frameTimestampSeconds": frame_timestamp_seconds,
                })

    print(json.dumps({"detections": detections}, separators=(",", ":")))


if __name__ == "__main__":
    try:
        main()
    except Exception as exc:
        print(json.dumps({"error": str(exc)}), file=sys.stderr)
        sys.exit(1)
