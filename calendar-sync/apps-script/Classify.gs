/** メインの予定を分類する（打ち合わせ／研修講演／対象外…）。 */

/**
 * 予定がどの組織のものか（接頭辞または色）。該当なしは ''。
 * 「（TU 打ち合わせ…）」のように先頭がカッコでも、「[調整中] TU …」のように先頭に札が付いていても接頭辞として見る。
 */
function orgOfMainEvent_(e, orgs) {
  const p = privProps_(e);
  if (p[PROP.ORG]) return p[PROP.ORG];
  const raw = String(e.summary || '');
  const titles = [
    raw.replace(/^[\s（(【\[]+/, ''),
    raw.replace(/^(?:\s*(?:\[[^\]]*\]|【[^】]*】|［[^］]*］))+\s*/, ''),
  ];
  for (let i = 0; i < orgs.length; i++) {
    const o = orgs[i];
    if (o.prefix && titles.some(function (t) { return t.indexOf(o.prefix) === 0; })) return o.code;
  }
  for (let i = 0; i < orgs.length; i++) {
    if (orgs[i].colorId && e.colorId === orgs[i].colorId) return orgs[i].code;
  }
  return '';
}

/** 分類ルールを上から順に当て、最初に当たったものを返す。どれにも当たらなければ DEFAULT_RULE。 */
function classify_(title, orgCode, rules) {
  const t = String(title || '');
  for (let i = 0; i < rules.length; i++) {
    const r = rules[i];
    if (r.org && r.org !== orgCode) continue;
    if (r.patterns.some(function (p) { p.lastIndex = 0; return p.test(t); })) return r;
  }
  return DEFAULT_RULE;
}
