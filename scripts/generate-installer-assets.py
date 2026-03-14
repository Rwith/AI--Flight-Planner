#!/usr/bin/env python3
"""
generate-installer-assets.py
Generates dark-themed BMP images and ICO/PNG icons for the AeroNav AI installer.

Outputs:
  build/sidebar.bmp           164 × 314  — Welcome / Finish left panel
  build/sidebar-uninstall.bmp 164 × 314  — Uninstaller left panel
  build/header.bmp            150 × 57   — Inner-page header strip
  assets/icon.ico             256 × 256  — Windows installer / taskbar icon
  assets/icon.png             512 × 512  — Linux AppImage icon

Run from the project root:
  python scripts/generate-installer-assets.py
"""

import struct
import os
import math
import zlib


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
# PNG writer (no external deps — raw DEFLATE via zlib)
# ---------------------------------------------------------------------------

def write_png(path, width, height, pixels):
    """
    Write a 32-bit RGBA PNG.
    pixels: list of (R, G, B, A) tuples, row-major, top-to-bottom.
    """
    def u32be(v):
        return struct.pack(">I", v)

    def chunk(tag, data):
        c = struct.pack(">I", len(data)) + tag + data
        crc = zlib.crc32(tag + data) & 0xFFFFFFFF
        return c + struct.pack(">I", crc)

    # IHDR
    ihdr_data = struct.pack(">IIBBBBB", width, height, 8, 6, 0, 0, 0)
    ihdr = chunk(b"IHDR", ihdr_data)

    # IDAT
    raw = b""
    for y in range(height):
        raw += b"\x00"  # filter type None
        for x in range(width):
            r, g, b, a = pixels[y * width + x]
            raw += bytes([r, g, b, a])
    compressed = zlib.compress(raw, 9)
    idat = chunk(b"IDAT", compressed)

    iend = chunk(b"IEND", b"")

    os.makedirs(os.path.dirname(path) or ".", exist_ok=True)
    with open(path, "wb") as f:
        f.write(b"\x89PNG\r\n\x1a\n")
        f.write(ihdr)
        f.write(idat)
        f.write(iend)

    print(f"  wrote {path}  ({width}×{height})")


# ---------------------------------------------------------------------------
# App icon pixels  — dark navy circle with "A" lettermark
# ---------------------------------------------------------------------------

def make_icon_pixels(size, alpha=True):
    """
    Returns a list of (R,G,B,A) or (R,G,B) pixels for the AeroNav icon at
    the given square size.  Design: dark circle, blue ring, white "A" glyph.
    """
    cx = cy = size / 2
    r_outer = size * 0.48
    r_ring_outer = size * 0.48
    r_ring_inner = size * 0.38
    r_inner = size * 0.36

    BG       = (0x0D, 0x11, 0x17)
    RING     = (0x1F, 0x6F, 0xEB)
    RING_HI  = (0x58, 0xA6, 0xFF)
    LETTER   = (0xE6, 0xED, 0xF3)
    TRANSP   = (0, 0, 0, 0)

    def in_circle(x, y, r):
        return math.sqrt((x - cx) ** 2 + (y - cy) ** 2) <= r

    # Rasterise a bold "A" via a signed-distance-field approximation.
    # The glyph occupies roughly 30 % of the icon width, centred.
    def in_letter_A(px, py):
        # Normalise to -1..1 space centred in circle
        nx = (px - cx) / (size * 0.22)
        ny = (py - cy) / (size * 0.22)
        # Move glyph up slightly
        ny -= 0.15

        # Left stroke   (from bottom-left to apex)
        # Right stroke  (from bottom-right to apex)
        # Cross bar
        stroke = 0.22  # half-width of each stroke in normalised space

        def seg_dist(ax, ay, bx, by, qx, qy):
            dx, dy = bx - ax, by - ay
            t = max(0, min(1, ((qx - ax) * dx + (qy - ay) * dy) / (dx * dx + dy * dy + 1e-9)))
            return math.sqrt((qx - ax - t * dx) ** 2 + (qy - ay - t * dy) ** 2)

        apex = (0.0, -1.0)
        bl   = (-0.75,  1.0)
        br   = ( 0.75,  1.0)
        ml   = (-0.28,  0.15)
        mr   = ( 0.28,  0.15)

        d_left  = seg_dist(bl[0], bl[1], apex[0], apex[1], nx, ny)
        d_right = seg_dist(br[0], br[1], apex[0], apex[1], nx, ny)
        d_cross = seg_dist(ml[0], ml[1], mr[0],   mr[1],   nx, ny)

        return min(d_left, d_right, d_cross) < stroke

    pixels = []
    for y in range(size):
        for x in range(size):
            dist = math.sqrt((x - cx) ** 2 + (y - cy) ** 2)

            if dist > r_outer:
                # Outside icon — transparent
                pixels.append(TRANSP if alpha else (0, 0, 0))
                continue

            # Anti-alias edge
            aa = clamp(int((r_outer - dist) * 4), 0, 255)

            if dist <= r_ring_inner:
                # Inner fill
                if in_letter_A(x, y):
                    base = LETTER + (aa,)
                else:
                    base = BG + (aa,)
            else:
                # Ring band
                t = (dist - r_ring_inner) / (r_ring_outer - r_ring_inner)
                ring_col = lerp_rgb(RING, RING_HI, t)
                base = ring_col + (aa,)

            if not alpha:
                base = base[:3]
            pixels.append(base)

    return pixels


# ---------------------------------------------------------------------------
# ICO writer  (single 256×256 32-bit RGBA image)
# ---------------------------------------------------------------------------

def write_ico(path, size=256):
    pixels = make_icon_pixels(size, alpha=True)

    # Build a PNG blob for the image data (ICO >= 256px stores PNG)
    import io

    def u32be(v): return struct.pack(">I", v)
    def u32le(v): return struct.pack("<I", v)
    def u16le(v): return struct.pack("<H", v)

    def png_blob(px, w, h):
        def chunk(tag, data):
            c = struct.pack(">I", len(data)) + tag + data
            crc = zlib.crc32(tag + data) & 0xFFFFFFFF
            return c + struct.pack(">I", crc)
        ihdr = chunk(b"IHDR", struct.pack(">IIBBBBB", w, h, 8, 6, 0, 0, 0))
        raw = b""
        for y in range(h):
            raw += b"\x00"
            for x in range(w):
                r, g, b, a = px[y * w + x]
                raw += bytes([r, g, b, a])
        idat = chunk(b"IDAT", zlib.compress(raw, 6))
        iend = chunk(b"IEND", b"")
        return b"\x89PNG\r\n\x1a\n" + ihdr + idat + iend

    image_data = png_blob(pixels, size, size)
    img_size = len(image_data)

    # ICO header + 1 directory entry
    header = b"\x00\x00" + u16le(1) + u16le(1)   # reserved, type=ICO, count=1
    # directory entry: w, h, palette, reserved, planes, bpp, size, offset
    entry = (bytes([0, 0]) +           # 0,0 = 256 for 256px
             b"\x00\x00" +             # palette count, reserved
             u16le(1) +                # color planes
             u16le(32) +               # bits per pixel
             u32le(img_size) +         # image data size
             u32le(6 + 16))            # offset = header(6) + entry(16)

    os.makedirs(os.path.dirname(path) or ".", exist_ok=True)
    with open(path, "wb") as f:
        f.write(header + entry + image_data)

    print(f"  wrote {path}  ({size}×{size} ICO)")


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

if __name__ == "__main__":
    print("Generating AeroNav AI installer assets …")
    make_sidebar("build/sidebar.bmp")
    make_sidebar("build/sidebar-uninstall.bmp", uninstall=True)
    make_header("build/header.bmp")

    # App icons
    icon_px_512 = make_icon_pixels(512, alpha=True)
    write_png("assets/icon.png", 512, 512, icon_px_512)
    write_ico("assets/icon.ico", size=256)

    print("Done.")
