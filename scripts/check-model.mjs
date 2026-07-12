// check-model.mjs — 驗證分塊部署的大檔已同步:manifest 存在、分塊齊、總大小一致
// (>25MiB 的檔以 24MiB 分塊落地,見 scripts/sync-vendor.mjs)
import { readFileSync, statSync } from 'fs';
import { dirname, join } from 'path';

const root = join(dirname(new URL(import.meta.url).pathname), '..');
let fails = 0;
for (const [dir, name] of [
  ['app/models', 'htdemucs.onnx'],
  ['app/vendor/ort', 'ort-wasm-simd-threaded.jsep.wasm'],
]) {
  try {
    const m = JSON.parse(readFileSync(join(root, dir, `${name}.manifest.json`), 'utf8'));
    const got = m.chunks.reduce((s, c) => s + statSync(join(root, dir, c)).size, 0);
    if (got !== m.size) throw new Error(`分塊總大小 ${got} ≠ manifest ${m.size}`);
    console.log(`✓ ${name} 分塊就位(${m.chunks.length} 塊,共 ${(m.size / 1048576).toFixed(0)} MB)`);
  } catch (e) {
    console.error(`✗ ${name} 未就位:npm install(${e.message})`);
    fails = 1;
  }
}
process.exit(fails);
