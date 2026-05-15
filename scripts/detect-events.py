#!/usr/bin/env python3
import argparse
import contextlib
import json
import re
import sys
from pathlib import Path

import cv2


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
    parser.add_argument("--include-all-classes", action="store_true")
    parser.add_argument("--model", default="yolov8n.pt")
    return parser.parse_args()


def frame_index(frame_path):
    match = re.search(r"frame_(\d+)\.jpg$", frame_path.name)
    if not match:
        return 1
    return int(match.group(1))


def yolo_class_name(class_names, class_id):
    if isinstance(class_names, dict):
        return class_names.get(class_id, class_id)
    if isinstance(class_names, list) and 0 <= class_id < len(class_names):
        return class_names[class_id]
    return class_id


def main():
    args = parse_args()
    wanted_classes = set(args.classes)
    frame_dir = Path(args.frame_dir)
    frames = sorted(frame_dir.glob("frame_*.jpg"))

    # Ultralytics may print first-run setup/settings messages during import and
    # model load. Keep all third-party chatter away from stdout; Node parses
    # stdout as a single JSON object.
    with contextlib.redirect_stdout(sys.stderr):
        from ultralytics import YOLO
        model = YOLO(args.model)
    class_names = model.names
    detections = []

    for frame_path in frames:
        image = cv2.imread(str(frame_path))
        if image is None:
            continue

        with contextlib.redirect_stdout(sys.stderr):
            predict_classes = None if args.include_all_classes else list(YOLO_CLASS_NAMES.keys())
            results = model.predict(
                source=image,
                conf=args.min_confidence,
                classes=predict_classes,
                verbose=False,
            )

        index = frame_index(frame_path)
        frame_timestamp_seconds = (index - 1) * args.sample_every_seconds

        for result in results:
            for box in result.boxes:
                class_id = int(box.cls[0])
                event_type = YOLO_CLASS_NAMES.get(class_id) or str(yolo_class_name(class_names, class_id))
                if not args.include_all_classes and event_type not in wanted_classes:
                    continue

                detections.append({
                    "type": event_type,
                    "classId": class_id,
                    "confidence": round(float(box.conf[0]), 4),
                    "colour": "unknown",
                    "framePath": str(frame_path),
                    "frameIndex": index,
                    "frameTimestampSeconds": frame_timestamp_seconds,
                })

    sys.stdout.write(json.dumps({"detections": detections}, separators=(",", ":")))
    sys.stdout.write("\n")


if __name__ == "__main__":
    try:
        main()
    except Exception as exc:
        print(json.dumps({"error": str(exc)}), file=sys.stderr)
        sys.exit(1)
