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
  const clean = validateEditForm_(form, getProjects_(true), messageId, getSnapshot_(), getLogEntries_());

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
function validateEditForm_(form, projects, entryId, snapshot, entries) {
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
    const proj = findProjectByName_(project, projects);
    if (!proj) throw new Error(n + '登録先が振り分けルールにありません。');
    const snap = projectSnapshot_(proj, snapshot);
    const section = String((t && t.section) || '').trim();
    if (section && !snap.sections.some(function (x) { return x.name === section; })) {
      throw new Error(n + 'セクション「' + clip_(section, 60) + '」が登録先にありません。「Quire から最新を読み込む」を押して選び直してください。');
    }
    const deps = validateDeps_(t && t.deps, i, tasks.length, entryId, snap, entries, n);
    const priority = Number(t && t.priority);
    if (!PRIORITIES.some(function (p) { return p.value === priority; })) throw new Error(n + '優先度が正しくありません。');
    const note = String((t && t.note) || '').trim();
    if (note.length > 2000) throw new Error(n + 'メモは2000文字以内にしてください。');
    return {
      id: taskLogId_(entryId, i),
      name: name, project: project, priority: priority, note: note, section: section,
      preds: deps.preds, succs: deps.succs,
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

/** 編集ページで分けたタスクの登録ログ ID。1件目は元の ID、2件目以降は「元の ID-e2」… */
function taskLogId_(entryId, index) {
  return index === 0 ? String(entryId) : String(entryId) + '-e' + (index + 1);
}

/**
 * 依存関係の入力を確かめる。[{ kind: 'pred'|'succ', ref: '#12' | 'cand:ID' | 'new:番号' }]
 * 既存タスクはスナップショットにある登録先のタスクだけ、候補は登録ログにあるものだけ受け付ける。
 * 戻り値: { preds: [ref], succs: [ref] }（ref は parseRefs_ と同じ形）
 */
function validateDeps_(list, index, count, entryId, snap, entries, n) {
  const out = { preds: [], succs: [] };
  if (list === undefined || list === null) return out;
  if (!Array.isArray(list) || list.length > MAX_DEPS * 2) throw new Error(n + '依存関係の指定が正しくありません。');
  const self = taskLogId_(entryId, index);
  const seen = {};
  list.forEach(function (d) {
    const kind = d && d.kind;
    if (kind !== 'pred' && kind !== 'succ') throw new Error(n + '依存関係の種類が正しくありません。');
    const raw = String((d && d.ref) || '');
    let ref;
    let m;
    if ((m = raw.match(/^#(\d{1,9})$/))) {
      const id = Number(m[1]);
      if (!snap.tasks.some(function (x) { return x.id === id; })) {
        throw new Error(n + '#' + id + ' は登録先の未完了タスクにありません。「Quire から最新を読み込む」を押して選び直してください。');
      }
      ref = { type: 'task', id: id };
    } else if ((m = raw.match(/^cand:([A-Za-z0-9_\-]{1,120})$/))) {
      if (m[1] === self || !entries.some(function (e) { return String(e.messageId) === m[1]; })) {
        throw new Error(n + '依存関係の候補が登録ログにありません。');
      }
      ref = { type: 'cand', id: m[1] };
    } else if ((m = raw.match(/^new:(\d)$/))) {
      const k = Number(m[1]);
      if (k === index || k >= count) throw new Error(n + '依存関係の相手（この画面のタスク）が正しくありません。');
      ref = { type: 'cand', id: taskLogId_(entryId, k) };
    } else {
      throw new Error(n + '依存関係の相手が正しくありません。');
    }
    const key = ref.type + ':' + ref.id;
    if (seen[key]) throw new Error(n + '同じタスクを依存関係に2回指定しています。');
    seen[key] = true;
    const target = kind === 'pred' ? out.preds : out.succs;
    if (target.length >= MAX_DEPS) throw new Error(n + '依存関係は先・あとそれぞれ ' + MAX_DEPS + ' 件までです。');
    target.push(ref);
  });
  return out;
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
      const where = result.project.name + (result.section ? ' / ' + result.section : '');
      return { title: '登録しました', detail: '登録先: ' + where, notes: result.notes, url: safeQuireUrl_(result.task.url), entry: entry };
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
  if (result.notes && result.notes.length) html += '<p class="note">' + escapeHtml_(clip_(result.notes.join(' / '), 500)) + '</p>';
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
        + escapeHtml_(c.form.name) + (url ? '</a>' : '') + '<br><span class="note">'
        + escapeHtml_(c.project.name + (c.section ? ' / ' + c.section.name : '')) + '</span>'
        + (c.notes && c.notes.length ? '<br><span class="note">' + escapeHtml_(clip_(c.notes.join(' / '), 300)) + '</span>' : '')
        + '</li>');
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
  const snapshot = getSnapshot_();
  const entries = getLogEntries_();
  const judgedOk = !!findProjectByName_(entry.judgedProject, projects);
  const selected = judgedOk ? String(entry.judgedProject) : settings.generalProject;

  // 依存関係の初期値（Claude の提案）。既存タスクの番号は判定プロジェクトのものなので、そのまま使えるときだけ
  const deps = [];
  [['pred', entry.predecessors], ['succ', entry.successors]].forEach(function (pair) {
    parseRefs_(pair[1]).slice(0, MAX_DEPS).forEach(function (r) {
      if (r.type === 'task' && judgedOk) deps.push({ kind: pair[0], ref: '#' + r.id });
      if (r.type === 'cand' && r.id !== String(entry.messageId)) deps.push({ kind: pair[0], ref: 'cand:' + r.id });
    });
  });

  const data = {
    id: String(entry.messageId),
    action: action,
    sig: String(sig),
    projects: projects.map(function (p) { return p.name; }),
    snap: snapshotForPage_(projects, snapshot),
    cands: relatedCandidates_(entry, entries),
    priorities: PRIORITIES,
    assignees: settings.assignees.join('; '),
    max: MAX_TASKS_PER_EDIT,
    maxDeps: MAX_DEPS,
    task: (function () {
      const s = defaultSchedule_(entry);
      return {
        name: clip_(entry.taskName || entry.subject, 200), project: selected, priority: 0, note: '', mode: 'period',
        startDate: s.start.date, startTime: s.start.time, endDate: s.end.date, endTime: s.end.time,
        section: judgedOk ? String(entry.section || '') : '', deps: deps,
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
    EDIT_PAGE_JS +
    '</script>';
  return page_('内容を直して登録', html);
}

/** 編集ページに渡すスナップショット。{ プロジェクト名: { fetchedAt, sections: [名前], tasks: [{ id, name, due }] } } */
function snapshotForPage_(projects, snapshot) {
  const out = {};
  projects.forEach(function (p) {
    const s = projectSnapshot_(p, snapshot);
    out[p.name] = structureForPage_(s);
  });
  return out;
}

function structureForPage_(s) {
  const tasks = s.tasks.slice().sort(function (a, b) {
    // 期日が近いものを上に。期日なしは番号の新しい順
    if (a.due && b.due) return a.due < b.due ? -1 : a.due > b.due ? 1 : 0;
    if (a.due || b.due) return a.due ? -1 : 1;
    return b.id - a.id;
  });
  return {
    fetchedAt: s.fetchedAt || '',
    sections: s.sections.map(function (x) { return x.name; }),
    tasks: tasks.map(function (x) { return { id: x.id, name: clip_(x.name, 80), due: String(x.due || '').slice(0, 10) }; }),
  };
}

/** 依存関係の相手に選べるほかの候補（同じメールから作った候補と、提案に出てくる候補）。 */
function relatedCandidates_(entry, entries) {
  const self = String(entry.messageId);
  const base = self.replace(/-e?\d+$/, '');
  const referred = parseRefs_(entry.predecessors).concat(parseRefs_(entry.successors))
    .filter(function (r) { return r.type === 'cand'; }).map(function (r) { return r.id; });
  return entries.filter(function (e) {
    const id = String(e.messageId);
    if (id === self || e.status === STATUS.REJECTED) return false;
    return id.replace(/-e?\d+$/, '') === base || referred.indexOf(id) >= 0;
  }).slice(0, 20).map(function (e) {
    return { id: String(e.messageId), name: clip_(e.taskName || e.subject, 80),
      project: String(e.currentProject || e.judgedProject), status: String(e.status) };
  });
}

/** 編集ページの「Quire から最新を読み込む」。そのプロジェクトのセクションと未完了タスクを読み直して返す。 */
function loadProjectStructure(messageId, action, sig, projectName) {
  if ((action !== 'edit' && action !== 'choose') || !verifyAction_(action, messageId, sig)) {
    throw new Error('リンクが無効です。');
  }
  const project = findProjectByName_(projectName, getProjects_(true));
  if (!project) throw new Error('登録先が振り分けルールにありません。');
  const s = refreshProjectSnapshot_(project);
  return structureForPage_(s);
}

// 編集ページのスクリプト。D（サーバーから渡すデータ）を使う。
const EDIT_PAGE_JS = [
  'var uid=0;',
  'function el(t,a){var e=document.createElement(t);if(a)for(var k in a)e[k]=a[k];return e;}',
  'function field(label,input){var l=el("label");l.appendChild(document.createTextNode(label));l.appendChild(input);return l;}',
  'function pair(label,d,t){var w=el("div",{className:"pair"});w.appendChild(el("span",{className:"pair-label",textContent:label}));var r=el("div",{className:"pair-row"});r.appendChild(d);r.appendChild(t);w.appendChild(r);return w;}',
  'function boxes(){return [].slice.call(document.querySelectorAll(".task"));}',
  'function snapOf(p){return D.snap[p]||{fetchedAt:"",sections:[],tasks:[]};}',
  'function refLabel(ref,box){',
  ' if(ref.indexOf("box:")===0){var i=boxes().findIndex(function(b){return b._uid===ref.slice(4);});if(i<0)return null;return "この画面の"+(i+1)+"件目: "+(boxes()[i].querySelector(".f-name").value||"(名前なし)");}',
  ' if(ref.indexOf("cand:")===0){var c=D.cands.filter(function(x){return x.id===ref.slice(5);})[0];return "ほかの候補: "+(c?c.name+"（"+c.project+"・"+c.status+"）":ref.slice(5));}',
  ' var n=Number(ref.slice(1)),t=snapOf(box._pj.value).tasks.filter(function(x){return x.id===n;})[0];return "#"+n+" "+(t?t.name:"(一覧にありません)");}',
  'function renderDeps(box){var ul=box._deps;ul.textContent="";',
  ' box._depList=box._depList.filter(function(d){return refLabel(d.ref,box)!==null;});',
  ' box._depList.forEach(function(d,i){var li=el("li");li.appendChild(el("span",{className:"tag "+d.kind,textContent:d.kind==="pred"?"先にやる":"あとに続く"}));',
  '  li.appendChild(document.createTextNode(" "+refLabel(d.ref,box)+" "));',
  '  var x=el("button",{type:"button",className:"link",textContent:"外す"});x.onclick=function(){box._depList.splice(i,1);renderDeps(box);};li.appendChild(x);ul.appendChild(li);});',
  ' if(!box._depList.length)ul.appendChild(el("li",{className:"note",textContent:"依存関係なし"}));}',
  'function fillSections(box,keep){var s=box._sec,cur=keep!==undefined?keep:s.value;s.textContent="";',
  ' s.appendChild(el("option",{value:"",textContent:"（セクションなし：プロジェクト直下）"}));',
  ' snapOf(box._pj.value).sections.forEach(function(n){var o=el("option",{value:n,textContent:n});if(n===cur)o.selected=true;s.appendChild(o);});',
  ' var f=snapOf(box._pj.value).fetchedAt;box._when.textContent=f?"Quire の内容: "+f+" 時点":"Quire の内容をまだ読み込んでいません";}',
  'function fillTargets(box){var s=box._tgt,q=box._q.value.trim().toLowerCase();s.textContent="";',
  ' function add(g,v,t){if(q&&t.toLowerCase().indexOf(q)<0)return;g.appendChild(el("option",{value:v,textContent:t}));}',
  ' var g1=el("optgroup",{label:"この画面のタスク"});boxes().forEach(function(b,i){if(b!==box)add(g1,"box:"+b._uid,(i+1)+"件目: "+(b.querySelector(".f-name").value||"(名前なし)"));});',
  ' var g2=el("optgroup",{label:"ほかの候補"});D.cands.forEach(function(c){add(g2,"cand:"+c.id,c.name+"（"+c.project+"・"+c.status+"）");});',
  ' var g3=el("optgroup",{label:"既存タスク（"+box._pj.value+"）"});snapOf(box._pj.value).tasks.forEach(function(t){add(g3,"#"+t.id,"#"+t.id+" "+t.name+(t.due?"（"+t.due+"）":""));});',
  ' [g1,g2,g3].forEach(function(g){if(g.children.length)s.appendChild(g);});',
  ' if(!s.children.length)s.appendChild(el("option",{value:"",textContent:"選べるタスクがありません"}));}',
  'function onProjectChange(box){var before=box._sec.value;fillSections(box,before);',
  ' var lost=box._depList.filter(function(d){return d.ref.charAt(0)==="#";}).length;',
  ' box._depList=box._depList.filter(function(d){return d.ref.charAt(0)!=="#";});',
  ' var msgs=[];if(before&&box._sec.value!==before)msgs.push("セクション「"+before+"」はこのプロジェクトに無いので外しました");',
  ' if(lost)msgs.push("前のプロジェクトの既存タスクとの依存関係（"+lost+"件）を外しました");',
  ' box._msg.textContent=msgs.join("。");renderDeps(box);fillTargets(box);}',
  'function addTask(t){var box=el("div",{className:"task"});box._uid=String(++uid);box._depList=(t.deps||[]).slice();',
  ' var name=el("input",{className:"f-name",maxLength:200,value:t.name||""});name.oninput=function(){boxes().forEach(function(b){if(b!==box){renderDeps(b);fillTargets(b);}});};',
  ' var mode=el("select",{className:"f-mode"});[["period","期間（開始〜終了）"],["due","期日のみ"]].forEach(function(m){var o=el("option",{value:m[0],textContent:m[1]});if(m[0]===(t.mode||"period"))o.selected=true;mode.appendChild(o);});',
  ' var sd=el("input",{className:"f-sd",type:"date",value:t.startDate||""}),st=el("input",{className:"f-st",type:"time",value:t.startTime||""});',
  ' var ed=el("input",{className:"f-ed",type:"date",value:t.endDate||""}),et=el("input",{className:"f-et",type:"time",value:t.endTime||""});',
  ' var startRow=pair("開始",sd,st),endRow=pair("終了",ed,et);',
  ' function sync(){var p=mode.value==="period";startRow.style.display=p?"":"none";endRow.firstChild.textContent=p?"終了（日付・時刻は任意）":"期日（時刻は任意）";}',
  ' mode.onchange=sync;',
  ' var pj=el("select",{className:"f-project"});D.projects.forEach(function(p){var o=el("option",{value:p,textContent:p});if(p===t.project)o.selected=true;pj.appendChild(o);});box._pj=pj;',
  ' var sec=el("select",{className:"f-section"});box._sec=sec;',
  ' box._when=el("span",{className:"note"});box._msg=el("p",{className:"warn"});',
  ' var reload=el("button",{type:"button",className:"btn sub-btn small",textContent:"Quire から最新を読み込む"});',
  ' reload.onclick=function(){var p=pj.value;reload.disabled=true;reload.textContent="読み込み中…";',
  '  google.script.run.withSuccessHandler(function(s){D.snap[p]=s;reload.disabled=false;reload.textContent="Quire から最新を読み込む";boxes().forEach(function(b){if(b._pj.value===p){fillSections(b);renderDeps(b);fillTargets(b);}});})',
  '  .withFailureHandler(function(e){reload.disabled=false;reload.textContent="Quire から最新を読み込む";alert(e.message);})',
  '  .loadProjectStructure(D.id,D.action,D.sig,p);};',
  ' pj.onchange=function(){onProjectChange(box);};',
  ' var pr=el("select",{className:"f-priority"});D.priorities.forEach(function(p){var o=el("option",{value:String(p.value),textContent:p.label});if(p.value===t.priority)o.selected=true;pr.appendChild(o);});',
  ' var note=el("textarea",{className:"f-note",maxLength:2000,rows:3,value:t.note||""});',
  ' box._deps=el("ul",{className:"deps"});',
  ' var kind=el("select");[["pred","先にやる（このタスクより前）"],["succ","あとに続く（このタスクより後）"]].forEach(function(k){kind.appendChild(el("option",{value:k[0],textContent:k[1]}));});',
  ' box._q=el("input",{placeholder:"タスク名で絞り込む"});box._q.oninput=function(){fillTargets(box);};',
  ' box._tgt=el("select");',
  ' var addDep=el("button",{type:"button",className:"btn sub-btn small",textContent:"依存関係を追加"});',
  ' addDep.onclick=function(){var r=box._tgt.value;if(!r)return;',
  '  if(box._depList.some(function(d){return d.ref===r;})){alert("同じタスクはすでに追加しています");return;}',
  '  if(box._depList.filter(function(d){return d.kind===kind.value;}).length>=D.maxDeps){alert("依存関係は先・あとそれぞれ"+D.maxDeps+"件までです");return;}',
  '  box._depList.push({kind:kind.value,ref:r});renderDeps(box);};',
  ' var depBox=el("div",{className:"dep-box"});depBox.appendChild(el("span",{className:"pair-label",textContent:"依存関係（同じプロジェクトのタスクとつなぎます）"}));',
  ' [box._deps,kind,box._q,box._tgt,addDep].forEach(function(x){depBox.appendChild(x);});',
  ' var rm=el("button",{type:"button",className:"link",textContent:"このタスクを削除"});rm.onclick=function(){if(boxes().length>1){box.remove();boxes().forEach(function(b){renderDeps(b);fillTargets(b);});}};',
  ' var where=el("div");[field("登録先",pj),field("セクション",sec)].forEach(function(f){where.appendChild(f);});where.appendChild(box._when);where.appendChild(document.createTextNode(" "));where.appendChild(reload);where.appendChild(box._msg);',
  ' [field("タスク名",name),field("日程",mode),startRow,endRow,where,depBox,field("優先度",pr),field("メモ（説明の先頭に入ります）",note)].forEach(function(f){box.appendChild(f);});sync();',
  ' box.appendChild(rm);document.getElementById("tasks").appendChild(box);',
  ' fillSections(box,t.section||"");boxes().forEach(function(b){renderDeps(b);fillTargets(b);});',
  ' if(t.section&&sec.value!==t.section)box._msg.textContent="提案されたセクション「"+t.section+"」が一覧にありません。「Quire から最新を読み込む」を押してください";}',
  'document.getElementById("assignees").value=D.assignees;',
  'addTask(D.task);',
  'document.getElementById("add").onclick=function(){if(boxes().length>=D.max){alert("一度に登録できるのは"+D.max+"件までです");return;}addTask({project:D.task.project,section:boxes()[0]._sec.value,priority:0,mode:"period",startDate:D.task.startDate});};',
  'document.getElementById("go").onclick=function(){var b=this,list=boxes();',
  ' var tasks=list.map(function(x){return{name:x.querySelector(".f-name").value,mode:x.querySelector(".f-mode").value,startDate:x.querySelector(".f-sd").value,startTime:x.querySelector(".f-st").value,endDate:x.querySelector(".f-ed").value,endTime:x.querySelector(".f-et").value,project:x._pj.value,section:x._sec.value,priority:Number(x.querySelector(".f-priority").value),note:x.querySelector(".f-note").value,',
  '  deps:x._depList.map(function(d){if(d.ref.indexOf("box:")!==0)return d;var i=list.findIndex(function(y){return y._uid===d.ref.slice(4);});return i<0?null:{kind:d.kind,ref:"new:"+i};}).filter(Boolean)};});',
  ' b.disabled=true;b.textContent="登録しています…";',
  ' google.script.run',
  '  .withSuccessHandler(function(html){document.getElementById("main").innerHTML=html;})',
  '  .withFailureHandler(function(e){b.disabled=false;b.textContent="登録する";alert(e.message);})',
  '  .submitEdit(D.id,D.action,D.sig,{assignees:document.getElementById("assignees").value,tasks:tasks});};',
].join('\n');

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
    '.dep-box{background:#f9fafb;border-radius:8px;padding:10px;margin:0 0 12px}.deps{margin:4px 0 8px}' +
    '.tag{display:inline-block;font-size:12px;border-radius:4px;padding:0 6px;color:#fff}.tag.pred{background:#0f766e}.tag.succ{background:#7c3aed}' +
    '.warn{color:#b45309;font-size:13px;margin:4px 0 12px}.btn.small{font-size:14px;padding:8px 12px}' +
    '.btn{display:inline-block;background:#0f766e;color:#fff;border:0;border-radius:8px;padding:12px 18px;' +
    'font-size:16px;text-decoration:none}.btn:disabled{opacity:.6}' +
    '</style>';
  const footer = '<p class="note" style="margin-top:32px">バージョン: ' + escapeHtml_(APP_VERSION) + '</p>';
  return HtmlService.createHtmlOutput(style + body + footer)
    .setTitle(title)
    .addMetaTag('viewport', 'width=device-width, initial-scale=1');
}
