# dtxgen web

[![CI](https://github.com/joe50261/dtxgen/actions/workflows/ci.yml/badge.svg)](https://github.com/joe50261/dtxgen/actions/workflows/ci.yml)
[![Deploy](https://github.com/joe50261/dtxgen/actions/workflows/deploy-pages.yml/badge.svg)](https://github.com/joe50261/dtxgen/actions/workflows/deploy-pages.yml)

純前端 DTX 自動製譜:音檔/譜包 zip → DTXMania 四難度譜包。全部運算在瀏覽器內,
零後端、檔案不離機 — 詳見 [`app/README_WEB.md`](app/README_WEB.md)。

**線上版:<https://joe50261.github.io/dtxgen/>**

## 開發

```bash
npm install            # 會自動抓 demucs(含分離模型)並同步到 app/
npm start              # 開 http://localhost:8080(或 npm run serve)
npm test               # 冒煙測試(node)
```

## 部署(GitHub Pages)

push 到 `main` 即自動部署:[`deploy-pages.yml`](.github/workflows/deploy-pages.yml)
會 `npm ci` → 同步 vendor 資產 → 跑測試 → 把 `app/` 整包發佈到 Pages;
也可在 Actions 頁面手動觸發(workflow_dispatch)。

**首次(一次性)**:若 workflow 在 configure-pages 步驟報
「Get Pages site failed」,到 Settings → Pages 把 Source 設為
「GitHub Actions」再重跑即可(啟用站台需 admin 權限,workflow 的
GITHUB_TOKEN 無法代辦)。

## 版控範圍

可再生的資產不進 git,由 `scripts/sync-vendor.mjs`(`npm install` 的 postinstall)
從 npm 套件同步:

| 路徑 | 來源 | 版控 |
|---|---|---|
| `app/models/htdemucs.onnx.*`(174MB,24MiB 分塊+manifest) | npm `demucs` | ✗(同步) |
| `app/vendor/demucs/` | npm `demucs` dist(import 已改寫) | ✗(同步) |
| `app/vendor/ort/`(jsep.wasm 為 24MiB 分塊) | npm `onnxruntime-web` dist | ✗(同步) |
| `app/vendor/jszip.min.js`、`libflac.min.wasm.*` | 手工 vendor | ✓ |
| `app/coi-serviceworker.min.js`(COOP/COEP 注入,啟用 WASM 多線程) | 手工 vendor | ✓ |
| `app/models/` 其餘小模型(ADTOF/GBDT/濾波器組) | 訓練產物 | ✓ |

超過 25MiB 的大檔(`htdemucs.onnx`、ort 的 `jsep.wasm`)同步時切成
24MiB 分塊 + manifest — 靜態主機有單檔上限(如 Cloudflare Pages 25MiB),
整檔無法部署;worker 於執行期依 manifest 抓回拼裝(`app/js/worker.js`)。

第三方元件授權(含 htdemucs 權重「僅限個人/研究用途」之注意事項)見
[`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md)。
