// Reads the shop logo for the PDF on the server. The Branding screen saves the logo as a PNG data URL,
// so this decodes that PNG (8-bit, no interlace), flattens transparency on white and shrinks it to fit the report header.
// Returns null for anything else (for example a WebP fallback), so the report still goes out without a logo.
import { inflateSync } from "node:zlib";

const SIGNATURE = [137, 80, 78, 71, 13, 10, 26, 10];

/** Decodes a PNG buffer to { w, h, rgb } with the picture flattened on white. */
export function decodePng(buf) {
  for (let i = 0; i < SIGNATURE.length; i++) if (buf[i] !== SIGNATURE[i]) return null;
  let p = 8, w = 0, h = 0, depth = 0, type = 0, interlace = 0, palette = null, trns = null;
  const idat = [];
  while (p + 8 <= buf.length) {
    const len = buf.readUInt32BE(p);
    const kind = buf.toString("latin1", p + 4, p + 8);
    const data = buf.subarray(p + 8, p + 8 + len);
    p += 12 + len;
    if (kind === "IHDR") {
      w = data.readUInt32BE(0); h = data.readUInt32BE(4);
      depth = data[8]; type = data[9]; interlace = data[12];
    } else if (kind === "PLTE") palette = data;
    else if (kind === "tRNS") trns = data;
    else if (kind === "IDAT") idat.push(data);
    else if (kind === "IEND") break;
  }
  if (!w || !h || depth !== 8 || interlace !== 0) return null;
  const channels = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[type];
  if (!channels || (type === 3 && !palette)) return null;

  const stride = w * channels;
  const raw = inflateSync(Buffer.concat(idat));
  if (raw.length < h * (stride + 1)) return null;
  const pixels = Buffer.alloc(stride * h);
  let prev = Buffer.alloc(stride);
  for (let y = 0; y < h; y++) {
    const filter = raw[y * (stride + 1)];
    const line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    const cur = pixels.subarray(y * stride, (y + 1) * stride);
    for (let x = 0; x < stride; x++) {
      const a = x >= channels ? cur[x - channels] : 0;
      const b = prev[x];
      const c = x >= channels ? prev[x - channels] : 0;
      let v = line[x];
      if (filter === 1) v += a;
      else if (filter === 2) v += b;
      else if (filter === 3) v += (a + b) >> 1;
      else if (filter === 4) {
        const pp = a + b - c, pa = Math.abs(pp - a), pb = Math.abs(pp - b), pc = Math.abs(pp - c);
        v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      }
      cur[x] = v & 255;
    }
    prev = cur;
  }

  const rgb = new Uint8Array(w * h * 3);
  for (let i = 0, j = 0; i < w * h; i++, j += 3) {
    const o = i * channels;
    let r, g, b, alpha = 255;
    if (type === 0) { r = g = b = pixels[o]; }
    else if (type === 4) { r = g = b = pixels[o]; alpha = pixels[o + 1]; }
    else if (type === 2) { r = pixels[o]; g = pixels[o + 1]; b = pixels[o + 2]; }
    else if (type === 6) { r = pixels[o]; g = pixels[o + 1]; b = pixels[o + 2]; alpha = pixels[o + 3]; }
    else {
      const idx = pixels[o];
      r = palette[idx * 3] ?? 0; g = palette[idx * 3 + 1] ?? 0; b = palette[idx * 3 + 2] ?? 0;
      alpha = trns && idx < trns.length ? trns[idx] : 255;
    }
    rgb[j] = Math.round((r * alpha + 255 * (255 - alpha)) / 255);
    rgb[j + 1] = Math.round((g * alpha + 255 * (255 - alpha)) / 255);
    rgb[j + 2] = Math.round((b * alpha + 255 * (255 - alpha)) / 255);
  }
  return { w, h, rgb };
}

/** Shrinks an image to fit maxW x maxH by averaging the source pixels in each block. */
export function fitRgb(img, maxW, maxH) {
  const k = Math.min(1, maxW / img.w, maxH / img.h);
  const w = Math.max(1, Math.round(img.w * k)), h = Math.max(1, Math.round(img.h * k));
  if (w === img.w && h === img.h) return img;
  const out = new Uint8Array(w * h * 3);
  const sx = img.w / w, sy = img.h / h;
  for (let y = 0; y < h; y++) {
    const y0 = Math.floor(y * sy), y1 = Math.min(img.h, Math.max(y0 + 1, Math.floor((y + 1) * sy)));
    for (let x = 0; x < w; x++) {
      const x0 = Math.floor(x * sx), x1 = Math.min(img.w, Math.max(x0 + 1, Math.floor((x + 1) * sx)));
      let r = 0, g = 0, b = 0, n = 0;
      for (let yy = y0; yy < y1; yy++) {
        for (let xx = x0; xx < x1; xx++) {
          const j = (yy * img.w + xx) * 3;
          r += img.rgb[j]; g += img.rgb[j + 1]; b += img.rgb[j + 2]; n++;
        }
      }
      const o = (y * w + x) * 3;
      out[o] = Math.round(r / n); out[o + 1] = Math.round(g / n); out[o + 2] = Math.round(b / n);
    }
  }
  return { w, h, rgb: out };
}

/** The logo for the PDF header from the saved data URL, or null when it cannot be read. */
export function logoFromDataUrl(url, maxW = 240, maxH = 100) {
  const m = /^data:image\/png;base64,(.+)$/.exec(String(url || ""));
  if (!m) return null;
  try {
    const img = decodePng(Buffer.from(m[1], "base64"));
    return img ? fitRgb(img, maxW, maxH) : null;
  } catch {
    return null;
  }
}
