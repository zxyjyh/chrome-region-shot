// 最小 PNG 解码器：只支持 8-bit、colorType 2(RGB)/6(RGBA)、非隔行
// 用于在测试里读取截图像素、判断内容是否正确
const fs = require('fs');
const zlib = require('zlib');

function decodePNG(buf) {
  let off = 8;
  let w = 0, h = 0, bitDepth = 0, colorType = 0, interlace = 0;
  const idat = [];
  while (off < buf.length) {
    const len = buf.readUInt32BE(off);
    const type = buf.toString('ascii', off + 4, off + 8);
    const data = buf.subarray(off + 8, off + 8 + len);
    if (type === 'IHDR') {
      w = data.readUInt32BE(0);
      h = data.readUInt32BE(4);
      bitDepth = data[8];
      colorType = data[9];
      interlace = data[12];
    } else if (type === 'IDAT') {
      idat.push(data);
    } else if (type === 'IEND') break;
    off += 12 + len;
  }
  if (bitDepth !== 8 || interlace !== 0 || (colorType !== 2 && colorType !== 6)) {
    throw new Error(`不支持的 PNG: depth=${bitDepth} color=${colorType} interlace=${interlace}`);
  }
  const bpp = colorType === 6 ? 4 : 3;
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const stride = w * bpp;
  const out = Buffer.alloc(h * stride);

  const paeth = (a, b, c) => {
    const p = a + b - c;
    const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
    return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
  };

  for (let y = 0; y < h; y++) {
    const ft = raw[y * (stride + 1)];
    const src = raw.subarray(y * (stride + 1) + 1, y * (stride + 1) + 1 + stride);
    const cur = out.subarray(y * stride, (y + 1) * stride);
    const prev = y > 0 ? out.subarray((y - 1) * stride, y * stride) : null;
    for (let x = 0; x < stride; x++) {
      const a = x >= bpp ? cur[x - bpp] : 0;
      const b = prev ? prev[x] : 0;
      const c = prev && x >= bpp ? prev[x - bpp] : 0;
      let v = src[x];
      if (ft === 1) v += a;
      else if (ft === 2) v += b;
      else if (ft === 3) v += (a + b) >> 1;
      else if (ft === 4) v += paeth(a, b, c);
      cur[x] = v & 0xff;
    }
  }

  return {
    w,
    h,
    pixel(x, y) {
      const i = y * stride + x * bpp;
      return [out[i], out[i + 1], out[i + 2]];
    },
    rowSamples(step = 40) {
      const res = [];
      for (let y = Math.floor(step / 2); y < h; y += step) {
        res.push({ y, rgb: this.pixel(Math.floor(w / 2), y) });
      }
      return res;
    },
  };
}

const nameToColor = (rgb) => {
  const [r, g, b] = rgb;
  const near = (v, t) => Math.abs(v - t) < 40;
  if (near(r, 255) && near(g, 0) && near(b, 0)) return 'RED';
  if (near(r, 0) && near(g, 255) && near(b, 0)) return 'GREEN';
  if (near(r, 0) && near(g, 0) && near(b, 255)) return 'BLUE';
  if (near(r, 255) && near(g, 255) && near(b, 0)) return 'YELLOW';
  if (near(r, 255) && near(g, 0) && near(b, 255)) return 'MAGENTA';
  if (r > 240 && g > 240 && b > 240) return 'WHITE';
  return `rgb(${r},${g},${b})`;
};

module.exports = { decodePNG, nameToColor, readImage: (f) => decodePNG(fs.readFileSync(f)) };
