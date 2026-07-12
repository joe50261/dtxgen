// JS 端到端:drums pcm → ADTOF → fuse → grid → quantize → simplify → DTX 檔
import { readFileSync, writeFileSync, mkdirSync } from 'fs';
import * as ort from '../spike/node_modules/onnxruntime-web/dist/ort.min.mjs';
import { adtofTranscribe } from '../app/js/adtof.js';
import { fuseAndSplit, estimateGrid, quantizeEvents, simplifyML, writeDtx, writeSetDef } from '../app/js/pipeline.js';

ort.env.wasm.wasmPaths = new URL('../spike/', import.meta.url).pathname;
ort.env.wasm.numThreads = 1;

const t0 = Date.now();
const pcm = readFileSync('/tmp/js_drums_f32.pcm');
const nS = pcm.length / 8;
const inter = new Float32Array(pcm.buffer, pcm.byteOffset, nS * 2);
const yL = new Float32Array(nS), yR = new Float32Array(nS), mono = new Float32Array(nS);
for (let i = 0; i < nS; i++) {
  yL[i] = inter[2 * i]; yR[i] = inter[2 * i + 1]; mono[i] = (yL[i] + yR[i]) / 2;
}
const fb = new Float32Array(readFileSync('../app/models/fb_matrix.bin').buffer);
const gbdt = JSON.parse(readFileSync('../app/models/simplify_gbdt.json'));

const session = await ort.InferenceSession.create(readFileSync('../app/models/adtof_frame_rnn.onnx'),
                                                  { executionProviders: ['wasm'] });
const { events: adtofEv } = await adtofTranscribe(ort, session, mono, fb);
const events = fuseAndSplit(adtofEv, yL, yR, 44100);
console.log('事件', events.length, '顆;類分布:',
  Object.fromEntries([...new Set(events.map(e => e.cls))].map(c => [c, events.filter(e => e.cls === c).length])));
const grid = estimateGrid(events);
console.log('grid: BPM', grid.bpm, 'beat0', grid.beat0.toFixed(3));
const { events: qevents, meanResid } = quantizeEvents(events, grid);
console.log('量化', qevents.length, '顆, 殘差', meanResid.toFixed(1), 'ms');

mkdirSync('/tmp/js_out', { recursive: true });
const files = {};
for (const lv of ['bsc', 'adv', 'ext', 'mstr']) {
  const ev = simplifyML(qevents, grid.bpm, lv, gbdt);
  const { text, dlevel, notes } = writeDtx(ev, grid, 'bgm.ogg', 'JSE2E', lv);
  writeFileSync(`/tmp/js_out/${lv}.dtx`, text, 'latin1');
  files[lv] = `${lv}.dtx`;
  console.log(`${lv}: ${notes} 顆 DLV${dlevel}`);
}
writeFileSync('/tmp/js_out/SET.def', writeSetDef('JSE2E', files), 'latin1');
console.log('JS 端到端完成', ((Date.now() - t0) / 1000).toFixed(1) + 's');
