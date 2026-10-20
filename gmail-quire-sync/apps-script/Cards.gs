/** Google Chat に送るカード。Webhook のカードのボタンはリンクしか開けないので、各ボタンは Web アプリへのリンクにする。 */

function approvalCard_(entry, selectedName, entries, project, snapshot) {
  let where = selectedName;
  if (entry.section && selectedName === String(entry.judgedProject)) {
    const known = project && projectSnapshot_(project, snapshot).sections
      .some(function (x) { return x.name === String(entry.section); });
    where += ' / ' + clip_(entry.section, 100) + (known ? '' : '（Quire で未確認）');
  }
  const widgets = [
    textWidget_(isMail_(entry) ? '送信者' : '依頼元（' + clip_(sourceOf_(entry), 20) + '）', clip_(entry.sender, 200)),
    textWidget_('タスク名', clip_(entry.taskName, 200)),
    textWidget_('登録先', where),
  ];
  // 依存関係は判定どおりのプロジェクトに入れるときだけ使う
  if (selectedName === String(entry.judgedProject)) {
    const before = refsLabel_(entry.predecessors, entries);
    const after = refsLabel_(entry.successors, entries);
    if (before) widgets.push(textWidget_('先にやるタスク（依存）', clip_(before, 300)));
    if (after) widgets.push(textWidget_('あとに続くタスク（依存）', clip_(after, 300)));
  }
  const schedule = scheduleLabel_(defaultSchedule_(entry));
  if (schedule) widgets.push(textWidget_('期間', schedule));
  widgets.push(textWidget_('判定', [entry.method, entry.confidence !== '' ? '確信度 ' + entry.confidence : '']
    .filter(String).join(' / ')));
  if (entry.reason) widgets.push(textWidget_('理由', clip_(entry.reason, 300)));
  if (entry.newProjectCandidate) widgets.push(textWidget_('新規プロジェクト候補', clip_(entry.newProjectCandidate, 100)));

  const buttons = [
    linkButton_('登録する', actionUrl_('approve', entry.messageId), true),
    linkButton_('内容を直して登録', actionUrl_('edit', entry.messageId)),
    linkButton_('却下', actionUrl_('reject', entry.messageId)),
  ];
  const sourceUrl = safeSourceUrl_(entry.gmailUrl);
  if (sourceUrl) buttons.push(linkButton_(sourceLinkLabel_(entry), sourceUrl));
  widgets.push({ buttonList: { buttons: buttons } });

  return {
    cardId: 'approval-' + entry.messageId,
    card: {
      header: { title: 'Quire に登録しますか？', subtitle: clip_(entry.subject, 100) },
      sections: [{ widgets: widgets }],
    },
  };
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
