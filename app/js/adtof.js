// adtof.js — ADTOF Frame_RNN 推論(ONNX)+ madmom NotePeakPicking 移植
// 對照基準:Python adtof_transcribe(同音檔事件集合 F1 ≥ 0.99, |Δt| ≤ 10ms)
import { logMelSpectrogram } from './dsp.js';

export const LABELS = ["KICK", "SNARE", "TOM", "HH", "CYM"];
const PP_T = { KICK: 0.22, SNARE: 0.24, TOM: 0.32, HH: 0.22, CYM: 0.30 };
const FPS = 100;

// Python Model.predict 的 RNN 分窗:window=limitInputSize(60000), warmup=trainingSequence(412)
const WINDOW = 60000, WARMUP = 412;

export async function adtofTranscribe(ort, session, yMono, fbFlat, onProgress) {
  const { data, T, bands } = logMelSpectrogram(yMono, fbFlat);
  // 分窗推論(step = window - 2*warmup;取中段避免 RNN 暖機邊緣)
  const act = new Float32Array(T * 5);
  const step = WINDOW - 2 * WARMUP;
  let done = 0;
  for (let s = 0; s < T; s += step) {
    const a = Math.max(0, s - WARMUP);
    const b = Math.min(T, s + step + WARMUP);
    const len = b - a;
    const x = new ort.Tensor('float32', data.subarray(a * bands, b * bands), [1, len, bands, 1]);
    const res = await session.run({ x });
    const y = res[session.outputNames[0]].data;   // (1, len, 5)
    const c0 = s, c1 = Math.min(T, s + step);
    for (let f = c0; f < c1; f++) {
      const src = (f - a) * 5;
      for (let k = 0; k < 5; k++) act[f * 5 + k] = y[src + k];
    }
    done = c1;
    if (onProgress) onProgress(done / T);
    if (b >= T) break;
  }
  // per-label madmom peak picking
  const events = {};
  for (let k = 0; k < 5; k++) {
    const lbl = LABELS[k];
    const a1 = new Float32Array(T);
    for (let f = 0; f < T; f++) a1[f] = act[f * 5 + k];
    events[lbl] = peakPick(a1, PP_T[lbl]);
  }
  return { events, act, T };
}

// madmom.features.onsets.peak_picking 移植:
// pre_avg=0.1s post_avg=0.01s pre_max=0.02s post_max=0.01s combine=0.02s @fps=100
export function peakPick(act, threshold, fps = FPS,
                         preAvg = 0.1, postAvg = 0.01, preMax = 0.02, postMax = 0.01,
                         combine = 0.02) {
  const T = act.length;
  const pa = Math.round(preAvg * fps), qa = Math.round(postAvg * fps);
  const pm = Math.round(preMax * fps), qm = Math.round(postMax * fps);
  const out = [];
  let last = -Infinity;
  for (let i = 0; i < T; i++) {
    // 移動平均(madmom uniform_filter origin 對齊:窗 [i-pa, i+qa],含端)
    let s = 0, c = 0;
    for (let j = Math.max(0, i - pa); j <= Math.min(T - 1, i + qa); j++) { s += act[j]; c++; }
    const movAvg = c ? s / c : 0;
    if (act[i] < movAvg + threshold) continue;
    // 局部最大(窗 [i-pm, i+qm])
    let isMax = true;
    for (let j = Math.max(0, i - pm); j <= Math.min(T - 1, i + qm); j++) {
      if (act[j] > act[i]) { isMax = false; break; }
    }
    if (!isMax) continue;
    const t = i / fps;
    if (t - last < combine) continue;   // 合併過近
    last = t;
    out.push(t);
  }
  return out;
}
