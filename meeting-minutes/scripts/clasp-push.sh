#!/usr/bin/env bash
# apps-script/ の中身を Apps Script プロジェクト（mtgmin-gas）へ送る。
# ログイン情報は環境変数 CLASPRC_JSON（clasp login で作られる ~/.clasprc.json の中身）から読む。
# 使い方: meeting-minutes/scripts/clasp-push.sh        … 送る
#         meeting-minutes/scripts/clasp-push.sh status … 送るファイルの一覧だけ表示
set -euo pipefail

CLASP_VERSION="3.4.1"
cd "$(dirname "$0")/../apps-script"

if [ -z "${CLASPRC_JSON:-}" ]; then
  echo "環境変数 CLASPRC_JSON が未設定です（クラウド環境の設定で登録し、新しいセッションで実行してください）。" >&2
  exit 1
fi

# ログイン情報は本人だけが読めるファイルに書く
umask 077
printf '%s' "$CLASPRC_JSON" > "$HOME/.clasprc.json"

if [ "${1:-}" = "status" ]; then
  npx -y "@google/clasp@${CLASP_VERSION}" show-file-status
else
  # --force: マニフェスト（appsscript.json）の上書き確認を省く
  npx -y "@google/clasp@${CLASP_VERSION}" push --force
fi
