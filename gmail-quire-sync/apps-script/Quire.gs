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
 * 登録ログの1行を、判定どおりの内容で Quire に登録する。
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

  const task = createTaskWithFallback_(project, buildTaskBody_(entry, settings, {
    name: entry.taskName || entry.subject,
    due: toQuireDate_(entry.due),
    assignees: settings.assignees,
  }), settings);

  const updates = {
    status: STATUS.DONE,
    taskUrl: safeQuireUrl_(task.url),
    taskOid: task.oid || '',
    currentProject: project.name,
  };
  // 判定と違うプロジェクトを選んだら、その送信者をルールに覚えさせる
  if (shouldLearn_(entry, [project], settings)) {
    learnSender_(entry.sender, project);
    updates.learned = true;
  }
  updateLog_(entry.row, updates);
  return { task: task, project: project };
}

/**
 * 編集ページで直した内容で登録する。1件目は元の行を更新し、2件目以降は登録ログに行を追加する。
 * form は validateEditForm_ を通したもの: { assignees: [...], tasks: [{ name, due, project, priority, note }] }
 * 戻り値: { created: [{ task, project }], error: エラー文 or '' }
 */
function registerEditedEntry_(entry, form) {
  const settings = getSettings_();
  const projects = getProjects_(false);
  const created = [];
  let error = '';

  for (let i = 0; i < form.tasks.length; i++) {
    const t = form.tasks[i];
    const project = findProjectByName_(t.project, projects);
    try {
      const task = createTaskWithFallback_(project, buildTaskBody_(entry, settings, {
        name: t.name, due: t.due, priority: t.priority, note: t.note, assignees: form.assignees,
      }), settings);
      created.push({ task: task, project: project, form: t });
    } catch (e) {
      error = (i + 1) + '件目の登録に失敗しました: ' + e.message;
      break;
    }
  }

  const learn = created.length > 0 && shouldLearn_(entry, created.map(function (c) { return c.project; }), settings);
  if (learn) learnSender_(entry.sender, created[0].project);

  created.forEach(function (c, i) {
    const values = {
      taskName: c.form.name,
      due: c.form.due,
      status: STATUS.DONE,
      taskUrl: safeQuireUrl_(c.task.url),
      taskOid: c.task.oid || '',
      currentProject: c.project.name,
    };
    if (learn) values.learned = true;
    if (i === 0) {
      updateLog_(entry.row, values);
    } else {
      appendLogCopy_(entry, String(entry.messageId) + '-e' + (i + 1), values);
    }
  });

  if (error) {
    const note = created.length ? '（' + created.length + '件は登録済み）' : '';
    if (!created.length) updateLog_(entry.row, { status: STATUS.ERROR });
    updateLog_(entry.row, { reason: clip_(String(entry.reason) + ' / ' + error + note, 500) });
  }
  return { created: created, error: error };
}

/** 判定と違う1つのプロジェクトに入れたときだけ、送信者を覚えさせる。 */
function shouldLearn_(entry, projects, settings) {
  const names = projects.map(function (p) { return p.name; })
    .filter(function (n, i, a) { return a.indexOf(n) === i; });
  return names.length === 1 && names[0] !== String(entry.judgedProject) && names[0] !== settings.generalProject;
}

/** Quire に送るタスクの中身。opts: { name, due, priority, note, assignees } */
function buildTaskBody_(entry, settings, opts) {
  const body = {
    name: clip_(opts.name || '(件名なし)', 200),
    description: (opts.note ? clip_(opts.note, 2000) + '\n\n' : '') + buildTaskDescription_(entry),
  };
  if (opts.due) body.due = opts.due;
  if (opts.priority !== undefined && opts.priority !== 0) body.priority = opts.priority;
  if (opts.assignees && opts.assignees.length) body.assignees = opts.assignees;
  if (entry.newProjectCandidate) body.tags = [settings.newProjectTag];
  return body;
}

/** タスクを作る。タグが無いなどで失敗したときは、タグを外してタイトルに印を付けて作り直す。 */
function createTaskWithFallback_(project, body, settings) {
  try {
    return quireCreateTask_(project.id, body);
  } catch (e) {
    if (!body.tags) throw e;
    const retry = JSON.parse(JSON.stringify(body));
    delete retry.tags;
    retry.name = clip_('[' + settings.newProjectTag + '] ' + retry.name, 200);
    return quireCreateTask_(project.id, retry);
  }
}

function buildTaskDescription_(entry) {
  const lines = [];
  if (entry.summary) lines.push(clip_(entry.summary, 2000), '');
  lines.push('**メール情報**');
  lines.push('- 送信者: ' + clip_(entry.sender, 200));
  lines.push('- 件名: ' + clip_(entry.subject, 300));
  if (entry.receivedAt) {
    const received = entry.receivedAt instanceof Date
      ? Utilities.formatDate(entry.receivedAt, Session.getScriptTimeZone(), 'yyyy-MM-dd HH:mm')
      : entry.receivedAt;
    lines.push('- 受信: ' + received);
  }
  const gmailUrl = safeGmailUrl_(entry.gmailUrl);
  if (gmailUrl) lines.push('- [Gmail で開く](' + gmailUrl + ')');
  if (entry.reason) lines.push('', '**振り分け理由**: ' + clip_(entry.reason, 500));
  if (entry.newProjectCandidate) lines.push('', '**新規プロジェクト候補**: ' + clip_(entry.newProjectCandidate, 100));
  return lines.join('\n');
}
