// png-squeeze entry: re-encode each 1280x720 RGBA screenshot as the smallest
// lossless PNG the contest decoder accepts (bit depth 8, non-interlaced,
// colour types 0/2/3/4/6, chunks IHDR/PLTE/tRNS/IDAT/IEND only).
//
// Method: decode the stored input PNG to RGBA, then screen every lossless
// representation of the same pixels (palette orderings when <=256 colours,
// grey / grey+alpha, RGB / RGBA, and a tRNS-keyed form when one fully
// transparent value is unused by opaque pixels) against several per-row
// filter strategies (fixed 0-4, minimum signed sum, fewest distinct byte
// pairs, lowest byte entropy, and a brute-force row search weighed by
// deflate against the preceding bytes). The winning filtered stream is
// compressed with the best of several zlib settings and an optimal-parsing
// deflater (deflate-opt.ts). Everything is deterministic: fixed search
// budgets counted in work, never in wall-clock time.

import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { deflateSync, inflateSync } from 'node:zlib';
import { optimalDeflate } from './deflate-opt.ts';

// ---------------------------------------------------------------- PNG write

const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(bytes, start, end) {
  let c = -1;
  for (let i = start; i < end; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

const SIGNATURE = [137, 80, 78, 71, 13, 10, 26, 10];

function buildPng(width, height, colourType, plte, trns, idat) {
  const chunks = [];
  const ihdr = new Uint8Array(13);
  const dv = new DataView(ihdr.buffer);
  dv.setUint32(0, width);
  dv.setUint32(4, height);
  ihdr[8] = 8;
  ihdr[9] = colourType;
  chunks.push(['IHDR', ihdr]);
  if (plte !== null) chunks.push(['PLTE', plte]);
  if (trns !== null) chunks.push(['tRNS', trns]);
  chunks.push(['IDAT', idat]);
  chunks.push(['IEND', new Uint8Array(0)]);
  let size = 8;
  for (const [, d] of chunks) size += 12 + d.length;
  const out = new Uint8Array(size);
  const view = new DataView(out.buffer);
  out.set(SIGNATURE, 0);
  let at = 8;
  for (const [type, data] of chunks) {
    view.setUint32(at, data.length);
    for (let i = 0; i < 4; i++) out[at + 4 + i] = type.charCodeAt(i);
    out.set(data, at + 8);
    view.setUint32(at + 8 + data.length, crc32(out, at + 4, at + 8 + data.length));
    at += 12 + data.length;
  }
  return out;
}

// ---------------------------------------------------------------- PNG read

function paethPred(a, b, c) {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  return pb <= pc ? b : c;
}

const CHANNELS = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };

// Decode an 8-bit non-interlaced PNG of colour type 0/2/3/4/6 to RGBA.
function decodeToRgba(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let at = 8;
  let width = 0;
  let height = 0;
  let colourType = 6;
  let palette = null;
  let trns = null;
  const idatParts = [];
  while (at < bytes.length) {
    const len = view.getUint32(at);
    const type = String.fromCharCode(bytes[at + 4], bytes[at + 5], bytes[at + 6], bytes[at + 7]);
    const data = bytes.subarray(at + 8, at + 8 + len);
    if (type === 'IHDR') {
      const d = new DataView(data.buffer, data.byteOffset, 13);
      width = d.getUint32(0);
      height = d.getUint32(4);
      colourType = data[9];
    } else if (type === 'PLTE') palette = data;
    else if (type === 'tRNS') trns = data;
    else if (type === 'IDAT') idatParts.push(data);
    else if (type === 'IEND') break;
    at += 12 + len;
  }
  const bpp = CHANNELS[colourType];
  const stride = width * bpp;
  const raw = inflateSync(idatParts.length === 1 ? idatParts[0] : Buffer.concat(idatParts));
  const samples = new Uint8Array(height * stride);
  for (let y = 0; y < height; y++) {
    const ft = raw[y * (stride + 1)];
    const src = y * (stride + 1) + 1;
    const o = y * stride;
    const p = o - stride;
    if (ft === 0) {
      samples.set(raw.subarray(src, src + stride), o);
    } else if (ft === 1) {
      for (let i = 0; i < stride; i++) samples[o + i] = raw[src + i] + (i >= bpp ? samples[o + i - bpp] : 0);
    } else if (ft === 2) {
      for (let i = 0; i < stride; i++) samples[o + i] = raw[src + i] + (y > 0 ? samples[p + i] : 0);
    } else if (ft === 3) {
      for (let i = 0; i < stride; i++) {
        samples[o + i] = raw[src + i] + (((i >= bpp ? samples[o + i - bpp] : 0) + (y > 0 ? samples[p + i] : 0)) >> 1);
      }
    } else {
      for (let i = 0; i < stride; i++) {
        const a = i >= bpp ? samples[o + i - bpp] : 0;
        const b = y > 0 ? samples[p + i] : 0;
        const c = y > 0 && i >= bpp ? samples[p + i - bpp] : 0;
        samples[o + i] = raw[src + i] + paethPred(a, b, c);
      }
    }
  }
  const n = width * height;
  const rgba = new Uint8Array(n * 4);
  if (colourType === 6) {
    rgba.set(samples);
  } else if (colourType === 2) {
    const key = trns === null ? -1 : (trns[1] << 16) | (trns[3] << 8) | trns[5];
    for (let i = 0, s = 0, d = 0; i < n; i++, s += 3, d += 4) {
      rgba[d] = samples[s];
      rgba[d + 1] = samples[s + 1];
      rgba[d + 2] = samples[s + 2];
      rgba[d + 3] = ((samples[s] << 16) | (samples[s + 1] << 8) | samples[s + 2]) === key ? 0 : 255;
    }
  } else if (colourType === 0) {
    const key = trns === null ? -1 : trns[1];
    for (let i = 0, d = 0; i < n; i++, d += 4) {
      const g = samples[i];
      rgba[d] = g;
      rgba[d + 1] = g;
      rgba[d + 2] = g;
      rgba[d + 3] = g === key ? 0 : 255;
    }
  } else if (colourType === 4) {
    for (let i = 0, s = 0, d = 0; i < n; i++, s += 2, d += 4) {
      rgba[d] = samples[s];
      rgba[d + 1] = samples[s];
      rgba[d + 2] = samples[s];
      rgba[d + 3] = samples[s + 1];
    }
  } else {
    for (let i = 0, d = 0; i < n; i++, d += 4) {
      const e = samples[i];
      rgba[d] = palette[e * 3];
      rgba[d + 1] = palette[e * 3 + 1];
      rgba[d + 2] = palette[e * 3 + 2];
      rgba[d + 3] = trns !== null && e < trns.length ? trns[e] : 255;
    }
  }
  return { width, height, rgba };
}

// ---------------------------------------------------------------- analysis

function wordsOf(rgba) {
  const at = rgba.byteOffset % 4 === 0 ? rgba : rgba.slice();
  return new Uint32Array(at.buffer, at.byteOffset, at.length >>> 2);
}

function analyse(rgba) {
  const n = rgba.length >>> 2;
  const u32 = wordsOf(rgba);
  let opaque = true;
  let grey = true;
  const counts = new Map();
  let many = false;
  for (let i = 0, d = 0; i < n; i++, d += 4) {
    if (rgba[d + 3] !== 255) opaque = false;
    if (rgba[d] !== rgba[d + 1] || rgba[d] !== rgba[d + 2]) grey = false;
    if (!many) {
      const c = u32[i];
      const k = counts.get(c);
      if (k === undefined) {
        if (counts.size === 256) many = true;
        else counts.set(c, 1);
      } else counts.set(c, k + 1);
    }
  }
  let colours = null;
  if (!many) {
    colours = [];
    for (const [word, count] of counts) {
      const b = new Uint8Array(Uint32Array.of(word).buffer);
      colours.push({ r: b[0], g: b[1], b: b[2], a: b[3], word, count });
    }
  }
  return { opaque, grey, colours };
}

// The single fully-transparent value usable as a tRNS key, or -1.
function transparentKey(rgba, grey) {
  let key = -1;
  for (let d = 0; d < rgba.length; d += 4) {
    const a = rgba[d + 3];
    if (a === 255) continue;
    if (a !== 0) return -1;
    const v = grey ? rgba[d] : (rgba[d] << 16) | (rgba[d + 1] << 8) | rgba[d + 2];
    if (key === -1) key = v;
    else if (key !== v) return -1;
  }
  if (key === -1) return -1;
  for (let d = 0; d < rgba.length; d += 4) {
    if (rgba[d + 3] !== 255) continue;
    const v = grey ? rgba[d] : (rgba[d] << 16) | (rgba[d + 1] << 8) | rgba[d + 2];
    if (v === key) return -1;
  }
  return key;
}

function channelSamples(rgba, ct) {
  const n = rgba.length >>> 2;
  if (ct === 6) return rgba;
  const ch = ct === 0 ? 1 : ct === 4 ? 2 : 3;
  const out = new Uint8Array(n * ch);
  for (let i = 0, d = 0, s = 0; i < n; i++, d += 4, s += ch) {
    if (ct === 0) out[s] = rgba[d];
    else if (ct === 4) {
      out[s] = rgba[d];
      out[s + 1] = rgba[d + 3];
    } else {
      out[s] = rgba[d];
      out[s + 1] = rgba[d + 1];
      out[s + 2] = rgba[d + 2];
    }
  }
  return out;
}

function paletteForm(rgba, colours, order) {
  const lum = (c) => 299 * c.r + 587 * c.g + 114 * c.b;
  const entries = [...colours].sort((x, y) => {
    const tx = x.a === 255 ? 1 : 0;
    const ty = y.a === 255 ? 1 : 0;
    if (tx !== ty) return tx - ty;
    if (tx === 0 && x.a !== y.a) return x.a - y.a;
    if (order === 'luminance') return lum(x) - lum(y) || x.word - y.word;
    if (order === 'first') return x.first - y.first;
    return y.count - x.count || x.word - y.word;
  });
  const index = new Map();
  entries.forEach((c, i) => index.set(c.word, i));
  const plte = new Uint8Array(entries.length * 3);
  let transparent = 0;
  entries.forEach((c, i) => {
    plte[i * 3] = c.r;
    plte[i * 3 + 1] = c.g;
    plte[i * 3 + 2] = c.b;
    if (c.a !== 255) transparent = i + 1;
  });
  const trns = transparent === 0 ? null : Uint8Array.from(entries.slice(0, transparent), (c) => c.a);
  const n = rgba.length >>> 2;
  const u32 = wordsOf(rgba);
  const indices = new Uint8Array(n);
  for (let i = 0; i < n; i++) indices[i] = index.get(u32[i]);
  return { plte, trns, indices };
}

// All lossless forms worth screening: {colourType, bpp, samples, plte, trns}.
function formsOf(rgba, info) {
  const forms = [];
  if (info.colours !== null) {
    // record first-appearance order for one palette ordering
    const seenAt = new Map();
    const u32 = wordsOf(rgba);
    for (let i = 0; i < u32.length; i++) if (!seenAt.has(u32[i])) seenAt.set(u32[i], i);
    for (const c of info.colours) c.first = seenAt.get(c.word);
    for (const order of ['count', 'luminance', 'first']) {
      const p = paletteForm(rgba, info.colours, order);
      forms.push({ colourType: 3, bpp: 1, samples: p.indices, plte: p.plte, trns: p.trns });
    }
    if (!info.grey) return forms;
  }
  const key = info.opaque ? -1 : transparentKey(rgba, info.grey);
  let ct;
  let trns = null;
  if (info.grey) {
    ct = info.opaque || key !== -1 ? 0 : 4;
    if (key !== -1) trns = Uint8Array.of(0, key);
  } else {
    ct = info.opaque || key !== -1 ? 2 : 6;
    if (key !== -1) trns = Uint8Array.of(0, key >>> 16, 0, (key >>> 8) & 0xff, 0, key & 0xff);
  }
  forms.push({ colourType: ct, bpp: CHANNELS[ct], samples: channelSamples(rgba, ct), plte: null, trns });
  return forms;
}

// ---------------------------------------------------------------- filtering

function filterRowInto(type, cur, prev, bpp, out) {
  const n = cur.length;
  if (type === 0) {
    out.set(cur);
  } else if (type === 1) {
    for (let i = 0; i < n; i++) out[i] = cur[i] - (i >= bpp ? cur[i - bpp] : 0);
  } else if (type === 2) {
    for (let i = 0; i < n; i++) out[i] = cur[i] - (prev === null ? 0 : prev[i]);
  } else if (type === 3) {
    for (let i = 0; i < n; i++) out[i] = cur[i] - (((i >= bpp ? cur[i - bpp] : 0) + (prev === null ? 0 : prev[i])) >> 1);
  } else {
    for (let i = 0; i < n; i++) {
      const a = i >= bpp ? cur[i - bpp] : 0;
      const b = prev === null ? 0 : prev[i];
      const c = prev !== null && i >= bpp ? prev[i - bpp] : 0;
      out[i] = cur[i] - paethPred(a, b, c);
    }
  }
}

function signedSum(row) {
  let s = 0;
  for (let i = 0; i < row.length; i++) {
    const v = row[i];
    s += v < 128 ? v : 256 - v;
  }
  return s;
}

const LOG2 = (() => {
  const t = new Float64Array(65537);
  for (let i = 1; i < t.length; i++) t[i] = Math.log2(i);
  return t;
})();

// choice: 0..4 fixed, or 'minsum' | 'pairs' | 'entropy' | 'brute'.
function filteredData(samples, width, height, bpp, choice) {
  const stride = width * bpp;
  const raw = new Uint8Array(height * (stride + 1));
  const trials = [];
  for (let t = 0; t < 5; t++) {
    const row = new Uint8Array(stride + 1);
    row[0] = t;
    trials.push(row);
  }
  const pairSeen = new Uint32Array(65536);
  let pairStamp = 0;
  const hist = new Int32Array(256);
  const touched = new Int32Array(256);
  for (let y = 0; y < height; y++) {
    const cur = samples.subarray(y * stride, (y + 1) * stride);
    const prev = y === 0 ? null : samples.subarray((y - 1) * stride, y * stride);
    const at = y * (stride + 1);
    if (typeof choice === 'number') {
      raw[at] = choice;
      filterRowInto(choice, cur, prev, bpp, raw.subarray(at + 1, at + 1 + stride));
      continue;
    }
    const before = raw.subarray(Math.max(0, at - 32768), at);
    let bestType = 0;
    let bestCost = Infinity;
    for (let t = 0; t < 5; t++) {
      const row = trials[t].subarray(1);
      filterRowInto(t, cur, prev, bpp, row);
      let cost;
      if (choice === 'minsum') {
        cost = signedSum(row);
      } else if (choice === 'pairs') {
        pairStamp++;
        let distinct = 0;
        for (let i = 1; i < row.length; i++) {
          const pair = (row[i - 1] << 8) | row[i];
          if (pairSeen[pair] !== pairStamp) {
            pairSeen[pair] = pairStamp;
            distinct++;
          }
        }
        cost = distinct;
      } else if (choice === 'entropy') {
        let nt = 0;
        for (let i = 0; i < row.length; i++) {
          const v = row[i];
          if (hist[v] === 0) touched[nt++] = v;
          hist[v]++;
        }
        let c = 0;
        for (let k = 0; k < nt; k++) {
          const cnt = hist[touched[k]];
          c += cnt * LOG2[cnt];
          hist[touched[k]] = 0;
        }
        cost = -c; // minimise -sum(c log c) == minimise entropy
      } else {
        // brute: weigh the row by deflate after the bytes already written
        cost = deflateSync(trials[t], before.length === 0
          ? { level: 4, memLevel: 9 }
          : { level: 4, memLevel: 9, dictionary: before }).length;
      }
      if (cost < bestCost) {
        bestCost = cost;
        bestType = t;
      }
    }
    raw.set(trials[bestType], at);
  }
  return raw;
}

// ---------------------------------------------------------------- screening

const SCREEN_OPTS = { level: 6, memLevel: 8, strategy: 0 };
// Stage A1 ranks the forms with two choices; stage A2 gives the two best
// forms the remaining choices. (Fixed Up/Average whole-image filters are
// left out: the adaptive choices already consider them row by row.)
const RANK_CHOICES = [0, 'minsum'];
const EXTRA_CHOICES = [1, 4, 'pairs', 'entropy'];

function chunkOverhead(form) {
  return (form.plte === null ? 0 : 12 + form.plte.length) + (form.trns === null ? 0 : 12 + form.trns.length);
}

function squeeze(rgba, width, height) {
  const info = analyse(rgba);
  const forms = formsOf(rgba, info);
  // Phase A: rank every form with two filter choices at zlib level 6,
  // then give the two best forms the remaining choices.
  const perFormBest = [];
  for (const form of forms) {
    let best = null;
    for (const choice of RANK_CHOICES) {
      const data = filteredData(form.samples, width, height, form.bpp, choice);
      const bytes = deflateSync(data, SCREEN_OPTS).length + chunkOverhead(form);
      if (best === null || bytes < best.bytes) best = { form, choice, data, bytes };
    }
    perFormBest.push(best);
  }
  perFormBest.sort((a, b) => a.bytes - b.bytes);
  for (const cand of perFormBest.slice(0, 2)) {
    for (const choice of EXTRA_CHOICES) {
      const data = filteredData(cand.form.samples, width, height, cand.form.bpp, choice);
      const bytes = deflateSync(data, SCREEN_OPTS).length + chunkOverhead(cand.form);
      if (bytes < cand.bytes) {
        cand.choice = choice;
        cand.data = data;
        cand.bytes = bytes;
      }
    }
  }
  perFormBest.sort((a, b) => a.bytes - b.bytes);
  // Phase B: brute-force row search on the best form, plus the best form
  // of a different colour type when there is one (brute force is the
  // priciest screening step, and two orderings of one colour type rarely
  // both need it).
  const candidates = [...perFormBest];
  const bruteForms = [perFormBest[0]];
  const otherType = perFormBest.find((c) => c.form.colourType !== perFormBest[0].form.colourType);
  if (otherType !== undefined && otherType.bytes <= perFormBest[0].bytes * 1.02) bruteForms.push(otherType);
  for (const cand of bruteForms) {
    const data = filteredData(cand.form.samples, width, height, cand.form.bpp, 'brute');
    const bytes = deflateSync(data, SCREEN_OPTS).length + chunkOverhead(cand.form);
    candidates.push({ form: cand.form, choice: 'brute', data, bytes });
  }
  candidates.sort((a, b) => a.bytes - b.bytes);
  // Phase C: final compression trials on the two best filtered streams.
  // The best stream gets every zlib setting, the runner-up one; the
  // (pricier) optimal-parsing deflater runs only on whichever candidate
  // zlib compressed best.
  let winner = null;
  let bestZlibCand = null;
  let bestZlibTotal = Infinity;
  candidates
    .filter((cand, rank) => rank === 0 || cand.bytes <= candidates[0].bytes * 1.03)
    .slice(0, 2)
    .forEach((cand, rank) => {
    const overhead = chunkOverhead(cand.form);
    const streams = [deflateSync(cand.data, { level: 9, memLevel: 9, strategy: 0 })];
    if (rank === 0) {
      streams.push(deflateSync(cand.data, { level: 9, memLevel: 9, strategy: 1 }));
      streams.push(deflateSync(cand.data, { level: 9, memLevel: 8, strategy: 0 }));
    }
    for (const s of streams) {
      const total = s.length + overhead;
      if (winner === null || total < winner.total) winner = { form: cand.form, idat: s, total };
      if (total < bestZlibTotal) {
        bestZlibTotal = total;
        bestZlibCand = cand;
      }
    }
  });
  if (bestZlibCand !== null) {
    const s = optimalDeflate(bestZlibCand.data);
    const total = s.length + chunkOverhead(bestZlibCand.form);
    if (total < winner.total) winner = { form: bestZlibCand.form, idat: s, total };
  }
  return buildPng(width, height, winner.form.colourType, winner.form.plte, winner.form.trns, winner.idat);
}

// ---------------------------------------------------------------- main

const I = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const O = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';
for (const id of readdirSync(I).sort()) {
  const image = decodeToRgba(new Uint8Array(readFileSync(join(I, id, 'image.png'))));
  mkdirSync(join(O, id), { recursive: true });
  writeFileSync(join(O, id, 'image.png'), squeeze(image.rgba, image.width, image.height));
}
