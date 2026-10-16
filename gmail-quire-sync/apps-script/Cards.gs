/** Google Chat に送るカード。Webhook のカードのボタンはリンクしか開けないので、各ボタンは Web アプリへのリンクにする。 */

function approvalCard_(entry, selectedName) {
  const widgets = [
    textWidget_('送信者', entry.sender),
    textWidget_('タスク名', entry.taskName),
    textWidget_('登録先', selectedName),
  ];
  const due = toQuireDate_(entry.due);
  if (due) widgets.push(textWidget_('期限', due));
  widgets.push(textWidget_('判定', [entry.method, entry.confidence !== '' ? '確信度 ' + entry.confidence : '']
    .filter(String).join(' / ')));
  if (entry.reason) widgets.push(textWidget_('理由', entry.reason));
  if (entry.newProjectCandidate) widgets.push(textWidget_('新規プロジェクト候補', entry.newProjectCandidate));

  const buttons = [
    linkButton_('登録する', actionUrl_('approve', entry.messageId), true),
    linkButton_('登録先を変える', actionUrl_('choose', entry.messageId)),
    linkButton_('却下', actionUrl_('reject', entry.messageId)),
  ];
  if (entry.gmailUrl) buttons.push(linkButton_('メールを開く', String(entry.gmailUrl)));
  widgets.push({ buttonList: { buttons: buttons } });

  return {
    cardId: 'approval-' + entry.messageId,
    card: {
      header: { title: 'Quire に登録しますか？', subtitle: String(entry.subject || '') },
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
