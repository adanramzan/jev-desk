// Generate simple Jev Desk icons (hexagon) as PNG files
// Run: node scripts/gen-icons.mjs

import { writeFileSync, mkdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const outDir = resolve(__dirname, '..', 'extension', 'icons');
mkdirSync(outDir, { recursive: true });

// Minimal PNG encoder (uncompressed, RGBA)
function createPng(size, drawFn) {
  const pixels = new Uint8Array(size * size * 4);
  drawFn(pixels, size);

  // PNG signature
  const signature = [137, 80, 78, 71, 13, 10, 26, 10];

  // IHDR
  const ihdr = new Uint8Array(13);
  new DataView(ihdr.buffer).setUint32(0, size);
  new DataView(ihdr.buffer).setUint32(4, size);
  ihdr[8] = 8;  // bit depth
  ihdr[9] = 6;  // RGBA
  ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;

  // IDAT — raw (store) deflate
  const rawRows = [];
  for (let y = 0; y < size; y++) {
    rawRows.push(0); // filter: none
    for (let x = 0; x < size; x++) {
      const i = (y * size + x) * 4;
      rawRows.push(pixels[i], pixels[i + 1], pixels[i + 2], pixels[i + 3]);
    }
  }

  const rawData = new Uint8Array(rawRows);
  const idat = deflateStore(rawData);

  // Assemble
  const chunks = [
    makeChunk('IHDR', ihdr),
    makeChunk('IDAT', idat),
    makeChunk('IEND', new Uint8Array(0)),
  ];

  const totalLen = 8 + chunks.reduce((s, c) => s + c.length, 0);
  const png = new Uint8Array(totalLen);
  let offset = 0;
  for (const b of signature) png[offset++] = b;
  for (const chunk of chunks) { png.set(chunk, offset); offset += chunk.length; }
  return Buffer.from(png);
}

function deflateStore(data) {
  // Wrap raw data in zlib store blocks
  const maxBlock = 65535;
  const blocks = [];
  for (let i = 0; i < data.length; i += maxBlock) {
    const end = Math.min(i + maxBlock, data.length);
    const len = end - i;
    const last = end >= data.length ? 1 : 0;
    blocks.push(last, len & 0xff, (len >> 8) & 0xff, (~len) & 0xff, ((~len) >> 8) & 0xff);
    for (let j = i; j < end; j++) blocks.push(data[j]);
  }

  // zlib header (CMF=0x78, FLG=0x01)
  const zlib = [0x78, 0x01, ...blocks];

  // Adler-32
  let a = 1, b = 0;
  for (let i = 0; i < data.length; i++) {
    a = (a + data[i]) % 65521;
    b = (b + a) % 65521;
  }
  const adler = ((b << 16) | a) >>> 0;
  zlib.push((adler >> 24) & 0xff, (adler >> 16) & 0xff, (adler >> 8) & 0xff, adler & 0xff);

  return new Uint8Array(zlib);
}

function makeChunk(type, data) {
  const chunk = new Uint8Array(12 + data.length);
  new DataView(chunk.buffer).setUint32(0, data.length);
  for (let i = 0; i < 4; i++) chunk[4 + i] = type.charCodeAt(i);
  chunk.set(data, 8);
  new DataView(chunk.buffer).setUint32(8 + data.length, crc32(chunk.subarray(4, 8 + data.length)));
  return chunk;
}

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    c ^= buf[i];
    for (let j = 0; j < 8; j++) c = (c >>> 1) ^ (c & 1 ? 0xedb88320 : 0);
  }
  return (c ^ 0xffffffff) >>> 0;
}

// Draw hexagon icon
function drawHexagon(pixels, size) {
  const cx = size / 2, cy = size / 2;
  const r = size * 0.4;
  const pts = [];
  for (let i = 0; i < 6; i++) {
    const angle = (Math.PI / 3) * i - Math.PI / 6;
    pts.push([cx + r * Math.cos(angle), cy + r * Math.sin(angle)]);
  }

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = (y * size + x) * 4;
      if (pointInPolygon(x, y, pts)) {
        // Accent blue: #1a73e8
        pixels[i] = 0x1a; pixels[i + 1] = 0x73; pixels[i + 2] = 0xe8; pixels[i + 3] = 255;
      } else {
        pixels[i] = pixels[i + 1] = pixels[i + 2] = pixels[i + 3] = 0;
      }
    }
  }
}

function pointInPolygon(px, py, pts) {
  let inside = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const [xi, yi] = pts[i], [xj, yj] = pts[j];
    if ((yi > py) !== (yj > py) && px < (xj - xi) * (py - yi) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

for (const size of [16, 48, 128]) {
  const png = createPng(size, drawHexagon);
  const path = resolve(outDir, `icon-${size}.png`);
  writeFileSync(path, png);
  console.log(`Generated ${path} (${png.length} bytes)`);
}
