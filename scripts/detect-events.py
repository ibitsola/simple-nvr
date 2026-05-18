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
    16: "dog",
}


def parse_args():
    parser = argparse.ArgumentParser(description="Detect simple-nvr events in sampled frames.")
    parser.add_argument("--frame-dir", required=True, help="Directory containing sampled JPEG frames.")
    parser.add_argument("--min-confidence", type=float, default=0.5)
    parser.add_argument("--sample-every-seconds", type=float, default=10.0)
    parser.add_argument("--classes", nargs="+", default=["person", "cat"])
    parser.add_argument("--include-all-classes", action="store_true")
    parser.add_argument("--model", default="yolov8n.pt")
    parser.add_argument("--imgsz", type=int, default=640)
    parser.add_argument("--motion-detection-enabled", action="store_true")
    parser.add_argument("--motion-min-area-percent", type=float, default=1.0)
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


def detect_motion(frames, min_area_percent):
    """
    Compare adjacent sampled frames using frame differencing.
    Returns (motion_detected, best_frame_path, analysis_dict).
    With only one frame, motion is assumed so YOLO still runs.
    """
    if len(frames) < 2:
        return True, frames[0] if frames else None, {
            "note": "single frame, assumed motion",
            "maxChangedPercent": 100.0,
            "frameCount": len(frames),
            "frames": [],
        }

    max_changed_pct = 0.0
    best_frame = frames[0]
    frame_analysis = []
    prev_blurred = None

    for frame_path in frames:
        img = cv2.imread(str(frame_path))
        if img is None:
            continue
        gray = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)
        blurred = cv2.GaussianBlur(gray, (21, 21), 0)

        if prev_blurred is not None:
            diff = cv2.absdiff(prev_blurred, blurred)
            _, thresh = cv2.threshold(diff, 25, 255, cv2.THRESH_BINARY)
            changed_pixels = int(cv2.countNonZero(thresh))
            total_pixels = blurred.shape[0] * blurred.shape[1]
            changed_pct = (changed_pixels / total_pixels) * 100.0
            frame_analysis.append({
                "frame": frame_path.name,
                "changedPercent": round(changed_pct, 3),
                "changedPixels": changed_pixels,
            })
            if changed_pct > max_changed_pct:
                max_changed_pct = changed_pct
                best_frame = frame_path

        prev_blurred = blurred

    return (max_changed_pct >= min_area_percent), best_frame, {
        "maxChangedPercent": round(max_changed_pct, 3),
        "minAreaPercent": min_area_percent,
        "frameCount": len(frames),
        "frames": frame_analysis,
    }


def main():
    args = parse_args()
    wanted_classes = set(args.classes)
    frame_dir = Path(args.frame_dir)
    frames = sorted(frame_dir.glob("frame_*.jpg"))

    result_extra = {}

    # Motion pre-check: fast frame differencing before loading the YOLO model.
    # If no meaningful motion exists in the sampled frames, skip YOLO entirely.
    if args.motion_detection_enabled:
        motion_detected, best_motion_frame, motion_analysis = detect_motion(
            frames, args.motion_min_area_percent
        )
        result_extra["motionDetected"] = motion_detected
        result_extra["motionAnalysis"] = motion_analysis
        if best_motion_frame is not None:
            idx = frame_index(best_motion_frame)
            result_extra["bestMotionFramePath"] = str(best_motion_frame)
            result_extra["bestMotionFrameTimestampSeconds"] = (idx - 1) * args.sample_every_seconds
        else:
            result_extra["bestMotionFramePath"] = None
            result_extra["bestMotionFrameTimestampSeconds"] = 0

        if not motion_detected:
            output = {"detections": []}
            output.update(result_extra)
            sys.stdout.write(json.dumps(output, separators=(",", ":")))
            sys.stdout.write("\n")
            return

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
                imgsz=args.imgsz,
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

    output = {"detections": detections}
    output.update(result_extra)
    sys.stdout.write(json.dumps(output, separators=(",", ":")))
    sys.stdout.write("\n")


if __name__ == "__main__":
    try:
        main()
    except Exception as exc:
        print(json.dumps({"error": str(exc)}), file=sys.stderr)
        sys.exit(1)
