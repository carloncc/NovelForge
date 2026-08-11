<div align="center">

<img src="docs/logo.png" width="96" alt="NovelForge" />

# NovelForge

**AI 小説 → ビジュアルノベル変換ツール**

小説（txt）をインポートするだけで、NovelForge が自動でプレイ可能なビジュアルノベルに変換。PC（exe）・Android（APK）・Web（zip）の 3 形式で出力できます。

Tauri 2 + Vue 3 + WebGAL · 軽量・高速 · API は完全カスタマイズ

[English](README.md) · [简体中文](README.zh-CN.md) · **日本語** · [한국어](README.ko-KR.md)

</div>

---

## 特徴

| | 説明 |
|---|---|
| 📖 **全自動パイプライン** | ① AI による章分割 → ② 多言語翻訳（任意）→ ③ キャラ/シーン/アイテムカード抽出 → ④ シナリオ作成（自動 CG 演出・アイテム特写・初登場紹介カード・動画スロット）→ ⑤ 立ち絵/背景/CG/アイテム画像生成 → ⑥ TTS ボイス → ⑦ 標準 WebGAL プロジェクトとして組立 |
| 🎨 **背景透過立ち絵** | AI セグメンテーション（isnet-anime、初回にモデル自動ダウンロード＆キャッシュ）優先、失敗/オフライン時は改良版クロマキー（連結 flood-fill + 緑縁除去 + エッジフェザリング）に自動フォールバック |
| 🎨 **画風の一貫性** | プロジェクト全体の「スタイルアンカー画像」+ 固定シード + 共通ネガティブプロンプト + チェーン img2img（三面図 → 立ち絵 → 表情/アクション）。マルチモーダル自己チェックで参照画像との一致を確認 |
| 📖 **ビジュアルバイブル・ゲート** | 画像の一括生成前に「ビジュアルバイブル」承認が必須：スタイルソースを選択（アップロードした参照画像をビジョンで分析 / LLM が小説全体を分析してスタイル見本を生成）+ 全主人公の三面図（正面/側面/背面）。特定キャラの三面図のみ再生成可能。入力が変わると承認は自動的に無効化 |
| 😊 **表情差分** | キャラごとに 5 表情（通常絵を参照に一貫性を維持）、セリフの感情に応じて自動切替 |
| 🏃 **アクション立ち絵** | 三面図から img2img でアクション立ち絵（抜剣・手振り・腕組みなど）を生成、見た目の一貫性を保持 |
| 🔀 **分岐選択** | LLM が決断ポイントを検出し 2〜3 択を生成、各分岐は本線に合流（WebGAL choose/label/jumpLabel） |
| 🎬 **章タイトルカード** | 各章冒頭に全画面タイトル演出 |
| ✨ **演出強化** | 名シーンは全面 CG、重要アイテムは特写演出、初登場キャラには紹介カード |
| 🎬 **動画スロット** | AI が名シーン位置をマークし動画プロンプトを作成。指定ファイル名で動画（即夢/可灵 など）を配置すると自動で有効化（API 費用ゼロ） |
| 🎙️ **ボイス + 声色制御** | セリフ単位で TTS、声色ライブラリ設定可能、AI がキャラに最適な声色を選択、失敗時は自動でフォールバック |
| 🎵 **BGM** | 音楽ファイルを雰囲気キーワードで自動マッチング。シーン/章の切替時にフェードアウト停止、BGM 鑑賞も解放 |
| 🔌 **API 完全カスタム** | LLM / ビジョン / 画像 / TTS の 4 チャンネルそれぞれに base_url + api_key + model（OpenAI 互換プロトコル）、複数プリセット + テストボタン。画像チャンネルは能力（参照画像数/img2img/シード）をモデル別に設定・自動検出 |
| 🗂️ **素材優先** | キャラ/アイテム/背景画像をインポートし手動マッピング可能。パイプラインは既存素材を優先し、不足分のみ AI 生成 |
| ♻️ **コスト管理** | 全工程ディスクキャッシュ・再開・章単位リラン・中止ボタン・トークン/費用統計・予算上限（超過で自動中止）・失敗タスク一覧と再試行・ログ保存 |
| 💾 **状態の永続化** | 小説/素材/オプション/結果を自動保存。AI 章分割スナップショットで再起動しても章を失わない。最近のプロジェクト履歴でワンクリック切替 |
| 📦 **3 形式エクスポート** | Web zip（キャッシュ自動除外）/ エクスポート前チェック（Lint）/ エクスポート設定（タイトル・game_key・UI 言語）/ PC exe（WebGAL Terre）/ Android APK（公式ツール） |
| 🔒 **セキュリティ** | LLM 出力インジェクション対策、CSP、依存監査で既知 CVE ゼロ |

## スクリーンショット

| 小説インポート | API 設定 | 生成 |
|---|---|---|
| ![Import](docs/screenshots/import.png) | ![Config](docs/screenshots/config.png) | ![Generate](docs/screenshots/generate.png) |

| エクスポート | ゲームタイトル | ゲームストーリー |
|---|---|---|
| ![Export](docs/screenshots/export.png) | ![Title](docs/screenshots/game-title.png) | ![Story](docs/screenshots/game-story.png) |

## クイックスタート

### 動作環境
- Node.js 18+ · pnpm
- Rust（開発/ビルド時のみ）：https://rustup.rs
- Windows / macOS / Linux
- Linux で日本語 UI を表示する場合はフォント導入：`sudo apt install fonts-noto-cjk`

### 開発実行

```bash
pnpm install
pnpm prepare:template   # WebGAL エンジンテンプレート取得（初回のみ、約 75MB、自動トリミング）
pnpm tauri dev
```

### ビルド・リリース

```bash
pnpm prepare:template   # 未実行の場合
pnpm tauri build
```
成果物は `src-tauri/target/release/bundle/`（Windows exe / macOS dmg / Linux AppImage）。

### 使い方

1. **小説をインポート**：txt を選択（GBK/UTF-8 自動判定）、章を自動分割。複数ファイルと LLM による高度な章分割にも対応。カスタム素材のインポートも可能
2. **API を設定**：テキスト LLM の base_url + key + model を入力（DeepSeek が最安、約 ¥1-2/100万トークン）。画像/TTS/ビジョンは後から追加可能（画像生成前までに画像チャンネル設定が必要）
3. **生成**：機能トグル（画像/表情差分/ボイス/動画スロット/BGM/紹介カード）→ 開始 → テキスト工程が先行。画像有効時は先に**ビジュアルバイブル承認**（スタイルソース選択 → 三面図生成/確認 → 承認）→ 承認後に画像/ボイス/組立を実行 → 進捗ログ + 費用統計。ステージ単位の再実行、AI 章分割へのフィードバックも可能
4. **プレビュー**：組み込み WebGAL エンジンで即プレイ
5. **エクスポート**：Web zip は直接デプロイ。exe/APK は生成される「导出说明.txt」の手順に従う

> API キーがなくても体験可能：自動でデモモード（サンプル小説内蔵）に入り、全工程が動作します。

## API 設定例

| サービス | チャンネル | Base URL | モデル例 |
|---|---|---|---|
| DeepSeek | LLM | `https://api.deepseek.com` | `deepseek-chat` |
| SiliconFlow | ビジョン | `https://api.siliconflow.cn/v1` | `zai-org/GLM-4.6V` |
| SiliconFlow | 画像（参照画像） | `https://api.siliconflow.cn/v1` | `Qwen/Qwen-Image-Edit-2509` |
| SiliconFlow | 画像 | `https://api.siliconflow.cn/v1` | `black-forest-labs/FLUX.1-schnell` |
| SiliconFlow | TTS | `https://api.siliconflow.cn/v1` | `FunAudioLLM/CosyVoice2-0.5B` |
| OpenAI | LLM | `https://api.openai.com/v1` | `gpt-4o-mini` |
| Kimi | LLM | `https://api.moonshot.cn/v1` | `moonshot-v1-8k` |
| Ollama（ローカル） | LLM | `http://localhost:11434/v1` | `qwen2.5:7b` |

**ビジョンチャンネル**：「画像を読む」すべての操作（スタイル参照画像の分析、キャラ参照の照合、画像セルフチェック）を担当し、テキスト LLM とは独立。新規設定はビジョンに SiliconFlow `zai-org/GLM-4.6V`、画像に `Qwen/Qwen-Image-Edit-2509`（参照画像最大 3 枚 / img2img）をデフォルト設定。旧 3 チャンネル構成は初回ロード時に自動移行。

## ビジュアルバイブル（画像生成ゲート）

画像生成を有効にすると、一括生成の前に**ビジュアルバイブル**の承認が必須になります（テキスト抽出/シナリオは影響なし）：

- **スタイルソース（二択）**：参照画像をアップロード（ビジョンチャンネルが分析し、グローバルなスタイル参照として使用）、または LLM が小説全体を分析しキャラなしのスタイル見本を生成。
- **キャラ三面図**：各主人公の正面/側面/背面を生成。個別に「三面図を再生成」可能、キャラ参照画像もアップロード可。影響はそのキャラのみ。
- **承認と続行**：キャラごとに確認 → ビジュアルバイブルを承認 → 画像/ボイス/組立が自動再開。小説・キャラ・スタイルに変更があると承認は無効化。
- **サイレントフォールバックなし**：参照画像非対応モデルは `REFERENCE_UNSUPPORTED`、参照ファイル欠落は `REFERENCE_MISSING` を明示。ビジョンチャンネル未設定時も明確な設定案内。

**保存場所**：すべてプロジェクト出力ディレクトリ `.novel2vn/visual-bible/` 配下（マニフェスト `visual-bible.json` は相対パス/プロンプト/承認状態のみ保存、base64 は含まず。画像は `style-reference.*`、`style-sample.png`、`threeview_<キャラID>.png` など）。参照ファイル欠落の場合はディレクトリが移動・削除された可能性があります：元のパスに戻すか、ビジュアルバイブル画面で再アップロード/再生成してください。

## Web モード（ブラウザで直接実行、ビルド不要）

```bash
npm run dev          # または pnpm dev、ブラウザで http://localhost:5173 を開く
```

Web 版はデスクトップ版と同じ機能をブラウザ内の同等実装で提供：

| デスクトップ（Tauri） | Web モード |
|---|---|
| ローカルファイルシステム | IndexedDB 仮想ファイルシステム（ブラウザに永続化） |
| Rust HTTP クライアント（CORS 制限なし） | dev サーバープロキシ中継（`/__novelforge/proxy`） |
| 組み込みプレビューサーバー | フロントが zip 化 → dev サーバーが展開して配信（同一オリジン iframe） |
| Rust rembg 切り抜き | canvas 連結 flood-fill クロマキー（白/黒背景の自動除去） |
| バンドル済み WebGAL テンプレート | `src-tauri/templates/webgal` を IndexedDB へオンデマンド同期 |
| ネイティブファイルダイアログ | ブラウザの `<input type="file">` |
| zip をディスクへ保存 | エクスポート zip を自動ダウンロード |

> 本番：`npm run build` + `npm run preview`（preview サーバーも同じプロキシ/プレビュー中間層を搭載、リバースプロキシ可能）。
> バックエンドのない静的ホスティングではブラウザ直結にフォールバック（ベンダーが CORS 対応している必要あり）。

## ユニバーサルアダプター（画像 / TTS）

各ベンダーの画像/音声プロトコルは大きく異なります（OpenAI 互換 / MiniMax 独自 / Alibaba タスクポーリング）。
NovelForge は**設定駆動のユニバーサルアダプターエンジン**（`sync`/`async` モード + フィールドマッピングテンプレート）を内蔵。設定画面の「ベンダーテンプレート」からワンクリック選択：

| ベンダー | 画像 | TTS |
|---|---|---|
| OpenAI 互換（Zhipu CogView / OpenAI） | ✅ openai-image | ✅ openai-tts |
| SiliconFlow（FLUX、推奨） | ✅ siliconflow-image（シード / ネガティブ / img2img フル対応） | ✅ openai-tts |
| MiniMax（image-01 / speech-2.8） | ✅ minimax-image | ✅ minimax-tts（HEX 自動デコード） |
| Alibaba DashScope（wanx-v1 / CosyVoice） | ✅ dashscope-image（タスクポーリング、シード/ネガティブ対応） | ✅ dashscope-tts |

ほかにも **Google Gemini**（`/v1beta/models/{model}:generateContent`、inlineData 自動抽出）と
**Stability AI**（multipart/form-data + 生バイナリ応答）を内蔵。エンジンはベンダー別エラーボディ（`base_resp` / `error.message` / `output.message` など）を自動解析して読みやすいメッセージに変換します。

新しいベンダーは「詳細 → カスタムアダプターテンプレート」に JSON を貼るだけでコード変更なしで接続可能。
参照画像能力（0〜3 枚、img2img、シード）は画像チャンネルでモデル別に設定・自動検出。能力不足や参照ファイル欠落時は明示的にエラーになり、静かに文生図へフォールバックすることはありません。

## 出力構成（標準 WebGAL プロジェクト）

```
出力ディレクトリ/
├─ index.html, assets/          # WebGAL エンジン（同梱）
├─ 导出说明.txt                 # exe/APK/Web zip の導出手順
├─ video_plan.txt               # AI が作成した動画スロット一覧（プロンプト）
└─ game/
   ├─ config.txt                # ゲーム設定
   ├─ scene/start.txt, ch*.txt  # シナリオ（テキストで直接編集可）
   ├─ background/  figure/  vocal/  bgm/  video/
   └─ .novel2vn/                # キャッシュと中間生成物（削除可）
      └─ visual-bible/          # ビジュアルバイブル：マニフェスト + スタイル参照 + 三面図
```

## 開発とテスト

```bash
# ユニット & E2E テスト（Node）
npx tsx tests/unit-render.ts      # レンダリング注入境界
npx tsx tests/unit-chapters.ts    # 章分割境界
npx tsx tests/unit-cache.ts       # キャッシュ/再開の一貫性
npx tsx tests/unit-tasks.ts       # 画像タスク構築
npx tsx tests/unit-material.ts    # 素材優先マッチング
npx tsx tests/unit-features.ts    # 紹介カード/表情/BGM/動画スロット
npx tsx tests/unit-persist.ts     # 状態永続化
npx tsx tests/unit-retry.ts       # API リトライ機構
npx tsx tests/unit-dedupe.ts      # シーン id 重複排除
npx tsx tests/unit-universal.ts   # ユニバーサルアダプターエンジン（全ベンダーテンプレート）
npx tsx tests/unit-vfs.ts         # IndexedDB 仮想ファイルシステム
npx tsx tests/e2e-demo.ts         # E2E パイプライン（サンプル小説）

# 実機エンジン検証（ヘッドレスブラウザで生成ゲームをロード）
npx tsx tests/engine-check.ts <プロジェクトディレクトリ>

# Rust 側テスト（クロマキー切り抜き）
cd src-tauri && cargo test
```

## アーキテクチャ

```
┌────────────────────────────────────────────┐
│  NovelForge（Tauri 2 + Vue 3 + TypeScript） │
│  ├─ pages: インポート / 設定 / 生成 /       │
│  │          プレビュー / エクスポート        │
│  ├─ core:  split → translate → extract →   │
│  │          script → images → voice →      │
│  │          render → project               │
│  ├─ api:   OpenAI 互換アダプター            │
│  │          （LLM / ビジョン / 画像 / TTS）  │
│  └─ Rust:  ファイル IO / HTTP 中継 /        │
│            プレビューサーバー / クロマキー   │
│            切り抜き / 設定保存              │
└───────────────┬────────────────────────────┘
                ▼ 標準 WebGAL プロジェクト
┌────────────────────────────────────────────┐
│  WebGAL エンジン（MPL-2.0、改変なし）        │
│  プレビュー（内蔵）/ exe（Terre）/           │
│  APK（公式ツール）                          │
└────────────────────────────────────────────┘
```

## クレジットとライセンス

- [WebGAL](https://github.com/OpenWebGAL/WebGAL) —— ビジュアルノベルエンジン（MPL-2.0）、[THIRD_PARTY_NOTICE](./THIRD_PARTY_NOTICE) 参照
- NovelForge 本体は [MIT](./LICENSE) ライセンス
- 公開作品には WebGAL の著作権表示を残す必要があります。ゲームコンテンツの著作権は作者に帰属します

## Roadmap

- [x] 画風一貫性：スタイルアンカー + 固定シード + ネガティブプロンプト + チェーン img2img
- [x] 分岐選択（choose/jumpLabel、LLM が決断ポイントを自動マーク）
- [x] 章タイトルカード / タイトル画面（Title_img/Title_bgm）/ BGM フェードアウト停止と鑑賞解放
- [x] ビジュアルバイブル・ゲート：スタイル参照 + キャラ三面図 + 承認フロー
- [x] ステージ単位生成 + フィードバック（AI 章分割）/ 複数ファイルインポート / 多言語翻訳
- [ ] 表情差分 img2img 強化（表情・衣装差分の追加）
- [ ] AI 音楽生成チャンネル（BGM 完全自動化）
- [ ] トランジション演出（背景遷移エフェクト）
- [ ] ゲーム内キャラ図鑑
- [ ] ナレーション音声（ナレーター声色）
- [ ] 立ち絵の口パク同期
