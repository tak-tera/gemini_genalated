/** Google Chat に送るカード。Webhook のカードのボタンはリンクしか開けないので、各ボタンは Web アプリへのリンクにする。 */

/**
 * 確認カード。カードを見ただけで「登録する」を押せるように、判断に要る情報を上にまとめる。
 *  見出し：タスク名
 *  要点（常に表示）：期日・登録先／セクション・担当者（・依存関係）→ ボタン
 *  詳細（折りたたみ）：依頼元・件名・判定・理由
 */
function approvalCard_(entry, selectedName, entries, project, snapshot) {
  const sameProject = selectedName === String(entry.judgedProject);

  // 登録先 / セクション
  let where = '<b>' + escapeHtml_(selectedName) + '</b>';
  if (entry.section && sameProject) {
    const known = project && projectSnapshot_(project, snapshot).sections
      .some(function (x) { return x.name === String(entry.section); });
    where += ' / ' + escapeHtml_(clip_(entry.section, 100)) + (known ? '' : '（Quire で未確認）');
  }

  const key = [
    iconWidget_('CLOCK', '期日', dueLabel_(defaultSchedule_(entry))),
    iconWidget_('BOOKMARK', '登録先', where),
    iconWidget_('PERSON', '担当者', escapeHtml_(assigneeLabel_(entry))),
  ];
  if (sameProject) {
    const before = refsLabel_(entry.predecessors, entries);
    const after = refsLabel_(entry.successors, entries);
    if (before) key.push(iconWidget_('DESCRIPTION', '先にやるタスク', escapeHtml_(clip_(before, 300))));
    if (after) key.push(iconWidget_('DESCRIPTION', 'あとに続くタスク', escapeHtml_(clip_(after, 300))));
  }
  if (entry.newProjectCandidate) {
    key.push(iconWidget_('STAR', '新規プロジェクト候補', escapeHtml_(clip_(entry.newProjectCandidate, 100))));
  }

  const buttons = [
    linkButton_('登録する', actionUrl_('approve', entry.messageId), true),
    linkButton_('内容を直して登録', actionUrl_('edit', entry.messageId)),
    linkButton_('却下', actionUrl_('reject', entry.messageId)),
  ];
  const sourceUrl = safeSourceUrl_(entry.gmailUrl);
  if (sourceUrl) buttons.push(linkButton_(sourceLinkLabel_(entry), sourceUrl));
  key.push({ buttonList: { buttons: buttons } });

  const mail = isMail_(entry);
  const detail = [
    textWidget_(mail ? '送信者' : '依頼元（' + clip_(sourceOf_(entry), 20) + '）', clip_(entry.sender, 200)),
    textWidget_(mail ? '件名' : '題名', clip_(entry.subject, 300)),
    textWidget_('判定', [entry.method, entry.confidence !== '' ? '確信度 ' + entry.confidence : ''].filter(String).join(' / ')),
  ];
  if (entry.reason) detail.push(textWidget_('理由', clip_(entry.reason, 300)));

  return {
    cardId: 'approval-' + entry.messageId,
    card: {
      header: {
        title: clip_(entry.taskName || entry.subject || '(タスク名なし)', 100),
        subtitle: 'Quire に登録しますか？（' + clip_(sourceOf_(entry), 20) + '）',
      },
      sections: [
        { widgets: key },
        { header: '詳細（依頼元・判定理由）', collapsible: true, uncollapsibleWidgetsCount: 0, widgets: detail },
      ],
    },
  };
}

/** 期日の表示。「11/13（金）・あと10日」。開始日があれば添える。空なら「期日未定」。 */
function dueLabel_(schedule) {
  const end = schedule.end;
  if (!end.date) return '<b>期日未定</b>';
  let text = '<b>' + mdw_(end.date) + (end.time ? ' ' + end.time : '') + '</b>';
  const days = daysFromToday_(end.date);
  if (days < 0) text += '・<font color="#d93025">期限切れ</font>';
  else if (days === 0) text += '・<font color="#d93025">今日</font>';
  else if (days === 1) text += '・明日';
  else if (days <= 14) text += '・あと' + days + '日';
  if (schedule.start.date && schedule.start.date !== end.date) text += '（開始 ' + mdw_(schedule.start.date) + '）';
  return text;
}

/** yyyy-MM-dd を「11/13（金）」にする。 */
function mdw_(date) {
  const m = String(date).match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return escapeHtml_(String(date));
  const w = '日月火水木金土'.charAt(new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])).getDay());
  return Number(m[2]) + '/' + Number(m[3]) + '（' + w + '）';
}

/** 今日（日本時間）から date までの日数。 */
function daysFromToday_(date) {
  const today = Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyy-MM-dd');
  const toUtc = function (d) { const p = d.split('-').map(Number); return Date.UTC(p[0], p[1] - 1, p[2]); };
  return Math.round((toUtc(date) - toUtc(today)) / 86400000);
}

/** 担当者の表示。自分は「自分」、空なら「担当者なし」。 */
function assigneeLabel_(entry) {
  if (sourceOf_(entry) !== SOURCE.CHAT) return '自分';
  const owner = ownerEmail_();
  const list = splitList_(entry.assignee).map(function (a) {
    return a === owner || a === 'me' ? '自分' : a;
  });
  return list.length ? list.join('、') : '担当者なし';
}

/** アイコン付きの1行（本文は HTML として表示。呼ぶ側でエスケープすること）。 */
function iconWidget_(icon, label, html) {
  return { decoratedText: { startIcon: { knownIcon: icon }, topLabel: label, text: html, wrapText: true } };
}

function linkButton_(text, url, filled) {
  const button = { text: text, onClick: { openLink: { url: url } } };
  if (filled) button.type = 'FILLED';
  return button;
}

function textWidget_(label, value) {
  return { decoratedText: { topLabel: label, text: escapeHtml_(String(value || '')), wrapText: true } };
}

function escapeHtml_(text) {
  return String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
