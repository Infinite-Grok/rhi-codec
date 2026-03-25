# RHI Codec

**Polychromatic per-element character-grid image and video codec.**

Send photos over LoRa. 2.3 KB for a full image. Built for [Reticulum](https://reticulum.network/) mesh networks.

> **Patent Pending** — US Application 64/014,800

## What It Does

RHI encodes images into a grid of Unicode braille characters, where **each dot carries its own RGB color**. The result is a binary format small enough to transmit over LoRa radio links — the same links that carry text chat on mesh networks — while reconstructing recognizable, full-color images on the other end.

| Width | Typical Size | Use Case |
|-------|-------------|----------|
| 25–30 cols | 1.5–2.5 KB | LoRa / ultra-low bandwidth |
| 50 cols | 4–6 KB | Mesh chat, Reticulum links |
| 80+ cols | 8–15 KB | WiFi mesh, higher fidelity |

## Live Demo

**[Try it in your browser →](https://infinite-grok.github.io/rhi-codec/)**

The demo page lets you encode any image, adjust width and rendering parameters, and see the reconstruction live. No server required — everything runs client-side.

## How It Works

1. **Encode** — The source image is downsampled to a braille character grid (2×3 dots per cell in 6-dot mode, 2×4 in 8-dot mode). Each active dot gets its own RGB color sampled from the corresponding region of the source.

2. **Pack** — The grid is serialized into a compact binary format with a 12-byte header, optional palette compression, and delta encoding for video frames.

3. **Decode & Render** — The receiver decodes the binary stream and reconstructs the image. The renderer pipeline applies bilinear upscaling and adaptive sharpening (heavier at low widths, lighter at high widths). All color correction — brightness, contrast, saturation, warmth, gamma — is exposed as user-adjustable controls.

### Wire Format (v1)

```
Header (12 bytes):
  magic:         4 bytes   "RHI\x01"
  cols:          2 bytes   uint16 LE
  rows:          2 bytes   uint16 LE
  flags:         1 byte    bit0=palette, bit1=delta, bit2=keyframe
  palette_size:  1 byte    0=direct RGB, 1-255=palette entries
  reserved:      2 bytes

Palette (optional):  palette_size × 3 bytes (RGB triplets)
Frame data:          per cell — braille code + dot mask + colors
Delta frames:        change count + sparse cell updates
```

## Files

| File | Description |
|------|-------------|
| `rhi_codec.py` | Python encoder/decoder — encode images to `.rhi` binary format |
| `rhive-renderer.js` | Zero-dependency JavaScript renderer — decode and display in any browser |
| `index.html` | Interactive demo (GitHub Pages) |
| `tuner.html` | Advanced tuning interface for dialing in render quality |

## Quick Start

### Python (Encoding)

```python
from rhi_codec import RHIEncoder, RHIDecoder

# Encode an image
enc = RHIEncoder(width=30)
data = enc.encode_image("photo.jpg")

with open("photo.rhi", "wb") as f:
    f.write(data)
print(f"Encoded: {len(data)} bytes")

# Decode
dec = RHIDecoder()
grid = dec.decode(data)
```

### JavaScript (Rendering)

```html
<script src="rhive-renderer.js"></script>
<canvas id="output"></canvas>
<script>
  const renderer = new RHiveRenderer(document.getElementById('output'));
  fetch('photo.rhi')
    .then(r => r.arrayBuffer())
    .then(buf => renderer.render(new Uint8Array(buf)));
</script>
```

## Design Principles

- **The codec delivers raw material, the human is the artist.** Color correction and rendering settings are user-facing controls, not baked-in processing. Different images want different treatment.
- **Adaptive sharpening scales inversely with resolution.** Heavy sharpening at 25–30w for edge recovery; minimal at 80w+ where resolution speaks for itself.
- **6-dot braille (2×3) is the preferred mode.** Better visual quality due to the 2:3 aspect ratio matching natural image proportions. 8-dot (2×4) available for maximum vertical resolution.

## License

[AGPL-3.0](LICENSE) — Free for open-source use. Commercial licensing available.

Contact: infinitegrok@gmail.com
