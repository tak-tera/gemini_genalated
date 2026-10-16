/**
 * Google Chat の Webhook への送信。
 * Google Cloud の設定は不要。スペースで発行した Webhook URL を
 * スクリプト プロパティ CHAT_WEBHOOK_URL に保存して使う。
 */

/** Webhook にメッセージを送る。戻り値は作成されたメッセージ。 */
function sendToChat_(message) {
  const res = UrlFetchApp.fetch(prop_('CHAT_WEBHOOK_URL'), {
    method: 'post',
    contentType: 'application/json; charset=UTF-8',
    payload: JSON.stringify(message),
    muteHttpExceptions: true,
  });
  if (res.getResponseCode() >= 300) {
    throw new Error('Chat Webhook エラー ' + res.getResponseCode() + ': ' + res.getContentText().slice(0, 300));
  }
  return JSON.parse(res.getContentText());
}

/** ボタンのリンク先になる Web アプリの URL。 */
function webAppUrl_() {
  const url = prop_('WEBAPP_URL', false) || ScriptApp.getService().getUrl();
  if (!url) throw new Error('Web アプリの URL が未設定です。docs/setup.md の手順 5 を参照してください。');
  return url;
}

function actionUrl_(action, messageId) {
  return webAppUrl_() + '?action=' + action + '&id=' + encodeURIComponent(String(messageId));
}
