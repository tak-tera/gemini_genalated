/** Google Chat に送るカード。Webhook のカードのボタンはリンクしか開けないので、各ボタンは Web アプリへのリンクにする。 */

function approvalCard_(entry, selectedName) {
  const widgets = [
    textWidget_('送信者', clip_(entry.sender, 200)),
    textWidget_('タスク名', clip_(entry.taskName, 200)),
    textWidget_('登録先', selectedName),
  ];
  const due = toQuireDate_(entry.due);
  if (due) widgets.push(textWidget_('期限', due));
  widgets.push(textWidget_('判定', [entry.method, entry.confidence !== '' ? '確信度 ' + entry.confidence : '']
    .filter(String).join(' / ')));
  if (entry.reason) widgets.push(textWidget_('理由', clip_(entry.reason, 300)));
  if (entry.newProjectCandidate) widgets.push(textWidget_('新規プロジェクト候補', clip_(entry.newProjectCandidate, 100)));

  const buttons = [
    linkButton_('登録する', actionUrl_('approve', entry.messageId), true),
    linkButton_('内容を直して登録', actionUrl_('edit', entry.messageId)),
    linkButton_('却下', actionUrl_('reject', entry.messageId)),
  ];
  const gmailUrl = safeGmailUrl_(entry.gmailUrl);
  if (gmailUrl) buttons.push(linkButton_('メールを開く', gmailUrl));
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
