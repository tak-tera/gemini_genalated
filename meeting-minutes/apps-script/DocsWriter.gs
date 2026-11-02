/**
 * Claude が書いた整理結果（Markdown を1行ずつ）を、Google ドキュメントの末尾に書式付きで追記する。
 *  - 「# 」「## 」「### 」→ 見出し1〜3
 *  - 「- 」「* 」→ 箇条書き（先頭の空白2つで1段下げる）
 *  - 「- [ ] 」→ チェックボックス付きの箇条書き
 *  - 「**太字**」→ 太字
 * 空行は入れない（フォーマットの規則どおり）。
 */

/** Markdown の1行を、段落の種類・本文・太字の位置に分解する。 */
function parseMarkdownLine_(raw) {
  let line = String(raw).replace(/\r/g, '').replace(/\s+$/, '');
  const result = { style: 'NORMAL_TEXT', list: '', level: 0, text: '', bold: [] };

  const heading = line.match(/^(#{1,6})\s+(.*)$/);
  const bullet = line.match(/^([ \t]*)[-*+]\s+(.*)$/);
  if (heading) {
    result.style = 'HEADING_' + heading[1].length;
    line = heading[2];
  } else if (bullet) {
    const indent = bullet[1].replace(/\t/g, '  ').length;
    result.level = Math.min(8, Math.floor(indent / 2));
    line = bullet[2];
    const check = line.match(/^\[( |x|X)\]\s*(.*)$/);
    if (check) {
      result.list = 'check';
      line = check[2];
    } else {
      result.list = 'bullet';
    }
  } else {
    line = line.replace(/^\s+/, '');
  }

  // **太字** を外し、外したあとの位置を記録する
  let text = '';
  let rest = line;
  for (;;) {
    const open = rest.indexOf('**');
    if (open < 0) break;
    const close = rest.indexOf('**', open + 2);
    if (close < 0) break;
    text += rest.slice(0, open);
    const inner = rest.slice(open + 2, close);
    if (inner) result.bold.push([text.length, text.length + inner.length]);
    text += inner;
    rest = rest.slice(close + 2);
  }
  result.text = text + rest;
  return result;
}

/**
 * Docs API の batchUpdate リクエストを作る。
 * insertAt: 挿入位置（本文末尾の改行の直前）。leadingBreak: 直前の段落に文字があるとき true。
 */
function buildDocRequests_(lines, insertAt, leadingBreak) {
  const paras = lines.map(parseMarkdownLine_).filter(function (p) { return p.text !== ''; });
  if (!paras.length) return [];

  // 箇条書きは先頭のタブの数で段の深さが決まる（箇条書きを付けるとタブは消える）
  const texts = paras.map(function (p) {
    return (p.list ? new Array(p.level + 1).join('\t') : '') + p.text;
  });
  const body = (leadingBreak ? '\n' : '') + texts.join('\n');
  const requests = [{ insertText: { location: { index: insertAt }, text: body } }];

  let pos = insertAt + (leadingBreak ? 1 : 0);
  const starts = [];
  texts.forEach(function (t) {
    starts.push(pos);
    pos += t.length + 1;
  });
  const endOfInserted = pos - 1; // 最後の段落の文字の終わり

  // 直前の段落から書式（見出し・箇条書き・太字など）を引き継がないようにリセットする
  requests.push({
    deleteParagraphBullets: { range: { startIndex: starts[0], endIndex: endOfInserted } },
  });
  requests.push({
    updateTextStyle: {
      range: { startIndex: starts[0], endIndex: endOfInserted },
      textStyle: { bold: false, italic: false, underline: false },
      fields: 'bold,italic,underline',
    },
  });

  paras.forEach(function (p, i) {
    const start = starts[i];
    const len = texts[i].length;
    requests.push({
      updateParagraphStyle: {
        range: { startIndex: start, endIndex: start + Math.max(1, len) },
        paragraphStyle: { namedStyleType: p.style },
        fields: 'namedStyleType',
      },
    });
    const offset = p.list ? p.level : 0; // 先頭のタブの分ずらす
    p.bold.forEach(function (b) {
      requests.push({
        updateTextStyle: {
          range: { startIndex: start + offset + b[0], endIndex: start + offset + b[1] },
          textStyle: { bold: true },
          fields: 'bold',
        },
      });
    });
  });

  // 同じ種類が続く箇条書きをひとまとまりにし、後ろのまとまりから付ける（タブが消えても前の位置がずれない）
  const groups = [];
  paras.forEach(function (p, i) {
    const last = groups[groups.length - 1];
    if (p.list && last && last.list === p.list && last.to === i - 1) {
      last.to = i;
    } else if (p.list) {
      groups.push({ list: p.list, from: i, to: i });
    }
  });
  groups.reverse().forEach(function (g) {
    requests.push({
      createParagraphBullets: {
        range: { startIndex: starts[g.from], endIndex: starts[g.to] + Math.max(1, texts[g.to].length) },
        bulletPreset: g.list === 'check' ? 'BULLET_CHECKBOX' : 'BULLET_DISC_CIRCLE_SQUARE',
      },
    });
  });
  return requests;
}

/** 整理結果をドキュメントの末尾に追記する。 */
function appendMarkdownToDoc_(docId, lines) {
  const doc = Docs.Documents.get(docId);
  const content = (doc.body && doc.body.content) || [];
  const last = content[content.length - 1];
  const endIndex = last ? last.endIndex : 2;
  let lastText = '';
  if (last && last.paragraph) {
    lastText = (last.paragraph.elements || []).map(function (el) {
      return (el.textRun && el.textRun.content) || '';
    }).join('');
  }
  const leadingBreak = lastText.replace(/\n$/, '') !== '';
  const requests = buildDocRequests_(lines, endIndex - 1, leadingBreak);
  if (!requests.length) throw new Error('追記する内容が空です。');
  Docs.Documents.batchUpdate({ requests: requests }, docId);
}
