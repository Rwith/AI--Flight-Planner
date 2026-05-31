// qrcode.js — Minimal pure-JS QR Code encoder for AeroNav GCS.
//
// Locked configuration: Version 5 · Error Correction level L · byte mode · mask 0.
//   - 37×37 modules
//   - 1 data block (108 data codewords + 26 EC codewords)
//   - Capacity: 106 bytes (we cap user input at ~95 chars to leave headroom)
//   - Fixed mask pattern 0  (any of the 8 masks is valid; scanners read all)
//
// Used by gcs.html to render a scannable maps-URL QR on the comms-lost overlay
// so a phone in the area can take over navigation if the GCS goes dark.
// Standalone, no dependencies — runs offline inside the APK.
//
// Reference: ISO/IEC 18004:2015.

(function (global) {
'use strict';

const VERSION     = 5;
const SIZE        = 4 * VERSION + 17;   // 37
const DATA_CW     = 108;                // V5-L data codewords
const EC_CW       = 26;                 // V5-L error-correction codewords
const FORMAT_INFO = 0x77C4;             // EC L + mask 0, BCH-encoded + masked

// ── GF(256) tables (primitive polynomial 0x11D) ────────────────────────────
const EXP = new Uint8Array(512);
const LOG = new Uint8Array(256);
(function buildGF() {
  let x = 1;
  for (let i = 0; i < 255; i++) {
    EXP[i] = x;
    LOG[x] = i;
    x <<= 1;
    if (x & 0x100) x ^= 0x11D;
  }
  for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255];
})();
function gfMul(a, b) { return (a && b) ? EXP[LOG[a] + LOG[b]] : 0; }

// Reed-Solomon generator polynomial of given degree.
function rsGenPoly(deg) {
  let g = [1];
  for (let i = 0; i < deg; i++) {
    const ng = new Array(g.length + 1).fill(0);
    for (let k = 0; k < g.length; k++) {
      ng[k]     ^= g[k];                  // x · g[k]
      ng[k + 1] ^= gfMul(g[k], EXP[i]);   // α^i · g[k]
    }
    g = ng;
  }
  return g;
}

// Compute `deg` EC bytes for `data` via polynomial division by gen poly.
function rsEncode(data, deg) {
  const gen = rsGenPoly(deg);
  const buf = new Uint8Array(data.length + deg);
  buf.set(data, 0);
  for (let i = 0; i < data.length; i++) {
    const lead = buf[i];
    if (!lead) continue;
    for (let j = 0; j < gen.length; j++) buf[i + j] ^= gfMul(gen[j], lead);
  }
  return buf.slice(data.length);
}

// ── Build the 108-byte data codeword block from text ───────────────────────
function encodeBytes(text) {
  if (text.length > 106) throw new Error('QR text too long for V5-L (max 106 bytes)');
  const out = new Uint8Array(DATA_CW);
  let bitPos = 0;
  function pushBits(value, n) {
    for (let i = n - 1; i >= 0; i--) {
      if ((value >> i) & 1) out[bitPos >> 3] |= 1 << (7 - (bitPos & 7));
      bitPos++;
    }
  }
  pushBits(0b0100, 4);              // byte mode indicator
  pushBits(text.length, 8);         // char count (V1-9 byte mode = 8 bits)
  for (let i = 0; i < text.length; i++) pushBits(text.charCodeAt(i) & 0xff, 8);
  // 4-bit terminator (or fewer if no room) + pad to byte boundary; both are
  // zeros and the buffer is already zero-initialised, so we just advance.
  bitPos += Math.min(4, DATA_CW * 8 - bitPos);
  bitPos = (bitPos + 7) & ~7;
  // Fill remaining bytes with alternating 0xEC / 0x11 (spec).
  let bytePos = bitPos >> 3;
  let pad = 0xEC;
  while (bytePos < DATA_CW) {
    out[bytePos++] = pad;
    pad = (pad === 0xEC) ? 0x11 : 0xEC;
  }
  return out;
}

// ── Build the 37×37 module matrix ───────────────────────────────────────────
function buildMatrix(text) {
  const data = encodeBytes(text);
  const ec   = rsEncode(data, EC_CW);
  // V5-L is a single block, so the combined stream is just data || ec.
  const stream = new Uint8Array(DATA_CW + EC_CW);
  stream.set(data, 0);
  stream.set(ec, DATA_CW);

  const m = [];   // module values (0 = light, 1 = dark)
  const r = [];   // reserved flag (true = function pattern / format info area)
  for (let i = 0; i < SIZE; i++) {
    m.push(new Uint8Array(SIZE));
    r.push(new Uint8Array(SIZE));
  }
  function setMod(row, col, val) {
    if (row < 0 || col < 0 || row >= SIZE || col >= SIZE) return;
    m[row][col] = val;
    r[row][col] = 1;
  }

  // — Finder patterns + 1-module separator ring at three corners —
  function placeFinder(cy, cx) {
    for (let dr = -1; dr <= 7; dr++) {
      for (let dc = -1; dc <= 7; dc++) {
        let dark = 0;
        if (dr >= 0 && dr <= 6 && dc >= 0 && dc <= 6) {
          const onBorder = (dr === 0 || dr === 6 || dc === 0 || dc === 6);
          const inCore   = (dr >= 2 && dr <= 4 && dc >= 2 && dc <= 4);
          dark = (onBorder || inCore) ? 1 : 0;
        }
        setMod(cy + dr, cx + dc, dark);
      }
    }
  }
  placeFinder(0,         0);
  placeFinder(0,         SIZE - 7);
  placeFinder(SIZE - 7,  0);

  // — Timing patterns (row 6 and col 6 between the finder separators) —
  for (let i = 8; i < SIZE - 8; i++) {
    const dark = (i % 2 === 0) ? 1 : 0;
    setMod(6, i, dark);
    setMod(i, 6, dark);
  }

  // — Alignment pattern (V5 has exactly one at (30, 30)) —
  (function placeAlign(cy, cx) {
    for (let dr = -2; dr <= 2; dr++) {
      for (let dc = -2; dc <= 2; dc++) {
        const onBorder = (Math.abs(dr) === 2 || Math.abs(dc) === 2);
        const center   = (dr === 0 && dc === 0);
        setMod(cy + dr, cx + dc, (onBorder || center) ? 1 : 0);
      }
    }
  })(SIZE - 7, SIZE - 7);   // (30, 30) for V5

  // — Fixed dark module at (4·V + 9, 8) = (29, 8) for V5 —
  setMod(4 * VERSION + 9, 8, 1);

  // — Reserve format-info regions (their values are written after data) —
  for (let i = 0; i <= 8; i++) {
    if (!r[8][i])           { r[8][i] = 1;           m[8][i] = 0;           }
    if (!r[i][8])           { r[i][8] = 1;           m[i][8] = 0;           }
  }
  for (let i = 0; i < 8; i++) {
    if (!r[SIZE - 1 - i][8]) { r[SIZE - 1 - i][8] = 1; m[SIZE - 1 - i][8] = 0; }
    if (!r[8][SIZE - 1 - i]) { r[8][SIZE - 1 - i] = 1; m[8][SIZE - 1 - i] = 0; }
  }

  // — Place data + EC bits in the zigzag pattern, applying mask 0 inline —
  let bitIdx = 0;
  const totalBits = stream.length * 8;
  let upward = true;
  for (let right = SIZE - 1; right >= 0; right -= 2) {
    if (right === 6) right = 5;   // skip the col-6 vertical timing column
    for (let v = 0; v < SIZE; v++) {
      const row = upward ? (SIZE - 1 - v) : v;
      for (let dc = 0; dc < 2; dc++) {
        const col = right - dc;
        if (col < 0 || r[row][col]) continue;
        let bit = 0;
        if (bitIdx < totalBits) {
          bit = (stream[bitIdx >> 3] >> (7 - (bitIdx & 7))) & 1;
          bitIdx++;
        }
        // Mask pattern 0: invert at every (row + col) % 2 === 0
        if (((row + col) & 1) === 0) bit ^= 1;
        m[row][col] = bit;
      }
    }
    upward = !upward;
  }

  // — Write 15-bit format info into both copies —
  // First copy: L-shape around top-left finder.
  for (let i = 0; i < 15; i++) {
    const bit = (FORMAT_INFO >> i) & 1;
    let r1, c1;
    if      (i < 6)  { r1 = 8;        c1 = i;       }
    else if (i === 6){ r1 = 8;        c1 = 7;       }
    else if (i === 7){ r1 = 8;        c1 = 8;       }
    else if (i === 8){ r1 = 7;        c1 = 8;       }
    else             { r1 = 14 - i;   c1 = 8;       }   // i=9..14 → rows 5..0
    m[r1][c1] = bit;
    // Second copy: bottom-left vertical (i 0..6) + top-right horizontal (7..14)
    if (i < 7) m[SIZE - 1 - i][8]      = bit;
    else       m[8][SIZE - 15 + i]     = bit;
  }
  // Re-assert the fixed dark module (it sits inside the second-copy region).
  m[4 * VERSION + 9][8] = 1;

  return m;
}

// ── Render the matrix as a single-path SVG string ──────────────────────────
function toSVG(text, opts) {
  opts = opts || {};
  const margin     = (opts.margin     != null) ? opts.margin     : 2;
  const moduleSize = (opts.moduleSize != null) ? opts.moduleSize : 1;
  const dark       = opts.dark  || '#000';
  const light      = opts.light || '#fff';
  const m = buildMatrix(text);
  const total = (SIZE + margin * 2) * moduleSize;
  const path = [];
  for (let row = 0; row < SIZE; row++) {
    for (let col = 0; col < SIZE; col++) {
      if (!m[row][col]) continue;
      const x = (col + margin) * moduleSize;
      const y = (row + margin) * moduleSize;
      path.push('M' + x + ',' + y + 'h' + moduleSize + 'v' + moduleSize +
                'h-' + moduleSize + 'z');
    }
  }
  return '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ' + total + ' ' +
         total + '" shape-rendering="crispEdges">' +
         '<rect width="100%" height="100%" fill="' + light + '"/>' +
         '<path d="' + path.join('') + '" fill="' + dark + '"/></svg>';
}

global.qrcode = { buildMatrix: buildMatrix, toSVG: toSVG, SIZE: SIZE };

})(window);
