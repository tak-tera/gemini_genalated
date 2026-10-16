/**
 * Google Chat からのイベント処理。
 *
 * Chat アプリの作り方は2種類あり、届くイベントの形が違う。どちらでも動くようにしてある。
 *  - Google Workspace アドオン形式（現在の Google Cloud コンソールの標準）: event.chat がある
 *  - 従来の Chat アプリ形式: event.type がある
 */

function isAddOnEvent_(event) {
  return !!(event && event.chat);
}

function eventUserEmail_(event) {
  const user = isAddOnEvent_(event) ? event.chat.user : event.user;
  return user && user.email ? String(user.email).toLowerCase() : '';
}

function eventSpace_(event) {
  if (isAddOnEvent_(event)) {
    const chat = event.chat;
    const payload = chat.addedToSpacePayload || chat.messagePayload || chat.buttonClickedPayload || {};
    return payload.space || (payload.message && payload.message.space) || null;
  }
  return event.space || null;
}

/** 本人以外からの操作を断る。OWNER_EMAIL が未設定なら誰でも可。 */
function isOwner_(event) {
  const owner = String(prop_('OWNER_EMAIL', false) || '').toLowerCase();
  return !owner || eventUserEmail_(event) === owner;
}

/** 1対1のチャット（DM）なら、その space を送信先として保存する。 */
function rememberDmSpace_(event) {
  const space = eventSpace_(event);
  if (!space || !space.name) return;
  const isDm = space.type === 'DM' || space.spaceType === 'DIRECT_MESSAGE' || space.singleUserBotDm;
  if (isDm && isOwner_(event)) setProp_('CHAT_SPACE', space.name);
}

// ---------- 返信の組み立て ----------

function textReply_(event, text) {
  if (isAddOnEvent_(event)) {
    return { hostAppDataAction: { chatDataAction: { createMessageAction: { message: { text: text } } } } };
  }
  return { text: text };
}

function updateCardReply_(event, card) {
  if (isAddOnEvent_(event)) {
    return { hostAppDataAction: { chatDataAction: { updateMessageAction: { message: { cardsV2: [card] } } } } };
  }
  return { actionResponse: { type: 'UPDATE_MESSAGE' }, cardsV2: [card] };
}

function clickParams_(event) {
  if (isAddOnEvent_(event)) return (event.commonEventObject && event.commonEventObject.parameters) || {};
  return (event.common && event.common.parameters) || {};
}

function formValue_(event, name) {
  const inputs = isAddOnEvent_(event)
    ? (event.commonEventObject && event.commonEventObject.formInputs)
    : (event.common && event.common.formInputs);
  const field = inputs && inputs[name];
  const values = field && field.stringInputs && field.stringInputs.value;
  return values && values.length ? values[0] : '';
}

// ---------- イベントハンドラ ----------

/** アプリが DM やスペースに追加されたとき。 */
function onAddedToSpace(event) {
  rememberDmSpace_(event);
  return textReply_(event,
    'Quire 登録確認アプリを追加しました。登録すべきメールが見つかると、ここに確認カードを送ります。');
}

/** アプリにメッセージが送られたとき。「状態」と送ると承認待ちの件数を返す。 */
function onMessage(event) {
  rememberDmSpace_(event);
  if (!isOwner_(event)) return textReply_(event, 'このアプリは所有者だけが使えます。');
  const pending = getLogEntries_().filter(function (e) { return e.status === STATUS.PENDING; }).length;
  return textReply_(event, '承認待ちは ' + pending + ' 件です。確認カードは数分おきに送られます。');
}

function onRemovedFromSpace(event) {
  const space = eventSpace_(event);
  if (space && space.name === prop_('CHAT_SPACE', false)) {
    PropertiesService.getScriptProperties().deleteProperty('CHAT_SPACE');
  }
}

/** 従来形式の Chat アプリではボタンの操作がここに届くので、押されたボタンに振り分ける。 */
function onCardClick(event) {
  const fn = (event.common && event.common.invokedFunction) || (event.action && event.action.actionMethodName);
  if (fn === 'onApproveClick') return onApproveClick(event);
  if (fn === 'onRejectClick') return onRejectClick(event);
  return textReply_(event, '不明な操作です: ' + fn);
}

/** 「登録する」ボタン。 */
function onApproveClick(event) {
  return handleDecision_(event, true);
}

/** 「却下」ボタン。 */
function onRejectClick(event) {
  return handleDecision_(event, false);
}

function handleDecision_(event, approve) {
  if (!isOwner_(event)) return textReply_(event, 'このアプリは所有者だけが使えます。');

  const messageId = clickParams_(event).messageId;
  const lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    const entry = findLogEntry_(messageId);
    if (!entry) return textReply_(event, '登録ログに該当する行が見つかりませんでした。');

    if (entry.status !== STATUS.PENDING) {
      return updateCardReply_(event, resultCard_(entry, 'すでに処理済みです（' + entry.status + '）',
        '', entry.taskUrl ? String(entry.taskUrl) : ''));
    }

    if (!approve) {
      updateLog_(entry.row, { status: STATUS.REJECTED });
      return updateCardReply_(event, resultCard_(entry, '却下しました', 'Quire には登録していません。'));
    }

    const projectName = formValue_(event, 'project') || String(entry.judgedProject);
    updateLog_(entry.row, { status: STATUS.APPROVED });
    try {
      const result = registerEntry_(entry, projectName);
      return updateCardReply_(event, resultCard_(entry, '登録しました',
        '登録先: ' + escapeHtml_(result.project.name), result.task.url));
    } catch (e) {
      updateLog_(entry.row, { status: STATUS.ERROR, reason: String(entry.reason) + ' / エラー: ' + e.message });
      return updateCardReply_(event, resultCard_(entry, '登録に失敗しました', escapeHtml_(e.message)));
    }
  } finally {
    lock.releaseLock();
  }
}
