// sync-vendor.mjs — 從 node_modules 同步 demucs 資產到靜態站(postinstall 自動執行)
// 1) node_modules/demucs/htdemucs.onnx      → app/models/(24MiB 分塊 + manifest)
// 2) node_modules/demucs/dist/*.js          → app/vendor/demucs/
//    其中 onnx-htdemucs.js 的 `import 'onnxruntime-node'`(bare specifier)改寫為
//    '../ort/ort.min.mjs' — 瀏覽器 module worker 不支援 import map,無 build step
//    的靜態站必須在落地時改寫這一行。升級 demucs 版本後重跑 npm install 即同步。
// 3) node_modules/onnxruntime-web/dist 的 runtime → app/vendor/ort/
//    (其中 jsep.wasm 亦超過 25MiB → 同樣分塊)
//
// 分塊的原因:靜態主機有單檔上限(Cloudflare Pages 25MiB),整檔 174MB 的模型
// 與 26MB 的 ort wasm 無法部署;worker 端依 manifest 逐塊抓回拼裝
// (見 app/js/worker.js fetchChunked)。
import { readFileSync, writeFileSync, mkdirSync, existsSync, statSync, readdirSync, rmSync, copyFileSync } from 'fs';
import { createRequire } from 'module';
import { dirname, join } from 'path';

const require = createRequire(import.meta.url);
const root = dirname(new URL(import.meta.url).pathname) + '/..';

// 大檔 → 24MiB 分塊(單塊 < Pages 25MiB 上限)+ <name>.manifest.json
const CHUNK = 24 * 1024 * 1024;
const chunksValid = (dir, name) => {
  try {
    const m = JSON.parse(readFileSync(join(dir, `${name}.manifest.json`), 'utf8'));
    return m.chunks.reduce((s, c) => s + statSync(join(dir, c)).size, 0) === m.size ? m : null;
  } catch { return null; }
};
function chunkAsset(src, destDir, name) {
  const srcSize = statSync(src).size;
  const cur = chunksValid(destDir, name);
  if (cur && cur.size === srcSize) return { n: cur.chunks.length, skipped: true };
  // 清掉整檔舊版與過期分塊(分塊數會隨版本變)再重切
  for (const f of readdirSync(destDir))
    if (f.startsWith(name)) rmSync(join(destDir, f));
  const data = readFileSync(src);
  const chunks = [];
  for (let off = 0; off < data.length; off += CHUNK) {
    const cn = `${name}.${String(chunks.length).padStart(3, '0')}.bin`;
    writeFileSync(join(destDir, cn), data.subarray(off, off + CHUNK));
    chunks.push(cn);
  }
  writeFileSync(join(destDir, `${name}.manifest.json`),
    JSON.stringify({ file: name, size: data.length, chunkBytes: CHUNK, chunks }, null, 2) + '\n');
  return { n: chunks.length, skipped: false };
}

let demucsDir;
try {
  demucsDir = dirname(require.resolve('demucs/package.json'));
} catch {
  console.log('demucs 尚未安裝(含 174MB 分離模型)— 執行:npm install');
  process.exit(0);
}

mkdirSync(join(root, 'app/models'), { recursive: true });
mkdirSync(join(root, 'app/vendor/demucs'), { recursive: true });
mkdirSync(join(root, 'app/vendor/ort'), { recursive: true });

// 模型(分塊)
const m = chunkAsset(join(demucsDir, 'htdemucs.onnx'), join(root, 'app/models'), 'htdemucs.onnx');
console.log(`✓ htdemucs.onnx → app/models/(${m.n} 分塊 ≤24MiB${m.skipped ? ',已就位跳過' : ''})`);

// demucs dist(patch bare specifier)
for (const f of ['apply.js', 'dsp.js', 'wav-utils.js', 'onnx-htdemucs.js']) {
  let code = readFileSync(join(demucsDir, 'dist', f), 'utf8');
  if (f === 'onnx-htdemucs.js')
    code = code.replace(/from ['"]onnxruntime-node['"]/, "from '../ort/ort.min.mjs'");
  writeFileSync(join(root, 'app/vendor/demucs', f), code);
}
console.log('✓ demucs dist(4 檔,onnx-htdemucs.js 已改寫 import)→ app/vendor/demucs/');

// onnxruntime-web runtime
// 注意:onnxruntime-web 的 exports 不含 ./package.json(require.resolve 會
// ERR_PACKAGE_PATH_NOT_EXPORTED),故 fallback 直接找 node_modules 路徑
let ortDir;
try {
  ortDir = join(dirname(require.resolve('onnxruntime-web/package.json')), 'dist');
} catch {
  const cand = join(root, 'node_modules/onnxruntime-web/dist');
  ortDir = existsSync(cand) ? cand : null;
}
// 瀏覽器 bundle(ort.min.mjs)只用 jsep 版 glue + wasm;非 jsep 的 wasm/mjs 供
// Node 冒煙測試(wasmPaths 指到本目錄)使用。jsep.wasm 超過 25MiB → 分塊,
// worker 以 ort.env.wasm.wasmBinary 餵回(glue .mjs 仍走 wasmPaths)。
const ortFiles = ['ort.min.mjs', 'ort-wasm-simd-threaded.wasm', 'ort-wasm-simd-threaded.mjs',
                  'ort-wasm-simd-threaded.jsep.mjs'];
const ortJsepWasm = 'ort-wasm-simd-threaded.jsep.wasm';
if (ortDir) {
  for (const f of ortFiles) {
    const src = join(ortDir, f);
    if (existsSync(src)) copyFileSync(src, join(root, 'app/vendor/ort', f));
  }
  const j = chunkAsset(join(ortDir, ortJsepWasm), join(root, 'app/vendor/ort'), ortJsepWasm);
  console.log(`✓ onnxruntime-web runtime → app/vendor/ort/(jsep.wasm ${j.n} 分塊${j.skipped ? ',已就位跳過' : ''})`);
}
// 站台完整性:ort runtime 缺檔即為壞站(app/vendor/ort 不進版控,只能靠同步)
const missing = ortFiles.filter(f => !existsSync(join(root, 'app/vendor/ort', f)));
if (!chunksValid(join(root, 'app/vendor/ort'), ortJsepWasm)) missing.push(`${ortJsepWasm}(分塊)`);
if (missing.length) {
  console.error(`✗ ort runtime 缺檔:${missing.join(' ')} — onnxruntime-web 未安裝?`);
  process.exit(1);
}
console.log('vendor 同步完成');
