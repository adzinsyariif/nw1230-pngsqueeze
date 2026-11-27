// Optimal-parsing DEFLATE compressor (zlib wrapper), in the manner of zopfli:
// hash-chain match search, a dynamic-programming parse that minimises the
// total bit cost under the current Huffman code lengths, two Huffman
// refinement iterations, and emission as dynamic-Huffman blocks (single
// block or split at fixed input intervals, whichever is smaller).
// Deterministic: every budget is counted in work (chain length, iterations),
// never in wall-clock time. Falls back to zlib level 9 if anything fails or
// if the optimal stream would not be smaller.

import { deflateSync, inflateSync } from 'node:zlib';

const MAX_CHAIN = 32; // hash-chain candidates examined per position
const GOOD_LEN = 64; // stop the chain walk once a match this long is found
const MAX_MATCH = 258;
const MIN_MATCH = 3;
const WINDOW = 32768;

// Length codes 257..285: base lengths and extra bits.
const LEN_BASE = [3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 15, 17, 19, 23, 27, 31, 35, 43, 51, 59, 67, 83, 99, 115, 131, 163, 195, 227, 258];
const LEN_EXTRA = [0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4, 5, 5, 5, 5, 0];
// Distance codes 0..29: base distances and extra bits.
const DIST_BASE = [1, 2, 3, 4, 5, 7, 9, 13, 17, 25, 33, 49, 65, 97, 129, 193, 257, 385, 513, 769, 1025, 1537, 2049, 3073, 4097, 6145, 8193, 12289, 16385, 24577];
const DIST_EXTRA = [0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7, 8, 8, 9, 9, 10, 10, 11, 11, 12, 12, 13, 13];

const LEN_CODE_OF = new Uint8Array(MAX_MATCH + 1); // length -> code index 0..28 (symbol 257+idx)
const LEN_EXTRA_OF = new Uint8Array(MAX_MATCH + 1);
for (let l = MIN_MATCH; l <= MAX_MATCH; l++) {
  let c = 0;
  while (c < 28 && LEN_BASE[c + 1] <= l) c++;
  LEN_CODE_OF[l] = c;
  LEN_EXTRA_OF[l] = LEN_EXTRA[c];
}
const DIST_CODE_OF = new Uint8Array(WINDOW + 1);
const DIST_EXTRA_OF = new Uint8Array(WINDOW + 1);
for (let d = 1; d <= WINDOW; d++) {
  let c = 0;
  while (c < 29 && DIST_BASE[c + 1] <= d) c++;
  DIST_CODE_OF[d] = c;
  DIST_EXTRA_OF[d] = DIST_EXTRA[c];
}

// ------------------------------------------------------------------ matches

// Hash of the 4 bytes at i (a 4-byte hash spends the chain budget on real
// matches; length-3 matches still arrive via seed propagation).
function hash4(data, i) {
  return Math.imul((data[i] << 24) | (data[i + 1] << 16) | (data[i + 2] << 8) | data[i + 3], 2654435761) >>> 16;
}

// Matches at i, searching the hash chain: up to MAX_PAIRS Pareto-optimal
// (length, distance) pairs -- no kept pair has both a length at least as
// large and a distance at most as large as another kept pair, so a shorter
// match at a much smaller distance (cheaper distance code) survives beside
// the longest match. `seedLen`/`seedDist` carry a propagated match from
// position i-1 (same distance, one byte shorter, known to match without
// comparing). Returns a flat [len, dist, len, dist, ...] array, longest
// first, possibly empty.
const MAX_PAIRS = 4;

function findMatches(data, i, head, prev, seedLen, seedDist) {
  const n = data.length;
  const maxLen = Math.min(MAX_MATCH, n - i);
  if (maxLen < MIN_MATCH) return [];
  const pairs = [];
  let bestLen = 0;
  const seed = Math.min(seedLen, maxLen);
  if (seed >= MIN_MATCH) {
    pairs.push([seed, seedDist]);
    bestLen = seed;
    // a propagated match at the maximum length cannot be beaten, only
    // matched at a smaller distance; skip the search (the saving in
    // distance-code bits is not worth the chain walk here)
    if (seed >= MAX_MATCH) return [seed, seedDist];
  }
  if (i + 3 >= n) return pairs.length > 0 ? [pairs[0][0], pairs[0][1]] : [];
  let cand = head[hash4(data, i)];
  let chain = MAX_CHAIN;
  const limit = Math.max(0, i - WINDOW);
  while (cand >= limit && chain-- > 0) {
    // quick reject: the byte just past the current best must match
    if (bestLen === 0 || data[cand + bestLen] === data[i + bestLen]) {
      let l = 0;
      while (l + 4 <= maxLen && data[cand + l] === data[i + l] && data[cand + l + 1] === data[i + l + 1] && data[cand + l + 2] === data[i + l + 2] && data[cand + l + 3] === data[i + l + 3]) l += 4;
      while (l < maxLen && data[cand + l] === data[i + l]) l++;
      if (l >= MIN_MATCH) {
        pairs.push([l, i - cand]);
        if (l > bestLen) {
          bestLen = l;
          if (l >= GOOD_LEN) break;
        }
      }
    }
    cand = prev[cand];
  }
  if (pairs.length === 0) return [];
  // Pareto frontier: sort by length descending (distance ascending on
  // ties), keep a pair only when its distance beats every longer pair's.
  pairs.sort((a, b) => b[0] - a[0] || a[1] - b[1]);
  const out = [];
  let minDist = Infinity;
  for (const [l, d] of pairs) {
    if (d < minDist) {
      out.push(l, d);
      minDist = d;
      if (out.length >= MAX_PAIRS * 2) break;
    }
  }
  return out;
}

// Matches at every position, computed once and reused by every parse.
// A match at i-1 of length L at distance D implies a match at i of length
// L-1 at distance D, which seeds the search (and its quick reject)
// without any byte comparisons.
function precomputeMatches(data) {
  const n = data.length;
  const pLen = new Uint16Array(n * MAX_PAIRS);
  const pDist = new Uint16Array(n * MAX_PAIRS);
  const head = new Int32Array(0x10000).fill(-1);
  const prev = new Int32Array(n).fill(-1);
  let seedLen = 0;
  let seedDist = 0;
  for (let i = 0; i < n; i++) {
    if (i + MIN_MATCH <= n) {
      const pairs = findMatches(data, i, head, prev, seedLen, seedDist);
      for (let k = 0; k + 1 < pairs.length; k += 2) {
        pLen[i * MAX_PAIRS + k / 2] = pairs[k];
        pDist[i * MAX_PAIRS + k / 2] = pairs[k + 1];
      }
      seedLen = pairs.length > 0 ? pairs[0] - 1 : 0;
      seedDist = pairs.length > 0 ? pairs[1] : 0;
    } else {
      seedLen = 0;
    }
    if (i + 3 < n) {
      const h = hash4(data, i);
      prev[i] = head[h];
      head[h] = i;
    }
  }
  return { pLen, pDist };
}

// ------------------------------------------------------------------ huffman

// Length-limited Huffman code lengths (at most maxBits).
// freq: array of counts (zeros allowed). Returns Uint8Array of lengths.
function huffmanLengths(freq, maxBits) {
  const n = freq.length;
  const lengths = new Uint8Array(n);
  const used = [];
  for (let i = 0; i < n; i++) if (freq[i] > 0) used.push(i);
  if (used.length === 0) return lengths;
  if (used.length === 1) {
    lengths[used[0]] = 1;
    return lengths;
  }
  // Package-merge (Moffat & Turpin): start from the leaves sorted by
  // weight; repeat maxBits-1 times { package consecutive pairs of the
  // current list, merge the packages with the leaves, keep the smallest
  // 2*(used-1) items }. A symbol's code length is then how often it appears
  // in the final list, packages expanded. (One round too many, or clamping
  // a count afterwards, breaks the Kraft equality.) Packages are nodes in
  // a pool (weight, left, right, symbol) so nothing is copied per round.
  const nodeWeight = [];
  const nodeLeft = [];
  const nodeRight = [];
  const nodeSymbol = [];
  const newNode = (weight, left, right, symbol) => {
    nodeWeight.push(weight);
    nodeLeft.push(left);
    nodeRight.push(right);
    nodeSymbol.push(symbol);
    return nodeWeight.length - 1;
  };
  const leaves = used
    .map((s) => newNode(freq[s], -1, -1, s))
    .sort((a, b) => nodeWeight[a] - nodeWeight[b] || nodeSymbol[a] - nodeSymbol[b]);
  let level = leaves;
  const keep = 2 * (used.length - 1);
  for (let round = 0; round < maxBits - 1; round++) {
    const packaged = [];
    for (let i = 0; i + 1 < level.length; i += 2) {
      packaged.push(newNode(nodeWeight[level[i]] + nodeWeight[level[i + 1]], level[i], level[i + 1], -1));
    }
    level = packaged.concat(leaves).sort((a, b) => nodeWeight[a] - nodeWeight[b]);
    if (level.length > keep) level.length = keep;
  }
  const counts = new Int32Array(n);
  const stack = [...level];
  while (stack.length > 0) {
    const node = stack.pop();
    if (nodeSymbol[node] >= 0) counts[nodeSymbol[node]]++;
    else {
      stack.push(nodeLeft[node]);
      stack.push(nodeRight[node]);
    }
  }
  for (const s of used) lengths[s] = counts[s];
  return lengths;
}

// Canonical codes from lengths: returns {codes: Uint32Array, lengths}.
function canonicalCodes(lengths) {
  const maxBits = 15;
  const blCount = new Int32Array(maxBits + 1);
  for (let i = 0; i < lengths.length; i++) if (lengths[i] > 0) blCount[lengths[i]]++;
  const next = new Int32Array(maxBits + 1);
  let code = 0;
  for (let b = 1; b <= maxBits; b++) {
    code = (code + blCount[b - 1]) << 1;
    next[b] = code;
  }
  const codes = new Uint32Array(lengths.length);
  for (let i = 0; i < lengths.length; i++) {
    if (lengths[i] > 0) codes[i] = next[lengths[i]]++;
  }
  return codes;
}

function reverseBits(code, len) {
  let r = 0;
  for (let i = 0; i < len; i++) {
    r = (r << 1) | (code & 1);
    code >>>= 1;
  }
  return r;
}

// ------------------------------------------------------------------ bit out

class BitWriter {
  constructor(capacity) {
    this.buf = new Uint8Array(capacity);
    this.pos = 0;
    this.acc = 0;
    this.accBits = 0;
  }
  ensure(extra) {
    if (this.pos + extra > this.buf.length) {
      const bigger = new Uint8Array(Math.max(this.buf.length * 2, this.pos + extra));
      bigger.set(this.buf.subarray(0, this.pos));
      this.buf = bigger;
    }
  }
  bits(value, count) {
    this.acc |= value << this.accBits;
    this.accBits += count;
    while (this.accBits >= 8) {
      this.ensure(1);
      this.buf[this.pos++] = this.acc & 0xff;
      this.acc >>>= 8;
      this.accBits -= 8;
    }
  }
  // Huffman codes are written most-significant bit first.
  code(codeValue, len) {
    this.bits(reverseBits(codeValue, len), len);
  }
  finish() {
    if (this.accBits > 0) {
      this.ensure(1);
      this.buf[this.pos++] = this.acc & 0xff;
      this.acc = 0;
      this.accBits = 0;
    }
    return this.buf.subarray(0, this.pos);
  }
}

// ------------------------------------------------------------------ emit

const CLEN_ORDER = [16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15];

function emitBlock(writer, tokens, startTok, endTok, isFinal) {
  const litFreq = new Int32Array(288);
  const distFreq = new Int32Array(32);
  for (let t = startTok; t < endTok; t++) {
    const tok = tokens[t];
    if (tok.len === 0) litFreq[tok.lit]++;
    else {
      litFreq[257 + LEN_CODE_OF[tok.len]]++;
      distFreq[DIST_CODE_OF[tok.dist]]++;
    }
  }
  litFreq[256]++;
  const litLen = huffmanLengths(litFreq, 15);
  const distLen = huffmanLengths(distFreq, 15);
  // a lone distance code of length 0 breaks some decoders; force length 1
  let anyDist = false;
  for (let i = 0; i < 32; i++) if (distLen[i] > 0) anyDist = true;
  if (!anyDist) distLen[0] = 1;
  let hlit = 288;
  while (hlit > 257 && litLen[hlit - 1] === 0) hlit--;
  let hdist = 32;
  while (hdist > 1 && distLen[hdist - 1] === 0) hdist--;
  // run-length encode the combined lengths
  const combined = [];
  for (let i = 0; i < hlit; i++) combined.push(litLen[i]);
  for (let i = 0; i < hdist; i++) combined.push(distLen[i]);
  const rle = []; // [symbol, extraValue, extraBits]
  const clenFreq = new Int32Array(19);
  const pushRle = (sym, extra, extraBits) => {
    rle.push([sym, extra, extraBits]);
    clenFreq[sym]++;
  };
  for (let i = 0; i < combined.length;) {
    const v = combined[i];
    let run = 1;
    while (i + run < combined.length && combined[i + run] === v) run++;
    if (v === 0) {
      let left = run;
      while (left >= 11) {
        const take = Math.min(138, left);
        pushRle(18, take - 11, 7);
        left -= take;
      }
      if (left >= 3) {
        pushRle(17, left - 3, 3);
        left = 0;
      }
      while (left-- > 0) pushRle(0, 0, 0);
    } else {
      pushRle(v, 0, 0);
      let left = run - 1;
      while (left >= 3) {
        const take = Math.min(6, left);
        pushRle(16, take - 3, 2);
        left -= take;
      }
      while (left-- > 0) pushRle(v, 0, 0);
    }
    i += run;
  }
  const clenLen = huffmanLengths(clenFreq, 7);
  let hclen = 19;
  while (hclen > 4 && clenLen[CLEN_ORDER[hclen - 1]] === 0) hclen--;
  const litCodes = canonicalCodes(litLen);
  const distCodes = canonicalCodes(distLen);
  const clenCodes = canonicalCodes(clenLen);
  writer.bits(isFinal ? 1 : 0, 1);
  writer.bits(2, 2); // dynamic Huffman
  writer.bits(hlit - 257, 5);
  writer.bits(hdist - 1, 5);
  writer.bits(hclen - 4, 4);
  for (let i = 0; i < hclen; i++) writer.bits(clenLen[CLEN_ORDER[i]], 3);
  for (const [sym, extra, extraBits] of rle) {
    writer.code(clenCodes[sym], clenLen[sym]);
    if (extraBits > 0) writer.bits(extra, extraBits);
  }
  for (let t = startTok; t < endTok; t++) {
    const tok = tokens[t];
    if (tok.len === 0) {
      writer.code(litCodes[tok.lit], litLen[tok.lit]);
    } else {
      const lc = LEN_CODE_OF[tok.len];
      writer.code(litCodes[257 + lc], litLen[257 + lc]);
      if (LEN_EXTRA[lc] > 0) writer.bits(tok.len - LEN_BASE[lc], LEN_EXTRA[lc]);
      const dc = DIST_CODE_OF[tok.dist];
      writer.code(distCodes[dc], distLen[dc]);
      if (DIST_EXTRA[dc] > 0) writer.bits(tok.dist - DIST_BASE[dc], DIST_EXTRA[dc]);
    }
  }
  writer.code(litCodes[256], litLen[256]);
}

function emitZlib(tokens, tokenInputPos, blockBytes) {
  const writer = new BitWriter(1 << 16);
  // block boundaries by input position covered
  const bounds = [0];
  if (blockBytes > 0) {
    let nextBound = blockBytes;
    for (let t = 0; t < tokens.length; t++) {
      if (tokenInputPos[t] >= nextBound && t > bounds[bounds.length - 1]) {
        bounds.push(t);
        nextBound += blockBytes;
      }
    }
  }
  bounds.push(tokens.length);
  for (let b = 0; b + 1 < bounds.length; b++) {
    emitBlock(writer, tokens, bounds[b], bounds[b + 1], b + 2 === bounds.length);
  }
  const deflated = writer.finish();
  return deflated;
}

function adler32(bytes) {
  let a = 1;
  let b = 0;
  for (let i = 0; i < bytes.length;) {
    const end = Math.min(bytes.length, i + 5552);
    for (; i < end; i++) {
      a += bytes[i];
      b += a;
    }
    a %= 65521;
    b %= 65521;
  }
  return ((b << 16) | a) >>> 0;
}

function wrapZlib(deflated, raw) {
  const out = new Uint8Array(2 + deflated.length + 4);
  out[0] = 0x78;
  out[1] = 0xda;
  out.set(deflated, 2);
  new DataView(out.buffer).setUint32(2 + deflated.length, adler32(raw));
  return out;
}

// ------------------------------------------------------------------ parse

// Largest length of each length-code bucket: within one bucket every length
// costs the same bits, so the DP only needs an edge at each bucket's top.
const LEN_BUCKET_TOP = LEN_BASE.map((base, c) => (c < 28 ? LEN_BASE[c + 1] - 1 : MAX_MATCH));

// A fast lazy-greedy parse over the precomputed matches, used only to get
// realistic symbol frequencies for the first DP parse's bit costs.
function greedyParse(data, matches) {
  const n = data.length;
  const tokens = [];
  const tokenInputPos = [];
  let i = 0;
  while (i < n) {
    const len = matches.pLen[i * MAX_PAIRS];
    if (len >= MIN_MATCH) {
      // lazy: a longer match one byte later wins over this one
      if (i + 1 < n && matches.pLen[(i + 1) * MAX_PAIRS] > len) {
        tokens.push({ lit: data[i], len: 0, dist: 0 });
        tokenInputPos.push(i);
        i++;
        continue;
      }
      tokens.push({ lit: 0, len, dist: matches.pDist[i * MAX_PAIRS] });
      tokenInputPos.push(i);
      i += len;
    } else {
      tokens.push({ lit: data[i], len: 0, dist: 0 });
      tokenInputPos.push(i);
      i++;
    }
  }
  return { tokens, tokenInputPos };
}

// One DP parse under the given bit costs, over the precomputed matches.
// Returns tokens [{lit} | {len,dist}] and each token's input position.
function parseWithCosts(data, matches, litBits, distBits) {
  const n = data.length;
  const distCost = new Int32Array(WINDOW + 1);
  for (let d = 1; d <= WINDOW; d++) distCost[d] = distBits[DIST_CODE_OF[d]] + DIST_EXTRA_OF[d];
  const cost = new Float64Array(n + 1).fill(Infinity);
  const fromPos = new Int32Array(n + 1).fill(-1);
  const fromLen = new Uint16Array(n + 1);
  const fromDist = new Uint16Array(n + 1);
  cost[0] = 0;
  for (let i = 0; i < n; i++) {
    if (!isFinite(cost[i])) continue;
    const litCost = cost[i] + litBits[data[i]];
    if (litCost < cost[i + 1]) {
      cost[i + 1] = litCost;
      fromPos[i + 1] = i;
      fromLen[i + 1] = 0;
      fromDist[i + 1] = 0;
    }
    const tryMatch = (mLen, mDist) => {
      if (mLen < MIN_MATCH) return;
      const dc = distCost[mDist];
      for (let cIdx = 0; cIdx < 29 && LEN_BASE[cIdx] <= mLen; cIdx++) {
        const l = Math.min(LEN_BUCKET_TOP[cIdx], mLen);
        const c = cost[i] + litBits[257 + cIdx] + LEN_EXTRA[cIdx] + dc;
        const j = i + l;
        if (c < cost[j]) {
          cost[j] = c;
          fromPos[j] = i;
          fromLen[j] = l;
          fromDist[j] = mDist;
        }
      }
    };
    for (let k = 0; k < MAX_PAIRS; k++) {
      const ml = matches.pLen[i * MAX_PAIRS + k];
      if (ml < MIN_MATCH) break;
      tryMatch(ml, matches.pDist[i * MAX_PAIRS + k]);
    }
  }
  // backtrack
  const tokens = [];
  const tokenInputPos = [];
  let p = n;
  const rev = [];
  while (p > 0) {
    const from = fromPos[p];
    if (from < 0) throw new Error('parse failed');
    if (fromLen[p] === 0) rev.push({ pos: from, lit: data[from], len: 0, dist: 0 });
    else rev.push({ pos: from, lit: 0, len: fromLen[p], dist: fromDist[p] });
    p = from;
  }
  rev.reverse();
  for (const t of rev) {
    tokens.push(t.len === 0 ? { lit: t.lit, len: 0, dist: 0 } : { lit: 0, len: t.len, dist: t.dist });
    tokenInputPos.push(t.pos);
  }
  return { tokens, tokenInputPos };
}

function frequencies(tokens) {
  const litFreq = new Int32Array(288);
  const distFreq = new Int32Array(32);
  for (const tok of tokens) {
    if (tok.len === 0) litFreq[tok.lit]++;
    else {
      litFreq[257 + LEN_CODE_OF[tok.len]]++;
      distFreq[DIST_CODE_OF[tok.dist]]++;
    }
  }
  litFreq[256]++;
  return { litFreq, distFreq };
}

// Compress `data` as a zlib stream with optimal parsing. Never throws:
// on any failure (or if not smaller) returns zlib level 9 instead.
export function optimalDeflate(data) {
  const fallback = () => new Uint8Array(deflateSync(data, { level: 9, memLevel: 9, strategy: 0 }));
  try {
    if (data.length < 64) return fallback();
    const matches = precomputeMatches(data);
    // initial bit costs from a fast greedy parse's symbol frequencies
    const greedy = greedyParse(data, matches);
    const gFreq = frequencies(greedy.tokens);
    let litBits = Int32Array.from(huffmanLengths(gFreq.litFreq, 15), (v) => (v === 0 ? 15 : v));
    let distBits = Int32Array.from(huffmanLengths(gFreq.distFreq, 15), (v) => (v === 0 ? 15 : v));
    // DP parses with Huffman refinement; more passes when the stream is
    // small enough that their cost stays bounded (counted in bytes of
    // input, never in time, so the choice is deterministic).
    const passes = 2;
    let parsed = null;
    for (let iter = 0; iter < passes; iter++) {
      parsed = parseWithCosts(data, matches, litBits, distBits);
      const { litFreq, distFreq } = frequencies(parsed.tokens);
      const litLen = huffmanLengths(litFreq, 15);
      const distLen = huffmanLengths(distFreq, 15);
      // symbols never used still need a finite cost for the next parse:
      // charge the maximum length so they stay unattractive but reachable
      litBits = Int32Array.from(litLen, (v) => (v === 0 ? 15 : v));
      distBits = Int32Array.from(distLen, (v) => (v === 0 ? 15 : v));
    }
    let best = null;
    for (const blockBytes of [0, 65536, 262144]) {
      const stream = wrapZlib(emitZlib(parsed.tokens, parsed.tokenInputPos, blockBytes), data);
      if (best === null || stream.length < best.length) best = stream;
    }
    // never hand back a stream that does not inflate to the input: an
    // invalid answer scores zero, so verify before trusting the parse
    const back = inflateSync(best);
    if (back.length !== data.length) return fallback();
    for (let i = 0; i < data.length; i++) if (back[i] !== data[i]) return fallback();
    const fb = fallback();
    return best.length < fb.length ? best : fb;
  } catch {
    return fallback();
  }
}
