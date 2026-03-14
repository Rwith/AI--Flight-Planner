#!/usr/bin/env python3
"""
generate-installer-assets.py
Generates dark-themed BMP images for the AeroNav AI Windows installer.

Outputs:
  build/sidebar.bmp          164 × 314  — Welcome / Finish left panel
  build/sidebar-uninstall.bmp 164 × 314  — Uninstaller left panel
  build/header.bmp           150 × 57   — Inner-page header strip

Run from the project root:
  python scripts/generate-installer-assets.py
"""

import struct
import os
import math


# ---------------------------------------------------------------------------
# BMP writer (24-bit, no external deps)
# ---------------------------------------------------------------------------

def write_bmp(path, width, height, pixels):
    """
    Write a 24-bit BMP.
    pixels: list of (R, G, B) tuples, row-major, top-to-bottom.
    """
    row_stride = ((width * 3 + 3) // 4) * 4
    pixel_data_size = row_stride * height
    file_size = 54 + pixel_data_size

    os.makedirs(os.path.dirname(path) or ".", exist_ok=True)

    with open(path, "wb") as f:
        # --- File header (14 bytes) ---
        f.write(b"BM")
        f.write(struct.pack("<I", file_size))
        f.write(struct.pack("<HH", 0, 0))
        f.write(struct.pack("<I", 54))

        # --- DIB header (40 bytes) ---
        f.write(struct.pack("<I", 40))
        f.write(struct.pack("<i", width))
        f.write(struct.pack("<i", -height))   # negative → top-down
        f.write(struct.pack("<H", 1))
        f.write(struct.pack("<H", 24))
        f.write(struct.pack("<I", 0))
        f.write(struct.pack("<I", pixel_data_size))
        f.write(struct.pack("<ii", 2835, 2835))
        f.write(struct.pack("<II", 0, 0))

        # --- Pixel data (BGR order, padded rows) ---
        for y in range(height):
            row = b""
            for x in range(width):
                r, g, b = pixels[y * width + x]
                row += bytes([b, g, r])
            row += b"\x00" * (row_stride - width * 3)
            f.write(row)

    print(f"  wrote {path}  ({width}×{height})")


# ---------------------------------------------------------------------------
# Color helpers
# ---------------------------------------------------------------------------

def lerp(a, b, t):
    return int(a + (b - a) * t)


def lerp_rgb(c0, c1, t):
    return (lerp(c0[0], c1[0], t),
            lerp(c0[1], c1[1], t),
            lerp(c0[2], c1[2], t))


def clamp(v, lo=0, hi=255):
    return max(lo, min(hi, v))


def add_rgb(c, delta):
    return tuple(clamp(v + delta) for v in c)


# ---------------------------------------------------------------------------
# AeroNav AI colour palette
# ---------------------------------------------------------------------------

DEEP_SPACE   = (0x0D, 0x11, 0x17)   # #0D1117 — darkest background
SPACE        = (0x16, 0x1B, 0x22)   # #161B22
MIDNIGHT     = (0x1C, 0x26, 0x35)   # #1C2635
BLUE_ACCENT  = (0x1F, 0x6F, 0xEB)   # #1F6FEB — GitHub Actions blue
BLUE_BRIGHT  = (0x58, 0xA6, 0xFF)   # #58A6FF — lighter accent
GRID_LINE    = (0x1E, 0x27, 0x37)   # subtle grid
WHITE_DIM    = (0xC9, 0xD1, 0xD9)   # muted white text colour


# ---------------------------------------------------------------------------
# Sidebar  164 × 314
# ---------------------------------------------------------------------------

def make_sidebar(path, width=164, height=314, uninstall=False):
    pixels = []

    for y in range(height):
        ty = y / (height - 1)

        for x in range(width):
            tx = x / (width - 1)

            # --- Background gradient (top-dark → bottom-midnight) ---
            base = lerp_rgb(DEEP_SPACE, MIDNIGHT, ty)

            # --- Subtle dot-grid overlay ---
            gx, gy = x % 20, y % 20
            on_grid = (gx == 0 or gy == 0)
            if on_grid:
                base = add_rgb(base, 8)

            # --- Diagonal "scan" lines for aviation feel ---
            diag = (x + y * 2) % 40
            if diag == 0:
                base = add_rgb(base, 12)

            # --- Right-edge blue accent stripe (4 px) ---
            if x >= width - 4:
                fade = (x - (width - 4)) / 3
                base = lerp_rgb(base, BLUE_ACCENT, fade * 0.8)

            # --- Bottom "horizon" glow ---
            bottom_glow = max(0.0, (ty - 0.75) / 0.25)
            if bottom_glow > 0:
                base = lerp_rgb(base, BLUE_ACCENT, bottom_glow * 0.18)

            # --- Circular emblem placeholder (center-ish) ---
            cx, cy = width // 2 - 10, height // 2 - 20
            dist = math.sqrt((x - cx) ** 2 + (y - cy) ** 2)
            if dist < 38:
                ring_fade = max(0.0, 1.0 - abs(dist - 30) / 8)
                base = lerp_rgb(base, BLUE_BRIGHT, ring_fade * 0.55)
            if dist < 22:
                inner = 1.0 - dist / 22
                base = lerp_rgb(base, BLUE_ACCENT, inner * 0.35)

            # --- "Uninstall" variant: slightly warmer tint ---
            if uninstall:
                r, g, b = base
                base = (clamp(r + 8), g, clamp(b - 6))

            pixels.append(base)

    write_bmp(path, width, height, pixels)


# ---------------------------------------------------------------------------
# Header  150 × 57
# ---------------------------------------------------------------------------

def make_header(path, width=150, height=57):
    pixels = []

    accent_bar = 3   # px tall blue bar at the very bottom

    for y in range(height):
        ty = y / (height - 1)

        for x in range(width):
            tx = x / (width - 1)

            # --- Background ---
            base = lerp_rgb(SPACE, DEEP_SPACE, ty * 0.6)

            # --- Subtle horizontal shimmer ---
            if y % 14 == 0:
                base = add_rgb(base, 10)

            # --- Right-side fade toward accent ---
            if tx > 0.70:
                fade = (tx - 0.70) / 0.30
                base = lerp_rgb(base, MIDNIGHT, fade * 0.6)

            # --- Bottom accent bar ---
            if y >= height - accent_bar:
                bar_fade = (y - (height - accent_bar)) / (accent_bar - 1)
                base = lerp_rgb(BLUE_ACCENT, BLUE_BRIGHT, bar_fade)

            pixels.append(base)

    write_bmp(path, width, height, pixels)


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

if __name__ == "__main__":
    print("Generating AeroNav AI installer assets …")
    make_sidebar("build/sidebar.bmp")
    make_sidebar("build/sidebar-uninstall.bmp", uninstall=True)
    make_header("build/header.bmp")
    print("Done.")
