/**
 * カードのボタンから開く Web ページ。
 * Web アプリは「自分だけがアクセスできる」設定で公開するので、他人が開いても動かない。
 *
 *   ?action=approve&id=… … 判定どおりのプロジェクトに登録
 *   ?action=choose&id=…  … 登録先を選ぶページを表示
 *   ?action=reject&id=…  … 却下として記録
 */

function doGet(e) {
  const p = (e && e.parameter) || {};
  if (!p.id) return page_('Quire 登録確認', '<p>このページはチャットのボタンから開いてください。</p>');

  const entry = findLogEntry_(p.id);
  if (!entry) return page_('見つかりません', '<p>登録ログに該当する行がありません。</p>');

  if (p.action === 'choose') return choosePage_(entry);
  if (p.action === 'approve') return resultPage_(decide_(p.id, true, p.project));
  if (p.action === 'reject') return resultPage_(decide_(p.id, false));
  return page_('不明な操作', '<p>操作の指定が正しくありません。</p>');
}

/** 登録先を選ぶページから呼ばれる。 */
function approveFromPage(messageId, projectName) {
  return resultHtml_(decide_(messageId, true, projectName));
}

/**
 * 承認・却下の処理。二度押しされても1回しか登録しない。
 * 戻り値: { title, detail, url, entry }
 */
function decide_(messageId, approve, projectName) {
  const lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    const entry = findLogEntry_(messageId);
    if (!entry) return { title: '見つかりません', detail: '登録ログに該当する行がありません。' };

    if (entry.status !== STATUS.PENDING) {
      return {
        title: 'すでに処理済みです',
        detail: 'ステータス: ' + entry.status + (entry.currentProject ? ' / 登録先: ' + entry.currentProject : ''),
        url: entry.taskUrl ? String(entry.taskUrl) : '',
        entry: entry,
      };
    }

    if (!approve) {
      updateLog_(entry.row, { status: STATUS.REJECTED });
      return { title: '却下しました', detail: 'Quire には登録していません。', entry: entry };
    }

    updateLog_(entry.row, { status: STATUS.APPROVED });
    try {
      const result = registerEntry_(entry, projectName || String(entry.judgedProject));
      return { title: '登録しました', detail: '登録先: ' + result.project.name, url: result.task.url, entry: entry };
    } catch (e) {
      updateLog_(entry.row, { status: STATUS.ERROR, reason: String(entry.reason) + ' / エラー: ' + e.message });
      return { title: '登録に失敗しました', detail: e.message, entry: entry };
    }
  } finally {
    lock.releaseLock();
  }
}

// ---------- ページの組み立て ----------

function resultPage_(result) {
  return page_(result.title, resultHtml_(result));
}

function resultHtml_(result) {
  let html = '<h1>' + escapeHtml_(result.title) + '</h1>';
  if (result.entry) html += '<p class="sub">' + escapeHtml_(result.entry.taskName || result.entry.subject) + '</p>';
  if (result.detail) html += '<p>' + escapeHtml_(result.detail) + '</p>';
  if (result.url) html += '<p><a class="btn" href="' + escapeHtml_(result.url) + '" target="_blank">Quire で開く</a></p>';
  html += '<p class="note">このページは閉じてかまいません。</p>';
  return html;
}

function choosePage_(entry) {
  const settings = getSettings_();
  const projects = getProjects_(true);
  const selected = findProjectByName_(entry.judgedProject, projects) ? String(entry.judgedProject) : settings.generalProject;
  const options = projects.map(function (p) {
    return '<option' + (p.name === selected ? ' selected' : '') + '>' + escapeHtml_(p.name) + '</option>';
  }).join('');

  const html =
    '<div id="main">' +
    '<h1>登録先を選ぶ</h1>' +
    '<p class="sub">' + escapeHtml_(entry.taskName || entry.subject) + '</p>' +
    '<p>送信者: ' + escapeHtml_(entry.sender) + '</p>' +
    (entry.reason ? '<p>判定理由: ' + escapeHtml_(entry.reason) + '</p>' : '') +
    '<select id="project">' + options + '</select>' +
    '<p><button class="btn" id="go" onclick="go()">この登録先で登録する</button></p>' +
    '</div>' +
    '<script>' +
    'function go(){' +
    ' var b=document.getElementById("go"); b.disabled=true; b.textContent="登録しています…";' +
    ' google.script.run' +
    '  .withSuccessHandler(function(html){document.getElementById("main").innerHTML=html;})' +
    '  .withFailureHandler(function(e){b.disabled=false; b.textContent="この登録先で登録する"; alert(e.message);})' +
    '  .approveFromPage(' + JSON.stringify(String(entry.messageId)) + ', document.getElementById("project").value);' +
    '}' +
    '</script>';
  return page_('登録先を選ぶ', html);
}

function page_(title, body) {
  const style =
    '<style>' +
    'body{font-family:-apple-system,"Hiragino Sans","Noto Sans JP",sans-serif;margin:24px 16px;color:#1f2937;line-height:1.6}' +
    'h1{font-size:20px;margin:0 0 8px}.sub{font-weight:bold}.note{color:#6b7280;font-size:13px}' +
    'select{width:100%;font-size:16px;padding:10px;margin:8px 0;border:1px solid #d1d5db;border-radius:8px}' +
    '.btn{display:inline-block;background:#0f766e;color:#fff;border:0;border-radius:8px;padding:12px 18px;' +
    'font-size:16px;text-decoration:none}.btn:disabled{opacity:.6}' +
    '</style>';
  return HtmlService.createHtmlOutput(style + body)
    .setTitle(title)
    .addMetaTag('viewport', 'width=device-width, initial-scale=1');
}
