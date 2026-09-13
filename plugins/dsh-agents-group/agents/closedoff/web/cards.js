/**
 * 结果卡片层：把工具返回的业务数据渲染成「结果分组 + 卡片」，并维护一份按
 * 「回答 + 工具调用」复合键的缓存。
 *
 * 页面是经典脚本，卡片层另外要用到页面的几件事：元素构造 `el`、结论渲染 `renderAnalysis`、
 * 滚动到底 `scrollBottom`，以及轨迹视图（它创建在卡片层之后，所以交进来的是取用函数而不是
 * 快照）。它们由 app.js 在 createCards 时传入，卡片层不读全局。
 *
 * 对外只有这些入口：复合键 `key`、缓存 `put`／`get`／`drop`／`reset`，以及工具行与卡片的
 * 渲染函数；`updateSectionState`／`appendFieldList`／`renderSummaryCard` 仍是内部实现。
 */
import {esc} from './render-text.js';
import {GROUP_LABELS, GROUP_ORDER, IC, TOOL_LABELS} from './labels.js';

export function createCards(seam) {
  var el = seam.el;
  var renderAnalysis = seam.renderAnalysis;
  var scrollBottom = seam.scrollBottom;
  var trajectory = seam.trajectory;

  // 浏览器缓存使用“回答 + 工具调用”复合键，避免历史回合复用 callId 时串数据。
  var dataCards = {};

  function put(astObj, callId, payload) { dataCards[resultKey(astObj, callId)] = payload; }
  function get(astObj, callId) { return dataCards[resultKey(astObj, callId)]; }
  function drop(astObj, callId) { delete dataCards[resultKey(astObj, callId)]; }
  function reset() { dataCards = {}; }

  function resultKey(astObj, callId) {
    return astObj.resultId + ':' + callId;
  }

  // Tool 行独立于思考折叠，只表示查询生命周期。
  function setToolPhase(card, phase) {
    card.phase = phase;
    var iconCls = 'dsh-icon icon-api tool-icon', stCls = 'tool-status', stText = card.status.textContent;
    if (phase === 'calling') { iconCls += ' calling'; stCls += ' run'; stText = '调用中'; }
    else if (phase === 'ended' || phase === 'done') { stCls += ' ok'; stText = '已完成'; }
    else if (phase === 'empty') { stText = '无记录'; }
    else if (phase === 'error') { iconCls += ' error'; stCls += ' err'; stText = '调用失败'; }
    card.icon.className = iconCls;
    card.status.className = stCls;
    card.status.textContent = stText;
  }

  function addToolChip(strip, callId, name) {
    var chip = el('div', 'tool-chip');
    var icon = el('span', 'dsh-icon icon-api tool-icon calling'); icon.setAttribute('aria-hidden', 'true');
    var label = el('span', 'tool-label');
    label.textContent = TOOL_LABELS[name] || '业务查询';
    label.title = label.textContent;
    var chrono = el('span', 'tool-chrono');
    var st = el('span', 'tool-status run', '调用中');
    chip.appendChild(icon); chip.appendChild(label); chip.appendChild(chrono); chip.appendChild(st);
    strip.appendChild(chip);
    scrollBottom();
    return { chip: chip, icon: icon, chrono: chrono, status: st, callAt: 0, phase: 'calling' };
  }

  function finishCards(toolCards) {
    for (var k in toolCards) {
      var c = toolCards[k];
      if (c.phase === 'ended') setToolPhase(c, 'done');
    }
  }

  function ensureResultSection(astObj, group) {
    var key = GROUP_LABELS[group] ? group : 'other';
    if (astObj.sections[key]) return astObj.sections[key];
    astObj.results.hidden = false;
    var section = el('section', 'result-section ' + key);
    var heading = el('h3', 'result-section-title');
    heading.id = astObj.resultId + '-' + key;
    heading.textContent = GROUP_LABELS[key];
    section.setAttribute('aria-labelledby', heading.id);
    var body = el('div', 'result-section-body');
    section.appendChild(heading);
    section.appendChild(body);
    var rank = GROUP_ORDER.indexOf(key);
    var before = null;
    for (var existingKey in astObj.sections) {
      if (GROUP_ORDER.indexOf(existingKey) > rank) { before = astObj.sections[existingKey].section; break; }
    }
    astObj.results.insertBefore(section, before);
    astObj.sections[key] = { section: section, heading: heading, body: body };
    return astObj.sections[key];
  }

  function updateSectionState(astObj, group) {
    var section = astObj.sections[group];
    if (!section) return;
    var states = Object.values(astObj.payloads).filter(function (payload) { return (payload.group || 'other') === group; }).map(function (payload) { return payload.state; });
    section.heading.textContent = GROUP_LABELS[group] + (states.length > 0 && states.every(function (state) { return state === 'empty'; }) ? ' · 无记录' : '');
  }

  function appendFieldList(container, fields) {
    var list = el('dl', 'mc-fields');
    for (var fi = 0; fi < fields.length; fi++) {
      var f = fields[fi];
      var row = el('div', 'mc-row');
      var dt = document.createElement('dt'); dt.textContent = f.k;
      var dd = document.createElement('dd'); dd.className = f.tone ? 'tone-' + f.tone : ''; dd.textContent = f.v;
      row.appendChild(dt); row.appendChild(dd); list.appendChild(row);
    }
    container.appendChild(list);
  }

  function renderSummaryCard(card) {
    var article = el('article', 'summary-card');
    article.appendChild(el('h4', 'summary-title', esc(card.title)));
    var attributes = el('dl', 'summary-attributes');
    var metrics = el('dl', 'summary-metrics');
    for (var i = 0; i < card.fields.length; i++) {
      var field = card.fields[i];
      var metric = /次数|数量|总数|黑名单/.test(field.k);
      var row = el('div', metric ? 'summary-metric' : 'summary-attribute');
      var dt = document.createElement('dt'); dt.textContent = field.k;
      var dd = document.createElement('dd'); dd.className = field.tone ? 'tone-' + field.tone : ''; dd.textContent = field.v;
      row.appendChild(dt); row.appendChild(dd); (metric ? metrics : attributes).appendChild(row);
    }
    if (attributes.childElementCount) article.appendChild(attributes);
    if (metrics.childElementCount) article.appendChild(metrics);
    return article;
  }

  function renderCards(callId, astObj, refreshing) {
    var cacheKey = resultKey(astObj, callId);
    var p = dataCards[cacheKey];
    if (!p || !p.cards) return;
    if (p.state === 'data' || p.state === 'empty') {
      astObj.hasStructured = true;
      astObj.hasResult = true;
    }
    astObj.payloads[callId] = p;
    var overviewChanged = !astObj.hasOverview && p.group === 'overview' && p.state === 'data';
    if (overviewChanged) astObj.hasOverview = true;
    var parent = ensureResultSection(astObj, p.group || 'other').body;
    var block = astObj.sources[callId];
    if (!block) {
      block = el('div', 'cards-block result-source');
      parent.appendChild(block);
      astObj.sources[callId] = block;
    }
    block.innerHTML = '';
    var countText = p.state === 'loading' ? '查询中' : p.state === 'error' ? '查询失败' : ('共 ' + p.count + ' 条');
    var head = el('div', 'cards-head', IC.list + ' ' + esc(p.sourceLabel || TOOL_LABELS[p.tool] || '业务查询') + ' <span class="cards-count">' + countText + '</span>' + (p.note ? '<span class="cards-note">· ' + esc(p.note) + '</span>' : ''));
    block.appendChild(head);
    var grid = el('div', 'cards-grid');
    if (p.state === 'loading') grid.appendChild(el('div', 'cards-empty', '正在查询…'));
    else if (p.state === 'error') grid.appendChild(el('div', 'cards-empty', '本次查询失败，可稍后重试'));
    else if (p.state === 'empty') grid.appendChild(el('div', 'cards-empty', '本次查询未发现记录'));
    else if (p.state === 'data' && !p.cards.length) grid.appendChild(el('div', 'cards-empty', '已返回数据，暂无适合卡片展示的字段'));
    for (var i = 0; i < p.cards.length; i++) {
      var c = p.cards[i];
      if (p.variant === 'summary') { grid.appendChild(renderSummaryCard(c)); continue; }
      var mc = el('article', 'mini-card');
      var suppressVehicleTitle = astObj.hasOverview && p.group !== 'overview' && ['carNum', 'carNumb', 'vehicleNo'].indexOf(c.titleKey) >= 0;
      if (!suppressVehicleTitle) mc.appendChild(el('h4', 'mc-title', esc(c.title)));
      appendFieldList(mc, c.fields);
      grid.appendChild(mc);
    }
    block.appendChild(grid);
    updateSectionState(astObj, p.group || 'other');
    if (overviewChanged && !refreshing) {
      for (var otherCallId in astObj.payloads) if (otherCallId !== callId) renderCards(otherCallId, astObj, true);
    }
    renderAnalysis(astObj, false);
    scrollBottom();
  }

  function renderVehicleMedia(callId, items, astObj) {
    if (!items || !items.length) return;
    astObj.hasStructured = true;
    astObj.hasResult = true;
    astObj.states[callId] = 'data';
    if (astObj.sources[callId]) astObj.sources[callId].remove();
    drop(astObj, callId);
    var parent = ensureResultSection(astObj, 'track').body;
    var block = el('div', 'cards-block result-source');
    astObj.sources[callId] = block;
    block.appendChild(el('div', 'cards-head', IC.camera + ' 车辆抓拍视频 <span class="cards-count">共 ' + items.length + ' 段</span>'));
    var grid = el('div', 'cards-grid');
    for (var i = 0; i < items.length; i++) {
      var item = items[i];
      var card = el('article', 'mini-card');
      card.appendChild(el('h4', 'mc-title', '抓拍片段 ' + (i + 1)));
      appendFieldList(card, [
        { k: '开始时间', v: item.startTime || '--', tone: '' },
        { k: '时长', v: item.timeLength || '--', tone: '' },
      ]);
      var button = document.createElement('button'); button.type = 'button'; button.className = 'track-3d-btn'; button.textContent = '查看抓拍视频';
      button._item = item;
      button.onclick = function () {
        var selected = this._item;
        trajectory().showGroup({
          groupName: '车辆抓拍视频', captureMode: true,
          devices: [{ deviceType: 6, capture: true, hideAddress: true, name: selected.startTime || '抓拍片段', deviceId: selected.deviceId, startTime: selected.startTime, timeLength: selected.timeLength, videoAddress: selected.mediaUrl }],
        });
      };
      card.appendChild(button); grid.appendChild(card);
    }
    block.appendChild(grid); parent.appendChild(block);
    renderAnalysis(astObj, false); scrollBottom();
  }

  return {
    key: resultKey, put: put, get: get, drop: drop, reset: reset,
    setToolPhase: setToolPhase, addToolChip: addToolChip, finishCards: finishCards,
    ensureResultSection: ensureResultSection, renderCards: renderCards, renderVehicleMedia: renderVehicleMedia,
  };
}
