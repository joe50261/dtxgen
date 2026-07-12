// sync-vendor.mjs — 從 node_modules 同步 demucs 資產到靜態站(postinstall 自動執行)
// 1) node_modules/demucs/htdemucs.onnx      → app/models/
// 2) node_modules/demucs/dist/*.js          → app/vendor/demucs/
//    其中 onnx-htdemucs.js 的 `import 'onnxruntime-node'`(bare specifier)改寫為
//    '../ort/ort.min.mjs' — 瀏覽器 module worker 不支援 import map,無 build step
//    的靜態站必須在落地時改寫這一行。升級 demucs 版本後重跑 npm install 即同步。
// 3) node_modules/onnxruntime-web/dist 的 runtime → app/vendor/ort/
import { copyFileSync, readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs';
import { createRequire } from 'module';
import { dirname, join } from 'path';

const require = createRequire(import.meta.url);
const root = dirname(new URL(import.meta.url).pathname) + '/..';

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

// 模型
copyFileSync(join(demucsDir, 'htdemucs.onnx'), join(root, 'app/models/htdemucs.onnx'));
console.log('✓ htdemucs.onnx → app/models/');

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
const ortFiles = ['ort.min.mjs', 'ort-wasm-simd-threaded.wasm', 'ort-wasm-simd-threaded.mjs',
                  'ort-wasm-simd-threaded.jsep.wasm', 'ort-wasm-simd-threaded.jsep.mjs'];
if (ortDir) {
  for (const f of ortFiles) {
    const src = join(ortDir, f);
    if (existsSync(src)) copyFileSync(src, join(root, 'app/vendor/ort', f));
  }
  console.log('✓ onnxruntime-web runtime → app/vendor/ort/');
}
// 站台完整性:ort runtime 缺檔即為壞站(app/vendor/ort 不進版控,只能靠同步)
const missing = ortFiles.filter(f => !existsSync(join(root, 'app/vendor/ort', f)));
if (missing.length) {
  console.error(`✗ ort runtime 缺檔:${missing.join(' ')} — onnxruntime-web 未安裝?`);
  process.exit(1);
}
console.log('vendor 同步完成');
