#!/usr/bin/env python3
"""Technically clean the standalone Usage soccer ball, preserving source geometry.

Requires Pillow and NumPy. The original PNG and seven-pose ledger are untouched.
This performs alpha/color cleanup and nearest-neighbor scaling, without redraw,
grid snapping, synthesized panels, or a manufactured outline.
"""

from __future__ import annotations

import argparse
from datetime import datetime, timezone
import importlib.util
import json
from pathlib import Path
import shutil
import tempfile

import numpy as np
from PIL import Image, __version__ as PILLOW_VERSION


ROOT = Path(__file__).resolve().parents[1]
HELPER_PATH = ROOT / "scripts/prepare-pet-assets.py"
HELPER_SPEC = importlib.util.spec_from_file_location("pet_asset_cleanup", HELPER_PATH)
HELPER = importlib.util.module_from_spec(HELPER_SPEC)
HELPER_SPEC.loader.exec_module(HELPER)

# Actual source pigments, sampled before flattening. A missing source pigment
# stays absent: assigning these roles does not paint a new border or panel.
PALETTE = (
    ("surface", (168, 196, 152), "#A5C595"),
    ("panels", (136, 161, 120), "#8CAB7B"),
    ("outline", (85, 109, 71), "#526F48"),
)


def prepare(args: argparse.Namespace) -> dict:
    if args.source.resolve() in (args.output.resolve(), args.runtime_output.resolve()):
        raise ValueError("Refusing to overwrite the original source")
    source_hash = HELPER.sha256(args.source)
    with Image.open(args.source) as image:
        source_size, source_mode = list(image.size), image.mode
        pixels = np.array(image.convert("RGBA"))
    raw_mask = pixels[:, :, 3] >= args.alpha_threshold
    mask = HELPER.morph(raw_mask, args.filter_size)
    mask = HELPER.morph(mask, args.filter_size, close=True)
    components = HELPER.components(mask)
    if not components:
        raise ValueError("Source has no opaque ball")
    mask = np.zeros_like(mask)
    for y, left, right in components[0]["spans"]:
        mask[y, left:right] = True
    labels = HELPER.clean_regions(pixels, mask, PALETTE, args.filter_size, args.minimum_area)
    cleaned = np.zeros_like(pixels)
    for index, (_, _, color) in enumerate(PALETTE, start=1):
        cleaned[labels == index] = (*HELPER.hex_rgb(color), 255)
    image = Image.fromarray(cleaned)
    source_bbox = image.getchannel("A").getbbox()
    if source_bbox is None:
        raise ValueError("Cleanup removed the ball")
    crop = image.crop(source_bbox)
    source_ratio = crop.width / crop.height
    if not 0.95 <= source_ratio <= 1.05:
        raise ValueError(f"Source ball is not near-square: {source_ratio:.6f}; refusing to reshape it")
    scale = args.longest_edge / max(crop.size)
    resized_size = tuple(round(edge * scale) for edge in crop.size)
    crop = crop.resize(resized_size, Image.Resampling.NEAREST)
    result = Image.new("RGBA", (args.canvas_size, args.canvas_size), (0, 0, 0, 0))
    offset = tuple((args.canvas_size - edge) // 2 for edge in crop.size)
    result.paste(crop, offset)
    args.output.parent.mkdir(parents=True, exist_ok=True)
    result.save(args.output, format="PNG", optimize=True)
    if HELPER.sha256(args.source) != source_hash:
        raise RuntimeError("Original source changed during cleanup")
    metadata = HELPER.inspect_output(args.output, PALETTE, args.canvas_size, args.longest_edge)
    if len(metadata["visible_components"]) != 1:
        raise ValueError("Expected one complete, connected ball")
    bbox = metadata["alpha_bbox"]
    output_ratio = (bbox[2] - bbox[0]) / (bbox[3] - bbox[1])
    if not 0.95 <= output_ratio <= 1.05:
        raise ValueError("Cleaned ball is not near-square")
    metadata["bbox_aspect_ratio"] = output_ratio
    metadata["checks"]["near_square_ball"] = "passed"
    metadata["checks"]["single_connected_ball"] = "passed"
    args.runtime_output.parent.mkdir(parents=True, exist_ok=True)
    shutil.copyfile(args.output, args.runtime_output)
    if args.runtime_output.read_bytes() != args.output.read_bytes():
        raise RuntimeError("Runtime copy differs from clean PNG")
    metadata["checks"]["runtime_copy_matches"] = "passed"
    processed_at = datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")
    return {
        "prop_id": "usage-soccer-ball",
        "source_image_path": HELPER.relative_path(args.source),
        "processed_image_path": HELPER.relative_path(args.output),
        "runtime_asset_path": HELPER.relative_path(args.runtime_output),
        "processing": {
            "method": "python-pillow-numpy-technical-cleanup",
            "processed_at": processed_at,
            "script_path": HELPER.relative_path(Path(__file__)),
            "script_sha256": HELPER.sha256(Path(__file__)),
            "helper_script_path": HELPER.relative_path(HELPER_PATH),
            "helper_script_sha256": HELPER.sha256(HELPER_PATH),
            "runtime_versions": {"Pillow": PILLOW_VERSION, "NumPy": np.__version__},
            "parameters": {
                "canvas_size": args.canvas_size, "longest_edge": args.longest_edge,
                "alpha_threshold": args.alpha_threshold, "filter_size": args.filter_size,
                "minimum_color_region_area": args.minimum_area, "resize": "NEAREST",
                "component_selection": "largest source-alpha component",
            },
            "source_size": source_size, "source_mode": source_mode,
            "source_sha256": source_hash, "source_cleaned_bbox": list(source_bbox),
            "source_bbox_aspect_ratio": source_ratio,
            "resized_subject_size": list(resized_size), "canvas_offset": list(offset),
            "removed_alpha_pixels": int(np.count_nonzero(raw_mask & ~mask)),
            "palette": [{"role": role, "source_centroid": list(seed), "color": color}
                        for role, seed, color in PALETTE],
            "authorization_source": "user explicitly authorized Python technical cleanup in this chat",
            "review_status": "pending",
            "notes": (
                "Preserve the source circle silhouette and panel layout. Remove alpha/color noise, "
                "flatten existing pigments to fixed greens, scale isotropically with nearest-neighbor "
                "and center on transparent RGBA. No redraw, aspect-ratio stretching, synthesized "
                "outline/panels or forced pixel-grid reconstruction. Original PNG retained unchanged."
            ),
            "reproduce_command": "python3 scripts/prepare-usage-soccer-ball.py",
            **metadata,
        },
        **metadata,
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source", type=Path, default=ROOT / "docs/pet-assets/images/usage-soccer-ball-v1.png")
    parser.add_argument("--output", type=Path, default=ROOT / "docs/pet-assets/images/usage-soccer-ball-clean.png")
    parser.add_argument("--runtime-output", type=Path,
                        default=ROOT / "apps/android/src/main/assets/clawd/props/usage-soccer-ball.png")
    parser.add_argument("--metadata", type=Path,
                        default=Path(tempfile.gettempdir()) / "issue8-soccer-ball-cleanup.json")
    parser.add_argument("--canvas-size", type=int, default=1024)
    parser.add_argument("--longest-edge", type=int, default=716)
    parser.add_argument("--alpha-threshold", type=int, default=224)
    parser.add_argument("--filter-size", type=int, default=3)
    parser.add_argument("--minimum-area", type=int, default=256)
    args = parser.parse_args()
    if args.canvas_size < 1 or not 1 <= args.longest_edge <= args.canvas_size * 0.8:
        parser.error("The longest edge must fit within 80% of a positive canvas")
    if not 1 <= args.alpha_threshold <= 255 or args.minimum_area < 1:
        parser.error("Alpha threshold must be 1–255 and minimum area positive")
    if args.filter_size < 1 or args.filter_size % 2 == 0:
        parser.error("Filter size must be a positive odd integer")
    record = prepare(args)
    args.metadata.parent.mkdir(parents=True, exist_ok=True)
    args.metadata.write_text(json.dumps(record, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(f"Prepared one ball: bbox={record['alpha_bbox']} ratio={record['bbox_aspect_ratio']:.6f} "
          f"palette={record['opaque_colors']}")
    print(f"Metadata: {args.metadata}")


if __name__ == "__main__":
    main()
