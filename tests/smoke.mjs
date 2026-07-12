// smoke.mjs — 自足冒煙測試(不需 Python 開發環境):
// 8 秒真實鼓軌 fixture → ADTOF(ONNX)→ 細分 → 量化 → 簡化 → DTX 寫出
// 驗證:事件數、BPM、DTX 結構、BGM 檔名一致、鼓 channel 行存在
import { readFileSync } from 'fs';
import * as ort from 'onnxruntime-web';
import { adtofTranscribe } from '../app/js/adtof.js';
import { fuseAndSplit, estimateGrid, quantizeEvents, simplifyML, writeDtx } from '../app/js/pipeline.js';

ort.env.wasm.wasmPaths = new URL('../app/vendor/ort/', import.meta.url).href.replace('file://', '') ;
ort.env.wasm.numThreads = 1;

let fails = 0;
const check = (name, ok, detail = '') => {
  console.log(`${ok ? '✓' : '✗'} ${name}${detail ? ' — ' + detail : ''}`);
  if (!ok) fails++;
};

const pcm = readFileSync(new URL('./fixture_drums_8s.pcm', import.meta.url));
const nS = pcm.length / 8;
const inter = new Float32Array(pcm.buffer, pcm.byteOffset, nS * 2);
const yL = new Float32Array(nS), yR = new Float32Array(nS), mono = new Float32Array(nS);
for (let i = 0; i < nS; i++) { yL[i] = inter[2*i]; yR[i] = inter[2*i+1]; mono[i] = (yL[i]+yR[i])/2; }

const base = new URL('../app/models/', import.meta.url);
const fb = new Float32Array(readFileSync(new URL('fb_matrix.bin', base)).buffer);
const gbdt = JSON.parse(readFileSync(new URL('simplify_gbdt.json', base)));
const session = await ort.InferenceSession.create(
  readFileSync(new URL('adtof_frame_rnn.onnx', base)), { executionProviders: ['wasm'] });

const { events: adtofEv } = await adtofTranscribe(ort, session, mono, fb);
const nEv = Object.values(adtofEv).reduce((s, a) => s + a.length, 0);
check('ADTOF 偵測', nEv >= 20, `${nEv} 事件`);

const events = fuseAndSplit(adtofEv, yL, yR, 44100);
check('細分', events.length >= 20, `${events.length} 顆`);

const grid = estimateGrid(events);
check('BPM 估計', grid.bpm > 170 && grid.bpm < 182, `BPM=${grid.bpm}(fixture 真值 176)`);

const { events: q } = quantizeEvents(events, grid);
const ext = simplifyML(q, grid.bpm, 'ext', gbdt);
check('難度簡化', ext.length > 0 && ext.length < q.length, `mstr ${q.length} → ext ${ext.length}`);

const { text, dlevel } = writeDtx(q, grid, 'bgm.mp3', 'Smoke', 'mstr');
check('DTX 結構', text.includes('#TITLE: Smoke') && text.includes('#WAV0X: bgm.mp3')
      && /#\d{3}1[123]: /.test(text) && dlevel > 0,
      `DLEVEL=${dlevel},BGM 宣告一致`);

process.exit(fails ? 1 : 0);
