"""
RHI Codec — Polychromatic Per-Element Character-Grid Image and Video Codec
Copyright (C) 2026 Jonathan T Laine

This program is free software: you can redistribute it and/or modify
it under the terms of the GNU Affero General Public License as published
by the Free Software Foundation, version 3.

Commercial licensing available. Contact: infinitegrok@gmail.com
Patent pending: US Application 64/014,800

Binary image/video format using braille-grid encoding with per-dot RGB color.
Designed for ultra-low-bandwidth transport over text and binary channels.

Wire format (v1):
  Header (12 bytes):
    magic:    4 bytes  "RHI\x01"
    cols:     2 bytes  uint16 LE
    rows:     2 bytes  uint16 LE
    flags:    1 byte   bit0=palette, bit1=delta, bit2=keyframe
    palette_size: 1 byte  0=no palette (direct RGB), 1-255=palette entries
    reserved: 2 bytes

  Palette (if flags.bit0, palette_size * 3 bytes):
    RGB triplets, palette_size entries

  Frame data (per cell, cols*rows cells):
    If no palette (direct RGB):
      braille_char: 1 byte  (code = char - 0x2800, max 0xFF)
      dot_mask:     1 byte  (which of 8 dots are active — redundant with braille but allows future extension)
      colors:       active_dots * 3 bytes  (only active dots get RGB, inactive skipped)

    If palette mode:
      braille_char: 1 byte
      dot_mask:     1 byte
      colors:       active_dots * 1 byte  (palette index per active dot)

  Delta frame (if flags.bit1):
    change_count: 2 bytes uint16 LE
    changes:      change_count * (2 + 1 + 1 + active*color_size) bytes
      row: 1 byte, col: 1 byte, braille_char: 1 byte, dot_mask: 1 byte, colors...

Usage:
  from rhi_codec import RHIEncoder, RHIDecoder

  # Encode
  enc = RHIEncoder(width=30)
  data = enc.encode_image("photo.jpg")
  with open("photo.rhi", "wb") as f: f.write(data)

  # Decode
  dec = RHIDecoder()
  grid = dec.decode(data)
  # grid is list of rows, each row is list of (braille_char, [8 colors or None])
"""

import struct
import io
from PIL import Image, ImageEnhance
import numpy as np

MAGIC = b'RHI\x01'
BRAILLE_BASE = 0x2800

# 6-dot braille (2×3 grid) — preferred embodiment
# A/B/C tested: 6-dot beats 8-dot on visual quality due to 2:3 aspect ratio
DOT_MAP_6 = [
    (0x01, 0x08),  # row 0: dot1, dot4
    (0x02, 0x10),  # row 1: dot2, dot5
    (0x04, 0x20),  # row 2: dot3, dot6
]

# 8-dot braille (2×4 grid) — alternative for max vertical resolution
DOT_MAP_8 = [
    (0x01, 0x08),  # row 0: dot1, dot4
    (0x02, 0x10),  # row 1: dot2, dot5
    (0x04, 0x20),  # row 2: dot3, dot6
    (0x40, 0x80),  # row 3: dot7, dot8
]

# Default to 6-dot
DOT_MAP = DOT_MAP_6
ELEM_COLS = 2
ELEM_ROWS = 3
ELEM_COUNT = 6

FLAG_PALETTE  = 0x01
FLAG_DELTA    = 0x02
FLAG_KEYFRAME = 0x04


def _otsu_threshold(luminances):
    """Compute Otsu's optimal threshold for a luminance array."""
    hist, _ = np.histogram(luminances, bins=256, range=(0, 256))
    hist = hist.astype(np.float64)
    total = hist.sum()
    if total == 0:
        return 128

    sum_total = np.dot(np.arange(256), hist)
    sum_bg = 0.0
    weight_bg = 0.0
    best_t = 0
    best_var = 0.0

    for t in range(256):
        weight_bg += hist[t]
        if weight_bg == 0:
            continue
        weight_fg = total - weight_bg
        if weight_fg == 0:
            break
        sum_bg += t * hist[t]
        mean_bg = sum_bg / weight_bg
        mean_fg = (sum_total - sum_bg) / weight_fg
        var_between = weight_bg * weight_fg * (mean_bg - mean_fg) ** 2
        if var_between > best_var:
            best_var = var_between
            best_t = t

    return best_t


class RHIEncoder:
    """Encode images/video to RHI binary format."""

    def __init__(self, width=30, threshold='otsu', preprocess=True,
                 all_dots=False, use_palette=True, contrast=1.3, dots=6):
        """
        Args:
            width: braille grid width in characters
            threshold: 'otsu', 'low' (5), or int value. Ignored if all_dots=True.
            preprocess: apply contrast enhancement before encoding
            all_dots: force all dots active per cell (max quality, larger file)
            use_palette: use indexed color palette (smaller file)
            contrast: contrast enhancement factor (1.0 = no change)
            dots: 6 (preferred, 2×3 grid) or 8 (2×4 grid)
        """
        self.width = width
        self.threshold_mode = threshold
        self.preprocess = preprocess
        self.all_dots = all_dots
        self.use_palette = use_palette
        self.contrast = contrast
        self.dots = dots
        if dots == 8:
            self.dot_map = DOT_MAP_8
            self.elem_cols = 2
            self.elem_rows = 4
            self.elem_count = 8
        else:
            self.dot_map = DOT_MAP_6
            self.elem_cols = 2
            self.elem_rows = 3
            self.elem_count = 6

    def _prepare_image(self, img, cols, rows):
        """Resize and optionally preprocess source image."""
        px_w, px_h = cols * self.elem_cols, rows * self.elem_rows
        img = img.convert('RGB').resize((px_w, px_h), Image.LANCZOS)

        if self.preprocess and self.contrast != 1.0:
            img = ImageEnhance.Contrast(img).enhance(self.contrast)

        return np.array(img)

    def _compute_threshold(self, pixels):
        """Compute the dot activation threshold."""
        if self.all_dots:
            return -1  # all dots active
        if self.threshold_mode == 'otsu':
            lum = 0.299 * pixels[:,:,0] + 0.587 * pixels[:,:,1] + 0.114 * pixels[:,:,2]
            return _otsu_threshold(lum.flatten())
        elif self.threshold_mode == 'low':
            return 5
        elif isinstance(self.threshold_mode, int):
            return self.threshold_mode
        return 20

    def _encode_grid(self, pixels, cols, rows):
        """Encode pixel array to braille grid with per-dot colors."""
        threshold = self._compute_threshold(pixels)
        grid = []

        for r in range(rows):
            row = []
            for c in range(cols):
                code = 0
                colors = []
                for dr in range(self.elem_rows):
                    for dc in range(self.elem_cols):
                        py = r * self.elem_rows + dr
                        px = c * self.elem_cols + dc
                        rgb = tuple(pixels[py, px])
                        lum = 0.299 * rgb[0] + 0.587 * rgb[1] + 0.114 * rgb[2]

                        if self.all_dots or lum > threshold:
                            code |= self.dot_map[dr][dc]
                            colors.append(rgb)
                        else:
                            colors.append(None)

                row.append((code, colors))
            grid.append(row)

        return grid

    def _build_palette(self, grid, rows, cols):
        """Build a color palette from the grid. Returns (palette, indexed_grid)."""
        # Collect all unique colors
        color_set = set()
        for row in grid:
            for code, colors in row:
                for c in colors:
                    if c is not None:
                        color_set.add(c)

        color_list = sorted(color_set)

        if len(color_list) <= 255:
            # Direct palette
            palette = color_list
            color_to_idx = {c: i for i, c in enumerate(palette)}
            return palette, color_to_idx

        # Too many colors — quantize to 255 using median cut approximation
        # Simple approach: k-means-ish with numpy
        all_colors = np.array(list(color_set), dtype=np.float32)
        # Random sample 255 centroids
        indices = np.random.choice(len(all_colors), min(255, len(all_colors)), replace=False)
        centroids = all_colors[indices].copy()

        # 3 iterations of k-means
        for _ in range(3):
            # Assign each color to nearest centroid
            dists = np.linalg.norm(all_colors[:, None, :] - centroids[None, :, :], axis=2)
            assignments = np.argmin(dists, axis=1)
            # Update centroids
            for k in range(len(centroids)):
                mask = assignments == k
                if mask.any():
                    centroids[k] = all_colors[mask].mean(axis=0)

        palette = [tuple(int(x) for x in c) for c in centroids]
        # Build lookup: each original color → nearest palette entry
        pal_arr = np.array(palette, dtype=np.float32)
        color_to_idx = {}
        for c in color_set:
            c_arr = np.array(c, dtype=np.float32)
            idx = int(np.argmin(np.linalg.norm(pal_arr - c_arr, axis=1)))
            color_to_idx[c] = idx

        return palette, color_to_idx

    def encode_image(self, source):
        """
        Encode an image to RHI binary format.

        Args:
            source: PIL Image, file path, or numpy array

        Returns:
            bytes: RHI binary data
        """
        if isinstance(source, str):
            img = Image.open(source)
        elif isinstance(source, np.ndarray):
            img = Image.fromarray(source)
        else:
            img = source

        aspect = img.height / img.width
        cols = self.width
        rows = max(1, round(cols * aspect * (self.elem_cols / self.elem_rows)))

        pixels = self._prepare_image(img, cols, rows)
        grid = self._encode_grid(pixels, cols, rows)

        return self._serialize(grid, cols, rows, is_keyframe=True)

    def encode_delta(self, prev_grid, curr_grid, cols, rows):
        """
        Encode a delta frame (only changed cells).

        Returns:
            bytes: RHI delta frame binary data
        """
        changes = []
        for r in range(rows):
            for c in range(cols):
                if prev_grid[r][c] != curr_grid[r][c]:
                    changes.append((r, c, curr_grid[r][c][0], curr_grid[r][c][1]))

        # If >60% changed, send as keyframe instead
        total_cells = rows * cols
        if len(changes) > total_cells * 0.6:
            return self._serialize(curr_grid, cols, rows, is_keyframe=True)

        return self._serialize_delta(changes, cols, rows)

    def _serialize(self, grid, cols, rows, is_keyframe=True):
        """Serialize grid to binary format."""
        buf = io.BytesIO()

        if self.use_palette:
            palette, color_to_idx = self._build_palette(grid, rows, cols)
            flags = FLAG_PALETTE | (FLAG_KEYFRAME if is_keyframe else 0)
            palette_size = len(palette)

            # Header
            buf.write(MAGIC)
            buf.write(struct.pack('<HH', cols, rows))
            buf.write(struct.pack('BB', flags, palette_size))
            buf.write(b'\x00\x00')  # reserved

            # Palette
            for r, g, b in palette:
                buf.write(struct.pack('BBB', r, g, b))

            # Grid data
            for row in grid:
                for code, colors in row:
                    active_mask = 0
                    active_indices = []
                    for i, c in enumerate(colors):
                        if c is not None:
                            active_mask |= (1 << i)
                            active_indices.append(color_to_idx.get(c, 0))

                    buf.write(struct.pack('BB', code, active_mask))
                    for idx in active_indices:
                        buf.write(struct.pack('B', idx))
        else:
            flags = FLAG_KEYFRAME if is_keyframe else 0

            # Header
            buf.write(MAGIC)
            buf.write(struct.pack('<HH', cols, rows))
            buf.write(struct.pack('BB', flags, 0))
            buf.write(b'\x00\x00')  # reserved

            # Grid data — direct RGB
            for row in grid:
                for code, colors in row:
                    active_mask = 0
                    active_colors = []
                    for i, c in enumerate(colors):
                        if c is not None:
                            active_mask |= (1 << i)
                            active_colors.append(c)

                    buf.write(struct.pack('BB', code, active_mask))
                    for r, g, b in active_colors:
                        buf.write(struct.pack('BBB', r, g, b))

        return buf.getvalue()

    def _serialize_delta(self, changes, cols, rows):
        """Serialize delta frame to binary."""
        buf = io.BytesIO()
        flags = FLAG_DELTA | (FLAG_PALETTE if self.use_palette else 0)

        # For delta, we skip palette rebuild — use direct RGB
        # (palette would need to be resent or referenced from keyframe)
        flags = FLAG_DELTA  # force direct RGB for deltas

        buf.write(MAGIC)
        buf.write(struct.pack('<HH', cols, rows))
        buf.write(struct.pack('BB', flags, 0))
        buf.write(b'\x00\x00')

        buf.write(struct.pack('<H', len(changes)))

        for r, c, code, colors in changes:
            active_mask = 0
            active_colors = []
            for i, col in enumerate(colors):
                if col is not None:
                    active_mask |= (1 << i)
                    active_colors.append(col)

            buf.write(struct.pack('BBB', r, c, code))
            buf.write(struct.pack('B', active_mask))
            for rr, gg, bb in active_colors:
                buf.write(struct.pack('BBB', rr, gg, bb))

        return buf.getvalue()


class RHIDecoder:
    """Decode RHI binary format back to braille grid."""

    def decode(self, data):
        """
        Decode RHI binary data.

        Returns:
            dict with keys: cols, rows, grid, is_delta, is_keyframe
            grid: list of rows, each row is list of (braille_char, [8 colors or None])
        """
        buf = io.BytesIO(data)

        magic = buf.read(4)
        if magic != MAGIC:
            raise ValueError(f"Invalid RHI magic: {magic}")

        cols, rows = struct.unpack('<HH', buf.read(4))
        flags, palette_size = struct.unpack('BB', buf.read(2))
        buf.read(2)  # reserved

        has_palette = bool(flags & FLAG_PALETTE)
        is_delta = bool(flags & FLAG_DELTA)
        is_keyframe = bool(flags & FLAG_KEYFRAME)

        palette = None
        if has_palette and palette_size > 0:
            palette = []
            for _ in range(palette_size):
                r, g, b = struct.unpack('BBB', buf.read(3))
                palette.append((r, g, b))

        if is_delta:
            return self._decode_delta(buf, cols, rows, palette)

        # Full frame
        grid = []
        for r in range(rows):
            row = []
            for c in range(cols):
                code, active_mask = struct.unpack('BB', buf.read(2))
                colors = [None] * 8
                for i in range(8):
                    if active_mask & (1 << i):
                        if palette:
                            idx = struct.unpack('B', buf.read(1))[0]
                            colors[i] = palette[idx] if idx < len(palette) else (0, 0, 0)
                        else:
                            rr, gg, bb = struct.unpack('BBB', buf.read(3))
                            colors[i] = (rr, gg, bb)

                char = chr(BRAILLE_BASE + code)
                # Convert colors to hex strings for compatibility
                hex_colors = []
                for col in colors:
                    if col:
                        hex_colors.append(f"#{col[0]:02x}{col[1]:02x}{col[2]:02x}")
                    else:
                        hex_colors.append(None)

                row.append((char, hex_colors))
            grid.append(row)

        return {
            'cols': cols,
            'rows': rows,
            'grid': grid,
            'is_delta': False,
            'is_keyframe': is_keyframe,
            'size_bytes': len(data),
        }

    def _decode_delta(self, buf, cols, rows, palette):
        """Decode a delta frame."""
        change_count = struct.unpack('<H', buf.read(2))[0]
        changes = []

        for _ in range(change_count):
            r, c, code = struct.unpack('BBB', buf.read(3))
            active_mask = struct.unpack('B', buf.read(1))[0]
            colors = [None] * 8
            for i in range(8):
                if active_mask & (1 << i):
                    if palette:
                        idx = struct.unpack('B', buf.read(1))[0]
                        colors[i] = palette[idx] if idx < len(palette) else (0, 0, 0)
                    else:
                        rr, gg, bb = struct.unpack('BBB', buf.read(3))
                        colors[i] = (rr, gg, bb)

            char = chr(BRAILLE_BASE + code)
            hex_colors = []
            for col in colors:
                if col:
                    hex_colors.append(f"#{col[0]:02x}{col[1]:02x}{col[2]:02x}")
                else:
                    hex_colors.append(None)

            changes.append((r, c, char, hex_colors))

        return {
            'cols': cols,
            'rows': rows,
            'changes': changes,
            'is_delta': True,
            'is_keyframe': False,
        }


def encode_file(input_path, output_path, width=30, **kwargs):
    """Convenience: encode an image file to .rhi"""
    enc = RHIEncoder(width=width, **kwargs)
    data = enc.encode_image(input_path)
    with open(output_path, 'wb') as f:
        f.write(data)
    return len(data)


def compare_sizes(input_path, width=30):
    """Compare RHI sizes against JPEG at various qualities."""
    img = Image.open(input_path)
    results = {}

    # RHI variants
    for palette in [True, False]:
        for all_dots in [True, False]:
            label = f"RHI {'palette' if palette else 'direct'} {'alldots' if all_dots else 'otsu'}"
            enc = RHIEncoder(width=width, use_palette=palette, all_dots=all_dots)
            data = enc.encode_image(img)
            results[label] = len(data)

    # JPEG at various qualities
    aspect = img.height / img.width
    cols = width
    rows = max(1, round(cols * aspect * 0.5))
    display_w, display_h = cols * 8, rows * 16  # approximate display size
    resized = img.resize((display_w, display_h), Image.LANCZOS)

    for q in [10, 30, 50, 70, 85, 95]:
        buf = io.BytesIO()
        resized.save(buf, format='JPEG', quality=q)
        results[f"JPEG q={q}"] = buf.tell()

    return results


if __name__ == '__main__':
    import sys

    if len(sys.argv) < 2:
        print("Usage: python rhi_codec.py <image> [width] [output.rhi]")
        print("       python rhi_codec.py --compare <image> [width]")
        sys.exit(1)

    if sys.argv[1] == '--compare':
        path = sys.argv[2]
        w = int(sys.argv[3]) if len(sys.argv) > 3 else 30
        results = compare_sizes(path, w)
        print(f"\nSize comparison at {w}w:")
        print("-" * 45)
        for label, size in sorted(results.items(), key=lambda x: x[1]):
            print(f"  {label:30s} {size:>8,} bytes  ({size/1024:.1f} KB)")
    else:
        input_path = sys.argv[1]
        w = int(sys.argv[2]) if len(sys.argv) > 2 else 30
        output = sys.argv[3] if len(sys.argv) > 3 else input_path.rsplit('.', 1)[0] + '.rhi'

        size = encode_file(input_path, output, width=w)
        print(f"Encoded {input_path} → {output}")
        print(f"  Width: {w} chars")
        print(f"  Size:  {size:,} bytes ({size/1024:.1f} KB)")
