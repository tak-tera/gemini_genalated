/**
 * Google Chat API の呼び出し（アプリとして送信する「アプリ認証」）。
 * ボタン付きカードを自分から送るにはアプリ認証が必要。
 *
 * トークンの取り方は2通り:
 *  1. SERVICE_ACCOUNT_EMAIL だけ設定（おすすめ）:
 *     実行ユーザーがサービスアカウントになりすましてトークンを発行する。鍵ファイル不要。
 *  2. SERVICE_ACCOUNT_KEY に鍵 JSON を設定: 鍵で署名してトークンを取る。
 */

const CHAT_SCOPE = 'https://www.googleapis.com/auth/chat.bot';

function chatAccessToken_() {
  const cache = CacheService.getScriptCache();
  const cached = cache.get('chat_token');
  if (cached) return cached;

  const keyJson = prop_('SERVICE_ACCOUNT_KEY', false);
  const token = keyJson ? tokenFromKey_(JSON.parse(keyJson)) : tokenByImpersonation_();
  cache.put('chat_token', token, 50 * 60); // 有効期限 60 分より短めに保持
  return token;
}

function tokenByImpersonation_() {
  const sa = prop_('SERVICE_ACCOUNT_EMAIL');
  const url = 'https://iamcredentials.googleapis.com/v1/projects/-/serviceAccounts/'
    + encodeURIComponent(sa) + ':generateAccessToken';
  const res = UrlFetchApp.fetch(url, {
    method: 'post',
    contentType: 'application/json',
    headers: { Authorization: 'Bearer ' + ScriptApp.getOAuthToken() },
    payload: JSON.stringify({ scope: [CHAT_SCOPE], lifetime: '3600s' }),
    muteHttpExceptions: true,
  });
  if (res.getResponseCode() !== 200) {
    throw new Error('サービスアカウントのトークン取得に失敗しました（'
      + res.getResponseCode() + '）: ' + res.getContentText().slice(0, 300));
  }
  return JSON.parse(res.getContentText()).accessToken;
}

function tokenFromKey_(key) {
  const now = Math.floor(Date.now() / 1000);
  const enc = function (obj) {
    return Utilities.base64EncodeWebSafe(JSON.stringify(obj)).replace(/=+$/, '');
  };
  const input = enc({ alg: 'RS256', typ: 'JWT' }) + '.' + enc({
    iss: key.client_email,
    scope: CHAT_SCOPE,
    aud: 'https://oauth2.googleapis.com/token',
    iat: now,
    exp: now + 3600,
  });
  const signature = Utilities.base64EncodeWebSafe(
    Utilities.computeRsaSha256Signature(input, key.private_key)).replace(/=+$/, '');
  const res = UrlFetchApp.fetch('https://oauth2.googleapis.com/token', {
    method: 'post',
    payload: {
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion: input + '.' + signature,
    },
    muteHttpExceptions: true,
  });
  if (res.getResponseCode() !== 200) {
    throw new Error('サービスアカウント鍵でのトークン取得に失敗しました: ' + res.getContentText().slice(0, 300));
  }
  return JSON.parse(res.getContentText()).access_token;
}

/** space（例: spaces/AAAA...）にメッセージを送る。戻り値は作成されたメッセージ。 */
function chatCreateMessage_(space, message) {
  return chatFetch_('post', 'https://chat.googleapis.com/v1/' + space + '/messages', message);
}

/** 送信済みメッセージ（例: spaces/AAAA/messages/BBBB）のカードを書き換える。 */
function chatUpdateMessage_(name, message) {
  return chatFetch_('patch',
    'https://chat.googleapis.com/v1/' + name + '?updateMask=text,cardsV2', message);
}

function chatFetch_(method, url, body) {
  const res = UrlFetchApp.fetch(url, {
    method: method,
    contentType: 'application/json',
    headers: { Authorization: 'Bearer ' + chatAccessToken_() },
    payload: JSON.stringify(body),
    muteHttpExceptions: true,
  });
  if (res.getResponseCode() >= 300) {
    throw new Error('Chat API エラー ' + res.getResponseCode() + ': ' + res.getContentText().slice(0, 300));
  }
  return JSON.parse(res.getContentText());
}
