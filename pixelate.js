// Downscale in linear light, then k-means palette in OKLab.

// sRGB transfer curve
const SRGB_DECODE_THRESHOLD = 0.04045;
const SRGB_ENCODE_THRESHOLD = 0.0031308;
const SRGB_LINEAR_SLOPE = 12.92;
const SRGB_OFFSET = 0.055;
const SRGB_GAMMA = 2.4;

// OKLab, two 3x3 steps each way: linear sRGB <-> LMS cone response <-> Lab
const LINEAR_SRGB_TO_LMS = [
  [0.4122214708, 0.5363325363, 0.0514459929],
  [0.2119034982, 0.6806995451, 0.1073969566],
  [0.0883024619, 0.2817188376, 0.6299787005],
];
const LMS_TO_OKLAB = [
  [0.2104542553, 0.793617785, -0.0040720468],
  [1.9779984951, -2.428592205, 0.4505937099],
  [0.0259040371, 0.7827717662, -0.808675766],
];
const OKLAB_TO_LMS = [
  [1, 0.3963377774, 0.2158037573],
  [1, -0.1055613458, -0.0638541728],
  [1, -0.0894841775, -1.291485548],
];
const LMS_TO_LINEAR_SRGB = [
  [4.0767416621, -3.3077115913, 0.2309699292],
  [-1.2684380046, 2.6097574011, -0.3413193965],
  [-0.0041960863, -0.7034186147, 1.707614701],
];

const SRGB_TO_LINEAR = new Float32Array(256);
for (let i = 0; i < 256; i++) {
  const c = i / 255;
  SRGB_TO_LINEAR[i] =
    c <= SRGB_DECODE_THRESHOLD ? c / SRGB_LINEAR_SLOPE : ((c + SRGB_OFFSET) / (1 + SRGB_OFFSET)) ** SRGB_GAMMA;
}

function linearToSrgb8(v) {
  if (v <= 0) return 0;
  if (v >= 1) return 255;
  const c =
    v <= SRGB_ENCODE_THRESHOLD ? v * SRGB_LINEAR_SLOPE : (1 + SRGB_OFFSET) * v ** (1 / SRGB_GAMMA) - SRGB_OFFSET;
  return Math.round(c * 255);
}

function mul3(m, x, y, z) {
  return [
    m[0][0] * x + m[0][1] * y + m[0][2] * z,
    m[1][0] * x + m[1][1] * y + m[1][2] * z,
    m[2][0] * x + m[2][1] * y + m[2][2] * z,
  ];
}

function srgb8ToOklab(r8, g8, b8, out, o) {
  const lms = mul3(LINEAR_SRGB_TO_LMS, SRGB_TO_LINEAR[r8], SRGB_TO_LINEAR[g8], SRGB_TO_LINEAR[b8]);
  const [L, a, b] = mul3(LMS_TO_OKLAB, Math.cbrt(lms[0]), Math.cbrt(lms[1]), Math.cbrt(lms[2]));
  out[o] = L;
  out[o + 1] = a;
  out[o + 2] = b;
}

function oklabToLinear(L, a, b) {
  const [l, m, s] = mul3(OKLAB_TO_LMS, L, a, b).map((v) => v ** 3);
  return mul3(LMS_TO_LINEAR_SRGB, l, m, s);
}

function oklabToSrgb8(L, a, b) {
  return oklabToLinear(L, a, b).map((v) => linearToSrgb8(v));
}

function inSrgbGamut(L, a, b) {
  return oklabToLinear(L, a, b).every((v) => v >= -1e-4 && v <= 1 + 1e-4);
}

export function fitWithin(w, h, maxSide) {
  const longest = Math.max(w, h);
  if (longest <= maxSide) return { width: w, height: h };
  const s = maxSide / longest;
  return { width: Math.max(1, Math.round(w * s)), height: Math.max(1, Math.round(h * s)) };
}

// box filter, premultiplied alpha to avoid dark edges
export function downscale(src, width, height) {
  const { width: sw, height: sh, data: s } = src;
  const out = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++) {
    const y0 = Math.floor((y * sh) / height);
    const y1 = Math.max(y0 + 1, Math.floor(((y + 1) * sh) / height));
    for (let x = 0; x < width; x++) {
      const x0 = Math.floor((x * sw) / width);
      const x1 = Math.max(x0 + 1, Math.floor(((x + 1) * sw) / width));
      let r = 0, g = 0, b = 0, a = 0;
      for (let yy = y0; yy < y1; yy++) {
        for (let i = (yy * sw + x0) * 4, end = (yy * sw + x1) * 4; i < end; i += 4) {
          const pa = s[i + 3] / 255;
          r += SRGB_TO_LINEAR[s[i]] * pa;
          g += SRGB_TO_LINEAR[s[i + 1]] * pa;
          b += SRGB_TO_LINEAR[s[i + 2]] * pa;
          a += pa;
        }
      }
      const o = (y * width + x) * 4;
      if (a > 0) {
        out[o] = linearToSrgb8(r / a);
        out[o + 1] = linearToSrgb8(g / a);
        out[o + 2] = linearToSrgb8(b / a);
      }
      out[o + 3] = Math.round((a / ((y1 - y0) * (x1 - x0))) * 255);
    }
  }
  return { width, height, data: out };
}

// pixels under 50% alpha share one transparent entry at index 0
export function quantize(img, colors) {
  const { width, height, data } = img;
  const n = width * height;

  // cluster unique colors weighted by count, not every pixel
  const uniqueOf = new Map(); // 0xRRGGBB -> unique index
  const keys = [];
  const weights = [];
  const pixelUnique = new Int32Array(n);
  let transparent = 0;
  for (let p = 0; p < n; p++) {
    const i = p * 4;
    if (data[i + 3] < 128) {
      pixelUnique[p] = -1;
      transparent++;
      continue;
    }
    const key = (data[i] << 16) | (data[i + 1] << 8) | data[i + 2];
    let u = uniqueOf.get(key);
    if (u === undefined) {
      u = keys.length;
      uniqueOf.set(key, u);
      keys.push(key);
      weights.push(0);
    }
    weights[u]++;
    pixelUnique[p] = u;
  }

  const m = keys.length;
  const lab = new Float32Array(m * 3);
  for (let u = 0; u < m; u++) srgb8ToOklab(keys[u] >> 16, (keys[u] >> 8) & 255, keys[u] & 255, lab, u * 3);

  const offset = transparent > 0 ? 1 : 0;
  const k = Math.min(colors, 256 - offset);
  let centroids, assignment, clusterColors;
  if (m <= k) {
    centroids = lab;
    assignment = Int32Array.from({ length: m }, (_, u) => u);
    clusterColors = keys.map((key) => [key >> 16, (key >> 8) & 255, key & 255]);
  } else {
    ({ centroids, assignment } = kmeans(lab, weights, k));
    restoreChroma(lab, weights, assignment, centroids, k);
    clusterColors = [];
    for (let c = 0; c < k; c++) clusterColors.push(oklabToSrgb8(centroids[c * 3], centroids[c * 3 + 1], centroids[c * 3 + 2]));
  }

  // sort dark to light
  const order = clusterColors.map((_, c) => c).sort((a, b) => centroids[a * 3] - centroids[b * 3]);
  const rank = new Int32Array(order.length);
  order.forEach((c, i) => (rank[c] = i));

  const palette = offset ? [[0, 0, 0]] : [];
  for (const c of order) palette.push(clusterColors[c]);

  const indices = new Uint8Array(n);
  for (let p = 0; p < n; p++) {
    const u = pixelUnique[p];
    indices[p] = u < 0 ? 0 : rank[assignment[u]] + offset;
  }
  return { width, height, indices, palette, transparentIndex: offset ? 0 : -1 };
}

export function toRgba({ width, height, indices, palette, transparentIndex }) {
  const out = new Uint8ClampedArray(width * height * 4);
  for (let p = 0; p < indices.length; p++) {
    const idx = indices[p];
    if (idx === transparentIndex) continue;
    const [r, g, b] = palette[idx];
    out.set([r, g, b, 255], p * 4);
  }
  return out;
}

function kmeans(points, weights, k, maxIter = 40) {
  const m = weights.length;
  const rand = mulberry32(0x9e3779b9); // fixed seed -> deterministic palette
  const cent = new Float32Array(k * 3);
  const dist = new Float64Array(m).fill(Infinity);

  // k-means++ init
  for (let c = 0; c < k; c++) {
    let total = 0;
    for (let i = 0; i < m; i++) total += c === 0 ? weights[i] : weights[i] * dist[i];
    let r = rand() * total;
    let pick = m - 1;
    for (let i = 0; i < m; i++) {
      const w = c === 0 ? weights[i] : weights[i] * dist[i];
      if (w > 0 && (r -= w) <= 0) {
        pick = i;
        break;
      }
    }
    cent.set(points.subarray(pick * 3, pick * 3 + 3), c * 3);
    for (let i = 0; i < m; i++) {
      const d = sqDist(points, i * 3, cent, c * 3);
      if (d < dist[i]) dist[i] = d;
    }
  }

  const assign = new Int32Array(m);
  const sums = new Float64Array(k * 3);
  const wsum = new Float64Array(k);
  for (let iter = 0; ; iter++) {
    let changed = iter === 0;
    for (let i = 0; i < m; i++) {
      let best = 0, bestD = Infinity;
      for (let c = 0; c < k; c++) {
        const d = sqDist(points, i * 3, cent, c * 3);
        if (d < bestD) {
          bestD = d;
          best = c;
        }
      }
      dist[i] = bestD;
      if (assign[i] !== best) {
        assign[i] = best;
        changed = true;
      }
    }
    if (!changed || iter === maxIter - 1) break;

    sums.fill(0);
    wsum.fill(0);
    for (let i = 0; i < m; i++) {
      const c = assign[i], w = weights[i];
      sums[c * 3] += points[i * 3] * w;
      sums[c * 3 + 1] += points[i * 3 + 1] * w;
      sums[c * 3 + 2] += points[i * 3 + 2] * w;
      wsum[c] += w;
    }
    for (let c = 0; c < k; c++) {
      if (wsum[c] > 0) {
        for (let j = 0; j < 3; j++) cent[c * 3 + j] = sums[c * 3 + j] / wsum[c];
      } else {
        // empty cluster: reseed at the worst-fit color
        let worst = 0;
        for (let i = 1; i < m; i++) if (weights[i] * dist[i] > weights[worst] * dist[worst]) worst = i;
        cent.set(points.subarray(worst * 3, worst * 3 + 3), c * 3);
        dist[worst] = 0;
      }
    }
  }
  return { centroids: cent, assignment: assign };
}

// Averaging a cluster's a/b vectors cancels out its hue spread, so the centroid
// comes out grayer than the colors it stands for. Give each centroid the mean
// chroma of its members (same hue and lightness), clipped to the sRGB gamut.
function restoreChroma(points, weights, assignment, cent, k) {
  const chromaSum = new Float64Array(k);
  const wsum = new Float64Array(k);
  for (let i = 0; i < assignment.length; i++) {
    const c = assignment[i];
    chromaSum[c] += Math.hypot(points[i * 3 + 1], points[i * 3 + 2]) * weights[i];
    wsum[c] += weights[i];
  }
  for (let c = 0; c < k; c++) {
    const o = c * 3;
    const current = Math.hypot(cent[o + 1], cent[o + 2]);
    if (wsum[c] === 0 || current < 1e-6) continue; // gray centroid: no hue to push along
    let scale = chromaSum[c] / wsum[c] / current;
    if (scale <= 1) continue;
    if (!inSrgbGamut(cent[o], cent[o + 1] * scale, cent[o + 2] * scale)) {
      let lo = 1, hi = scale;
      for (let j = 0; j < 12; j++) {
        const mid = (lo + hi) / 2;
        if (inSrgbGamut(cent[o], cent[o + 1] * mid, cent[o + 2] * mid)) lo = mid;
        else hi = mid;
      }
      scale = lo;
    }
    cent[o + 1] *= scale;
    cent[o + 2] *= scale;
  }
}

function sqDist(a, i, b, j) {
  const d0 = a[i] - b[j], d1 = a[i + 1] - b[j + 1], d2 = a[i + 2] - b[j + 2];
  return d0 * d0 + d1 * d1 + d2 * d2;
}

function mulberry32(seed) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
