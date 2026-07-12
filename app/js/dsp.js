// dsp.js — FFT / STFT / madmom 前處理重現 / 頻帶特徵(細分用)
// 對照基準:Python numpy 版(mean|diff| ≤ 1e-4)

// ── radix-2 迭代 FFT(實輸入,回傳前 n/2 個 bin 的振幅)──
export class FFT {
  constructor(n) {
    this.n = n;
    this.rev = new Uint32Array(n);
    let bits = Math.log2(n) | 0;
    for (let i = 0; i < n; i++) {
      let r = 0;
      for (let b = 0; b < bits; b++) r = (r << 1) | ((i >> b) & 1);
      this.rev[i] = r;
    }
    this.cos = new Float32Array(n / 2);
    this.sin = new Float32Array(n / 2);
    for (let i = 0; i < n / 2; i++) {
      this.cos[i] = Math.cos(-2 * Math.PI * i / n);
      this.sin[i] = Math.sin(-2 * Math.PI * i / n);
    }
    this.re = new Float64Array(n);
    this.im = new Float64Array(n);
  }
  // input: Float32Array(n)(已加窗);回傳 {re, im}(內部緩衝,呼叫者立即消費)
  forward(x) {
    const { n, rev, re, im } = this;
    for (let i = 0; i < n; i++) { re[i] = x[rev[i]]; im[i] = 0; }
    for (let len = 2; len <= n; len <<= 1) {
      const half = len >> 1, step = n / len;
      for (let i = 0; i < n; i += len) {
        for (let j = 0; j < half; j++) {
          const k = j * step;
          const c = this.cos[k], s = this.sin[k];
          const xr = re[i + j + half] * c - im[i + j + half] * s;
          const xi = re[i + j + half] * s + im[i + j + half] * c;
          re[i + j + half] = re[i + j] - xr; im[i + j + half] = im[i + j] - xi;
          re[i + j] += xr; im[i + j] += xi;
        }
      }
    }
    return { re, im };
  }
  magnitude(x, out) { // out: Float32Array(n/2)
    const { re, im } = this.forward(x);
    const h = this.n >> 1;
    for (let i = 0; i < h; i++) out[i] = Math.hypot(re[i], im[i]);
    return out;
  }
}

export function hann(n) {   // np.hanning(對稱窗)
  const w = new Float32Array(n);
  for (let i = 0; i < n; i++) w[i] = 0.5 - 0.5 * Math.cos(2 * Math.PI * i / (n - 1));
  return w;
}

// ── madmom log-filtered spectrogram 重現 ──
// y: Float32Array mono @44100;fb: Float32Array(1024*84);回傳 {data: Float32Array(T*84), T}
export function logMelSpectrogram(y, fbFlat, bands = 84, frameSize = 2048, hop = 441) {
  const pad = frameSize >> 1;
  const nFrames = Math.floor(y.length / hop) + 1;   // madmom FramedSignal 幀數
  const fft = new FFT(frameSize);
  const win = hann(frameSize);
  const seg = new Float32Array(frameSize);
  const mag = new Float32Array(frameSize >> 1);
  const out = new Float32Array(nFrames * bands);
  // 稀疏化 filterbank:每 band 的 (startBin, coeffs)
  const fbBands = [];
  for (let b = 0; b < bands; b++) {
    let s = -1, e = -1;
    for (let i = 0; i < 1024; i++) {
      const v = fbFlat[i * bands + b];
      if (v !== 0) { if (s < 0) s = i; e = i; }
    }
    const coef = new Float32Array(Math.max(0, e - s + 1));
    for (let i = s; i <= e; i++) coef[i - s] = fbFlat[i * bands + b];
    fbBands.push({ s, coef });
  }
  for (let f = 0; f < nFrames; f++) {
    const a = f * hop - pad;
    for (let i = 0; i < frameSize; i++) {
      const j = a + i;
      seg[i] = (j >= 0 && j < y.length ? y[j] : 0) * win[i];
    }
    fft.magnitude(seg, mag);
    const row = f * bands;
    for (let b = 0; b < bands; b++) {
      const { s, coef } = fbBands[b];
      let acc = 0;
      for (let k = 0; k < coef.length; k++) acc += mag[s + k] * coef[k];
      out[row + b] = Math.log10(acc + 1.0);
    }
  }
  return { data: out, T: nFrames, bands };
}

// ── onset envelope(簡化 SuperFlux):log-mel 正差分逐 band 求和,零均值 ──
// 供變速偵測:事件空洞區(稀疏 intro/break)的 BPM 證據(fps=100)
export function onsetEnvelope(y, fbFlat) {
  const { data, T, bands } = logMelSpectrogram(y, fbFlat);
  const env = new Float32Array(Math.max(0, T - 1));
  let mean = 0;
  for (let f = 1; f < T; f++) {
    let s = 0;
    for (let b = 0; b < bands; b++) {
      const d = data[f * bands + b] - data[(f - 1) * bands + b];
      if (d > 0) s += d;
    }
    env[f - 1] = s; mean += s;
  }
  if (env.length) {
    mean /= env.length;
    for (let i = 0; i < env.length; i++) env[i] -= mean;
  }
  return { env, fps: 100 };
}

// ── 細分用頻帶特徵(features.py 的 JS 版,只取細分需要的)──
// 對事件時刻 t(秒):attack/body/tail 三段 9 頻帶能量、高頻衰減、立體聲 LR
const BANDS_HZ = [20, 60, 120, 250, 500, 1000, 2000, 4000, 8000, 16000];
export function eventFeatures(yL, yR, sr, times) {
  const n = yL.length;
  const nfft = 2048;
  const fft = new FFT(nfft);
  const win = hann(nfft);
  const seg = new Float32Array(nfft);
  const mag = new Float32Array(nfft >> 1);
  const freqs = new Float32Array(nfft >> 1);
  for (let i = 0; i < nfft >> 1; i++) freqs[i] = i * sr / nfft;
  const yM = new Float32Array(n);
  for (let i = 0; i < n; i++) yM[i] = (yL[i] + yR[i]) / 2;

  const specAt = (t0, t1) => {
    const c = Math.round((t0 + t1) / 2 * sr) - (nfft >> 1);
    for (let i = 0; i < nfft; i++) {
      const j = c + i;
      seg[i] = (j >= 0 && j < n ? yM[j] : 0) * win[i];
    }
    fft.magnitude(seg, mag);
    const e = new Float64Array(9);
    for (let i = 0; i < mag.length; i++) {
      const fz = freqs[i], p = mag[i] * mag[i];
      for (let b = 0; b < 9; b++) if (fz >= BANDS_HZ[b] && fz < BANDS_HZ[b + 1]) { e[b] += p; break; }
    }
    return e;
  };
  const out = [];
  for (const t of times) {
    const atk = specAt(t - 0.005, t + 0.030);
    const body = specAt(t + 0.030, t + 0.090);
    const tail = specAt(t + 0.090, t + 0.180);
    const hi = a => a[6] + a[7] + a[8];
    const lo = a => a[0] + a[1] + a[2];
    const decayHigh = Math.log10((hi(tail) + 1e-12) / (hi(atk) + 1e-12));
    const decayLow = Math.log10((lo(tail) + 1e-12) / (lo(atk) + 1e-12));
    // tom 帶質心(60-750Hz)
    const centers = [40, 90, 185, 375, 750];
    let cw = 0, cs = 0;
    for (let b = 1; b <= 4; b++) { cw += atk[b]; cs += centers[b] * atk[b]; }
    const tomCentroid = cs / (cw + 1e-12);
    // 立體聲高頻 LR(一階差分近似高通)
    const b0 = Math.max(0, Math.round(t * sr)), b1 = Math.min(n, Math.round((t + 0.09) * sr));
    let el = 1e-12, er = 1e-12;
    for (let i = b0 + 1; i < b1; i++) {
      const dl = yL[i] - yL[i - 1], dr = yR[i] - yR[i - 1];
      el += dl * dl; er += dr * dr;
    }
    out.push({ atk, body, tail, decayHigh, decayLow, tomCentroid, lrHigh: Math.log10(el / er) });
  }
  return out;
}
