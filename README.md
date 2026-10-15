# Claude Code Mods

Claude Code の Mod（10/1 公開の拡張機能）6本をまとめたリポジトリです。

## インストール

ターミナルの Claude Code で、`<mod>` を下記の名前に置き換えて実行します。

```text
/plugin install <mod> --marketplace marulimo/claude-code-mods
```

続けて `y` を入力し、インストール先のスコープを選びます。デスクトップアプリの Code タブではこのコマンドは使えないため、ターミナルでインストールしてください。user スコープに入れれば、デスクトップのセッションでも読み込まれます。

Mod の設定項目は各 `mods/<mod>/.claude-plugin/plugin.json` の `userConfig` に定義しています。実行コマンドは PATH 上で見つかる必要があります。別の場所にある場合は設定で実行ファイルのパスを指定してください。

## ask-codex

右側のパネルから、Devin SWE-2 への相談と Codex への作業依頼を送ります。送った分は Devin と Codex の利用枠で動き、Claude の使用量は使いません。単独のリポジトリ [marulimo/ask-codex](https://github.com/marulimo/ask-codex) でも同じ版を公開しています。

- 使い方: パネル上部の「Devin（相談）」「Codex（作業）」で送り先を選び、入力欄に書いて Enter。「推論」で強さを選びます（送り先ごとに覚えます）。コマンドでも送れます: `/devin <質問>`、`/codex <依頼>`、`/codex-panel`。
- 必要なもの: 使う送り先の CLI です（片方だけでも動きます）。Codex CLI はログイン済み、Devin CLI はログイン済みで SWE-2 が使えること。
- 設定: Codex の権限（`workspace-write`）、Codex の推論強度（`high`）、Codex のモデル（空なら CLI の既定）、codex の場所（空なら自動で探す）、Devin の強さ（`high`）、devin の場所（空なら自動で探す）、Devin を動かすフォルダー（空なら `~/.ask-codex/devin-chat`）です。
- 注意: Codex の権限を `danger-full-access` にすると、確認もサンドボックスもなしで作業フォルダーを書き換えます。Devin は中身の空な専用フォルダーで、その1回だけフォルダーの信頼確認を省いて動かします。失敗の記録は `~/.ask-codex/errors.log` に残ります。
- 詳しくは [mods/ask-codex/README.md](mods/ask-codex/README.md) を参照してください。

## ai-usage-hub

Claude、Codex、Grok、Gemini、Devin の使用率とリセット時刻をパネルに表示します。Claude のセッション情報と外部 collector の結果を使います。

- コマンド: `/usage-hub`。起動時にもパネルを開き、5分おきに取得します。
- 必要なもの: Node.js と、各サービスの使用率を集める collector が別途必要です。collector とそのログイン処理はこのリポジトリには含まれません。
- 設定: `userConfig` はありません。環境変数 `AI_USAGE_NODE`（既定 `node`）と `AI_USAGE_DASH_DIR`（既定は `USERPROFILE` または `HOME` の下の `ai-usage-dashboard`）を使います。
- 呼び出し: collector のフォルダーを作業ディレクトリとして、次を実行します。終了コード 0 で、標準出力に JSON だけを返してください。

```text
node <AI_USAGE_DASH_DIR>/server.mjs --json codex,grok,gemini,devin,claude
```

JSON は次の形です。`groups` は必須配列で、グループには文字列の `name` と配列の `rows` が必要です。行には文字列の `label` と有限の数値または `null` の `used` が必要です。`used` は使用率の百分率です。

```json
{
  "groups": [
    {
      "name": "CODEX",
      "rows": [
        { "label": "5時間", "used": 25, "reset": "2026-10-16T00:00:00Z" },
        { "label": "週次", "used": null, "state": "データなし" }
      ],
      "stale": false,
      "note": null
    }
  ]
}
```

認識するグループ名は `CLAUDE`、`CODEX`、`GROK`、`GEMINI`、`DEVIN` です。省略可能な項目は、行の `reset`（日時文字列）、`state`（状態文字列）、`star`（真なら Claude の Fable 枠）、グループの `stale`（真なら古いデータ）、`note`（文字列）です。Claude の補完行は `5時間` と `週次` で始まるラベルを使います。取得に失敗したときは前回値を残すため、表示の失敗時刻も確認してください。

## ai-router

入力を送信すると、依頼に適した AI の判定結果をトーストとステータス行に表示します。Claude への送信は判定の完了を待ちません。

- コマンド: ありません。通常の入力送信時に動きます。スラッシュコマンド、空白を除いて8文字未満の入力などは判定しません。
- 必要なもの: Python と外部の判定スクリプトです。スクリプト、利用先 API の設定や認証は同梱しません。
- 設定: `pythonPath`（`python`）、`routerScript`（空）、`backend`（`jev`、または `decisions`）、`privateFolders`（空）、`privateWords`（空）です。
- `routerScript` が空なら実行せず、「判定スクリプト未設定」と表示します。
- `privateFolders` は除外する絶対パス、`privateWords` は除外する語句をカンマ区切りで指定します。フォルダー自身とその配下、語句の部分一致を大文字小文字を区別せず判定します。既定ではどちらも除外しません。
- 注意: 設定すると入力全文を判定スクリプトの標準入力へ渡します。外部送信の有無はスクリプト側の実装にも依存します。

呼び出しは次の形です。入力全文を標準入力から読み、12秒以内に終了コード 0 と標準出力の JSON を返す必要があります。

```text
python <routerScript> --backend jev
```

`backend` を `decisions` にすると末尾の引数も `decisions` になります。成功結果の例です。

```json
{
  "ok": true,
  "label": "候補A",
  "entry": "作業の入口",
  "top": [{ "id": "candidate_a", "p": 0.82 }, { "id": "candidate_b", "p": 0.11 }]
}
```

成功時は `ok: true`、文字列の `label` と `entry`、1件以上の `top` が必要です。`p` は 0〜1 の有限数なら百分率で表示します。2件目の `id` と `p` が有効なら次点も表示します。失敗時は `{"ok":false,"reason":"service_unavailable"}` の形を返せます。`reason` は英字で始まる英数字・アンダースコア80文字以内だけを表示します。それ以外は一般的な失敗表示になります。

## side-chat

Claude が考えている間、Dots 役（ChatGPT）と GrokBot 役（Grok）がパネルで交互に、いまの会話の話題について雑談します。直近の会話（最大8発言・1発言300字・合計1500字）、このターンの使用ツール名、直近の雑談を送り先に渡します。

- 送らないもの: ツールの出力とコードブロックは渡しません。設定 `privateWords` の語句を含む発言は丸ごと省き、APIキー・トークン・メールアドレス・32文字以上の英数字列は伏せ字にします。

- コマンド: `/side-chat`、`/side-chat off`、`/side-chat on` です。
- 必要なもの: ログイン済みの Codex CLI と、`hermes_cli` を読み込める Python / Hermes Agent です。Grok は `xai-oauth` 経由で X Premium の枠を使います。
- 設定: `codexPath`（`codex`）、`gptModel`（`gpt-6.1-sol`）、`python`（`py`）、`pythonVersion`（`-3.13`）、`grokModel`（`grok-4.3`）、`startDelaySec`（20秒）、`gapSec`（20秒）、`maxLines`（6）、`privateFolders`（空）、`privateWords`（空）です。Python ランチャーに版指定が不要なら `pythonVersion` を空にします。
- `privateFolders` は除外する絶対パスをカンマ区切りで指定します。設定したフォルダーとその配下では送りません。既定では除外しません。
- `privateWords` は雑談の材料に渡さない語句をカンマ区切りで指定します。大文字小文字を区別せず部分一致で判定します。既定では除外しません。
- 注意: 雑談ごとに Codex / Grok の利用枠を使います。不要な場合は `off` で止めてください。

## tag-feed

X のハッシュタグに合う投稿を探し、パネルに新着を表示します。タグを登録すると定期取得します。

- コマンド: `/tag-feed #タグ #別のタグ`、`/tag-feed` です。パネルには即時取得と停止・再開のボタンがあります。
- 必要なもの: `hermes_cli` を読み込める Python / Hermes Agent と、Grok の `xai-oauth` ログインです。
- 設定: `python`（`py`）、`pythonVersion`（`-3.13`）、`model`（`grok-4.3`）、`intervalMinutes`（10分、最短2分）です。
- 注意: X API は使いません。Grok の検索で投稿 URL を探し、X の埋め込み用の公開エンドポイントから本文を取得します。取得ごとに Grok の X Premium 枠を使います。検索結果や公開エンドポイントの状況により取得できない投稿もあります。

## x-post

本文に登録タグを付け、ブラウザで X の投稿画面や返信画面を開きます。最後の「ポスト」は人が押します。この Mod が自分で投稿することはありません。

- コマンド: `/x 本文`、`/x-reply <投稿URL> 本文`、`/x-tag [add|rm|clear] [タグ]`、`/x-mode on|off`、`/x-account @名前`、`/x-pane` です。
- ペイン: 上にハッシュタグ（入力欄で追加、押すと削除）とメンション、下に投稿欄（返信先と本文。Enter で投稿画面を開く）を並べます。本文はハッシュタグ込みのプレビューと文字数の目安を出します。
- 必要なもの: X にログインしたブラウザです。メンション検索には別途、PATH 上の Hermes Agent（`hermes`）と Grok のログインが必要です。`hermes` が無くても投稿はできます。
- 設定: `userConfig` はありません。タグ、推論中だけ投稿可能にするモード、自分のアカウントを上記コマンドで保存します。アカウントの既定値は空で、未設定ならペインに `/x-account @名前 で設定` と出ます。`hermes` のモデルとプロバイダーは環境変数 `X_POST_HERMES_MODEL`（既定 `grok-4.3`）と `X_POST_HERMES_PROVIDER`（既定 `xai-oauth`）で変えられます。
- 上限: タグは10個、1つ50文字までです。本文がタグ込みで280を超えると投稿画面を開きません（X に合わせ、日本語などは1文字2、URL は23と数える目安です）。
- 注意: X API キーは不要です。メンション検索は「更新」を押したときだけ動き、1回30〜40秒かかり Grok の枠を使います。検索なので取りこぼしがあり、X の通知画面の代わりにはなりません。ブラウザは Windows では `rundll32`、macOS では `open`、それ以外では `xdg-open` で開きます。開けなければコマンドが返すリンクから開いてください。デスクトップ版ではペインの幅を Mod から変えられないので、狭いときは境目をドラッグしてください。

## 動作環境とライセンス

作者は Windows 11 で動かしています。他 OS は未確認です。Mod 対応の Claude Code が必要です。

MIT ライセンスです。詳しくは [LICENSE](LICENSE) を参照してください。
