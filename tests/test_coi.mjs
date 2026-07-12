// 靜態檢查:crossOriginIsolated(WASM 多執行緒)佈署不變量 —
// GitHub Pages 設不了 COOP/COEP header,靠 coi-serviceworker 於執行期注入;
// 這裡守住一壞就靜默退回單線程的條件(SW scope、載入順序、config 順序、線程 gate)
import { readFileSync } from 'fs';

let fails = 0;
const check = (name, ok, detail = '') => {
  console.log(`${ok ? '✓' : '✗'} ${name}${detail ? ' — ' + detail : ''}`);
  if (!ok) fails++;
};

const app = new URL('../app/', import.meta.url);
const sw = readFileSync(new URL('coi-serviceworker.min.js', app), 'utf8');
// 註解內的 <script> 不會執行 — 先剝掉,免得被註解掉的引用還讓檢查過
const html = readFileSync(new URL('index.html', app), 'utf8').replace(/<!--[\s\S]*?-->/g, '');
// 同理剝掉整行 // 註解(被註解掉的舊 gate 不算數)
const worker = readFileSync(new URL('js/worker.js', app), 'utf8').replace(/^\s*\/\/.*$/gm, '');
const main = readFileSync(new URL('js/main.js', app), 'utf8').replace(/^\s*\/\/.*$/gm, '');

// SW 必須在 app 根目錄:scope 上限 = 腳本所在目錄(Pages 無 Service-Worker-Allowed),
// 放 vendor/ 底下只能控到 vendor/,主頁面拿不到 COOP/COEP
check('coi-serviceworker 在 app 根目錄且會注入 COOP/COEP',
  sw.includes('Cross-Origin-Embedder-Policy') && sw.includes('Cross-Origin-Opener-Policy'),
  `${(sw.length / 1024).toFixed(1)} KB`);

// 以「字元位置」比先後:config(inline)→ SW 腳本 → 其他外部腳本
const posCfg = html.search(/<script>[^<]*coepCredentialless: \(\) => false/);
const posCoi = html.search(/<script src="coi-serviceworker\.min\.js">/);
const posOther = html.search(/<script [^>]*src="(?!coi-serviceworker)/);
check('index.html 以同目錄相對路徑引用 SW(scope 才涵蓋整站)', posCoi >= 0);
check('window.coi 設定(require-corp 模式;Safari 不支援 credentialless)排在 SW 腳本之前',
  posCfg >= 0 && posCfg < posCoi, `cfg@${posCfg} coi@${posCoi}`);
check('SW 排在其他外部腳本之前(須先註冊/重整才隔離)',
  posCoi >= 0 && (posOther < 0 || posCoi < posOther), `coi@${posCoi} 首個其他 src@${posOther}`);

check('worker numThreads 以 crossOriginIsolated 為 gate、未隔離明示 1 線程',
  /ort\.env\.wasm\.numThreads\s*=\s*self\.crossOriginIsolated\s*\?[^;]*:\s*1\s*;/.test(worker));
// 裸寫 crossOriginIsolated 在缺這個 global 的舊瀏覽器直接 ReferenceError(模組整個掛掉);
// 一律走 self./window. 屬性存取(缺時安全地是 undefined)。前面沒 . 的是裸引用;
// 後面跟 =/: 的是 log 字串裡的標籤(如 `crossOriginIsolated=${...}`),放行
const bare = /(?<![.\w])crossOriginIsolated(?![\w=:])/;
check('main.js/worker.js 不裸寫 crossOriginIsolated(舊瀏覽器 ReferenceError)',
  !bare.test(main) && !bare.test(worker));

process.exit(fails ? 1 : 0);
