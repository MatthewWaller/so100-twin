# /// script
# requires-python = ">=3.10"
# dependencies = ["pyarrow>=14", "numpy>=1.26"]
# ///
"""Convert LeRobot (v2.x) SO-100 episodes into compact JSON for the SO-100 Digital Twin viewer.

Reads a local LeRobot dataset directory (meta/info.json + data/*.parquet + optional videos/*.mp4)
strictly read-only, and writes:

    <out>/<id>.json          joint series (recorded values + URDF radians) for one episode
    <out>/videos/<id>.mp4    optional H.264 re-encode of one camera stream (needs ffmpeg)
    <out>/index.json         episode list consumed by the app (merged, not overwritten)

Usage (with uv, no venv needed):

    uv run tools/convert_lerobot.py \
        --dataset ~/.cache/huggingface/lerobot/<user>/<repo> \
        --episodes 0 3 \
        --calibration ~/.cache/huggingface/lerobot/calibration/robots/so100_follower/<id>.json \
        --out public/episodes

See README.md ("Joint mapping") for how dataset values become URDF joint angles.
"""

from __future__ import annotations

import argparse
import json
import math
import shutil
import subprocess
from pathlib import Path

import numpy as np
import pyarrow.parquet as pq

JOINTS = ["shoulder_pan", "shoulder_lift", "elbow_flex", "wrist_flex", "wrist_roll", "gripper"]

# STS3215 servos: 4096 ticks per revolution. LeRobot's calibration pose reads 2047 ("half turn").
TICKS = 4096
HALF_TURN = 2047
TICK_RAD = 2 * math.pi / TICKS

# ---------------------------------------------------------------------------------------------
# Joint mapping: dataset value -> URDF joint angle (radians) for TheRobotStudio SO100/so100.urdf.
#
# The URDF's all-zero pose is the folded "rest" pose (upper arm back on its stop, forearm folded
# forward over it, jaw closed). Each joint maps as
#
#     q_urdf = sign * (angle_rad - ref_rad) + offset_rad
#
# where angle_rad is the servo angle recovered from the dataset and ref is the servo reading that
# corresponds to URDF zero. Signs/offsets were fitted by eye against the front-camera video of
# the author's own arm, so treat them as calibrated-to-this-arm, not universal.
# ---------------------------------------------------------------------------------------------

# LeRobot >= 0.2 ("so100_follower", names like "shoulder_pan.pos"): values are normalized.
# Body joints use RANGE_M100_100 over [range_min, range_max]; gripper uses RANGE_0_100.
# `ref` is either "mid" (calibration pose, raw 2047), "min" or "max" (end of recorded range).
NORMALIZED_MAP = {
    "shoulder_pan": dict(sign=-1.0, ref="mid", offset_deg=0.0),
    "shoulder_lift": dict(sign=1.0, ref="min", offset_deg=0.0),
    "elbow_flex": dict(sign=1.0, ref="max", offset_deg=0.0),
    "wrist_flex": dict(sign=1.0, ref="mid", offset_deg=0.0),
    "wrist_roll": dict(sign=1.0, ref="mid", offset_deg=0.0),
    "gripper": dict(sign=1.0, ref="min", offset_deg=0.0),
}

# Legacy LeRobot (< 0.2, robot_type "so100", names like "main_shoulder_pan"): values are degrees
# with zero at the "arm fully extended horizontally" calibration pose.
LEGACY_MAP = {
    "shoulder_pan": dict(sign=-1.0, offset_deg=0.0),
    "shoulder_lift": dict(sign=-1.0, offset_deg=180.0),
    "elbow_flex": dict(sign=1.0, offset_deg=-180.0),
    "wrist_flex": dict(sign=1.0, offset_deg=0.0),
    "wrist_roll": dict(sign=1.0, offset_deg=0.0),
    "gripper": dict(sign=1.0, offset_deg=0.0),
}

# Used only when a normalized dataset is converted without --calibration: a generic ~200 degree
# span centred on the calibration pose. The 3D pose will be approximate.
DEFAULT_RANGE = {j: (HALF_TURN - 1130, HALF_TURN + 1130) for j in JOINTS}
DEFAULT_RANGE["wrist_roll"] = (0, 4095)
DEFAULT_RANGE["gripper"] = (2030, 3430)


def detect_convention(names: list[str]) -> str:
    if all(n.endswith(".pos") for n in names):
        return "normalized"
    if all(n.startswith("main_") or n.startswith("follower_") for n in names):
        return "legacy_degrees"
    raise SystemExit(f"Unrecognized joint names {names}; expected SO-100 LeRobot features.")


def canonical(name: str) -> str:
    n = name.removesuffix(".pos")
    for prefix in ("main_", "follower_"):
        n = n.removeprefix(prefix)
    if n not in JOINTS:
        raise SystemExit(f"Unknown joint '{name}'")
    return n


def to_urdf_normalized(values: np.ndarray, joint: str, calib: dict) -> np.ndarray:
    lo, hi = calib[joint]
    if joint == "gripper":
        raw = lo + values / 100.0 * (hi - lo)
    else:
        raw = lo + (values + 100.0) / 200.0 * (hi - lo)
    m = NORMALIZED_MAP[joint]
    ref = {"mid": HALF_TURN, "min": lo, "max": hi}[m["ref"]]
    return m["sign"] * (raw - ref) * TICK_RAD + math.radians(m["offset_deg"])


def to_urdf_legacy(values: np.ndarray, joint: str) -> np.ndarray:
    m = LEGACY_MAP[joint]
    return np.radians(m["sign"] * values + m["offset_deg"])


def load_calibration(path: Path | None) -> tuple[dict, str]:
    if path is None:
        return DEFAULT_RANGE, "default (approximate)"
    data = json.loads(path.expanduser().read_text())
    return {j: (data[j]["range_min"], data[j]["range_max"]) for j in JOINTS}, path.name


def encode_video(src: Path, dst: Path, width: int) -> bool:
    if shutil.which("ffmpeg") is None:
        print("  ffmpeg not found; skipping video")
        return False
    dst.parent.mkdir(parents=True, exist_ok=True)
    cmd = [
        "ffmpeg", "-y", "-loglevel", "error", "-i", str(src),
        "-vf", f"scale={width}:-2", "-c:v", "libx264", "-preset", "slow", "-crf", "23",
        "-pix_fmt", "yuv420p", "-movflags", "+faststart", "-an", str(dst),
    ]
    subprocess.run(cmd, check=True)
    # The viewer presents frames by index from a JPEG sequence instead of playing the mp4,
    # so playback stays locked to the arm in every browser (no autoplay or seek quirks).
    frames = dst.with_suffix("")
    frames.mkdir(exist_ok=True)
    subprocess.run([
        "ffmpeg", "-y", "-loglevel", "error", "-i", str(dst),
        "-vf", "scale=480:-2", "-q:v", "5", "-start_number", "0", str(frames / "%04d.jpg"),
    ], check=True)
    return True


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--dataset", required=True, type=Path, help="local LeRobot dataset root")
    ap.add_argument("--episodes", type=int, nargs="+", default=[0])
    ap.add_argument("--calibration", type=Path, help="LeRobot follower calibration JSON (normalized datasets)")
    ap.add_argument("--out", type=Path, default=Path("public/episodes"))
    ap.add_argument("--camera", help="video key, e.g. observation.images.front (default: first)")
    ap.add_argument("--no-video", action="store_true")
    ap.add_argument("--video-width", type=int, default=640)
    ap.add_argument("--prefix", help="id prefix (default: dataset folder name)")
    ap.add_argument("--label", help="human-readable label prefix")
    ap.add_argument("--repo-id", help="Hub repo id to record as the source (default: <parent>/<name>)")
    args = ap.parse_args()

    root = args.dataset.expanduser().resolve()
    info = json.loads((root / "meta" / "info.json").read_text())
    feats = info["features"]
    names = feats["observation.state"]["names"]
    convention = detect_convention(names)
    joints = [canonical(n) for n in names]
    calib, calib_name = load_calibration(args.calibration)
    if convention == "legacy_degrees":
        calib_name = "n/a (dataset stores degrees)"

    tasks = {}
    tasks_file = root / "meta" / "tasks.jsonl"
    if tasks_file.exists():
        for line in tasks_file.read_text().splitlines():
            if line.strip():
                t = json.loads(line)
                tasks[t["task_index"]] = t["task"]

    video_keys = [k for k, v in feats.items() if v.get("dtype") == "video"]
    camera = args.camera or (video_keys[0] if video_keys else None)
    prefix = args.prefix or root.name
    repo_id = args.repo_id or f"{root.parent.name}/{root.name}"
    args.out.mkdir(parents=True, exist_ok=True)

    index_path = args.out / "index.json"
    index = json.loads(index_path.read_text()) if index_path.exists() else {"episodes": []}

    for ep in args.episodes:
        chunk = ep // info.get("chunks_size", 1000)
        pq_path = root / info["data_path"].format(episode_chunk=chunk, episode_index=ep)
        table = pq.read_table(pq_path).to_pydict()
        state = np.asarray(table["observation.state"], dtype=np.float64)
        action = np.asarray(table["action"], dtype=np.float64) if "action" in table else None
        ts = np.asarray(table["timestamp"], dtype=np.float64)
        task = tasks.get(int(table["task_index"][0])) if "task_index" in table else None

        def series(arr: np.ndarray) -> dict:
            rec, urdf = {}, {}
            for i, j in enumerate(joints):
                col = arr[:, i]
                rec[j] = [round(float(x), 2) for x in col]
                q = to_urdf_legacy(col, j) if convention == "legacy_degrees" else to_urdf_normalized(col, j, calib)
                urdf[j] = [round(float(x), 4) for x in q]
            return {"recorded": rec, "urdf": urdf}

        ep_id = f"{prefix}-ep{ep}"
        video_rel = None
        if camera and not args.no_video:
            src = root / info["video_path"].format(episode_chunk=chunk, video_key=camera, episode_index=ep)
            if src.exists() and encode_video(src, args.out / "videos" / f"{ep_id}.mp4", args.video_width):
                video_rel = f"videos/{ep_id}.mp4"

        unit = "deg" if convention == "legacy_degrees" else "norm"
        doc = {
            "id": ep_id,
            "label": f"{args.label or prefix} · episode {ep}",
            "source": {
                "repo_id": repo_id,
                "episode_index": ep,
                "robot_type": info.get("robot_type"),
                "codebase_version": info.get("codebase_version"),
                "calibration": calib_name,
            },
            "task": task,
            "fps": info["fps"],
            "frames": len(ts),
            "timestamps": [round(float(t), 4) for t in ts],
            "convention": convention,
            "units": {
                j: ("% open" if j == "gripper" and unit == "norm" else ("deg" if unit == "deg" else "−100…100"))
                for j in joints
            },
            "joints": joints,
            "state": series(state),
            "action": series(action) if action is not None else None,
            "video": video_rel,
            "camera": camera if video_rel else None,
        }
        out_file = args.out / f"{ep_id}.json"
        out_file.write_text(json.dumps(doc, separators=(",", ":")))
        print(f"  wrote {out_file} ({out_file.stat().st_size / 1024:.0f} KB, {len(ts)} frames)"
              + (f" + {video_rel}" if video_rel else ""))

        entry = {"id": ep_id, "label": doc["label"], "file": f"{ep_id}.json", "task": task,
                 "frames": len(ts), "fps": info["fps"], "video": video_rel is not None}
        ids = [e["id"] for e in index["episodes"]]
        if ep_id in ids:
            index["episodes"][ids.index(ep_id)] = entry  # keep existing order
        else:
            index["episodes"].append(entry)

    index_path.write_text(json.dumps(index, indent=2) + "\n")
    print(f"  index: {index_path} ({len(index['episodes'])} episodes)")


if __name__ == "__main__":
    main()
