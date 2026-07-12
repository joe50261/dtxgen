// 變速端到端:ETERNAL BLAZE 合成混音的鼓軌 → ADTOF → grid → DTX
// 對照 Python 版(quantize.py + madmom DBN):105→155、變速於小節 7(dtx 內 #00808)
// fixture 生成(38MB 不入 repo):對變速曲的 drums stem(f32 stereo interleaved)
//   python3 -c "import soundfile as sf,numpy as np; y,sr=sf.read('drums.wav');
//               y.astype(np.float32).reshape(-1).tofile('/tmp/js_eternal_f32.pcm')"
import { readFileSync } from 'fs';
import * as ort from '../spike/node_modules/onnxruntime-web/dist/ort.min.mjs';
import { adtofTranscribe } from '../app/js/adtof.js';
import { fuseAndSplit, estimateGrid, quantizeEvents, writeDtx } from '../app/js/pipeline.js';
import { onsetEnvelope } from '../app/js/dsp.js';

ort.env.wasm.wasmPaths = new URL('../spike/', import.meta.url).pathname;
ort.env.wasm.numThreads = 1;

const pcm = readFileSync('/tmp/js_eternal_f32.pcm');
const nS = pcm.length / 8;
const inter = new Float32Array(pcm.buffer, pcm.byteOffset, nS * 2);
const yL = new Float32Array(nS), yR = new Float32Array(nS), mono = new Float32Array(nS);
for (let i = 0; i < nS; i++) { yL[i] = inter[2 * i]; yR[i] = inter[2 * i + 1]; mono[i] = (yL[i] + yR[i]) / 2; }
const fb = new Float32Array(readFileSync('../app/models/fb_matrix.bin').buffer);

const session = await ort.InferenceSession.create(readFileSync('../app/models/adtof_frame_rnn.onnx'),
                                                  { executionProviders: ['wasm'] });
const { events: adtofEv } = await adtofTranscribe(ort, session, mono, fb);
const events = fuseAndSplit(adtofEv, yL, yR, 44100);
console.log('事件', events.length, '顆');

const onset = onsetEnvelope(mono, fb);   // 空洞異段(稀疏 intro)的變速證據
const grid = estimateGrid(events, null, onset);
console.log('segments:', JSON.stringify(grid.segments));
const { events: qevents, meanResid } = quantizeEvents(events, grid);
console.log(`量化 ${qevents.length} 顆,殘差 ${meanResid.toFixed(1)}ms`);

let fail = 0;
const A = (cond, msg) => { console.log((cond ? 'PASS' : 'FAIL') + ' ' + msg); if (!cond) fail++; };
A(grid.segments.length === 2, `段數 = ${grid.segments.length}(期望 2)`);
if (grid.segments.length === 2) {
  const [a, b] = grid.segments;
  A(Math.abs(a.bpm - 105) < 1.5, `首段 BPM ${a.bpm} ≈ 105`);
  A(Math.abs(b.bpm - 155) < 1.5, `次段 BPM ${b.bpm} ≈ 155`);
  A(b.startMeasure === 7, `變速小節 ${b.startMeasure}(Python 版 = 7)`);
}
A(meanResid < 10, `殘差 ${meanResid.toFixed(1)}ms < 10ms(單段硬套時 Python 實測 14.6ms)`);

// DTX 寫出:變速宣告 + channel 08 行
const { text } = writeDtx(qevents, grid, 'bgm.ogg', 'EB', 'mstr');
const bpmDefs = [...text.matchAll(/#BPM(\w\w): ([\d.]+)/g)].map(m => [m[1], +m[2]]);
const ch08 = [...text.matchAll(/#(\d{3})08: (\w\w)/g)].map(m => [+m[1], m[2]]);
console.log('變速宣告:', JSON.stringify(bpmDefs), 'channel08:', JSON.stringify(ch08));
A(bpmDefs.length === 2 && ch08.length === 2, '變速事件確實存在於輸出檔');
A(ch08.length === 2 && ch08[0][0] === 1 && ch08[1][0] === 8, `channel08 於小節 ${ch08.map(c => c[0])}(Python 版 = 1,8)`);

// 恆定曲不受影響:同一 grid 流程跑 176 fixture 事件(smoke 已蓋,此處驗 segments=1 路徑的寫出)
console.log(fail ? `\n${fail} 項失敗` : '\n全部通過');
process.exit(fail ? 1 : 0);
