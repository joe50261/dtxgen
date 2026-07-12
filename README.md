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
會 `npm ci` → 同步 vendor 資產 → 跑測試 → 把 `app/` 整包發佈到 Pages。
首次執行會自動啟用 Pages(build type = GitHub Actions),不需手動到 Settings 設定;
也可在 Actions 頁面手動觸發(workflow_dispatch)。

## 版控範圍

可再生的資產不進 git,由 `scripts/sync-vendor.mjs`(`npm install` 的 postinstall)
從 npm 套件同步:

| 路徑 | 來源 | 版控 |
|---|---|---|
| `app/models/htdemucs.onnx`(174MB) | npm `demucs` | ✗(同步) |
| `app/vendor/demucs/` | npm `demucs` dist(import 已改寫) | ✗(同步) |
| `app/vendor/ort/` | npm `onnxruntime-web` dist | ✗(同步) |
| `app/vendor/jszip.min.js`、`libflac.min.wasm.*` | 手工 vendor | ✓ |
| `app/models/` 其餘小模型(ADTOF/GBDT/濾波器組) | 訓練產物 | ✓ |
