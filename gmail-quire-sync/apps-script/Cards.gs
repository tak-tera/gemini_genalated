/** Google Chat に表示するカード。 */

/** 承認依頼カード。登録先を選ぶプルダウンと「登録する」「却下」ボタンを持つ。 */
function approvalCard_(entry, projects, selectedName) {
  const widgets = [
    textWidget_('送信者', entry.sender),
    textWidget_('タスク名', entry.taskName),
  ];
  const due = toQuireDate_(entry.due);
  if (due) widgets.push(textWidget_('期限', due));
  widgets.push(textWidget_('判定', [entry.method, entry.confidence !== '' ? '確信度 ' + entry.confidence : '']
    .filter(String).join(' / ')));
  if (entry.reason) widgets.push(textWidget_('理由', entry.reason));
  if (entry.newProjectCandidate) widgets.push(textWidget_('新規プロジェクト候補', entry.newProjectCandidate));

  widgets.push({
    selectionInput: {
      name: 'project',
      label: '登録先',
      type: 'DROPDOWN',
      items: projects.map(function (p) {
        return { text: p.name, value: p.name, selected: p.name === selectedName };
      }),
    },
  });

  const params = [{ key: 'messageId', value: String(entry.messageId) }];
  const buttons = [
    { text: '登録する', type: 'FILLED', onClick: { action: { function: 'onApproveClick', parameters: params } } },
    { text: '却下', onClick: { action: { function: 'onRejectClick', parameters: params } } },
  ];
  if (entry.gmailUrl) buttons.push({ text: 'メールを開く', onClick: { openLink: { url: String(entry.gmailUrl) } } });
  widgets.push({ buttonList: { buttons: buttons } });

  return {
    cardId: 'approval-' + entry.messageId,
    card: {
      header: { title: 'Quire に登録しますか？', subtitle: String(entry.subject || '') },
      sections: [{ widgets: widgets }],
    },
  };
}

/** 処理後に差し替える結果カード。 */
function resultCard_(entry, title, detail, linkUrl) {
  const widgets = [
    textWidget_('件名', entry.subject),
    textWidget_('タスク名', entry.taskName),
  ];
  if (detail) widgets.push({ textParagraph: { text: detail } });
  if (linkUrl) {
    widgets.push({ buttonList: { buttons: [{ text: 'Quire で開く', onClick: { openLink: { url: linkUrl } } }] } });
  }
  return {
    cardId: 'result-' + entry.messageId,
    card: { header: { title: title }, sections: [{ widgets: widgets }] },
  };
}

function textWidget_(label, value) {
  return { decoratedText: { topLabel: label, text: escapeHtml_(String(value || '')), wrapText: true } };
}

function escapeHtml_(text) {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
