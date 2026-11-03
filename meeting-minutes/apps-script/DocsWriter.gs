/**
 * Claude が書いた整理結果（Markdown を1行ずつ）を、Google ドキュメントに書式付きで差し込む。
 *  - 処理ログの「メモの見出し」（Y列）があれば、その見出しのセクションの終わり（次の同じ階層以上の見出しの直前）
 *  - 無ければ、またはその見出しが見つからなければ、ドキュメントの先頭（最初の行がタイトルや見出し1ならその直後）
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
 * insertAt: 挿入位置。
 * leadingBreak: 本文末尾に足すとき、直前の段落に文字があれば true（先に改行を入れる）。
 * trailingBreak: 既存の段落の前に差し込むとき true（最後に改行を入れて、後ろの段落と分ける）。
 */
function buildDocRequests_(lines, insertAt, leadingBreak, trailingBreak) {
  const paras = lines.map(parseMarkdownLine_).filter(function (p) { return p.text !== ''; });
  if (!paras.length) return [];

  // 箇条書きは先頭のタブの数で段の深さが決まる（箇条書きを付けるとタブは消える）
  const texts = paras.map(function (p) {
    return (p.list ? new Array(p.level + 1).join('\t') : '') + p.text;
  });
  const body = (leadingBreak ? '\n' : '') + texts.join('\n') + (trailingBreak ? '\n' : '');
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

/** 段落の文字（日付チップ・予定チップ・人物チップの表示名も含める）。 */
function paragraphText_(paragraph) {
  return (paragraph.elements || []).map(function (el) {
    if (el.textRun) return el.textRun.content || '';
    if (el.richLink && el.richLink.richLinkProperties) return el.richLink.richLinkProperties.title || '';
    if (el.dateElement && el.dateElement.dateElementProperties) {
      return el.dateElement.dateElementProperties.displayText || '';
    }
    if (el.person && el.person.personProperties) return el.person.personProperties.name || '';
    return '';
  }).join('').replace(/\n$/, '');
}

/** 見出しの階層（TITLE は 0、見出し1〜6 は 1〜6、見出しでなければ 0 以外の大きな値）。 */
function headingLevel_(paragraph) {
  const style = String((paragraph.paragraphStyle && paragraph.paragraphStyle.namedStyleType) || '');
  if (style === 'TITLE') return 0;
  const m = style.match(/^HEADING_(\d)$/);
  return m ? Number(m[1]) : 99;
}

/** 照合用に、空白・区切り記号・全角半角の違いをならす。 */
function normalizeHeading_(text) {
  return String(text || '').normalize('NFKC').replace(/[\s|｜:：・\-–—_#*【】\[\]()（）「」]/g, '').toLowerCase();
}

/**
 * 差し込み位置を決める。戻り値: { index, mode: 'before' | 'append', found }
 * anchor（メモの見出し）に合う見出しがあれば、そのセクションの終わり。無ければ先頭。
 */
function findInsertPosition_(content, anchor) {
  const paras = [];
  content.forEach(function (el) {
    if (el.paragraph) {
      paras.push({ start: el.startIndex, end: el.endIndex, level: headingLevel_(el.paragraph), text: paragraphText_(el.paragraph) });
    } else if (el.table || el.tableOfContents) {
      paras.push({ start: el.startIndex, end: el.endIndex, level: 99, text: '' });
    }
  });
  const last = content[content.length - 1];
  const bodyEnd = last ? last.endIndex : 2;

  const target = normalizeHeading_(anchor);
  if (target) {
    // 1) 見出し全体が一致（含む）するもの → 2) 「|」の後ろ（会議名）で一致するもの
    const titlePart = normalizeHeading_(String(anchor).split(/[|｜]/).pop());
    const isMatch = [
      function (p) { const t = normalizeHeading_(p.text); return t && (t.indexOf(target) >= 0 || target.indexOf(t) >= 0) && t.length >= 4; },
      function (p) { const t = normalizeHeading_(p.text); return titlePart.length >= 4 && t.indexOf(titlePart) >= 0; },
    ];
    for (let k = 0; k < isMatch.length; k++) {
      for (let i = 0; i < paras.length; i++) {
        if (paras[i].level === 99 || !isMatch[k](paras[i])) continue;
        // セクションの終わり = 次の同じ階層以上の見出し
        for (let j = i + 1; j < paras.length; j++) {
          if (paras[j].level <= paras[i].level) return { index: paras[j].start, mode: 'before', found: true };
        }
        return { index: bodyEnd - 1, mode: 'append', found: true };
      }
    }
  }

  // 先頭：最初の文字のある段落がタイトルか見出し1なら、その直後
  const first = paras.filter(function (p) { return p.text.trim() !== '' || p.level !== 99; })[0];
  if (first && first.level <= 1 && paras.length > 1) {
    const next = paras[paras.indexOf(first) + 1];
    if (next) return { index: next.start, mode: 'before', found: false };
  }
  return { index: paras.length ? paras[0].start : 1, mode: paras.length ? 'before' : 'append', found: false };
}

/** 整理結果をドキュメントに差し込む。メモの見出しが見つかったかどうかを返す。 */
function insertMarkdownToDoc_(docId, lines, anchor) {
  const doc = Docs.Documents.get(docId);
  const content = (doc.body && doc.body.content) || [];
  const pos = findInsertPosition_(content, anchor);
  let requests;
  if (pos.mode === 'append') {
    const last = content[content.length - 1];
    const lastText = last && last.paragraph ? paragraphText_(last.paragraph) : '';
    requests = buildDocRequests_(lines, pos.index, lastText !== '', false);
  } else {
    requests = buildDocRequests_(lines, pos.index, false, true);
  }
  if (!requests.length) throw new Error('追記する内容が空です。');
  Docs.Documents.batchUpdate({ requests: requests }, docId);
  return pos.found;
}

/** 整理結果をドキュメントの末尾に追記する（書式テスト用）。 */
function appendMarkdownToDoc_(docId, lines) {
  const doc = Docs.Documents.get(docId);
  const content = (doc.body && doc.body.content) || [];
  const last = content[content.length - 1];
  const endIndex = last ? last.endIndex : 2;
  const lastText = last && last.paragraph ? paragraphText_(last.paragraph) : '';
  const requests = buildDocRequests_(lines, endIndex - 1, lastText !== '', false);
  if (!requests.length) throw new Error('追記する内容が空です。');
  Docs.Documents.batchUpdate({ requests: requests }, docId);
}
