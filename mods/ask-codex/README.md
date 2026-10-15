# ask-codex

Claude Code の右側のパネルから、Devin SWE-2 への相談と Codex への作業依頼を送る Mod です。
送った分は Devin と Codex の利用枠で動くので、Claude の使用量は使いません。

- **Devin（相談）**: Devin CLI の SWE-2 に質問する。冒頭に「ツール禁止・ファイル読取禁止」を付け、中身の空な専用フォルダーで動かす
- **Codex（作業）**: Codex CLI（`codex exec`）に今の作業フォルダーで作業を頼む。既定は作業フォルダーの中だけ書き換えられる権限

返答はパネルに Markdown で出ます。
「コピー」と「Claudeの入力欄へ」で、返答をそのまま次に使えます。

## 必要なもの

- Claude Code 2.1.295 以降（Mod の仕組みが入っている版）
- 使う送り先の CLI（片方だけでも動きます）
  - [Codex CLI](https://github.com/openai/codex)（`npm i -g @openai/codex` のあと `codex login`）
  - [Devin CLI](https://docs.devin.ai/)（ログイン済みで `devin models list` に SWE-2 が出ること）

## 入れ方

Claude Code のターミナルで次の1行を打ちます。

```
/plugin install ask-codex --marketplace marulimo/ask-codex
```

`Add marketplace?` には `y`、入れる範囲は user（すべてのセッション）を選びます。
入れたあと新しいセッションを始めると、右側に「Devin / Codex」のパネルが開きます。

## 使い方

- パネル上部の「Devin（相談）」「Codex（作業）」で送り先を選び、入力欄に書いて Enter
- 「推論」で強さを選ぶ（Devin は medium / high / max、Codex は low〜xhigh）。送り先ごとに覚えます
- 複数行の長い文は Claude の入力欄に書いて「Claudeの入力欄の文を送る」を押す。Claude には送られません
- コマンドでも送れます: `/devin <質問>`、`/codex <依頼>`、`/codex-panel`（パネルを開く）

## 設定

`/config` の ask-codex の行で変えられます。

| 項目 | 既定 | 内容 |
| --- | --- | --- |
| Codex の権限 | `workspace-write` | `danger-full-access` にすると確認もサンドボックスもなしで動く。自分の環境だけで使うこと |
| Codex の推論強度 | `high` | パネルで送り先ごとに変えられる |
| Codex のモデル | 空 | 空なら Codex CLI の既定モデル |
| codex の場所 | 空 | 空なら自動で探す |
| Devin の強さ | `high` | SWE-2 の medium / high / max |
| devin の場所 | 空 | 空なら自動で探す |
| Devin を動かすフォルダー | 空 | 空なら `~/.ask-codex/devin-chat` |

## 注意

- Devin は `--respect-workspace-trust false` を付けて、その1回だけフォルダーの信頼確認を省いて動かします。動かす場所は中身の空な専用フォルダーです
- Codex を `danger-full-access` にすると、今の作業フォルダーのファイルを確認なしで書き換え、コマンドも実行します。git で戻せる状態で使ってください
- 返答は日本語で返すよう指示しています
- 失敗の記録は `~/.ask-codex/errors.log` に残ります
- 利用料金は各サービスの規約に従います。SWE-2 が無料かどうかは Devin 側の提供条件によります

## English

A Claude Code mod that adds a right-side pane for sending prompts to **Devin SWE-2** (chat only, tools forbidden, run in an empty folder) and **Codex CLI** (works in your current folder; `workspace-write` by default, `danger-full-access` opt-in). Answers render as Markdown in the pane, and nothing is sent to Claude unless you press "Claudeの入力欄へ". Install with `/plugin install ask-codex --marketplace marulimo/ask-codex`. The UI and the chat guard are in Japanese.

## ライセンス

MIT
