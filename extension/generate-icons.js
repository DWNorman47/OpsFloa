// Generate icons/icon{16,48,128}.png — a white padlock on an indigo rounded square.
// No dependencies: raw RGBA → PNG via zlib. Re-run to regenerate.
const fs = require('fs');
const zlib = require('zlib');
const path = require('path');

const CRC = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; }
  return (buf) => { let c = 0xffffffff; for (let i = 0; i < buf.length; i++) c = t[(c ^ buf[i]) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
})();
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length, 0);
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(CRC(td), 0);
  return Buffer.concat([len, td, crc]);
}
function png(size, rgba) {
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; ihdr[9] = 6; // 8-bit, RGBA
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) { raw[y * (size * 4 + 1)] = 0; rgba.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4); }
  return Buffer.concat([sig, chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0))]);
}

function roundRect(x, y, x0, y0, x1, y1, r) {
  if (x < x0 || x > x1 || y < y0 || y > y1) return false;
  const nx = x < x0 + r ? x0 + r : (x > x1 - r ? x1 - r : x);
  const ny = y < y0 + r ? y0 + r : (y > y1 - r ? y1 - r : y);
  return Math.hypot(x - nx, y - ny) <= r;
}

function draw(size) {
  const rgba = Buffer.alloc(size * size * 4); // transparent
  const ind = [79, 70, 229], white = [255, 255, 255];
  const S = size;
  const set = (x, y, c, a = 255) => { const i = (y * S + x) * 4; rgba[i] = c[0]; rgba[i + 1] = c[1]; rgba[i + 2] = c[2]; rgba[i + 3] = a; };
  for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
    if (!roundRect(x + .5, y + .5, .5, .5, S - .5, S - .5, S * 0.22)) continue; // rounded indigo square
    set(x, y, ind);
    const cx = S * 0.5;
    // shackle (top half of a ring)
    const d = Math.hypot(x + .5 - cx, y + .5 - S * 0.46);
    if (y + .5 <= S * 0.5 && d <= S * 0.2 && d >= S * 0.12) { set(x, y, white); continue; }
    // body
    if (roundRect(x + .5, y + .5, S * 0.30, S * 0.48, S * 0.70, S * 0.80, S * 0.07)) {
      // keyhole
      if (Math.hypot(x + .5 - cx, y + .5 - S * 0.60) <= S * 0.045) set(x, y, ind);
      else set(x, y, white);
    }
  }
  return rgba;
}

const outDir = path.join(__dirname, 'icons');
fs.mkdirSync(outDir, { recursive: true });
for (const s of [16, 48, 128]) fs.writeFileSync(path.join(outDir, `icon${s}.png`), png(s, draw(s)));
console.log('Wrote icons/icon16.png, icon48.png, icon128.png');
