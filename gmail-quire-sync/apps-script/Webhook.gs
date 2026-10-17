/**
 * Google Chat の Webhook への送信と、カードのボタンに付けるリンクの作成。
 *
 * セキュリティ:
 *  - Webhook URL は秘密情報。コードやシートには書かず、スクリプト プロパティ CHAT_WEBHOOK_URL にだけ保存する
 *  - 送信先は chat.googleapis.com に限定する（プロパティが書き換えられても他所へ送らない）
 *  - ボタンのリンクには署名（HMAC）を付け、署名が合わないリンクでは何もしない
 */

const WEBHOOK_PREFIX = 'https://chat.googleapis.com/v1/spaces/';
const WEBAPP_PREFIX = 'https://script.google.com/';

/** Webhook にメッセージを送る。戻り値は作成されたメッセージ。 */
function sendToChat_(message) {
  const url = String(prop_('CHAT_WEBHOOK_URL'));
  if (url.indexOf(WEBHOOK_PREFIX) !== 0) {
    throw new Error('CHAT_WEBHOOK_URL が Google Chat の Webhook URL ではありません。');
  }
  const res = UrlFetchApp.fetch(url, {
    method: 'post',
    contentType: 'application/json; charset=UTF-8',
    payload: JSON.stringify(message),
    muteHttpExceptions: true,
  });
  if (res.getResponseCode() >= 300) {
    // エラー内容に URL（鍵とトークン）は含まれないが、念のため本文も短く切る
    throw new Error('Chat Webhook エラー ' + res.getResponseCode() + ': ' + res.getContentText().slice(0, 200));
  }
  return JSON.parse(res.getContentText());
}

/** ボタンのリンク先になる Web アプリの URL。 */
function webAppUrl_() {
  const url = String(prop_('WEBAPP_URL', false) || ScriptApp.getService().getUrl() || '');
  if (url.indexOf(WEBAPP_PREFIX) !== 0) {
    throw new Error('WEBAPP_URL が未設定か、Apps Script の URL ではありません。docs/setup.md の手順 4 を参照してください。');
  }
  return url;
}

/** 署名付きのボタン用リンク。 */
function actionUrl_(action, messageId) {
  const id = String(messageId);
  return webAppUrl_() + '?action=' + encodeURIComponent(action)
    + '&id=' + encodeURIComponent(id)
    + '&sig=' + signAction_(action, id);
}

// ---------- リンクの署名 ----------

/** 署名用の秘密鍵。無ければ作ってスクリプト プロパティに保存する。 */
function linkSecret_() {
  const props = PropertiesService.getScriptProperties();
  let secret = props.getProperty('LINK_SECRET');
  if (!secret) {
    secret = Utilities.getUuid() + Utilities.getUuid();
    props.setProperty('LINK_SECRET', secret);
  }
  return secret;
}

function signAction_(action, messageId) {
  const bytes = Utilities.computeHmacSha256Signature(action + ':' + messageId, linkSecret_());
  return Utilities.base64EncodeWebSafe(bytes).replace(/=+$/, '');
}

/** 署名を確かめる。比較は文字ごとの時間差が出ない方法で行う。 */
function verifyAction_(action, messageId, sig) {
  const expected = signAction_(action, String(messageId));
  const given = String(sig || '');
  if (given.length !== expected.length) return false;
  let diff = 0;
  for (let i = 0; i < expected.length; i++) diff |= expected.charCodeAt(i) ^ given.charCodeAt(i);
  return diff === 0;
}

/** 【手動で実行】署名鍵を作り直す。これまでに送ったカードのボタンはすべて使えなくなる。 */
function rotateLinkSecret() {
  PropertiesService.getScriptProperties().deleteProperty('LINK_SECRET');
  linkSecret_();
  Logger.log('署名鍵を作り直しました。送信済みカードのボタンは無効になります。');
}

// ---------- 外部から来た値の確認 ----------

/** 許可したホストの https URL だけを通す。それ以外は空文字。 */
function safeUrl_(value, prefix) {
  const url = String(value || '').trim();
  return url.indexOf(prefix) === 0 && !/[\s"'<>]/.test(url) ? url : '';
}

function safeGmailUrl_(value) {
  return safeUrl_(value, 'https://mail.google.com/');
}

// 元リンクとして開いてよいサイト。これ以外の URL はカードやタスクに載せない
const SOURCE_LINK_PREFIXES = [
  'https://mail.google.com/',
  'https://docs.google.com/',
  'https://drive.google.com/',
  'https://chat.google.com/',
  'https://mail.google.com/chat/',
  'https://calendar.google.com/',
  'https://quire.io/',
];

/** 元リンクを確かめる。許可したサイトの https URL だけを通す。 */
function safeSourceUrl_(value) {
  for (let i = 0; i < SOURCE_LINK_PREFIXES.length; i++) {
    const url = safeUrl_(value, SOURCE_LINK_PREFIXES[i]);
    if (url) return url;
  }
  return '';
}

/** 出どころ。空欄（古い行）はメール。 */
function sourceOf_(entry) {
  const s = String(entry.source || '').trim();
  return s || SOURCE.MAIL;
}

function isMail_(entry) {
  return sourceOf_(entry) === SOURCE.MAIL;
}

/** 出どころに合わせた「元資料を開く」ボタンの文言。 */
function sourceLinkLabel_(entry) {
  return isMail_(entry) ? 'メールを開く' : '元資料を開く';
}

function safeQuireUrl_(value) {
  return safeUrl_(value, 'https://quire.io/');
}

/** 長すぎる文字列を切り詰める。 */
function clip_(value, max) {
  const text = String(value === undefined || value === null ? '' : value);
  return text.length > max ? text.slice(0, max - 1) + '…' : text;
}
