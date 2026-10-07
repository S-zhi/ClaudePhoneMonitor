#!/usr/bin/env python3
"""Clean the seven pet concept PNGs without modifying their original files.

Requires Pillow and NumPy. Run from any directory; defaults are relative to this
script's repository. All geometry comes from the source pixels: no redraw or
global pixel-grid snapping is performed.
"""

from __future__ import annotations

import argparse
from collections import defaultdict
from datetime import datetime, timezone
import hashlib
import json
from pathlib import Path
import tempfile

import numpy as np
from PIL import Image, ImageDraw, ImageFilter, ImageFont, __version__ as PILLOW_VERSION


ROOT = Path(__file__).resolve().parents[1]
ACTIONS = (
    "idle-rest", "working-typing", "waiting-point", "finish-cheer",
    "error-alert", "offline-rest", "usage-ball",
)

# Source centroids describe the pigments in these v1 AI outputs. Output colors
# are explicit design colors; nearest output-color matching would split the
# textured gray/green regions into unintended patches.
BODY = ("body", (217, 115, 82), "#D97757")
EYES = ("eyes", (24, 20, 19), "#1E1917")
PALETTES = {
    "working-typing": (
        BODY, EYES,
        ("computer-light", (150, 151, 158), "#A6A3A0"),
        ("computer-dark", (88, 90, 97), "#686665"),
    ),
    "error-alert": (
        BODY, EYES, ("alert", (195, 72, 70), "#C5524F"),
    ),
    "offline-rest": (
        ("body", (103, 113, 131), "#6C7685"),
        ("eyes", (24, 25, 28), "#1E1917"),
    ),
    "usage-ball": (
        BODY, EYES,
        ("ball-light", (162, 190, 143), "#A5C595"),
        ("ball-dark", (123, 145, 103), "#8CAB7B"),
    ),
}


def sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def relative_path(path: Path) -> str:
    try:
        return path.resolve().relative_to(ROOT).as_posix()
    except ValueError:
        return str(path.resolve())


def hex_rgb(value: str) -> tuple[int, int, int]:
    return tuple(int(value[i:i + 2], 16) for i in (1, 3, 5))


def components(mask: np.ndarray) -> list[dict]:
    """Find 4-connected components with row runs, avoiding optional SciPy."""
    parent = [0]
    runs = []
    previous = []

    def find(label):
        while parent[label] != label:
            parent[label] = parent[parent[label]]
            label = parent[label]
        return label

    for y, row in enumerate(mask):
        changes = np.flatnonzero(np.diff(np.r_[False, row, False]))
        current = []
        for left, right in zip(changes[::2], changes[1::2]):
            left, right = int(left), int(right)
            label = len(parent)
            parent.append(label)
            for old_left, old_right, old_label in previous:
                if old_right <= left:
                    continue
                if old_left >= right:
                    break
                root, old_root = find(label), find(old_label)
                if root != old_root:
                    parent[old_root] = root
            current.append((left, right, label))
            runs.append((y, left, right, label))
        previous = current

    grouped = defaultdict(list)
    for y, left, right, label in runs:
        grouped[find(label)].append((y, left, right))
    result = []
    for spans in grouped.values():
        result.append({
            "area": sum(right - left for _, left, right in spans),
            "bbox": [min(left for _, left, _ in spans), spans[0][0],
                     max(right for _, _, right in spans), spans[-1][0] + 1],
            "spans": spans,
        })
    return sorted(result, key=lambda item: item["area"], reverse=True)


def remove_small(mask: np.ndarray, minimum_area: int) -> tuple[np.ndarray, int]:
    result = np.zeros_like(mask)
    for component in components(mask):
        if component["area"] >= minimum_area:
            for y, left, right in component["spans"]:
                result[y, left:right] = True
    return result, int(np.count_nonzero(mask & ~result))


def morph(mask: np.ndarray, size: int, *, close: bool = False) -> np.ndarray:
    image = Image.fromarray(mask.astype(np.uint8) * 255)
    filters = (ImageFilter.MaxFilter, ImageFilter.MinFilter) if close else (
        ImageFilter.MinFilter, ImageFilter.MaxFilter)
    for filter_type in filters:
        image = image.filter(filter_type(size))
    return np.array(image) != 0


def neighbor_counts(mask: np.ndarray) -> np.ndarray:
    padded = np.pad(mask.astype(np.uint8), 1)
    height, width = mask.shape
    return sum(padded[y:y + height, x:x + width]
               for y in range(3) for x in range(3))


def clean_regions(pixels: np.ndarray, mask: np.ndarray, palette: tuple,
                  filter_size: int, minimum_area: int) -> np.ndarray:
    rgb = pixels[:, :, :3].astype(np.int32)
    distances = []
    for _, source_rgb, _ in palette:
        distances.append(np.sum((rgb - np.array(source_rgb)) ** 2, axis=2))
    original_labels = np.argmin(np.stack(distances), axis=0) + 1
    labels = np.zeros(mask.shape, dtype=np.uint8)
    for index in range(1, len(palette) + 1):
        region = morph((original_labels == index) & mask, filter_size)
        region, _ = remove_small(region, minimum_area)
        labels[region & mask] = index

    # Restore only the narrow gaps from region opening. Local label votes remove
    # the tiny dark/red/green fringe pixels without painting over retained eyes
    # or the computer/ball. An isolated component without a surviving pigment
    # is a noise remnant, so leave it transparent.
    for _ in range(filter_size * 4):
        missing = mask & (labels == 0)
        if not np.any(missing):
            break
        votes = np.stack([neighbor_counts(labels == index)
                          for index in range(1, len(palette) + 1)])
        reachable = missing & (votes.max(axis=0) > 0)
        if not np.any(reachable):
            break
        winners = votes.argmax(axis=0) + 1
        labels[reachable] = winners[reachable]
    return labels


def inspect_output(path: Path, palette: tuple, canvas_size: int,
                   longest_edge: int) -> dict:
    with Image.open(path) as image:
        if image.mode != "RGBA" or image.size != (canvas_size, canvas_size):
            raise ValueError(f"Unexpected image format: {path}")
        pixels = np.array(image)
        alpha = pixels[:, :, 3]
        values = np.unique(alpha).tolist()
        bbox = image.getchannel("A").getbbox()
        if values != [0, 255] or bbox is None:
            raise ValueError(f"Expected binary transparency in {path}: {values}")
        colors = sorted({tuple(rgb) for rgb in pixels[alpha == 255, :3].tolist()})
        allowed = {hex_rgb(entry[2]) for entry in palette}
        if not set(colors) <= allowed:
            raise ValueError(f"Colors outside the palette in {path}")
        margins = [bbox[0], bbox[1], canvas_size - bbox[2], canvas_size - bbox[3]]
        if min(margins) < canvas_size * 0.1:
            raise ValueError(f"Insufficient transparent margin in {path}")
        if max(bbox[2] - bbox[0], bbox[3] - bbox[1]) != longest_edge:
            raise ValueError(f"Incorrect longest edge in {path}")
        if abs(bbox[0] - (canvas_size - bbox[2])) > 1 or abs(
                bbox[1] - (canvas_size - bbox[3])) > 1:
            raise ValueError(f"The output is not centered: {path}")
        if np.any(pixels[alpha == 0, :3]):
            raise ValueError(f"Transparent pixels contain hidden color in {path}")
        return {
            "actual_size": list(image.size), "mode": image.mode,
            "rgba": True, "alpha_extrema": [int(alpha.min()), int(alpha.max())],
            "alpha_values": values, "alpha_bbox": list(bbox), "bbox": list(bbox),
            "transparent_pixel_count": int(np.count_nonzero(alpha == 0)),
            "opaque_pixel_count": int(np.count_nonzero(alpha == 255)),
            "margin_pixels": margins,
            "opaque_colors": ["#%02X%02X%02X" % color for color in colors],
            "opaque_color_count": len(colors),
            "visible_components": [{"area": c["area"], "bbox": c["bbox"]}
                                   for c in components(alpha == 255)],
            "sha256": sha256(path),
            "checks": {
                "size": "passed", "rgba": "passed", "binary_alpha": "passed",
                "palette": "passed", "transparent_margin_10_percent": "passed",
                "longest_edge": "passed", "centered": "passed",
                "zero_rgb_in_transparent_pixels": "passed",
            },
        }


def prepare(action: str, args: argparse.Namespace, processed_at: str) -> dict:
    source = args.source_dir / f"{action}-v1.png"
    output = args.output_dir / f"{action}-clean.png"
    if source.resolve() == output.resolve():
        raise ValueError("Refusing to overwrite a source image")
    source_hash = sha256(source)
    with Image.open(source) as image:
        source_size, source_mode = list(image.size), image.mode
        pixels = np.array(image.convert("RGBA"))
    raw_mask = pixels[:, :, 3] >= args.alpha_threshold
    mask = morph(raw_mask, args.filter_size)
    mask = morph(mask, args.filter_size, close=True)
    mask, removed_alpha_pixels = remove_small(mask, args.minimum_area)
    palette = PALETTES.get(action, (BODY, EYES))
    labels = clean_regions(pixels, mask, palette, args.filter_size, args.minimum_area)
    cleaned = np.zeros_like(pixels)
    for index, (_, _, color) in enumerate(palette, start=1):
        cleaned[labels == index] = (*hex_rgb(color), 255)
    image = Image.fromarray(cleaned)
    source_bbox = image.getchannel("A").getbbox()
    if source_bbox is None:
        raise ValueError(f"Cleanup removed all pixels from {source}")
    crop = image.crop(source_bbox)
    longest_edge = round(args.canvas_size * args.occupancy)
    scale = longest_edge / max(crop.size)
    resized_size = tuple(round(edge * scale) for edge in crop.size)
    crop = crop.resize(resized_size, Image.Resampling.NEAREST)
    result = Image.new("RGBA", (args.canvas_size, args.canvas_size), (0, 0, 0, 0))
    offset = tuple((args.canvas_size - edge) // 2 for edge in crop.size)
    result.paste(crop, offset)
    result.save(output, format="PNG", optimize=True)
    if sha256(source) != source_hash:
        raise RuntimeError(f"Source changed during preparation: {source}")
    metadata = inspect_output(output, palette, args.canvas_size, longest_edge)
    processing = {
        "method": "python-pillow-numpy-technical-cleanup",
        "processed_at": processed_at,
        "script_path": relative_path(Path(__file__)),
        "script_sha256": sha256(Path(__file__)),
        "runtime_versions": {"Pillow": PILLOW_VERSION, "NumPy": np.__version__},
        "parameters": {
            "canvas_size": args.canvas_size, "longest_edge_occupancy": args.occupancy,
            "alpha_threshold": args.alpha_threshold, "filter_size": args.filter_size,
            "minimum_component_area": args.minimum_area, "resize": "NEAREST",
        },
        "source_size": source_size, "source_mode": source_mode,
        "source_sha256": source_hash, "source_cleaned_bbox": list(source_bbox),
        "resized_subject_size": list(resized_size), "canvas_offset": list(offset),
        "removed_disconnected_alpha_pixels": removed_alpha_pixels,
        "palette": [{"role": role, "source_centroid": list(seed), "color": color}
                    for role, seed, color in palette],
        "notes": (
            "Original PNG retained byte-for-byte. Threshold source alpha, apply "
            "3px rectangular opening/closing and remove small connected noise. "
            "Map source pigment regions to fixed flat colors, remove tiny region "
            "fringes and fill narrow cleanup gaps with local color votes. "
            "Preserve source pose, silhouette, eyes and props; crop the complete "
            "visible group, scale with nearest-neighbor, and center on transparent "
            "RGBA. No global pixel-grid snapping, redraw or AI generation."
        ),
        "reproduce_command": "python3 scripts/prepare-pet-assets.py",
        **metadata,
    }
    return {
        "action_id": action, "source_image_path": relative_path(source),
        "processed_image_path": relative_path(output), "image_path": relative_path(output),
        "script_path": processing["script_path"], "processed_at": processed_at,
        "method": processing["method"], "processing": processing, **metadata,
    }


def make_contact_sheet(records: list[dict], output: Path):
    columns, cell_width, cell_height, thumbnail_size = 4, 320, 344, 288
    rows = (len(records) + columns - 1) // columns
    sheet = Image.new("RGB", (columns * cell_width, rows * cell_height), "#25201E")
    draw = ImageDraw.Draw(sheet)
    font = ImageFont.load_default(size=17)
    for index, record in enumerate(records):
        x, y = index % columns * cell_width, index // columns * cell_height
        with Image.open(ROOT / record["processed_image_path"]) as image:
            thumbnail = image.resize((thumbnail_size, thumbnail_size), Image.Resampling.NEAREST)
            sheet.paste(thumbnail, (x + (cell_width - thumbnail_size) // 2, y + 8), thumbnail)
        draw.text((x + cell_width // 2, y + 310), record["action_id"],
                  font=font, fill="#FFFFFF", anchor="mm")
    output.parent.mkdir(parents=True, exist_ok=True)
    sheet.save(output, format="PNG", optimize=True)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source-dir", type=Path, default=ROOT / "docs/pet-assets/images")
    parser.add_argument("--output-dir", type=Path, default=ROOT / "docs/pet-assets/images")
    parser.add_argument("--metadata", type=Path, default=Path(tempfile.gettempdir()) / "issue8-cleanup-results.json")
    parser.add_argument("--contact-sheet", type=Path, default=ROOT / "docs/pet-assets/contact-sheet.png")
    parser.add_argument("--actions", choices=ACTIONS, nargs="+", default=list(ACTIONS))
    parser.add_argument("--canvas-size", type=int, default=1024)
    parser.add_argument("--occupancy", type=float, default=0.7)
    parser.add_argument("--alpha-threshold", type=int, default=224)
    parser.add_argument("--filter-size", type=int, default=3)
    parser.add_argument("--minimum-area", type=int, default=256)
    args = parser.parse_args()
    if args.canvas_size <= 0 or not 0.1 <= args.occupancy <= 0.8:
        parser.error("Canvas size must be positive and occupancy between 0.1 and 0.8")
    if not 1 <= args.alpha_threshold <= 255 or args.minimum_area < 1:
        parser.error("Alpha threshold must be 1–255 and minimum area positive")
    if args.filter_size < 1 or args.filter_size % 2 == 0:
        parser.error("Filter size must be a positive odd integer")
    args.output_dir.mkdir(parents=True, exist_ok=True)
    processed_at = datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")
    records = [prepare(action, args, processed_at) for action in args.actions]
    make_contact_sheet(records, args.contact_sheet)
    args.metadata.parent.mkdir(parents=True, exist_ok=True)
    args.metadata.write_text(json.dumps(records, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    print(f"Prepared {len(records)} PNGs; all export checks passed.")
    for record in records:
        print(f"{record['action_id']}: {record['actual_size']} {record['mode']} "
              f"bbox={record['alpha_bbox']} colors={record['opaque_color_count']} "
              f"components={len(record['visible_components'])}")
    print(f"Metadata: {args.metadata}")
    print(f"Contact sheet: {args.contact_sheet}")


if __name__ == "__main__":
    main()
