/**
 * Quire API（https://quire.io/dev/api/）との接続。
 * OAuth2 ライブラリ（apps-script-oauth2）でトークンを取得・自動更新する。
 */

const QUIRE_API_BASE = 'https://quire.io/api';

function quireService_() {
  return OAuth2.createService('quire')
    .setAuthorizationBaseUrl('https://quire.io/oauth')
    .setTokenUrl('https://quire.io/oauth/token')
    .setClientId(prop_('QUIRE_CLIENT_ID'))
    .setClientSecret(prop_('QUIRE_CLIENT_SECRET'))
    .setCallbackFunction('quireAuthCallback')
    // トリガーや Chat から同じトークンを使うため、スクリプト全体で保存する
    .setPropertyStore(PropertiesService.getScriptProperties())
    .setCache(CacheService.getScriptCache());
}

/** 【手動で実行】Quire 接続用の URL をログに出す。URL をブラウザで開いて許可する。 */
function showQuireAuthUrl() {
  const service = quireService_();
  if (service.hasAccess()) {
    Logger.log('Quire には接続済みです。');
    return;
  }
  Logger.log('次の URL をブラウザで開き、Quire で「Allow」を押してください:\n' + service.getAuthorizationUrl());
}

/** Quire の認可画面から戻ってきたときに呼ばれる。 */
function quireAuthCallback(request) {
  const ok = quireService_().handleCallback(request);
  return HtmlService.createHtmlOutput(ok
    ? 'Quire との接続が完了しました。このタブは閉じてかまいません。'
    : 'Quire との接続に失敗しました。もう一度 showQuireAuthUrl を実行してください。');
}

/** 【手動で実行】Quire の接続を解除する（やり直したいとき）。 */
function resetQuireAuth() {
  quireService_().reset();
  Logger.log('Quire の接続を解除しました。');
}

/** 【手動で実行】接続確認。自分の Quire ユーザー名をログに出す。 */
function testQuire() {
  const me = quireFetch_('get', '/user/id/me');
  Logger.log('Quire に接続できました: ' + me.name);
}

function quireFetch_(method, path, body) {
  const service = quireService_();
  if (!service.hasAccess()) {
    throw new Error('Quire に未接続です。showQuireAuthUrl を実行して接続してください。');
  }
  const options = {
    method: method,
    headers: { Authorization: 'Bearer ' + service.getAccessToken() },
    contentType: 'application/json',
    muteHttpExceptions: true,
  };
  if (body) options.payload = JSON.stringify(body);

  for (let attempt = 0; attempt < 3; attempt++) {
    const res = UrlFetchApp.fetch(QUIRE_API_BASE + path, options);
    const code = res.getResponseCode();
    if (code === 429) {
      // レート制限。Retry-After 秒（なければ 5 秒）待ってやり直す
      const wait = Number(res.getHeaders()['Retry-After'] || 5);
      Utilities.sleep(Math.min(wait, 30) * 1000);
      continue;
    }
    const text = res.getContentText();
    if (code >= 300) {
      throw new Error('Quire API エラー ' + code + ': ' + text.slice(0, 300));
    }
    return text ? JSON.parse(text) : null;
  }
  throw new Error('Quire API のレート制限が続いています。時間をおいて再実行してください。');
}

/** プロジェクトにタスクを作る。projectId はプロジェクトの ID（URL の /w/ の後ろ）。"-" は個人 Inbox。 */
function quireCreateTask_(projectId, task) {
  return quireFetch_('post', '/task/id/' + encodeURIComponent(projectId), task);
}

function quireGetTask_(oid) {
  return quireFetch_('get', '/task/' + encodeURIComponent(oid));
}

/** タスク URL からプロジェクト ID を取り出す。https://quire.io/w/{id}/{番号} 以外は個人 Inbox とみなす。 */
function projectIdFromTaskUrl_(url) {
  const m = String(url || '').match(/quire\.io\/w\/([^\/?#]+)/);
  return m ? decodeURIComponent(m[1]) : '-';
}

/**
 * 登録ログの1行を Quire に登録する。
 * projectName を省略すると判定プロジェクトに入れる。
 * 戻り値: { task, project }
 */
function registerEntry_(entry, projectName) {
  const settings = getSettings_();
  const projects = getProjects_(false);
  const project = findProjectByName_(projectName || entry.judgedProject, projects)
    || findProjectByName_(settings.generalProject, projects);
  if (!project) {
    throw new Error('登録先プロジェクト「' + (projectName || entry.judgedProject) + '」が振り分けルールにありません。');
  }

  const body = {
    name: String(entry.taskName || entry.subject || '(件名なし)'),
    description: buildTaskDescription_(entry),
  };
  const due = toQuireDate_(entry.due);
  if (due) body.due = due;
  if (entry.newProjectCandidate) body.tags = [settings.newProjectTag];

  let task;
  try {
    task = quireCreateTask_(project.id, body);
  } catch (e) {
    if (!body.tags) throw e;
    // タグが無いなどで失敗したときは、タグを外してタイトルに印を付けて登録する
    delete body.tags;
    body.name = '[' + settings.newProjectTag + '] ' + body.name;
    task = quireCreateTask_(project.id, body);
  }

  const updates = {
    status: STATUS.DONE,
    taskUrl: task.url || '',
    taskOid: task.oid || '',
    currentProject: project.name,
  };
  // 判定と違うプロジェクトを選んだら、その送信者をルールに覚えさせる
  if (project.name !== String(entry.judgedProject) && project.name !== settings.generalProject) {
    learnSender_(entry.sender, project);
    updates.learned = true;
  }
  updateLog_(entry.row, updates);
  return { task: task, project: project };
}

function buildTaskDescription_(entry) {
  const lines = [];
  if (entry.summary) lines.push(String(entry.summary), '');
  lines.push('**メール情報**');
  lines.push('- 送信者: ' + entry.sender);
  lines.push('- 件名: ' + entry.subject);
  if (entry.receivedAt) {
    const received = entry.receivedAt instanceof Date
      ? Utilities.formatDate(entry.receivedAt, Session.getScriptTimeZone(), 'yyyy-MM-dd HH:mm')
      : entry.receivedAt;
    lines.push('- 受信: ' + received);
  }
  if (entry.gmailUrl) lines.push('- [Gmail で開く](' + entry.gmailUrl + ')');
  if (entry.reason) lines.push('', '**振り分け理由**: ' + entry.reason);
  if (entry.newProjectCandidate) lines.push('', '**新規プロジェクト候補**: ' + entry.newProjectCandidate);
  return lines.join('\n');
}
