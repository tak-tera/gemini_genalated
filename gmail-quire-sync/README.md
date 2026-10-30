# Gmail → Quire タスク登録（Google Chat で確認）

Gmail の受信トレイから自分がやるべきことを見つけ、Google Chat のボタンで確認してから Quire に登録する仕組みです。

## 全体の流れ

```
Gmail ──(1時間ごと)──▶ Claude の定期実行タスク
                         │ メールを読み、タスクかどうか・どのプロジェクトかを判断
                         ▼
                 Google スプレッドシート「登録ログ」（ステータス: 承認待ち）
                         │
                         ▼ 5分ごと
                 Apps Script ──(Webhook)──▶ Google Chat のスペースにカードを送る
                                              [登録する] [内容を直して登録] [却下] [メールを開く]
                         ┌────────────────────────┘ ボタンを押すとブラウザが開く
                         ▼
                 Apps Script の Web ページ（自分だけが開ける）
                         │ Quire API でタスクを作成 ──▶ 登録ログを「登録済」に更新
                         ▼ 毎朝
                 Quire で別プロジェクトへ移したタスクを調べ、送信者を振り分けルールに追加
```

Google Cloud の設定は不要です。チャットへの送信は Google Chat の Webhook、
ボタンを押したあとの処理は Apps Script の Web アプリで行います。

| 役割 | 担当 |
|---|---|
| メールを読んでタスクか判断し、振り分け先を決める | Claude（定期実行タスク） |
| Chat への確認カード送信 | Apps Script（Webhook） |
| ボタンを押したあとの登録・却下 | Apps Script（Web アプリ） |
| Quire への登録 | Apps Script（Quire API） |
| 再分類からの学習 | Apps Script（登録先の変更と、Quire での移動を検知） |
| セクション・依存関係 | Claude が提案し、Apps Script がセクションの下に作成して依存関係をつなぐ |

## スプレッドシート

「Gmail→Quire 振り分けルール」というスプレッドシートを使います。タブは3つです。

- **振り分けルール**: プロジェクトごとの送信元・関係性メモ・キーワード
- **設定**: General の入れ先、確信度の下限、処理済みラベル、Chat で確認するかどうか など
- **登録ログ**: 判定結果と承認状況（1タスク1行）。W〜Z 列はセクション・先行タスク・後続タスク・依存メモ
- **Quireスナップショット**: Apps Script が毎時 Quire から写す、プロジェクトごとのセクションと未完了タスク（Claude の提案と編集ページの選択肢に使う）

## フォルダ構成

- `apps-script/` … Apps Script のコード（Webhook 送信、Web ページ、Quire API、トリガー処理）
- `docs/setup.md` … 設定手順（Webhook・Web アプリ・Quire API）
- `docs/claude-routine.md` … Claude の定期実行タスクに渡す指示文
- `docs/studio.md` … Google Workspace Studio（Gemini）から使う場合の受付口と初期プロンプト
- `apps-script-intake/` … Studio の Webhook を受ける受付口（別の Apps Script プロジェクト）

## メール以外からの候補（共通スキル）

`skill/quire-task-candidate/SKILL.md` は、会議・議事録、チャット、手入力、他プロジェクトなどから
タスク候補を登録ログに追加するための Claude のスキルです（claude.ai のアカウント共通スキルとして使う）。
候補は「出どころ」列（V列）で区別され、メールと同じくチャットで確認してから Quire に登録されます。
使う前に `【スプレッドシートID】` を実際の ID に置き換えてください。
送信者の学習はメール由来の候補だけで行います。

## 新しいプロジェクトの扱い

Quire API にはプロジェクトを作る機能がないため、既存のどれにも合わない案件は General に入れ、
「新規PJ候補」タグ（無ければタスク名の先頭に印）を付けます。Quire でプロジェクトを作ったら、
振り分けルールに1行追加してください。次回からそこへ振り分けます。
