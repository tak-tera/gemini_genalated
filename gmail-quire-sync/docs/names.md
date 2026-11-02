# 名前と URL・設定値の対応表

このプロジェクトのものは、すべて `QT-`（Quire Task）で始めます。
名前を変えても ID・URL・チップは変わらないので、動作には影響しません。

## 部品の名前

| 種類 | 名前 | 旧名 | 役割 | コード |
|---|---|---|---|---|
| Apps Script | **QT-本体** | Gmail→Quir | 確認カードの送信、承認ページ、Quire への登録、学習、スナップショット | `apps-script/` |
| Apps Script | **QT-受付口** | Gmail→Stuido→Quire 振り分けルール | Studio の Webhook を受け、台帳に「承認待ち」で追記するだけ | `apps-script-intake/` |
| スプレッドシート | **QT-台帳** | Gmail→Quire 振り分けルール | 振り分けルール・設定・登録ログ・Quireスナップショット（タブ名は変えない） | — |
| Studio フロー | **QT-メール判定** | 新着メールのタスク判定とWebhook送信 | メールを判定して受付口へ | `docs/studio.md` |
| Studio フロー | **QT-チャット判定-TC** | — | TC スペースの投稿を判定して受付口へ | `docs/chat-setup.md` |
| Studio スキル | **QT-判定スキル-メール** | Quire タスク判定 | メールの判定基準 | `docs/studio-skill.md` |
| Studio スキル | **QT-判定スキル-チャット** | Quire タスク判定（Chat） | チャットの判定基準 | `docs/studio-chat-skill.md` |
| Chat スペース | **QT-確認** | Quire登録確認 | メール由来の確認カードが届く自分用のスペース | — |
| Chat の Webhook 名 | **QT-確認カード** | Quire登録確認 など | QT-確認 と TC に登録する Webhook の名前 | — |
| claude.ai スキル | quire-task-candidate | — | 会話や議事録から台帳に候補を追加（Claude 版） | `skill/quire-task-candidate/` |
| Claude 定期実行タスク | Gmail→Quire タスク候補の判定 | — | Claude 版のメール判定（一時停止中） | `docs/claude-routine.md` |

## URL・設定値

| 呼び名 | 中身 | 置き場所 |
|---|---|---|
| 承認ページ URL | QT-本体 の Web アプリの URL（`…/exec`） | QT-本体 の `WEBAPP_URL` |
| 受付口 URL | QT-受付口 の Web アプリの URL ＋ `?key=合言葉` | QT-メール判定・QT-チャット判定-TC の Webhook ステップ |
| 確認用 Webhook | QT-確認 スペースの Webhook の URL | QT-本体 の `CHAT_WEBHOOK_URL` |
| TC Webhook | TC スペースの Webhook の URL | QT-本体 の `SPACE_WEBHOOK_TC` |
| 合言葉 | 受付口が照合する値 | QT-受付口 の `INTAKE_TOKEN`（QT-本体 には置かない） |

- Chat の Webhook の URL に付いている `key` と `token` は Google Chat が付けるもので、受付口の合言葉とは別物
- 合言葉を作り直したら、QT-メール判定 と QT-チャット判定-TC の両方の URL を差し替える
- Intake.gs は QT-受付口 にだけ置く。QT-本体 に入れると承認ページが受付口の画面に置き換わる

## スペースや入口を増やすとき

- フロー：`QT-チャット判定-（スペース名）`
- QT-本体 のスクリプト プロパティ：`SPACE_WEBHOOK_（スペース名）`
- Webhook 名：`QT-確認カード`（どのスペースでも同じ名前でよい）
