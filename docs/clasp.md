# clasp による Apps Script の管理

このリポジトリの Apps Script（`calendar-sync/`、`gmail-quire-sync/`）は clasp で GAS に反映します。
エディタへの貼り付けは不要になります。

```
コードを直す → プルリクエスト（構文チェック）→ main にマージ
                                              └─▶ GitHub Actions が clasp push
                                                   （Web アプリは同じ URL のまま新しい版に更新）
```

| 対象 | 置き場所 |
|---|---|
| clasp の設定（どの GAS プロジェクトか） | 各フォルダの `.clasp.json`（`scriptId`） |
| GAS に送るファイル | 各フォルダの `apps-script/` の `.gs` と `appsscript.json`（`.claspignore`） |
| 自動反映 | `.github/workflows/gas-deploy.yml` |
| clasp のログイン情報 | GitHub の Secrets `CLASPRC_JSON`（リポジトリには置かない） |

## 1. 最初に1回だけ（所要 15 分ほど）

### 1-1. Apps Script API をオンにする

メインのアカウント（t-consulting.biz）で https://script.google.com/home/usersettings を開き、
「Google Apps Script API」を **オン** にします。

### 1-2. 自分の PC で clasp にログインする

Node.js 20 以上が必要です。

```sh
git clone https://github.com/tak-tera/gemini_genalated.git
cd gemini_genalated
npm ci
npm run login        # ブラウザが開くので、メインのアカウントで許可
```

ホームフォルダに `.clasprc.json` ができます（ログイン情報。人に渡さない）。

> 管理コンソールでサードパーティ アプリを制限していて許可画面が出ない場合は、
> 「セキュリティ」→「API の制御」で clasp（Google Apps Script CLI）を信頼済みにしてください。

### 1-3. スクリプト ID を設定する

1. 対象の GAS プロジェクトを開き、左の歯車「プロジェクトの設定」→「スクリプト ID」をコピー。
   - calendar-sync をまだ作っていなければ、https://script.google.com/ で「新しいプロジェクト」を作ってから。
2. `calendar-sync/.clasp.json` / `gmail-quire-sync/.clasp.json` の `"scriptId": ""` に貼り付けます。
   （スクリプト ID だけでは誰も中身を見られないので、リポジトリに入れてかまいません）

### 1-4. 既存プロジェクトは、先に GAS 側の中身を取り込んで比べる

gmail-quire-sync のようにエディタで直したことがあるプロジェクトは、push で上書きする前に確認します。

```sh
npm run quire:pull   # GAS 側の中身を apps-script/ に取り込む
git diff             # リポジトリとの違いを確認。残したい変更があればコミットする
```

### 1-5. GitHub に登録する

リポジトリの Settings →「Secrets and variables」→「Actions」で登録します。

| 種類 | 名前 | 値 |
|---|---|---|
| Secrets | `CLASPRC_JSON` | 1-2 でできた `~/.clasprc.json` の中身をそのまま |
| Variables | `GAS_DEPLOYMENT_ID_GMAIL_QUIRE_SYNC` | gmail-quire-sync の Web アプリの配信 ID（`AKfy…`） |
| Variables | `GAS_DEPLOYMENT_ID_CALENDAR_SYNC` | 不要（calendar-sync は Web アプリがないので空のまま） |

配信 ID は GAS エディタの「デプロイ」→「デプロイを管理」、または
`npx clasp -P gmail-quire-sync deployments` で確認できます。
配信 ID を入れておくと、Web アプリの URL（Chat カードのボタン先）を変えずに新しい版に更新します。

## 2. ふだんの使い方

- コードを直してプルリクエストを出す → 構文チェックが走る
- main にマージ → 変わったプロジェクトだけ GAS に反映される
- 手動で反映したいとき: GitHub の「Actions」→「Apps Script (clasp)」→「Run workflow」でプロジェクトを選ぶ

自分の PC から直接使うコマンド:

| コマンド | 内容 |
|---|---|
| `npm run check` | 構文チェック |
| `npm run calendar:push` / `npm run quire:push` | GAS に反映（構文チェックのあと） |
| `npm run calendar:pull` / `npm run quire:pull` | GAS 側の中身を取り込む |
| `npm run calendar:status` / `npm run quire:status` | 送られるファイルの一覧 |
| `npm run calendar:open` / `npm run quire:open` | GAS エディタを開く |
| `npm run calendar:logs` / `npm run quire:logs` | 実行ログを見る |

## 3. 注意

- **GAS エディタで直接直さない**。次の push で上書きされます。直したときは `pull` してコミットしてください。
- `appsscript.json` で権限（oauthScopes）を増やしたときは、反映後に GAS エディタで関数を1回手動実行して承認し直します。
  承認するまでトリガーが失敗します。
- トリガー・スクリプト プロパティ・Web アプリの設定は push では変わりません。
- `CLASPRC_JSON` はメインのアカウントで Apps Script を書き換えられる鍵です。漏れたおそれがあるときは
  https://myaccount.google.com/permissions で clasp のアクセスを取り消し、`npm run login` からやり直して Secrets を更新します。
