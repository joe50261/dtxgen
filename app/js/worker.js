// worker.js — 全 pipeline 在 Web Worker 內執行(module worker)
import * as ort from '../vendor/ort/ort.min.mjs';
import { ONNXHTDemucs } from '../vendor/demucs/onnx-htdemucs.js';
import { separateTracks } from '../vendor/demucs/apply.js';
import { adtofTranscribe } from './adtof.js';
import { fuseAndSplit, estimateGrid, quantizeEvents, simplifyML, writeDtx, writeSetDef, makeKeysounds } from './pipeline.js';
import { onsetEnvelope } from './dsp.js';

ort.env.wasm.wasmPaths = new URL('../vendor/ort/', import.meta.url).href;
ort.env.wasm.numThreads = Math.min(4, (self.navigator?.hardwareConcurrency || 2));

const P = (pct, msg) => postMessage({ type: 'progress', pct, msg });
const L = (msg, level = 'info') => postMessage({ type: 'log', level, msg });
let STAGE = '初始化';
const setStage = s => { STAGE = s; L(`階段:${s}`); };

let adtofSession = null, demucsModel = null, gbdt = null, fb = null;

async function ensureAssets(needDemucs) {
  const base = new URL('../models/', import.meta.url).href;
  if (!fb) {
    fb = new Float32Array(await (await fetch(base + 'fb_matrix.bin')).arrayBuffer());
    gbdt = await (await fetch(base + 'simplify_gbdt.json')).json();
  }
  if (!adtofSession) {
    P(2, '載入鼓事件模型');
    const t = performance.now();
    const r = await fetch(base + 'adtof_frame_rnn.onnx');
    if (!r.ok) throw new Error(`adtof_frame_rnn.onnx 載入失敗:HTTP ${r.status}`);
    const buf = new Uint8Array(await r.arrayBuffer());
    adtofSession = await ort.InferenceSession.create(buf, { executionProviders: ['wasm'] });
    L(`ADTOF 模型就緒(${(buf.length/1048576).toFixed(1)} MB, ${((performance.now()-t)/1000).toFixed(1)}s)`);
  }
  if (needDemucs && !demucsModel) {
    P(4, '載入分離模型(97MB,首次較慢,之後有快取)');
    const t = performance.now();
    const r = await fetch(base + 'htdemucs.onnx');
    if (!r.ok) throw new Error(`htdemucs.onnx 載入失敗:HTTP ${r.status} — 執行過 npm install 了嗎?`);
    const buf = new Uint8Array(await r.arrayBuffer());
    demucsModel = await ONNXHTDemucs.init(buf);
    L(`demucs 模型就緒(${(buf.length/1048576).toFixed(1)} MB, ${((performance.now()-t)/1000).toFixed(1)}s;EP=${typeof navigator!=='undefined'&&'gpu' in navigator?'webgpu 優先':'wasm'})`);
  }
}

onmessage = async (ev) => {
  const { yL, yR, sr, isDrumsStem, title, bpmHint, levels, bgmName } = ev.data;
  try {
    setStage('載入模型');
    L(`輸入:${(yL.length/sr).toFixed(1)}s @${sr}Hz, isDrumsStem=${isDrumsStem}, bpmHint=${bpmHint||'無'}`);
    await ensureAssets(!isDrumsStem);
    const n = yL.length;
    let dL = yL, dR = yR;
    if (!isDrumsStem) {
      setStage('demucs 分離');
      const tSep = performance.now();
      P(8, '分離鼓軌(最耗時;M 系列瀏覽器會用 WebGPU 加速)');
      const res = await separateTracks(demucsModel, { channelData: [yL, yR], sampleRate: sr },
        p => P(8 + Math.min(0.99, p / 17) * 52, `分離鼓軌 ${Math.round(Math.min(0.99, p / 17) * 100)}%`));
      dL = res.drums.channelData[0]; dR = res.drums.channelData[1];
      L(`分離完成(${((performance.now()-tSep)/1000).toFixed(0)}s)`);
    }
    setStage('ADTOF 鼓事件偵測');
    const tDet = performance.now();
    P(62, '鼓事件偵測(ADTOF)');
    const mono = new Float32Array(n);
    for (let i = 0; i < n; i++) mono[i] = (dL[i] + dR[i]) / 2;
    const { events: adtofEv } = await adtofTranscribe(ort, adtofSession, mono, fb,
      p => P(62 + p * 18, `鼓事件偵測 ${Math.round(p * 100)}%`));
    L(`ADTOF:${Object.entries(adtofEv).map(([k,v])=>`${k}=${v.length}`).join(' ')}(${((performance.now()-tDet)/1000).toFixed(1)}s)`);
    setStage('細分與節拍估計');
    P(82, '細分與節拍估計');
    const events = fuseAndSplit(adtofEv, dL, dR, sr);
    const dist = {};
    for (const e of events) dist[e.cls] = (dist[e.cls]||0)+1;
    L(`細分:${events.length} 顆 — ${Object.entries(dist).map(([k,v])=>`${k}=${v}`).join(' ')}`);
    // onset envelope 算在「原始輸入」(混音或純鼓)上 — 事件空洞區(稀疏 intro)
    // 的變速證據;ADTOF 無鼓可報時 envelope 仍看得到 synth/伴奏的拍
    const monoIn = (dL === yL) ? mono : (() => {
      const m = new Float32Array(n);
      for (let i = 0; i < n; i++) m[i] = (yL[i] + yR[i]) / 2;
      return m;
    })();
    const onset = onsetEnvelope(monoIn, fb);
    const grid = estimateGrid(events, bpmHint || null, onset);
    const segTxt = grid.segments.map(s => `${s.bpm}@小節${s.startMeasure}`).join(' → ');
    L(`grid:BPM=${segTxt}${grid.segments.length > 1 ? '(變速)' : ''} beat0=${grid.beat0.toFixed(3)}s`);
    if (grid.bpm < 65 || grid.bpm > 235) L(`BPM ${grid.bpm} 異常 — 可用「BPM 提示」重做`, 'warn');
    setStage('量化與難度簡化');
    const { events: qevents, meanResid } = quantizeEvents(events, grid);
    L(`量化:${qevents.length} 顆,殘差 mean=${meanResid.toFixed(1)}ms${meanResid>15?'(偏高:BPM 可能有誤,可用「BPM 提示」重做)':''}`);
    if (meanResid > 15) L('量化殘差偏高', 'warn');
    setStage('現作 keysound');
    P(86, '現作 keysound(切自該曲鼓軌)');
    const ksMap = makeKeysounds(events, dL, dR, sr);
    L(`現作 keysound:${Object.keys(ksMap).length} 顆(${Object.values(ksMap).map(k=>k.name).join(' ')})`);
    P(88, '產生四難度譜面');
    setStage('DTX 寫出');
    const charts = {};
    const files = {};
    for (const lv of (levels || ['bsc', 'adv', 'ext', 'mstr'])) {
      const evLv = simplifyML(qevents, grid.bpm, lv, gbdt);
      const w = writeDtx(evLv, grid, bgmName || 'bgm.ogg', title, lv, ksMap);
      charts[lv] = w;
      files[lv] = lv + '.dtx';
    }
    const setdef = writeSetDef(title, files);
    // 鼓原軌 PCM 傳回主線程編 FLAC(與 Python 版格式一致)
    P(94, '打包鼓原軌');
    const stemL = (dL === yL) ? dL.slice() : dL;   // 純鼓軌路徑下 dL 即輸入,slice 避免共享
    const stemR = (dR === yR) ? dR.slice() : dR;
    postMessage({
      type: 'done',
      charts: Object.fromEntries(Object.entries(charts).map(([k, v]) => [k, v.text])),
      stats: Object.fromEntries(Object.entries(charts).map(([k, v]) => [k, { dlevel: v.dlevel, notes: v.notes }])),
      setdef, bpm: grid.bpm, meanResid,
      bpmText: grid.segments.length > 1
        ? grid.segments.map(s => `${Math.round(s.bpm * 100) / 100}@${s.startMeasure}`).join('→') + '(變速)'
        : String(grid.bpm),
      keysounds: Object.fromEntries(Object.entries(ksMap).map(([k, v]) => [v.name, v.bytes])),
      stemL, stemR, sr,
    }, [stemL.buffer, stemR.buffer, ...Object.values(ksMap).map(v => v.bytes)]);
  } catch (e) {
    postMessage({ type: 'error', stage: STAGE, error: String(e && e.stack || e) });
  }
};
