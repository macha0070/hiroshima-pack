# 広島県市町ゲーム

広島県の 30 市区町（広島市は 8 区に分割）を箱に詰め、となり同士をくっつけて広島県を完成させるパズルゲーム。

**遊ぶ: https://macha0070.github.io/hiroshima-pack/**

## 構成

- `game/index.html` `game/game.js` — ゲーム本体（matter.js 0.19.0 を CDN から読み込み）
- `game/data.js` — 市区町の形と隣接表（生成物、手で編集しない）
- `data/N03-21_34_210101.json` — 元データ（国土数値情報 行政区域、[smartnews-smri/japan-topography](https://github.com/smartnews-smri/japan-topography) の 1% 簡略版）
- `tools/build-data.js` — `data/` から `game/data.js` を作る
- `tools/serve.js` — 動作確認用のローカルサーバー

## 使い方

```bash
cd tools && npm install
```

```bash
node tools/build-data.js
```

```bash
node tools/serve.js 5180
```

`main` に push すると `.github/workflows/pages.yml` が `game/` を GitHub Pages に公開する。

## 調整しどころ

- `game/game.js` 冒頭の Tuning（サイズ指数 `SIZE_EXP`、制限時間、得点、出す順番の `START_POOL` / `PICK_POOL`）
- `tools/build-data.js` の `ISLAND_MIN`（ピースに含める島の下限）と `SEA`（海をまたぐ隣接）

出典：「国土数値情報（行政区域データ）」（国土交通省）を加工して作成
