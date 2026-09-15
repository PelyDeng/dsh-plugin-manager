/**
 * auth 目录页的排版探针，配合 `scripts/web-page-probe.mjs` 使用：
 *
 *   node scripts/web-page-probe.mjs --root plugins/builtin/dsh-auth --prefix /auth \
 *     --stub plugins/builtin/dsh-auth/tests/page-stub.json --probe plugins/builtin/dsh-auth/tests/page-probe.js
 *
 * 量的是「一行最多三张卡片」这条版式约束，以及同一行里的错位：卡片头部与页脚的行内位置差、
 * 是否出现横向溢出、说明实际渲染了几行（长说明必须被截断到固定行数，否则整行高度参差）。
 */
const round = value => Math.round(value * 10) / 10;
const sections = [...document.querySelectorAll('.plugin-section')].map(section => {
  const rows = new Map();
  for (const card of section.querySelectorAll('.plugin-card')) {
    const top = Math.round(card.getBoundingClientRect().top);
    rows.set(top, [...(rows.get(top) ?? []), card]);
  }
  return {
    label: section.querySelector('.plugin-section-title')?.textContent ?? '',
    rows: [...rows.values()].map(row => {
      const heads = row.map(card => round(card.querySelector('.plugin-card-head').getBoundingClientRect().top));
      const feet = row.map(card => round(card.querySelector('.plugin-card-foot').getBoundingClientRect().bottom));
      return {
        cards: row.length,
        headSpread: round(Math.max(...heads) - Math.min(...heads)),
        footSpread: round(Math.max(...feet) - Math.min(...feet)),
        overflow: row.some(card => card.scrollWidth > card.clientWidth + 1),
        descriptionLines: row.map(card => Math.round(card.querySelector('.plugin-description').getBoundingClientRect().height / 18)),
      };
    }),
  };
});
return { sections, pageOverflow: document.documentElement.scrollWidth > document.documentElement.clientWidth };
