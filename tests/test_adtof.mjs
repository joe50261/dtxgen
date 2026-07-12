// ADTOF 全鏈對照(JS mel→ONNX→peak picking vs Python adtof_transcribe)
import { readFileSync } from 'fs';
import * as ort from '../spike/node_modules/onnxruntime-web/dist/ort.node.min.mjs';
import { adtofTranscribe, LABELS } from '../app/js/adtof.js';

ort.env.wasm.wasmPaths = new URL('../spike/', import.meta.url).pathname;
ort.env.wasm.numThreads = 1;

const pcm = readFileSync('/tmp/js_drums_f32.pcm');
const nS = pcm.length / 8;
const inter = new Float32Array(pcm.buffer, pcm.byteOffset, nS * 2);
const mono = new Float32Array(nS);
for (let i = 0; i < nS; i++) mono[i] = (inter[2 * i] + inter[2 * i + 1]) / 2;
const fb = new Float32Array(readFileSync('../app/models/fb_matrix.bin').buffer);

const t0 = Date.now();
const session = await ort.InferenceSession.create(readFileSync('../app/models/adtof_frame_rnn.onnx'),
                                                  { executionProviders: ['wasm'] });
const { events } = await adtofTranscribe(ort, session, mono, fb);
console.log('JS ADTOF', ((Date.now() - t0) / 1000).toFixed(1) + 's',
            Object.fromEntries(LABELS.map(l => [l, events[l].length])));

const ref = JSON.parse(readFileSync('/tmp/adtof_ref.json'));
let fails = 0;
for (const lbl of LABELS) {
  const a = events[lbl], b = ref[lbl] || [];
  // 貪婪配對 ±15ms
  const used = new Array(b.length).fill(false);
  let tp = 0, dmax = 0;
  for (const t of a) {
    let bi = -1, bd = 1e9;
    for (let j = 0; j < b.length; j++) if (!used[j] && Math.abs(b[j] - t) < bd) { bd = Math.abs(b[j] - t); bi = j; }
    if (bi >= 0 && bd <= 0.015) { used[bi] = true; tp++; dmax = Math.max(dmax, bd); }
  }
  const f1 = 2 * tp / (a.length + b.length);
  const ok = f1 >= 0.985;
  console.log(`${ok ? '✓' : '✗'} ${lbl}: JS ${a.length} / PY ${b.length} F1=${f1.toFixed(3)} max|Δt|=${(dmax * 1000).toFixed(1)}ms`);
  if (!ok) fails++;
}
process.exit(fails ? 1 : 0);
