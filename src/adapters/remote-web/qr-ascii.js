'use strict';

/**
 * Zero-dependency ISO/IEC 18004 QR Code encoder & UTF-8 half-block ASCII renderer (v2.7.0).
 *
 * - Supports Byte mode, Error Correction Level L, Versions 1..10 (up to 271 UTF-8 bytes).
 * - Pure JavaScript with zero external dependencies and zero vendor literals (SOLID #0).
 * - Intended for rendering scannable local LAN install URLs in terminal CLI output.
 */

// GF(256) with primitive polynomial x^8 + x^4 + x^3 + x^2 + 1 (0x11d)
const GF_EXP = new Uint8Array(512);
const GF_LOG = new Uint8Array(256);
(function initGaloisField() {
  let x = 1;
  for (let i = 0; i < 255; i += 1) {
    GF_EXP[i] = x;
    GF_LOG[x] = i;
    x <<= 1;
    if (x & 0x100) {
      x ^= 0x11d;
    }
  }
  for (let i = 255; i < 512; i += 1) {
    GF_EXP[i] = GF_EXP[i - 255];
  }
})();

function gfMul(a, b) {
  if (a === 0 || b === 0) return 0;
  return GF_EXP[GF_LOG[a] + GF_LOG[b]];
}

function rsGeneratorPoly(degree) {
  let poly = [1];
  for (let i = 0; i < degree; i += 1) {
    const next = new Array(poly.length + 1).fill(0);
    const factor = GF_EXP[i];
    for (let j = 0; j < poly.length; j += 1) {
      next[j] ^= poly[j];
      next[j + 1] ^= gfMul(poly[j], factor);
    }
    poly = next;
  }
  return poly;
}

function rsComputeRemainder(data, ecCount) {
  const gen = rsGeneratorPoly(ecCount);
  const res = new Uint8Array(ecCount);
  for (let i = 0; i < data.length; i += 1) {
    const factor = data[i] ^ res[0];
    for (let j = 0; j < ecCount - 1; j += 1) {
      res[j] = res[j + 1] ^ gfMul(gen[j + 1], factor);
    }
    res[ecCount - 1] = gfMul(gen[ecCount], factor);
  }
  return res;
}

// Version 1..10 Error Correction Level L specifications:
// [version, dataCodewords, ecPerBlock, g1Blocks, g1Data, g2Blocks, g2Data, alignCenters]
const VERSION_SPECS_L = Object.freeze([
  null,
  { version: 1, dataCodewords: 19, ecPerBlock: 7, g1Blocks: 1, g1Data: 19, g2Blocks: 0, g2Data: 0, align: [] },
  { version: 2, dataCodewords: 34, ecPerBlock: 10, g1Blocks: 1, g1Data: 34, g2Blocks: 0, g2Data: 0, align: [6, 18] },
  { version: 3, dataCodewords: 55, ecPerBlock: 15, g1Blocks: 1, g1Data: 55, g2Blocks: 0, g2Data: 0, align: [6, 22] },
  { version: 4, dataCodewords: 80, ecPerBlock: 20, g1Blocks: 1, g1Data: 80, g2Blocks: 0, g2Data: 0, align: [6, 26] },
  { version: 5, dataCodewords: 108, ecPerBlock: 26, g1Blocks: 1, g1Data: 108, g2Blocks: 0, g2Data: 0, align: [6, 30] },
  { version: 6, dataCodewords: 136, ecPerBlock: 18, g1Blocks: 2, g1Data: 68, g2Blocks: 0, g2Data: 0, align: [6, 34] },
  { version: 7, dataCodewords: 156, ecPerBlock: 20, g1Blocks: 2, g1Data: 78, g2Blocks: 0, g2Data: 0, align: [6, 22, 38] },
  { version: 8, dataCodewords: 194, ecPerBlock: 24, g1Blocks: 2, g1Data: 97, g2Blocks: 0, g2Data: 0, align: [6, 24, 42] },
  { version: 9, dataCodewords: 232, ecPerBlock: 30, g1Blocks: 2, g1Data: 116, g2Blocks: 0, g2Data: 0, align: [6, 26, 46] },
  { version: 10, dataCodewords: 274, ecPerBlock: 18, g1Blocks: 2, g1Data: 68, g2Blocks: 2, g2Data: 69, align: [6, 28, 50] },
]);

function selectVersionForByteLength(byteLength) {
  for (let v = 1; v < VERSION_SPECS_L.length; v += 1) {
    const spec = VERSION_SPECS_L[v];
    const countBits = v <= 9 ? 8 : 16;
    const totalBitsNeeded = 4 + countBits + byteLength * 8;
    if (totalBitsNeeded <= spec.dataCodewords * 8) {
      return spec;
    }
  }
  throw new Error(`ERR_QR_PAYLOAD_TOO_LONG:${byteLength}`);
}

function encodeDataCodewords(bytes, spec) {
  const bits = [];
  function pushBits(val, len) {
    for (let i = len - 1; i >= 0; i -= 1) {
      bits.push((val >>> i) & 1);
    }
  }

  // Byte mode indicator (0100) + character count
  pushBits(0b0100, 4);
  pushBits(bytes.length, spec.version <= 9 ? 8 : 16);
  for (let i = 0; i < bytes.length; i += 1) {
    pushBits(bytes[i], 8);
  }

  const maxBits = spec.dataCodewords * 8;
  const termLen = Math.min(4, maxBits - bits.length);
  pushBits(0, termLen);
  while (bits.length % 8 !== 0) {
    bits.push(0);
  }

  const out = [];
  for (let i = 0; i < bits.length; i += 8) {
    let b = 0;
    for (let j = 0; j < 8; j += 1) {
      b = (b << 1) | bits[i + j];
    }
    out.push(b);
  }

  const padBytes = [0xec, 0x11];
  let padIdx = 0;
  while (out.length < spec.dataCodewords) {
    out.push(padBytes[padIdx & 1]);
    padIdx += 1;
  }
  return out;
}

function buildFinalCodewords(dataCodewords, spec) {
  const dataBlocks = [];
  const ecBlocks = [];
  let offset = 0;

  for (let b = 0; b < spec.g1Blocks; b += 1) {
    const blk = dataCodewords.slice(offset, offset + spec.g1Data);
    offset += spec.g1Data;
    dataBlocks.push(blk);
    ecBlocks.push(rsComputeRemainder(blk, spec.ecPerBlock));
  }
  for (let b = 0; b < spec.g2Blocks; b += 1) {
    const blk = dataCodewords.slice(offset, offset + spec.g2Data);
    offset += spec.g2Data;
    dataBlocks.push(blk);
    ecBlocks.push(rsComputeRemainder(blk, spec.ecPerBlock));
  }

  const finalBytes = [];
  const maxDataLen = Math.max(spec.g1Data, spec.g2Data);
  for (let i = 0; i < maxDataLen; i += 1) {
    for (let b = 0; b < dataBlocks.length; b += 1) {
      if (i < dataBlocks[b].length) finalBytes.push(dataBlocks[b][i]);
    }
  }
  for (let i = 0; i < spec.ecPerBlock; i += 1) {
    for (let b = 0; b < ecBlocks.length; b += 1) {
      finalBytes.push(ecBlocks[b][i]);
    }
  }
  return finalBytes;
}

function computeFormatBits(ecLevelBits, maskIndex) {
  const data = (ecLevelBits << 3) | maskIndex;
  let rem = data << 10;
  const poly = 0b10100110111;
  for (let i = 14; i >= 10; i -= 1) {
    if ((rem >>> i) & 1) {
      rem ^= poly << (i - 10);
    }
  }
  return ((data << 10) | rem) ^ 0b101010000010010;
}

function computeVersionBits(version) {
  let rem = version << 12;
  const poly = 0b1111100100101;
  for (let i = 17; i >= 12; i -= 1) {
    if ((rem >>> i) & 1) {
      rem ^= poly << (i - 12);
    }
  }
  return (version << 12) | rem;
}

function maskPredicate(maskIndex, r, c) {
  switch (maskIndex) {
    case 0: return (r + c) % 2 === 0;
    case 1: return r % 2 === 0;
    case 2: return c % 3 === 0;
    case 3: return (r + c) % 3 === 0;
    case 4: return (Math.floor(r / 2) + Math.floor(c / 3)) % 2 === 0;
    case 5: return ((r * c) % 2) + ((r * c) % 3) === 0;
    case 6: return (((r * c) % 2) + ((r * c) % 3)) % 2 === 0;
    case 7: return (((r + c) % 2) + ((r * c) % 3)) % 2 === 0;
    default: return false;
  }
}

function createEmptyGrid(size) {
  const modules = new Array(size);
  const isFunction = new Array(size);
  for (let r = 0; r < size; r += 1) {
    modules[r] = new Uint8Array(size);
    isFunction[r] = new Uint8Array(size);
  }
  return { modules, isFunction };
}

function setFunc(grid, r, c, dark) {
  if (r < 0 || c < 0 || r >= grid.modules.length || c >= grid.modules.length) return;
  grid.modules[r][c] = dark ? 1 : 0;
  grid.isFunction[r][c] = 1;
}

function drawFinderPattern(grid, top, left) {
  for (let dr = -1; dr <= 7; dr += 1) {
    for (let dc = -1; dc <= 7; dc += 1) {
      const r = top + dr;
      const c = left + dc;
      if (r < 0 || c < 0 || r >= grid.modules.length || c >= grid.modules.length) continue;
      const isBorder = dr === -1 || dr === 7 || dc === -1 || dc === 7;
      const isOuter = dr === 0 || dr === 6 || dc === 0 || dc === 6;
      const isInner = dr >= 2 && dr <= 4 && dc >= 2 && dc <= 4;
      setFunc(grid, r, c, !isBorder && (isOuter || isInner));
    }
  }
}

function drawAlignmentPattern(grid, centerR, centerC) {
  for (let dr = -2; dr <= 2; dr += 1) {
    for (let dc = -2; dc <= 2; dc += 1) {
      const dist = Math.max(Math.abs(dr), Math.abs(dc));
      setFunc(grid, centerR + dr, centerC + dc, dist !== 1);
    }
  }
}

function drawFormatInfo(grid, formatBits) {
  const size = grid.modules.length;
  // Copy 1: around top-left finder
  const coords1 = [
    [8, 0], [8, 1], [8, 2], [8, 3], [8, 4], [8, 5], [8, 7], [8, 8],
    [7, 8], [5, 8], [4, 8], [3, 8], [2, 8], [1, 8], [0, 8],
  ];
  for (let i = 0; i < 15; i += 1) {
    const bit = (formatBits >>> (14 - i)) & 1;
    setFunc(grid, coords1[i][0], coords1[i][1], bit === 1);
  }
  // Copy 2: bottom-left & top-right
  for (let i = 0; i < 7; i += 1) {
    const bit = (formatBits >>> (14 - i)) & 1;
    setFunc(grid, size - 1 - i, 8, bit === 1);
  }
  for (let i = 7; i < 15; i += 1) {
    const bit = (formatBits >>> (14 - i)) & 1;
    setFunc(grid, 8, size - 15 + i, bit === 1);
  }
}

function drawVersionInfo(grid, version) {
  if (version < 7) return;
  const size = grid.modules.length;
  const bits = computeVersionBits(version);
  for (let i = 0; i < 18; i += 1) {
    const bit = ((bits >>> i) & 1) === 1;
    const a = Math.floor(i / 3);
    const b = size - 11 + (i % 3);
    setFunc(grid, a, b, bit);
    setFunc(grid, b, a, bit);
  }
}

function placeDataBits(grid, finalCodewords) {
  const size = grid.modules.length;
  const totalBits = finalCodewords.length * 8;
  let bitIdx = 0;
  let upward = true;

  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5;
    for (let step = 0; step < size; step += 1) {
      const r = upward ? size - 1 - step : step;
      for (let colOff = 0; colOff < 2; colOff += 1) {
        const c = right - colOff;
        if (grid.isFunction[r][c]) continue;
        let dark = 0;
        if (bitIdx < totalBits) {
          dark = (finalCodewords[bitIdx >>> 3] >>> (7 - (bitIdx & 7))) & 1;
          bitIdx += 1;
        }
        grid.modules[r][c] = dark;
      }
    }
    upward = !upward;
  }
}

function computePenalty(modules) {
  const size = modules.length;
  let penalty = 0;

  // N1: adjacent same-color runs >= 5
  for (let r = 0; r < size; r += 1) {
    let runColor = modules[r][0];
    let runLen = 1;
    for (let c = 1; c < size; c += 1) {
      if (modules[r][c] === runColor) {
        runLen += 1;
      } else {
        if (runLen >= 5) penalty += 3 + (runLen - 5);
        runColor = modules[r][c];
        runLen = 1;
      }
    }
    if (runLen >= 5) penalty += 3 + (runLen - 5);
  }
  for (let c = 0; c < size; c += 1) {
    let runColor = modules[0][c];
    let runLen = 1;
    for (let r = 1; r < size; r += 1) {
      if (modules[r][c] === runColor) {
        runLen += 1;
      } else {
        if (runLen >= 5) penalty += 3 + (runLen - 5);
        runColor = modules[r][c];
        runLen = 1;
      }
    }
    if (runLen >= 5) penalty += 3 + (runLen - 5);
  }

  // N2: 2x2 blocks of same color
  for (let r = 0; r < size - 1; r += 1) {
    for (let c = 0; c < size - 1; c += 1) {
      const v = modules[r][c];
      if (modules[r][c + 1] === v && modules[r + 1][c] === v && modules[r + 1][c + 1] === v) {
        penalty += 3;
      }
    }
  }

  // N4: dark module balance
  let darkCount = 0;
  for (let r = 0; r < size; r += 1) {
    for (let c = 0; c < size; c += 1) {
      darkCount += modules[r][c];
    }
  }
  const pct = (darkCount * 100) / (size * size);
  const k = Math.floor(Math.abs(pct - 50) / 5);
  penalty += k * 10;

  return penalty;
}

function encodeQrMatrix(text) {
  if (typeof text !== 'string' || text.length === 0) {
    throw new Error('ERR_QR_EMPTY_TEXT');
  }
  const bytes = Buffer.from(text, 'utf8');
  const spec = selectVersionForByteLength(bytes.length);
  const size = 17 + spec.version * 4;
  const dataCodewords = encodeDataCodewords(bytes, spec);
  const finalCodewords = buildFinalCodewords(dataCodewords, spec);

  const baseGrid = createEmptyGrid(size);
  drawFinderPattern(baseGrid, 0, 0);
  drawFinderPattern(baseGrid, 0, size - 7);
  drawFinderPattern(baseGrid, size - 7, 0);

  // Timing patterns
  for (let i = 8; i < size - 8; i += 1) {
    setFunc(baseGrid, 6, i, i % 2 === 0);
    setFunc(baseGrid, i, 6, i % 2 === 0);
  }

  // Alignment patterns
  const centers = spec.align;
  for (let i = 0; i < centers.length; i += 1) {
    for (let j = 0; j < centers.length; j += 1) {
      const cr = centers[i];
      const cc = centers[j];
      if (baseGrid.isFunction[cr][cc]) continue;
      drawAlignmentPattern(baseGrid, cr, cc);
    }
  }

  // Dark module & reserve format/version areas
  setFunc(baseGrid, 4 * spec.version + 9, 8, true);
  drawFormatInfo(baseGrid, 0);
  drawVersionInfo(baseGrid, spec.version);
  placeDataBits(baseGrid, finalCodewords);

  // Evaluate all 8 masks for EC Level L (format indicator bits: 01)
  let bestModules = null;
  let bestMask = 0;
  let bestPenalty = Infinity;

  for (let maskIdx = 0; maskIdx < 8; maskIdx += 1) {
    const candidate = {
      modules: baseGrid.modules.map((row) => Uint8Array.from(row)),
      isFunction: baseGrid.isFunction,
    };
    for (let r = 0; r < size; r += 1) {
      for (let c = 0; c < size; c += 1) {
        if (!candidate.isFunction[r][c] && maskPredicate(maskIdx, r, c)) {
          candidate.modules[r][c] ^= 1;
        }
      }
    }
    drawFormatInfo(candidate, computeFormatBits(0b01, maskIdx));
    const pen = computePenalty(candidate.modules);
    if (pen < bestPenalty) {
      bestPenalty = pen;
      bestMask = maskIdx;
      bestModules = candidate.modules;
    }
  }

  return {
    version: spec.version,
    size,
    mask: bestMask,
    modules: bestModules,
  };
}

/**
 * Renders a QR matrix to a compact UTF-8 half-block string (2 rows per line).
 * Default (`invert: false`) assumes dark terminal background with light text:
 * light quiet zone rendered with bright blocks (`█`) and dark modules with spaces (` `),
 * producing a standard high-contrast black-on-white scannable QR code on dark terminals.
 */
function renderQrAscii(matrixOrText, { quietZone = 2, invert = false } = {}) {
  const qr = typeof matrixOrText === 'string' ? encodeQrMatrix(matrixOrText) : matrixOrText;
  if (!qr || !Array.isArray(qr.modules) || qr.modules.length === 0) {
    throw new Error('ERR_QR_INVALID_MATRIX');
  }
  const size = qr.modules.length;
  const qz = Number.isInteger(quietZone) && quietZone >= 0 && quietZone <= 8 ? quietZone : 2;
  const total = size + qz * 2;

  function isLightCell(r, c) {
    const mr = r - qz;
    const mc = c - qz;
    const isDark = mr >= 0 && mc >= 0 && mr < size && mc < size ? qr.modules[mr][mc] === 1 : false;
    return invert ? isDark : !isDark;
  }

  const lines = [];
  for (let r = 0; r < total; r += 2) {
    let line = '';
    for (let c = 0; c < total; c += 1) {
      const top = isLightCell(r, c);
      const bot = r + 1 < total ? isLightCell(r + 1, c) : !invert;
      if (top && bot) line += '█';
      else if (top && !bot) line += '▀';
      else if (!top && bot) line += '▄';
      else line += ' ';
    }
    lines.push(line);
  }
  return lines.join('\n');
}

module.exports = {
  encodeQrMatrix,
  renderQrAscii,
};
