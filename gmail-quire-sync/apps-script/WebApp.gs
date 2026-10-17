/**
 * カードのボタンから開く Web ページ。
 *
 * セキュリティ:
 *  - Web アプリは「自分のみ」アクセスできる設定で公開する（他人が開いても Google が拒否する）
 *  - リンクには署名（sig）が付いており、署名が合わなければ何もしない
 *    （本人がだまされて偽のリンクを開いても、勝手に登録・却下されない）
 *  - 登録先は振り分けルールにある有効なプロジェクトだけを受け付ける
 *
 *  - 編集ページから送られた内容は、サーバー側で項目ごとに形式と長さを確かめてから使う
 *
 *   ?action=approve&id=…&sig=… … 判定どおりの内容で登録
 *   ?action=edit&id=…&sig=…    … 内容を直して登録するページを表示（旧カードの choose も同じページ）
 *   ?action=reject&id=…&sig=…  … 却下として記録
 */

const ACTIONS = ['approve', 'edit', 'choose', 'reject'];
const MAX_TASKS_PER_EDIT = 5;
const PRIORITIES = [
  { value: -1, label: '低' },
  { value: 0, label: '中' },
  { value: 1, label: '高' },
  { value: 2, label: '緊急' },
];

function doGet(e) {
  const p = (e && e.parameter) || {};
  if (!p.id) return page_('Quire 登録確認', '<p>このページはチャットのボタンから開いてください。</p>');

  if (ACTIONS.indexOf(p.action) < 0 || !verifyAction_(p.action, p.id, p.sig)) {
    return page_('リンクが無効です', '<p>このリンクは無効か、期限切れです。チャットのカードから開き直してください。</p>');
  }

  const entry = findLogEntry_(p.id);
  if (!entry) return page_('見つかりません', '<p>登録ログに該当する行がありません。</p>');

  if (p.action === 'edit' || p.action === 'choose') return editPage_(entry, p.action, p.sig);
  if (p.action === 'approve') return resultPage_(decide_(p.id, true));
  return resultPage_(decide_(p.id, false));
}

/** 編集ページの「登録する」から呼ばれる。リンクの署名と送られた内容を確かめてから登録する。 */
function submitEdit(messageId, action, sig, form) {
  if ((action !== 'edit' && action !== 'choose') || !verifyAction_(action, messageId, sig)) {
    throw new Error('リンクが無効です。');
  }
  const clean = validateEditForm_(form, getProjects_(true));

  const lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    const entry = findLogEntry_(messageId);
    if (!entry) throw new Error('登録ログに該当する行がありません。');
    if (entry.status !== STATUS.PENDING) {
      return resultHtml_({ title: 'すでに処理済みです', detail: 'ステータス: ' + entry.status,
        url: safeQuireUrl_(entry.taskUrl), entry: entry });
    }
    updateLog_(entry.row, { status: STATUS.APPROVED });
    const result = registerEditedEntry_(entry, clean);
    return editResultHtml_(result);
  } finally {
    lock.releaseLock();
  }
}

/** 日付（yyyy-MM-dd）と時刻（HH:mm）の入力を確かめる。時刻だけの入力はエラー。 */
function checkParts_(date, time, label) {
  const d = String(date || '').trim();
  const t = String(time || '').trim();
  if (d && !/^\d{4}-\d{2}-\d{2}$/.test(d)) throw new Error(label + '日の形式が正しくありません。');
  if (t && !/^([01]\d|2[0-3]):[0-5]\d$/.test(t)) throw new Error(label + '時刻の形式が正しくありません。');
  if (t && !d) throw new Error(label + '時刻を入れるときは日付も入れてください。');
  return { date: d, time: t };
}

/** 編集ページから届いた内容を確かめ、使える形にそろえる。おかしな値があればエラーにする。 */
function validateEditForm_(form, projects) {
  if (!form || typeof form !== 'object') throw new Error('入力内容が読み取れませんでした。');
  const tasks = Array.isArray(form.tasks) ? form.tasks : [];
  if (!tasks.length) throw new Error('タスクを1件以上入力してください。');
  if (tasks.length > MAX_TASKS_PER_EDIT) throw new Error('一度に登録できるのは ' + MAX_TASKS_PER_EDIT + ' 件までです。');

  const cleanTasks = tasks.map(function (t, i) {
    const n = (i + 1) + '件目: ';
    const name = String((t && t.name) || '').trim();
    if (!name) throw new Error(n + 'タスク名を入力してください。');
    if (name.length > 200) throw new Error(n + 'タスク名は200文字以内にしてください。');
    const mode = (t && t.mode) === 'due' ? 'due' : (t && t.mode) === 'period' ? 'period' : '';
    if (!mode) throw new Error(n + '日程の種類が正しくありません。');
    const start = checkParts_(t && t.startDate, t && t.startTime, n + '開始');
    const end = checkParts_(t && t.endDate, t && t.endTime, n + (mode === 'due' ? '期日' : '終了'));
    if (mode === 'period' && start.date && end.date && compareParts_(start, end) > 0) {
      throw new Error(n + '開始日時が終了日時より後になっています。');
    }
    const useStart = mode === 'period' ? start : { date: '', time: '' };
    const project = String((t && t.project) || '');
    if (!findProjectByName_(project, projects)) throw new Error(n + '登録先が振り分けルールにありません。');
    const priority = Number(t && t.priority);
    if (!PRIORITIES.some(function (p) { return p.value === priority; })) throw new Error(n + '優先度が正しくありません。');
    const note = String((t && t.note) || '').trim();
    if (note.length > 2000) throw new Error(n + 'メモは2000文字以内にしてください。');
    return {
      name: name, project: project, priority: priority, note: note,
      quireStart: toQuireDateTime_(useStart.date, useStart.time),
      quireDue: toQuireDateTime_(end.date, end.time),
      startText: partsText_(useStart),
      dueText: partsText_(end),
    };
  });

  const assignees = splitList_(form.assignees);
  if (assignees.length > 5) throw new Error('担当者は5人までにしてください。');
  assignees.forEach(function (a) {
    if (a !== 'me' && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(a)) {
      throw new Error('担当者は me かメールアドレスで入力してください: ' + a);
    }
  });
  return { tasks: cleanTasks, assignees: assignees };
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
        url: safeQuireUrl_(entry.taskUrl),
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
      return { title: '登録しました', detail: '登録先: ' + result.project.name, url: safeQuireUrl_(result.task.url), entry: entry };
    } catch (e) {
      updateLog_(entry.row, { status: STATUS.ERROR, reason: String(entry.reason) + ' / エラー: ' + e.message });
      return { title: '登録に失敗しました', detail: clip_(e.message, 300), entry: entry };
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
  if (result.entry) html += '<p class="sub">' + escapeHtml_(clip_(result.entry.taskName || result.entry.subject, 200)) + '</p>';
  if (result.detail) html += '<p>' + escapeHtml_(result.detail) + '</p>';
  if (result.url) html += '<p><a class="btn" href="' + escapeHtml_(result.url) + '" target="_blank">Quire で開く</a></p>';
  html += '<p class="note">このページは閉じてかまいません。</p>';
  return html;
}

function editResultHtml_(result) {
  const parts = ['<h1>' + escapeHtml_(result.error ? (result.created.length ? '一部だけ登録しました' : '登録に失敗しました') : '登録しました') + '</h1>'];
  if (result.created.length) {
    parts.push('<ul>');
    result.created.forEach(function (c) {
      const url = safeQuireUrl_(c.task.url);
      parts.push('<li>' + (url ? '<a href="' + escapeHtml_(url) + '" target="_blank">' : '')
        + escapeHtml_(c.form.name) + (url ? '</a>' : '') + '<br><span class="note">' + escapeHtml_(c.project.name) + '</span></li>');
    });
    parts.push('</ul>');
  }
  if (result.error) parts.push('<p>' + escapeHtml_(clip_(result.error, 300)) + '</p>');
  parts.push('<p class="note">このページは閉じてかまいません。</p>');
  return parts.join('');
}

/** 内容を直して登録するページ。入力欄は JavaScript で作り、値は textContent / value で入れる（HTML として解釈させない）。 */
function editPage_(entry, action, sig) {
  const settings = getSettings_();
  const projects = getProjects_(true);
  const selected = findProjectByName_(entry.judgedProject, projects) ? String(entry.judgedProject) : settings.generalProject;
  const data = {
    id: String(entry.messageId),
    action: action,
    sig: String(sig),
    projects: projects.map(function (p) { return p.name; }),
    priorities: PRIORITIES,
    assignees: settings.assignees.join('; '),
    max: MAX_TASKS_PER_EDIT,
    task: (function () {
      const s = defaultSchedule_(entry);
      return {
        name: clip_(entry.taskName || entry.subject, 200), project: selected, priority: 0, note: '', mode: 'period',
        startDate: s.start.date, startTime: s.start.time, endDate: s.end.date, endTime: s.end.time,
      };
    })(),
  };
  const sourceUrl = safeSourceUrl_(entry.gmailUrl);

  const html =
    '<div id="main">' +
    '<h1>内容を直して登録</h1>' +
    '<div class="box">' +
    '<p class="sub">' + escapeHtml_(clip_(entry.subject, 200)) + '</p>' +
    '<p class="note">' + escapeHtml_(clip_(entry.sender, 200)) + '</p>' +
    (entry.summary ? '<p>' + escapeHtml_(clip_(entry.summary, 1000)) + '</p>' : '') +
    (entry.reason ? '<p class="note">判定理由: ' + escapeHtml_(clip_(entry.reason, 300)) + '</p>' : '') +
    '<p class="note">出どころ: ' + escapeHtml_(clip_(sourceOf_(entry), 20)) + '</p>' +
    (sourceUrl ? '<p><a href="' + escapeHtml_(sourceUrl) + '" target="_blank">' + escapeHtml_(sourceLinkLabel_(entry)) + '</a></p>' : '') +
    '</div>' +
    '<label>担当者（me は自分。複数は ; 区切り）<input id="assignees"></label>' +
    '<div id="tasks"></div>' +
    '<p><button class="btn sub-btn" id="add" type="button">＋ タスクを追加</button></p>' +
    '<p><button class="btn" id="go" type="button">登録する</button></p>' +
    '</div>' +
    '<script>' +
    'var D=JSON.parse(' + jsString_(JSON.stringify(data)) + ');' +
    'function el(t,a){var e=document.createElement(t);if(a)for(var k in a)e[k]=a[k];return e;}' +
    'function field(label,input){var l=el("label");l.appendChild(document.createTextNode(label));l.appendChild(input);return l;}' +
    'function pair(label,d,t){var w=el("div",{className:"pair"});w.appendChild(el("span",{className:"pair-label",textContent:label}));var r=el("div",{className:"pair-row"});r.appendChild(d);r.appendChild(t);w.appendChild(r);return w;}' +
    'function addTask(t){var box=el("div",{className:"task"});' +
    ' var name=el("input",{className:"f-name",maxLength:200,value:t.name||""});' +
    ' var mode=el("select",{className:"f-mode"});[["period","期間（開始〜終了）"],["due","期日のみ"]].forEach(function(m){var o=el("option",{value:m[0],textContent:m[1]});if(m[0]===(t.mode||"period"))o.selected=true;mode.appendChild(o);});' +
    ' var sd=el("input",{className:"f-sd",type:"date",value:t.startDate||""}),st=el("input",{className:"f-st",type:"time",value:t.startTime||""});' +
    ' var ed=el("input",{className:"f-ed",type:"date",value:t.endDate||""}),et=el("input",{className:"f-et",type:"time",value:t.endTime||""});' +
    ' var startRow=pair("開始",sd,st),endRow=pair("終了",ed,et);' +
    ' function sync(){var p=mode.value==="period";startRow.style.display=p?"":"none";endRow.firstChild.textContent=p?"終了（日付・時刻は任意）":"期日（時刻は任意）";}' +
    ' mode.onchange=sync;' +
    ' var pj=el("select",{className:"f-project"});D.projects.forEach(function(p){var o=el("option",{value:p,textContent:p});if(p===t.project)o.selected=true;pj.appendChild(o);});' +
    ' var pr=el("select",{className:"f-priority"});D.priorities.forEach(function(p){var o=el("option",{value:String(p.value),textContent:p.label});if(p.value===t.priority)o.selected=true;pr.appendChild(o);});' +
    ' var note=el("textarea",{className:"f-note",maxLength:2000,rows:3,value:t.note||""});' +
    ' var rm=el("button",{type:"button",className:"link",textContent:"このタスクを削除"});rm.onclick=function(){if(document.querySelectorAll(".task").length>1)box.remove();};' +
    ' [field("タスク名",name),field("日程",mode),startRow,endRow,field("登録先",pj),field("優先度",pr),field("メモ（説明の先頭に入ります）",note)].forEach(function(f){box.appendChild(f);});sync();' +
    ' box.appendChild(rm);document.getElementById("tasks").appendChild(box);}' +
    'document.getElementById("assignees").value=D.assignees;' +
    'addTask(D.task);' +
    'document.getElementById("add").onclick=function(){if(document.querySelectorAll(".task").length>=D.max){alert("一度に登録できるのは"+D.max+"件までです");return;}addTask({project:D.task.project,priority:0,mode:"period",startDate:D.task.startDate});};' +
    'document.getElementById("go").onclick=function(){var b=this;' +
    ' var tasks=[].map.call(document.querySelectorAll(".task"),function(x){return{name:x.querySelector(".f-name").value,mode:x.querySelector(".f-mode").value,startDate:x.querySelector(".f-sd").value,startTime:x.querySelector(".f-st").value,endDate:x.querySelector(".f-ed").value,endTime:x.querySelector(".f-et").value,project:x.querySelector(".f-project").value,priority:Number(x.querySelector(".f-priority").value),note:x.querySelector(".f-note").value};});' +
    ' b.disabled=true;b.textContent="登録しています…";' +
    ' google.script.run' +
    '  .withSuccessHandler(function(html){document.getElementById("main").innerHTML=html;})' +
    '  .withFailureHandler(function(e){b.disabled=false;b.textContent="登録する";alert(e.message);})' +
    '  .submitEdit(D.id,D.action,D.sig,{assignees:document.getElementById("assignees").value,tasks:tasks});};' +
    '</script>';
  return page_('内容を直して登録', html);
}

/** スクリプト内に埋め込む文字列。</script> などで抜け出せないよう < > & をエスケープする。 */
function jsString_(value) {
  return JSON.stringify(String(value)).replace(/</g, '\\u003c').replace(/>/g, '\\u003e').replace(/&/g, '\\u0026');
}

function page_(title, body) {
  const style =
    '<style>' +
    'body{font-family:-apple-system,"Hiragino Sans","Noto Sans JP",sans-serif;margin:24px 16px;color:#1f2937;line-height:1.6}' +
    'h1{font-size:20px;margin:0 0 8px}.sub{font-weight:bold}.note{color:#6b7280;font-size:13px}' +
    'select,input,textarea{display:block;width:100%;box-sizing:border-box;font-size:16px;padding:10px;margin:4px 0 12px;' +
    'border:1px solid #d1d5db;border-radius:8px;font-family:inherit}' +
    'label{display:block;font-size:14px;color:#374151}' +
    '.box{background:#f3f4f6;border-radius:8px;padding:12px;margin:12px 0}.box p{margin:4px 0}' +
    '.task{border:1px solid #d1d5db;border-radius:8px;padding:12px;margin:12px 0}' +
    '.link{background:none;border:0;color:#b91c1c;font-size:14px;padding:0}' +
    '.btn.sub-btn{background:#e5e7eb;color:#1f2937}' +
    '.pair{margin:0 0 12px}.pair-label{display:block;font-size:14px;color:#374151}' +
    '.pair-row{display:flex;gap:8px}.pair-row input{margin:4px 0 0}.pair-row input[type=date]{flex:3}.pair-row input[type=time]{flex:2}' +
    'ul{padding-left:20px}li{margin:8px 0}' +
    '.btn{display:inline-block;background:#0f766e;color:#fff;border:0;border-radius:8px;padding:12px 18px;' +
    'font-size:16px;text-decoration:none}.btn:disabled{opacity:.6}' +
    '</style>';
  const footer = '<p class="note" style="margin-top:32px">バージョン: ' + escapeHtml_(APP_VERSION) + '</p>';
  return HtmlService.createHtmlOutput(style + body + footer)
    .setTitle(title)
    .addMetaTag('viewport', 'width=device-width, initial-scale=1');
}
