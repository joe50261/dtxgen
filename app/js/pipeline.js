// pipeline.js — 細分(fusion-lite)、BPM 估計與量化、GBDT 難度簡化、DTX 寫出
// 各段對照基準:Python 版(見 webfe/tests/)

// ═══════════ fusion-lite:5 類 → 10 類細分 ═══════════
// Python 版用 keysound NMF 激活比;JS 版用頻帶特徵替代(端到端 F1 把關)
import { eventFeatures } from './dsp.js';

export function fuseAndSplit(adtofEvents, yL, yR, sr) {
  const events = [];   // {t, cls}
  for (const t of adtofEvents.KICK) events.push({ t, cls: 'KICK' });
  for (const t of adtofEvents.SNARE) events.push({ t, cls: 'SNARE' });
  for (const t of adtofEvents.TOM) events.push({ t, cls: 'TOM' });
  for (const t of adtofEvents.HH) events.push({ t, cls: 'HH' });
  for (const t of adtofEvents.CYM) events.push({ t, cls: 'CYM' });
  events.sort((a, b) => a.t - b.t);
  const feats = eventFeatures(yL, yR, sr, events.map(e => e.t));

  // HH 開/閉:高頻衰減 per-song 2-means(open 衰減慢 → decayHigh 大)
  const hhIdx = events.map((e, i) => e.cls === 'HH' ? i : -1).filter(i => i >= 0);
  const hhOpen = new Set();
  if (hhIdx.length >= 8) {
    const v = hhIdx.map(i => feats[i].decayHigh);
    let c0 = percentile(v, 25), c1 = percentile(v, 75);
    for (let it = 0; it < 20; it++) {
      const g0 = [], g1 = [];
      for (const x of v) (Math.abs(x - c0) < Math.abs(x - c1) ? g0 : g1).push(x);
      if (!g0.length || !g1.length) break;
      c0 = mean(g0); c1 = mean(g1);
    }
    if (Math.abs(c1 - c0) > 0.25) {
      const hiC = Math.max(c0, c1), border = (c0 + c1) / 2;
      hhIdx.forEach((i, k) => { if (v[k] > border) hhOpen.add(i); });
      // open 群不應過半(慣例上 closed 為主)— 過半則翻轉判斷失敗,全閉
      if (hhOpen.size > hhIdx.length * 0.6) hhOpen.clear();
    }
  }
  // CYM 左右:lrHigh 2-means(分離不足全歸右)
  const cyIdx = events.map((e, i) => e.cls === 'CYM' ? i : -1).filter(i => i >= 0);
  const cyLeft = new Set();
  if (cyIdx.length >= 6) {
    const v = cyIdx.map(i => feats[i].lrHigh);
    let c0 = percentile(v, 25), c1 = percentile(v, 75);
    for (let it = 0; it < 20; it++) {
      const g0 = [], g1 = [];
      for (const x of v) (Math.abs(x - c0) < Math.abs(x - c1) ? g0 : g1).push(x);
      if (!g0.length || !g1.length) break;
      c0 = mean(g0); c1 = mean(g1);
    }
    if (Math.abs(c1 - c0) > 0.28) {
      const loC = Math.min(c0, c1);
      cyIdx.forEach((i, k) => {
        if (Math.abs(v[k] - loC) < Math.abs(v[k] - Math.max(c0, c1))) cyLeft.add(i);
      });
    }
  }
  // TOM 高低:tom 帶質心三分位
  const tomIdx = events.map((e, i) => e.cls === 'TOM' ? i : -1).filter(i => i >= 0);
  const tomCls = new Map();
  if (tomIdx.length >= 6) {
    const v = tomIdx.map(i => feats[i].tomCentroid);
    const q33 = percentile(v, 33), q66 = percentile(v, 66);
    tomIdx.forEach((i, k) => {
      tomCls.set(i, v[k] > q66 ? 'TOM_H' : (v[k] > q33 ? 'TOM_L' : 'TOM_F'));
    });
  } else tomIdx.forEach(i => tomCls.set(i, 'TOM_L'));

  const out = [];
  events.forEach((e, i) => {
    let cls = e.cls;
    if (cls === 'HH') cls = hhOpen.has(i) ? 'HH_O' : 'HH_C';
    else if (cls === 'CYM') cls = cyLeft.has(i) ? 'LCRASH' : 'CRASH';
    else if (cls === 'TOM') cls = tomCls.get(i) || 'TOM_L';
    out.push({ t: e.t, cls });
  });
  // 物理規則:鈸與 hihat 同刻(±25ms)去 hihat
  const cyT = out.filter(e => e.cls === 'CRASH' || e.cls === 'LCRASH').map(e => e.t);
  return out.filter(e => {
    if (e.cls === 'HH_C' || e.cls === 'HH_O')
      for (const t of cyT) if (Math.abs(t - e.t) <= 0.025) return false;
    return true;
  });
}

const mean = a => a.reduce((s, x) => s + x, 0) / a.length;
function percentile(arr, p) {
  const a = [...arr].sort((x, y) => x - y);
  const i = (a.length - 1) * p / 100;
  const lo = Math.floor(i), hi = Math.ceil(i);
  return a[lo] + (a[hi] - a[lo]) * (i - lo);
}

// ═══════════ BPM 估計(分段變速)+ 整數格點精修(quantize.py 移植)═══════════
// 模型(逆向自真實譜面):歌曲 = K 段恆定 BPM,變速點落在小節線;
// 恆定曲(K=1)行為與舊版完全一致。
// Python 版以 madmom DBN 拍點找變速點;JS 無 madmom → 改事件驅動:
// 滑動窗局部 BPM 序列的持續躍遷即變速候選,切點以兩側網格殘差 argmin 精修。

function _scanBpm(ts, lo, hi) {
  // 整數粗掃(0.98 先驗)+ ±0.3% 細掃 + 半速歸簡。
  // 倍速網格是正確網格的超集、殘差只小不大 → 半速「幾乎沒變差」(<8%)
  // 即歸簡(防 105 被估成 210);歸簡下限同掃描下限 — 純 8 分 pattern 時
  // 半速與原速資訊等價,只能靠範圍先驗裁決(Python 版 oct 摺疊同款)。
  let best = { score: Infinity, bpm: 120, phase: ts[0] || 0 };
  for (let b = Math.ceil(lo); b <= Math.floor(hi); b++) {
    const r = refinePhase(ts, b, ts[0]);
    const score = r.score * 0.98;
    if (score < best.score) best = { score, bpm: b, phase: r.phase };
  }
  if (best.bpm / 2 >= lo) {
    const h = refinePhase(ts, best.bpm / 2, ts[0]);
    if (h.score * 0.98 < best.score * 1.08)
      best = { score: h.score * 0.98, bpm: best.bpm / 2, phase: h.phase };
  }
  for (let v = best.bpm * 0.997; v <= best.bpm * 1.003; v += 0.02) {
    const r = refinePhase(ts, v, best.phase);
    if (r.score < best.score) best = { score: r.score, bpm: v, phase: r.phase };
  }
  return best;
}

function _segmentByResidual(ts, g, lo, hi) {
  // 殘差驅動分段:全域最優網格下,異速段的殘差必然系統性偏高(兩網格不相容)。
  // 高殘差連續區間 → 單獨估 BPM → 需「明顯不同(≥4%)且殘差改善 ≥40%」才立段
  // — rit./演奏鬆散的高殘差套不上任何恆定 BPM,自然過不了改善驗證,防誤切。
  // (滑動窗局部 BPM 序列在稀疏 intro 湊不齊每窗證據 — eternal 前 16s 實測踩坑;
  //  殘差法只需異段「整體」夠 15 顆,對稀疏段穩健。)
  const g16 = 60 / g.bpm / 4;
  const res = ts.map(t => { const p = (t - g.phase) / g16; return Math.min(Math.abs(p - Math.round(p)) * g16, 0.030); });
  const t0 = ts[0], t1 = ts[ts.length - 1];
  const marks = [];
  for (let s = t0; s < t1 - 2; s += 1) {          // 4s 窗 / 1s 步的殘差均值
    let sum = 0, n = 0;
    for (let i = 0; i < ts.length; i++) if (ts[i] >= s && ts[i] < s + 4) { sum += res[i]; n++; }
    marks.push({ tc: s + 2, bad: n >= 6 && sum / n > 0.012 });
  }
  const zones = [];
  let cur = null;
  for (const m of marks) {
    if (m.bad) { if (!cur) cur = { s: m.tc - 2, e: m.tc + 2 }; else cur.e = m.tc + 2; }
    else if (cur) { zones.push(cur); cur = null; }
  }
  if (cur) zones.push(cur);
  const out = [];
  for (const z of zones) {
    if (z.e - z.s < 8) continue;
    if (z.e >= t1 - 2 && z.e - z.s < 16) continue;   // 曲末短異段=rit.,譜師慣例 BPM 一路到底
    const w = ts.filter(t => t >= z.s && t < z.e);
    if (w.length < 15) continue;
    const r = _scanBpm(w, lo, hi);
    if (Math.max(r.bpm, g.bpm) / Math.min(r.bpm, g.bpm) < 1.04) continue;
    let before = 0, after = 0;
    const z16 = 60 / r.bpm / 4;
    for (const t of w) {
      const p0 = (t - g.phase) / g16; before += Math.min(Math.abs(p0 - Math.round(p0)) * g16, 0.030);
      const p1 = (t - r.phase) / z16; after += Math.min(Math.abs(p1 - Math.round(p1)) * z16, 0.030);
    }
    if (after > before * 0.6) continue;
    out.push({ s: z.s, e: z.e, bpm: Math.round(r.bpm * 100) / 100, phase: r.phase });
  }
  return out;
}

function _gapSegments(ts, onset, lo, hi, gBpm) {
  // 事件空洞(>6s)但音樂仍在的區間(稀疏 intro/break — ADTOF 無鼓可報):
  // BPM 用 onset envelope 自相關,相位用梳狀對齊。與主段 ≥4% 差才立段。
  // (eternal 前 16s 只有 4 顆鼓事件,但 envelope 自相關明確給出 105 — 實測依據)
  if (!onset || !onset.env || onset.env.length < 400) return [];
  const { env, fps } = onset;
  let allRms = 0;
  for (let j = 0; j < env.length; j++) allRms += env[j] * env[j];
  allRms = Math.sqrt(allRms / env.length);
  const gaps = [];
  if (ts[0] > 6) gaps.push({ s: 0, e: ts[0] });
  for (let i = 1; i < ts.length; i++)
    if (ts[i] - ts[i - 1] > 6) gaps.push({ s: ts[i - 1], e: ts[i] });
  const out = [];
  for (const gz of gaps) {
    // 貪婪吸收:空洞左緣 2s 內的零星事件簇併入(它們屬於同一異速段)
    let s = gz.s;
    let k = 0;
    while (k < ts.length && ts[k] <= gz.s + 1e-9) k++;
    while (k > 0 && s - ts[k - 1] < 2) { s = ts[k - 1]; k--; }
    const e = gz.e;
    if (e - s < 8) continue;
    const a = Math.max(0, Math.floor(s * fps)), b = Math.min(env.length, Math.floor(e * fps));
    let rms = 0;
    for (let j = a; j < b; j++) rms += env[j] * env[j];
    rms = Math.sqrt(rms / Math.max(1, b - a));
    if (rms < allRms * 0.25) continue;   // 真靜默(音樂還沒開始)→ 不成段
    // 自相關 → 拍週期
    const lagLo = Math.max(2, Math.floor(60 * fps / hi)), lagHi = Math.ceil(60 * fps / lo);
    let bestLag = -1, bestV = -Infinity;
    for (let l = lagLo; l <= Math.min(lagHi, b - a - 2); l++) {
      let v = 0;
      for (let j = a; j + l < b; j++) v += env[j] * env[j + l];
      if (v > bestV) { bestV = v; bestLag = l; }
    }
    if (bestLag < 0) continue;
    const bpm0 = 60 * fps / bestLag;
    // 梳狀相位對齊 + 整數細化(整數候選 1.02 加成)
    let bpm = bpm0, phase = s, bestScore = -Infinity;
    for (const v of [Math.round(bpm0) - 1, Math.round(bpm0), Math.round(bpm0) + 1, bpm0]) {
      if (v < lo || v > hi) continue;
      const per = 60 / v;
      for (let ph = 0; ph < per; ph += 0.005) {
        let sc = 0, n = 0;
        for (let t = s + ph; t < e; t += per) {
          const idx = Math.round(t * fps);
          if (idx >= 0 && idx < env.length) { sc += env[idx]; n++; }
        }
        sc = n ? sc / n : -Infinity;
        if (Number.isInteger(v)) sc *= 1.02;
        if (sc > bestScore) { bestScore = sc; bpm = v; phase = s + ph; }
      }
    }
    if (Math.max(bpm, gBpm) / Math.min(bpm, gBpm) < 1.04) continue;
    // 事件不足的段取整數 BPM(quantize.py 同款:<15 顆時 bpm=round(base))
    // — envelope 自相關峰位有 ±0.3% 級誤差,整數先驗是譜面慣例
    if (Math.abs(bpm - Math.round(bpm)) / bpm < 0.01) {
      const v = Math.round(bpm);
      const per = 60 / v;
      let bs = -Infinity;
      for (let ph = 0; ph < per; ph += 0.005) {
        let sc = 0, m = 0;
        for (let t = s + ph; t < e; t += per) {
          const idx = Math.round(t * fps);
          if (idx >= 0 && idx < env.length) { sc += env[idx]; m++; }
        }
        if (m && sc / m > bs) { bs = sc / m; phase = s + ph; }
      }
      bpm = v;
    }
    out.push({ s, e, bpm: Math.round(bpm * 100) / 100, phase });
  }
  return out;
}

export function estimateGrid(events, bpmHint = null, onset = null) {
  const ts = events.map(e => e.t).sort((a, b) => a - b);
  if (ts.length < 20)
    return { bpm: 120, beat0: 0, period: 0.5, segments: [{ startSec: 0, bpm: 120, startMeasure: 0 }] };
  // 無 hint 時範圍 [100,240] — 與 Python 版 oct 摺疊下限一致(<100 的曲請給 BPM 提示)
  const [lo, hi] = bpmHint ? [bpmHint * 0.7, bpmHint * 1.45] : [100, 240];
  const t1 = ts[ts.length - 1];

  // 全域最優(主段)+ 兩路異段偵測:殘差驅動(有鼓異段)+ 空洞驅動(無鼓異段)
  const g = _scanBpm(ts, lo, hi);
  const gBpm = Math.round(g.bpm * 100) / 100;
  const anomalies = [..._segmentByResidual(ts, g, lo, hi),
                     ..._gapSegments(ts, onset, lo, hi, gBpm)].sort((a, b) => a.s - b.s);

  // 主段與異段交錯成完整段列表(異段間縫隙 <4s 歸前段)
  const segs = [];
  let cursor = ts[0];
  for (const z of anomalies) {
    if (z.s > cursor + 4) segs.push({ s: cursor, e: z.s, bpm: gBpm, phase: g.phase });
    segs.push(z);
    cursor = z.e;
  }
  if (!segs.length || t1 - cursor > 4) segs.push({ s: cursor, e: t1 + 0.01, bpm: gBpm, phase: g.phase });
  // 相鄰段同 BPM(±0.5)→ 合併(誤切)
  const merged = [segs[0]];
  for (const sg of segs.slice(1)) {
    if (Math.abs(sg.bpm - merged[merged.length - 1].bpm) <= 0.5) merged[merged.length - 1].e = sg.e;
    else merged.push(sg);
  }

  // 首段 downbeat:backbeat 先驗(SNARE 在 2/4 拍、KICK/CRASH 在 1 拍)
  const s0 = merged[0];
  const period0 = 60 / s0.bpm;
  const score4 = [0, 0, 0, 0];
  for (const e of events) {
    if (e.t >= s0.e) continue;
    const b = (e.t - s0.phase) / period0;
    const bi = Math.round(b);
    if (Math.abs(b - bi) > 0.2 || bi < 0) continue;
    for (let sh = 0; sh < 4; sh++) {
      const pm = ((bi - sh) % 4 + 4) % 4;
      if (e.cls === 'SNARE' && (pm === 1 || pm === 3)) score4[sh] += 1;
      else if (e.cls === 'KICK' && pm === 0) score4[sh] += 0.6;
      else if ((e.cls === 'CRASH' || e.cls === 'LCRASH') && pm === 0) score4[sh] += 1.2;
    }
  }
  const shift = score4.indexOf(Math.max(...score4));
  let beat0 = s0.phase + shift * period0;
  while (beat0 >= 4 * period0) beat0 -= 4 * period0;
  while (beat0 < 0) beat0 += 4 * period0;

  // 接縫規整(quantize.py 直譯):切點精修 → snap 後段拍網格 → 前段整小節
  // → 前段 BPM 微調 <0.5% 使小節線精確落在後段 phase(譜師工具同款操作)
  const outSegs = [{ startSec: beat0, bpm: s0.bpm, startMeasure: 0 }];
  for (let k = 1; k < merged.length; k++) {
    const prev = outSegs[outSegs.length - 1];
    const nxt = merged[k];
    const pPrev = 60 / prev.bpm, p16b = 60 / nxt.bpm;
    // 切點精修:候選 = 前段拍線(粗切點 ±6s),兩側各 8s 事件的截斷殘差和 argmin
    const tRough = nxt.s;
    let tCut = tRough, bestCost = Infinity;
    for (let tb = tRough - 6; tb <= tRough + 6; tb += pPrev) {
      const tm = prev.startSec + Math.round((tb - prev.startSec) / pPrev) * pPrev;
      let cost = 0, nEv = 0;
      for (const t of ts) {
        if (t < tm - 8 || t >= tm + 8) continue;
        const [bp, ph] = t < tm ? [prev.bpm, prev.startSec] : [nxt.bpm, nxt.phase];
        const g16 = 60 / bp / 4;
        const pos = (t - ph) / g16;
        cost += Math.min(Math.abs(pos - Math.round(pos)) * g16, 0.030);
        nEv++;
      }
      // 平均而非總和:窗內事件數隨 tm 滑動而變,總和會偏向事件少的一側
      cost = (nEv ? cost / nEv : 0) + Math.abs(tm - tRough) * 0.0005;  // tie-break:cost 平坦時取靠近錨點者
      if (cost < bestCost) { bestCost = cost; tCut = tm; }
    }
    // 後段起點 snap 到後段拍網格
    const nb = Math.round((tCut - nxt.phase) / p16b);
    const tStartNext = nxt.phase + nb * p16b;
    // 前段覆蓋整數小節;BPM 微調(<0.5%)令小節線精確落在 tStartNext
    const nMeas = Math.max(1, Math.round((tStartNext - prev.startSec) / (4 * pPrev)));
    const bpmAdj = nMeas * 4 * 60 / (tStartNext - prev.startSec);
    if (Math.abs(bpmAdj - prev.bpm) / prev.bpm < 0.005) prev.bpm = Math.round(bpmAdj * 1e4) / 1e4;
    outSegs.push({ startSec: tStartNext, bpm: nxt.bpm, startMeasure: prev.startMeasure + nMeas });
  }
  return { bpm: outSegs[0].bpm, beat0, period: 60 / outSegs[0].bpm, segments: outSegs };
}

function refinePhase(ts, bpm, ph0) {
  const p16 = 60 / bpm / 4;
  let ph = ph0;
  for (let it = 0; it < 3; it++) {
    const r = ts.map(t => { const pos = (t - ph) / p16; return pos - Math.round(pos); });
    r.sort((a, b) => a - b);
    ph += r[r.length >> 1] * p16;
  }
  let s = 0;
  for (const t of ts) {
    const pos = (t - ph) / p16;
    s += Math.min(Math.abs(pos - Math.round(pos)) * p16, 0.030);
  }
  return { score: s / ts.length, phase: ph };
}

// ═══════════ 量化(分段查表;1/16 + 三連音擇優)═══════════
export function quantizeEvents(events, grid) {
  const segs = grid.segments || [{ startSec: grid.beat0, bpm: grid.bpm, startMeasure: 0 }];
  const out = [];
  let residSum = 0, residN = 0;
  for (const e of events) {
    let k = segs.length - 1;
    while (k > 0 && e.t < segs[k].startSec) k--;
    const sg = segs[k];
    const period = 60 / sg.bpm;
    const b = (e.t - sg.startSec) / period;
    if (k === 0 && b < -0.26) continue;
    const bi = Math.floor(b + 1e-9);
    const frac = b - bi;
    const q16 = Math.round(frac * 4) / 4, q24 = Math.round(frac * 6) / 6;
    const r16 = Math.abs(frac - q16), r24 = Math.abs(frac - q24);
    let qf, denB;
    if (r24 < r16 * 0.55) { qf = q24; denB = 6; } else { qf = q16; denB = 4; }
    residSum += Math.abs(frac - qf) * period * 1000; residN++;
    const bq = bi + qf;
    if (bq < 0) continue;
    let measure = sg.startMeasure + Math.floor(bq / 4);
    let posInMeasure = bq - Math.floor(bq / 4) * 4;
    // 段邊界保護:量化溢出到下一段起始小節時歸入下一段開頭
    if (k + 1 < segs.length && measure >= segs[k + 1].startMeasure) {
      measure = segs[k + 1].startMeasure; posInMeasure = 0;
    }
    const den = 4 * denB;
    let num = Math.round(posInMeasure * denB);
    if (num >= den) { measure += 1; num -= den; }
    out.push({ m: measure, num, den, cls: e.cls });
  }
  // 同 lane 同格去重
  const seen = new Set();
  const dedup = out.filter(e => {
    const k = `${e.m}|${e.num * (48 / e.den)}|${e.cls}`;
    if (seen.has(k)) return false;
    seen.add(k); return true;
  });
  return { events: dedup, meanResid: residN ? residSum / residN : 0 };
}

// ═══════════ GBDT 難度簡化(simplify_ml.py + extract_features 移植)═══════════
const FAM = { KICK: 'KICK', SNARE: 'SNARE', HH_C: 'HH', HH_O: 'HH',
              TOM_H: 'TOM', TOM_L: 'TOM', TOM_F: 'TOM',
              CRASH: 'CYM', LCRASH: 'CYM', RIDE: 'CYM' };
const CLS2LANE = { KICK: 'BD', SNARE: 'SD', HH_C: 'HH', HH_O: 'HHO', TOM_H: 'HT',
                   TOM_L: 'LT', TOM_F: 'FT', CRASH: 'CY', LCRASH: 'LC', RIDE: 'RD' };
const FAMS = ['KICK', 'SNARE', 'HH', 'TOM', 'CYM', 'PEDAL'];
const SLOTS = ['ext', 'adv', 'bsc'];

export function gbdtPredict(model, x) {
  let s = model.baseline;
  for (const nodes of model.trees) {
    let i = 0;
    while (!nodes[i].leaf) {
      const v = x[nodes[i].f];
      i = (Number.isNaN(v) ? nodes[i].ml : v <= nodes[i].t) ? nodes[i].l : nodes[i].r;
    }
    s += nodes[i].v;
  }
  return 1 / (1 + Math.exp(-s));
}

// simplify_dataset.extract_features 的 JS 移植(31 維 + slot one-hot = 34?
// Python:26 基礎 + 3 slot = 對照 features 名單動態組)
export function simplifyFeatures(qevents, bpm, slotIdx, featureNames) {
  const beatLen = 60 / bpm;
  const evs = qevents.map(e => {
    const beat = e.num / e.den * 4;
    const lane = CLS2LANE[e.cls];
    return { t: (e.m * 4 + beat) * beatLen, lane, fam: FAM[e.cls], measure: e.m, beat };
  }).sort((a, b) => a.t - b.t);
  const n = evs.length;
  const T = evs.map(e => e.t);
  const dur = Math.max(T[n - 1] - T[0], 1);
  const dens = n / dur;
  const famShare = {};
  for (const f of FAMS) famShare[f] = evs.filter(e => e.fam === f).length / Math.max(n, 1);
  const at = new Map();
  evs.forEach((e, i) => {
    const k = Math.round(e.t / 0.015);
    if (!at.has(k)) at.set(k, []);
    at.get(k).push(i);
  });
  const famTimes = {};
  for (const f of FAMS) famTimes[f] = evs.filter(e => e.fam === f).map(e => e.t);
  const measFam = new Map();
  evs.forEach((e, i) => {
    const k = `${e.measure}|${e.fam}`;
    if (!measFam.has(k)) measFam.set(k, []);
    measFam.get(k).push(i);
  });
  const rows = [];
  for (let i = 0; i < n; i++) {
    const e = evs[i];
    const beat = e.beat;
    const sub16 = Math.round(beat * 4) % 4;
    const isTri = Math.abs(beat * 6 - Math.round(beat * 6)) < 1e-6 &&
                  Math.abs(beat * 4 - Math.round(beat * 4)) > 1e-6;
    const bInt = Math.floor(beat) % 4;
    const simul = at.get(Math.round(e.t / 0.015)).filter(j => j !== i).map(j => evs[j]);
    const ft = famTimes[e.fam];
    const k = lowerBound(ft, e.t);
    const prevIoi = k > 0 ? (e.t - ft[k - 1]) / beatLen : 8;
    const nextIoi = k + 1 < ft.length ? (ft[k + 1] - e.t) / beatLen : 8;
    const w = 2 * beatLen;
    let localAll = -1, localFam = -1;
    for (const t of T) if (t >= e.t - w && t <= e.t + w) localAll++;
    for (const t of ft) if (t >= e.t - w && t <= e.t + w) localFam++;
    let fill = 0;
    for (const t of famTimes.TOM) if (t >= e.t - beatLen && t <= e.t + beatLen) fill++;
    const grp = measFam.get(`${e.measure}|${e.fam}`);
    const posInMeas = grp.indexOf(i) / Math.max(grp.length, 1);
    const feat = {};
    for (const f of FAMS) feat[`fam_${f}`] = e.fam === f ? 1 : 0;
    feat.is_open_hh = e.lane === 'HHO' ? 1 : 0;
    feat.is_ride = e.lane === 'RD' ? 1 : 0;
    feat.sub16 = sub16; feat.is_tri = isTri ? 1 : 0; feat.beat_in_meas = bInt;
    feat.on_beat = (sub16 === 0 && !isTri) ? 1 : 0;
    feat.on_and = sub16 === 2 ? 1 : 0;
    feat.downbeat = (bInt === 0 && sub16 === 0) ? 1 : 0;
    feat.backbeat_sn = (e.fam === 'SNARE' && sub16 === 0 && (bInt === 1 || bInt === 3)) ? 1 : 0;
    feat.n_simul = simul.length;
    feat.w_cym = simul.some(s => s.fam === 'CYM') ? 1 : 0;
    feat.w_kick = simul.some(s => s.fam === 'KICK') ? 1 : 0;
    feat.w_snare = simul.some(s => s.fam === 'SNARE') ? 1 : 0;
    feat.prev_ioi = Math.min(prevIoi, 8); feat.next_ioi = Math.min(nextIoi, 8);
    feat.local_all = localAll; feat.local_fam = localFam;
    feat.in_fill = fill >= 3 ? 1 : 0;
    feat.pos_in_meas = posInMeas;
    feat.song_dens = dens; feat.fam_share = famShare[e.fam];
    feat.progress = (e.t - T[0]) / dur;
    for (let si = 0; si < SLOTS.length; si++) feat[`slot_${SLOTS[si]}`] = si === slotIdx ? 1 : 0;
    rows.push(featureNames.map(nm => feat[nm] ?? 0));
  }
  return { rows, order: evs.map((e, i) => i) };
}

function lowerBound(a, x) {
  let lo = 0, hi = a.length;
  while (lo < hi) { const m = (lo + hi) >> 1; if (a[m] < x) lo = m + 1; else hi = m; }
  return lo;
}

export function simplifyML(qevents, bpm, level, gbdt) {
  if (level === 'mstr') return qevents;
  const slotIdx = SLOTS.indexOf(level);
  // 依原始排序對應(simplifyFeatures 內部按 t 排序 — qevents 已是量化序,同序)
  const sorted = [...qevents].sort((a, b) => (a.m * 4 + a.num / a.den * 4) - (b.m * 4 + b.num / b.den * 4));
  const { rows } = simplifyFeatures(sorted, bpm, slotIdx, gbdt.features);
  const p = rows.map(x => gbdtPredict(gbdt, x));
  // 4 小節窗配額(窗內機率和,窗內按機率取 top)
  const win = new Map();
  sorted.forEach((e, i) => {
    const k = Math.floor(e.m / 4);
    if (!win.has(k)) win.set(k, []);
    win.get(k).push(i);
  });
  const keep = new Set();
  for (const idx of win.values()) {
    const kN = Math.round(idx.reduce((s, i) => s + p[i], 0));
    idx.sort((a, b) => p[b] - p[a]).slice(0, kN).forEach(i => keep.add(i));
  }
  return sorted.filter((_, i) => keep.has(i));
}

// ═══════════ DTX 寫出(dtx_writer.py 移植)═══════════
// wav 欄為現作 keysound 檔名(makeKeysounds 的 KS_SPEC 同名;ksMap 正常必覆蓋,
// 此處僅為兜底宣告 — 系統不攜帶、不打包任何外部音色檔)
const CLASS_CHANNEL = {
  KICK: ['13', '01', 'ks_kick.wav', 90, 0],
  SNARE: ['12', '02', 'ks_snare.wav', 90, -10],
  HH_C: ['11', '06', 'ks_hhclose.wav', 80, -30],
  HH_O: ['18', '08', 'ks_hhopen.wav', 80, -30],
  TOM_H: ['14', '0B', 'ks_tomh.wav', 90, 0],
  TOM_L: ['15', '0D', 'ks_toml.wav', 90, 20],
  TOM_F: ['17', '0F', 'ks_tomf.wav', 90, 40],
  CRASH: ['16', '0H', 'ks_crash.wav', 85, 30],
  LCRASH: ['1A', '0M', 'ks_lcrash.wav', 85, -30],
  RIDE: ['19', '0R', 'ks_ride.wav', 85, 50],
};

function gcd(a, b) { while (b) { [a, b] = [b, a % b]; } return a; }

export function writeDtx(qevents, { bpm, beat0, period, segments }, bgmFile, title, level, ksMap = null) {
  const evs = qevents.map(e => ({ ...e, m: e.m + 1 }));   // 小節 0 留 lead-in
  const dur = evs.length ? Math.max(...evs.map(e => e.m)) * 4 * 60 / bpm : 1;
  const dens = evs.length / Math.max(dur, 1);
  const dlevel = Math.max(1, Math.min(99, Math.round(5.9 * dens + 10.6)));
  const L = [];
  L.push('; Created by dtxgen-web (pure frontend)');
  L.push('');
  L.push(`#TITLE: ${title}`);
  L.push('#ARTIST: dtxgen-web');
  L.push(`#COMMENT: auto-generated (${level})`);
  L.push(`#BPM: ${bpm}`);
  L.push(`#DLEVEL: ${dlevel}`);
  L.push('');
  // 變速:#BPMzz 定義 + channel 08 事件(變速點在小節線;量化座標 +1 位移)
  const bpmLines = [];
  if (segments && segments.length > 1) {
    segments.forEach((s, i) => {
      const zz = (i + 1).toString(36).toUpperCase().padStart(2, '0');
      L.push(`#BPM${zz}: ${s.bpm}`);
      bpmLines.push(`#${String(s.startMeasure + 1).padStart(3, '0')}08: ${zz}`);
    });
    L.push('');
  }
  const used = [...new Set(evs.map(e => e.cls))].sort();
  for (const cls of used) {
    let [ch, chip, wav, vol, pan] = CLASS_CHANNEL[cls];
    if (ksMap && ksMap[cls]) wav = ksMap[cls].name;   // 現作 keysound
    L.push(`#WAV${chip}: ${wav}`);
    L.push(`#VOLUME${chip}: ${vol}`);
    if (pan) L.push(`#PAN${chip}: ${pan}`);
  }
  L.push(`#WAV0X: ${bgmFile}`);
  L.push('#VOLUME0X: 95');
  L.push('#BGMWAV: 0X');
  L.push('');
  const leadInBeats = beat0 / period;
  if (leadInBeats >= 0.005) {
    // 真實譜包慣例:BGM chip 放小節 0 內部,使音樂第一拍 = 小節 1 開頭
    const DEN = 384;
    const pos = 4 - leadInBeats;
    const num = Math.round(pos / 4 * DEN) % DEN;
    const row = new Array(DEN).fill('00');
    row[num] = '0X';
    L.push(`#00001: ${row.join('')}`);
  } else {
    L.push('#00101: 0X');
  }
  L.push(...bpmLines);
  L.push('');
  // 逐小節逐 channel 組行
  const grid = new Map();   // `${m}|${ch}` -> Map(fracKey(num/den 以 lcm) -> chip)
  for (const e of evs) {
    const [ch, chip] = CLASS_CHANNEL[e.cls];
    const key = `${e.m}|${ch}`;
    if (!grid.has(key)) grid.set(key, []);
    grid.get(key).push({ num: e.num, den: e.den, chip });
  }
  const keys = [...grid.keys()].sort((a, b) => {
    const [ma, ca] = a.split('|'), [mb, cb] = b.split('|');
    return (+ma - +mb) || (ca < cb ? -1 : 1);
  });
  for (const key of keys) {
    const [m, ch] = key.split('|');
    const slots = grid.get(key);
    let den = 4;
    for (const s of slots) den = den * s.den / gcd(den, s.den);
    const row = new Array(den).fill('00');
    for (const s of slots) row[(s.num * den / s.den) % den] = s.chip;
    L.push(`#${String(m).padStart(3, '0')}${ch}: ${row.join('')}`);
  }
  return { text: L.join('\r\n') + '\r\n', dlevel, notes: evs.length };
}

export function writeSetDef(title, files) {
  const label = { bsc: 'BASIC', adv: 'ADVANCED', ext: 'EXTREME', mstr: 'MASTER' };
  const L = [`#TITLE ${title}`, ''];
  let i = 1;
  for (const lv of ['bsc', 'adv', 'ext', 'mstr']) {
    if (files[lv]) {
      L.push(`#L${i}LABEL ${label[lv]}`);
      L.push(`#L${i}FILE ${files[lv]}`);
      L.push('');
      i++;
    }
  }
  return L.join('\r\n');
}

// ═══════════ 現作 keysound(keysounds_make.py 移植)═══════════
// 從該曲鼓軌切各鼓件最乾淨的一擊;WAV 16-bit(DTXMania 通用)
const KS_SPEC = {
  KICK: [0.25, 'ks_kick.wav'], SNARE: [0.30, 'ks_snare.wav'],
  HH_C: [0.15, 'ks_hhclose.wav'], HH_O: [0.60, 'ks_hhopen.wav'],
  TOM_H: [0.40, 'ks_tomh.wav'], TOM_L: [0.40, 'ks_toml.wav'], TOM_F: [0.45, 'ks_tomf.wav'],
  CRASH: [1.20, 'ks_crash.wav'], LCRASH: [1.20, 'ks_lcrash.wav'], RIDE: [0.80, 'ks_ride.wav'],
};

export function makeKeysounds(events, yL, yR, sr) {
  const n = yL.length;
  const timesAll = events.map(e => e.t).sort((a, b) => a - b);
  const energyAt = t => {
    let s = 0;
    const a = Math.max(0, Math.round(t * sr)), b = Math.min(n, Math.round((t + 0.08) * sr));
    for (let i = a; i < b; i++) { const m = (yL[i] + yR[i]) / 2; s += m * m; }
    return s;
  };
  const out = {};   // cls -> {name, bytes}
  for (const [cls, [win, fname]] of Object.entries(KS_SPEC)) {
    const tc = events.filter(e => e.cls === cls).map(e => e.t);
    if (!tc.length) continue;
    const en = tc.map(energyAt);
    const med = [...en].sort((a, b) => a - b)[en.length >> 1];
    const iso = tc.map(t => {
      let best = 9e9;
      for (const u of timesAll) { const d = Math.abs(u - t); if (d > 1e-6 && d < best) best = d; }
      return best;
    });
    let cand = tc.map((_, i) => i).filter(i => en[i] >= med * 0.6);
    if (!cand.length) cand = tc.map((_, i) => i);
    let best = cand.reduce((a, b) => iso[a] >= iso[b] ? a : b);
    if (iso[best] < win * 0.5) best = cand.reduce((a, b) => en[a] >= en[b] ? a : b);
    const t0 = tc[best];
    const a = Math.max(0, Math.round((t0 - 0.005) * sr));
    const b = Math.min(n, a + Math.round(win * sr));
    const len = b - a;
    const sl = new Float32Array(len), sr2 = new Float32Array(len);
    for (let i = 0; i < len; i++) { sl[i] = yL[a + i]; sr2[i] = yR[a + i]; }
    const fi = Math.min(Math.round(0.003 * sr), len), fo = Math.min(Math.round(0.025 * sr), len);
    for (let i = 0; i < fi; i++) { const g = i / fi; sl[i] *= g; sr2[i] *= g; }
    for (let i = 0; i < fo; i++) { const g = i / fo; sl[len - 1 - i] *= g; sr2[len - 1 - i] *= g; }
    let peak = 1e-6;
    for (let i = 0; i < len; i++) peak = Math.max(peak, Math.abs(sl[i]), Math.abs(sr2[i]));
    const g = Math.pow(10, -3 / 20) / peak;
    for (let i = 0; i < len; i++) { sl[i] *= g; sr2[i] *= g; }
    out[cls] = { name: fname, bytes: encodeWav16(sl, sr2, sr) };
  }
  return out;
}

export function encodeWav16(yL, yR, sr) {
  const n = yL.length;
  const buf = new ArrayBuffer(44 + n * 4);
  const v = new DataView(buf);
  const w = (o, s) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
  w(0, 'RIFF'); v.setUint32(4, 36 + n * 4, true); w(8, 'WAVE');
  w(12, 'fmt '); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 2, true);
  v.setUint32(24, sr, true); v.setUint32(28, sr * 4, true); v.setUint16(32, 4, true); v.setUint16(34, 16, true);
  w(36, 'data'); v.setUint32(40, n * 4, true);
  let o = 44;
  for (let i = 0; i < n; i++) {
    v.setInt16(o, Math.max(-32768, Math.min(32767, Math.round(yL[i] * 32767))), true); o += 2;
    v.setInt16(o, Math.max(-32768, Math.min(32767, Math.round(yR[i] * 32767))), true); o += 2;
  }
  return buf;
}

// ═══════════ stem 打包(postMessage transfer 前置)═══════════
// demucs 的 channelData 是「全部 stem 共用一塊大 buffer」的 view(demucs-js
// apply.ts:new Float32Array(result.data.buffer, offset, length))— 直接把
// dL.buffer、dR.buffer 放進 transfer list 會因同一 ArrayBuffer 出現兩次而
// DataCloneError,且就算去重也會把整塊 4-stem buffer 搬去主線程。
// 凡與輸入共享、非獨占整塊 buffer、或左右共用 buffer 者,slice 成緊湊獨立副本,
// 保證回傳的兩個 buffer 相異且可各自 transfer。
export function detachStems(dL, dR, yL, yR) {
  const owns = a => a.byteOffset === 0 && a.byteLength === a.buffer.byteLength;
  const stemL = (dL === yL || !owns(dL)) ? dL.slice() : dL;
  const stemR = (dR === yR || !owns(dR) || dR.buffer === stemL.buffer) ? dR.slice() : dR;
  return { stemL, stemR };
}

// ═══════════ BGM 伴奏(去鼓)═══════════
// demucs 四 stem 除 drums 外相加 = 伴奏(bass+other+vocals)。取「stem 和」
// 而非「混音減鼓軌」:減法會把鼓估計的殘差(鈸尾、房間殘響)原樣留在 BGM,
// stem 和只剩漏進其他軌的少量鼓聲,去鼓較乾淨(Python demucs two-stems 同法)。
// 輸出為緊湊新 buffer(與 stem 共用的大 buffer 脫鉤,可各自 transfer)。
export function accompanimentFromStems(tracks, n) {
  const bgmL = new Float32Array(n), bgmR = new Float32Array(n);
  for (const [name, t] of Object.entries(tracks)) {
    if (name === 'drums') continue;
    const sL = t.channelData[0], sR = t.channelData[1] || sL;
    for (let i = 0; i < n; i++) { bgmL[i] += sL[i]; bgmR[i] += sR[i]; }
  }
  return { bgmL, bgmR };
}
