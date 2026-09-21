import {createConversationHistory} from './conversation-history.js';

import {esc, mdToHtml, stripMarkdownTables} from './render-text.js';
import {answerText, compactDuration, compactTokens, exactTokens, summaryDuration} from './format.js';

import { GROUP_LABELS, GROUP_ORDER, IC, TOOL_LABELS } from './labels.js';
import {createCards} from './cards.js';
import {createTrajectoryView} from './trajectory.js';
(function () {
  var APP_CONFIG = window.CLOSEDOFF_CONFIG;
  if (!APP_CONFIG || !APP_CONFIG.routePrefix || !APP_CONFIG.map) throw new Error('封闭化页面配置缺失');
  var routePath = function (path) { return APP_CONFIG.routePrefix + path; };
  var $ = function (s) { return document.querySelector(s); };
  var inner = $('#inner'), input = $('#input'), sendBtn = $('#sendBtn');
  var statusDot = $('#statusDot'), statusText = $('#statusText');
  var picker = globalThis.createModelPicker({mount:document.getElementById('model-picker'),iconBase:routePath('/assets/'),load:function(id){return businessFetch(routePath('/models')+(id?'?conversationId='+encodeURIComponent(id):'')).then(readJson);}});
  var conversationId = '';
  var storageKey = '';
  var identityKey = '';
  var identityReady = false;
  var sidebar;
  var identityEpoch = 0;
  var responseEpochs = new WeakMap();
  var running = false;
  var followBottom = true;
  var activeChatController = null;
  var activeRestoreController = null;
  var titleRefresh;

  function stopTitleRefresh() {
    if (titleRefresh) clearTimeout(titleRefresh.timer);
    titleRefresh = undefined;
  }
  function syncConversationUrl(id) {
    var url = new URL(window.location.href);
    if (id) url.searchParams.set('conversationId', id);
    else url.searchParams.delete('conversationId');
    window.history.replaceState(window.history.state, '', url);
  }
  function startTitleRefresh(id) {
    stopTitleRefresh();
    var pending = titleRefresh = { id: id, epoch: identityEpoch, until: Date.now() + 65000 };
    function tick() {
      if (titleRefresh !== pending) return;
      if (conversationId !== id || identityEpoch !== pending.epoch || !identityReady || Date.now() >= pending.until) { stopTitleRefresh(); return; }
      Promise.resolve(sidebar && sidebar.refresh()).finally(function () {
        if (titleRefresh === pending) pending.timer = setTimeout(tick, 2000);
      });
    }
    pending.timer = setTimeout(tick, 2000);
  }
  function acceptTitleList(data) {
    var current = titleRefresh && data.items.find(function (item) { return item.id === titleRefresh.id; });
    if (current && current.titleSource !== 'automatic') stopTitleRefresh();
    return data;
  }

  var trajectory;

  // 卡片层在 web/cards.js 里；这里把它要用的三件事和轨迹视图交给它。
  var cards = createCards({
    el: el,
    renderAnalysis: renderAnalysis,
    scrollBottom: scrollBottom,
    trajectory: function () { return trajectory; },
  });

  function setStatus(kind, text) {
    statusDot.className = 'dot' + (kind === 'thinking' ? ' thinking' : kind === 'off' ? ' off' : '');
    statusText.textContent = text;
  }

  function fmtTime(ms) {
    var d = new Date(ms);
    function p(n) { return (n < 10 ? '0' : '') + n; }
    return p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds());
  }

  function el(tag, cls, html) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (html !== undefined) e.innerHTML = html;
    return e;
  }

  trajectory = createTrajectoryView({
    mapConfig: APP_CONFIG.map,
    routePath: routePath,
    icons: IC,
    el: el,
    escapeHtml: esc,
    scrollBottom: scrollBottom,
  });

  function addUser(text) {
    var row = el('div', 'msg user');
    row.appendChild(el('div', 'avatar usr', IC.user));
    row.appendChild(el('div', 'bubble', esc(text)));
    inner.appendChild(row);
    scrollBottom();
  }

  function addAssistant() {
    var resultId = 'result-' + Date.now() + '-' + Math.random().toString(16).slice(2);
    var row = el('div', 'msg assistant');
    row.appendChild(el('div', 'avatar bot', '封'));
    var bubble = el('div', 'bubble');
    row.appendChild(bubble);

    var progressWrap = el('div', 'turn-process');
    var reasoning = document.createElement('details'); reasoning.className = 'reasoning-row'; reasoning.hidden = true;
    var reasoningSummary = document.createElement('summary');
    var thinkIcon = el('span', 'dsh-icon icon-think'); thinkIcon.setAttribute('aria-hidden', 'true');
    var reasoningTitle = el('span', 'reasoning-title', '思考');
    var reasoningSep = el('span', 'reasoning-sep'); reasoningSep.setAttribute('aria-hidden', 'true');
    var reasoningPreview = el('span', 'reasoning-preview', '正在生成…');
    reasoningSummary.appendChild(thinkIcon); reasoningSummary.appendChild(reasoningTitle); reasoningSummary.appendChild(reasoningSep); reasoningSummary.appendChild(reasoningPreview);
    var reasoningBody = el('div', 'reasoning-body');
    reasoning.appendChild(reasoningSummary); reasoning.appendChild(reasoningBody);
    var toolProgress = el('section', 'tool-progress'); toolProgress.hidden = true;
    var toolHead = el('div', 'tool-progress-head');
    var toolTitle = el('span', 'tool-progress-title', '工具调用');
    toolTitle.id = resultId + '-tools';
    toolProgress.setAttribute('aria-labelledby', toolTitle.id);
    var progressSummary = el('span', 'tool-progress-summary', '');
    toolHead.appendChild(toolTitle); toolHead.appendChild(progressSummary); toolProgress.appendChild(toolHead);
    var strip = el('div', 'tool-strip');
    toolProgress.appendChild(strip);
    var progressLive = el('span', 'sr-only');
    progressLive.setAttribute('role', 'status'); progressLive.setAttribute('aria-live', 'polite'); progressLive.setAttribute('aria-atomic', 'true');
    progressLive.textContent = '正在思考';
    progressWrap.appendChild(reasoning); progressWrap.appendChild(toolProgress); progressWrap.appendChild(progressLive); bubble.appendChild(progressWrap);

    var results = el('div', 'results-container');
    results.hidden = true;
    bubble.appendChild(results);

    var analysisHeading = el('h3', 'analysis-heading', '结论与建议');
    analysisHeading.hidden = true;
    bubble.appendChild(analysisHeading);

    var md = el('div', 'md');
    md.appendChild(el('span', 'cursor'));
    bubble.appendChild(md);
    var turnStatus = el('div', 'turn-status');
    turnStatus.setAttribute('role', 'status');
    turnStatus.setAttribute('aria-live', 'polite');
    turnStatus.hidden = true;
    bubble.appendChild(turnStatus);

    var actions = el('div', 'assistant-actions');
    actions.hidden = true;
    actions.setAttribute('aria-label', '回答操作');
    function actionButton(icon, label) {
      var button = el('button', 'answer-action');
      button.type = 'button';
      button.title = label;
      button.setAttribute('aria-label', label);
      button.appendChild(el('span', 'answer-icon ' + icon));
      actions.appendChild(button);
      return button;
    }
    function statButton(icon, label) {
      var wrap = el('span', 'answer-meta');
      var button = el('button', 'answer-stat');
      button.type = 'button';
      button.title = label;
      button.setAttribute('aria-label', label);
      button.setAttribute('aria-haspopup', 'dialog');
      button.setAttribute('aria-expanded', 'false');
      button.appendChild(el('span', 'answer-icon ' + icon));
      button.appendChild(el('span', 'answer-stat-label'));
      var popover = el('div', 'answer-popover');
      popover.setAttribute('role', 'dialog');
      popover.setAttribute('aria-label', label);
      popover.hidden = true;
      wrap.appendChild(button);
      wrap.appendChild(popover);
      actions.appendChild(wrap);
      return { wrap: wrap, button: button, label: button.querySelector('.answer-stat-label'), popover: popover };
    }
    var copyAction = actionButton('icon-copy', '复制回答');
    var likeAction = actionButton('icon-like', '好回答');
    var dislikeAction = actionButton('icon-dislike', '差回答');
    var branchAction = actionButton('icon-branch', '从这里创建新对话');
    var usageAction = statButton('icon-database', '查看本轮用量');
    var timeAction = statButton('icon-clock', '查看本轮用时');
    var completedAt = el('time', 'answer-clock');
    actions.appendChild(completedAt);
    var actionStatus = el('span', 'answer-action-status');
    actionStatus.setAttribute('role', 'status');
    actionStatus.setAttribute('aria-live', 'polite');
    actions.appendChild(actionStatus);
    bubble.appendChild(actions);
    bubble.setAttribute('aria-busy', 'true');
    inner.appendChild(row);
    scrollBottom();
    return {
      row: row, bubble: bubble, reasoning: reasoning, reasoningPreview: reasoningPreview, reasoningBody: reasoningBody,
      toolProgress: toolProgress, progressSummary: progressSummary, progressLive: progressLive, strip: strip,
      results: results, resultId: resultId,
      sections: {}, sources: {}, payloads: {}, states: {}, analysisHeading: analysisHeading, md: md, cursor: md.querySelector('.cursor'), turnStatus: turnStatus,
      actions: actions, copyAction: copyAction, likeAction: likeAction, dislikeAction: dislikeAction, branchAction: branchAction,
      usageAction: usageAction, timeAction: timeAction, completedAt: completedAt, actionStatus: actionStatus, turnMeta: null,
      accumulated: '', hasStructured: false, hasResult: false, hasOverview: false, terminalMessage: '', terminalTone: '',
    };
  }

  function closeAnswerPopovers(except) {
    document.querySelectorAll('.answer-popover:not([hidden])').forEach(function (popover) {
      if (popover === except) return;
      popover.hidden = true;
      var button = popover.parentElement && popover.parentElement.querySelector('.answer-stat');
      if (button) button.setAttribute('aria-expanded', 'false');
    });
  }

  function toggleAnswerPopover(action) {
    var willOpen = action.popover.hidden;
    closeAnswerPopovers(willOpen ? action.popover : null);
    action.popover.hidden = !willOpen;
    action.button.setAttribute('aria-expanded', String(willOpen));
    if (willOpen) {
      var margin = 16;
      var buttonRect = action.button.getBoundingClientRect();
      var width = Math.min(430, Math.max(0, window.innerWidth - margin * 2));
      action.popover.style.width = width + 'px';
      var popoverRect = action.popover.getBoundingClientRect();
      var left = Math.max(margin, Math.min(buttonRect.left, window.innerWidth - popoverRect.width - margin));
      var top = buttonRect.top - popoverRect.height - 8;
      if (top < margin) top = Math.min(window.innerHeight - popoverRect.height - margin, buttonRect.bottom + 8);
      action.popover.style.left = left + 'px';
      action.popover.style.top = Math.max(margin, top) + 'px';
    }
  }

  function actionDetails(popover, title, rows) {
    popover.innerHTML = '';
    popover.appendChild(el('div', 'answer-popover-title', esc(title)));
    var list = document.createElement('dl');
    rows.forEach(function (row) {
      list.appendChild(el('dt', '', esc(row[0])));
      list.appendChild(el('dd', '', esc(row[1])));
    });
    popover.appendChild(list);
  }

  function actionMessage(ast, text, error) {
    ast.actionStatus.textContent = text || '';
    ast.actionStatus.classList.toggle('error', Boolean(error));
    clearTimeout(ast.actionStatusTimer);
    if (text) ast.actionStatusTimer = setTimeout(function () {
      ast.actionStatus.textContent = '';
      ast.actionStatus.classList.remove('error');
    }, 2500);
  }

  function writeClipboard(text) {
    if (navigator.clipboard && navigator.clipboard.writeText) return navigator.clipboard.writeText(text);
    var area = document.createElement('textarea');
    area.value = text;
    area.style.position = 'fixed';
    area.style.opacity = '0';
    document.body.appendChild(area);
    area.select();
    var copied = document.execCommand('copy');
    area.remove();
    return copied ? Promise.resolve() : Promise.reject(new Error('复制失败'));
  }

  function postJson(path, payload) {
    return businessFetch(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    }).then(readJson);
  }

  function setFeedbackState(ast, rating) {
    ast.feedbackRating = rating || null;
    ast.likeAction.dataset.active = String(rating === 'positive');
    ast.dislikeAction.dataset.active = String(rating === 'negative');
    ast.likeAction.setAttribute('aria-pressed', String(rating === 'positive'));
    ast.dislikeAction.setAttribute('aria-pressed', String(rating === 'negative'));
  }

  function openConversation(id) {
    if (running || !identityReady) return;
    stopTitleRefresh();
    if (activeRestoreController) activeRestoreController.abort();
    activeRestoreController = null;
    conversationId = id;
    syncConversationUrl(conversationId);
    if (sidebar) sidebar.render();
    localStorage.setItem(storageKey, conversationId);
    followBottom = true;
    resetViewState();
    inner.innerHTML = '';
    restore();
  }

  function bindAnswerActions(ast) {
    if (ast.actionsBound) return;
    ast.actionsBound = true;
    ast.copyAction.addEventListener('click', function () {
      var text = answerText(ast);
      if (!text) return;
      writeClipboard(text).then(function () {
        var icon = ast.copyAction.querySelector('.answer-icon');
        icon.className = 'answer-icon icon-check';
        ast.copyAction.title = '已复制';
        ast.copyAction.setAttribute('aria-label', '已复制');
        setTimeout(function () {
          icon.className = 'answer-icon icon-copy';
          ast.copyAction.title = '复制回答';
          ast.copyAction.setAttribute('aria-label', '复制回答');
        }, 1000);
      }).catch(function (error) { actionMessage(ast, error.message || '复制失败', true); });
    });
    function feedback(rating) {
      if (!ast.turnMeta || !ast.turnMeta.messageId) return;
      ast.likeAction.disabled = true;
      ast.dislikeAction.disabled = true;
      postJson(routePath('/feedback'), {
        conversationId: conversationId,
        messageId: ast.turnMeta.messageId,
        rating: rating,
      }).then(function (result) {
        setFeedbackState(ast, result.rating);
      }).catch(function (error) {
        actionMessage(ast, error.message || '反馈失败', true);
      }).finally(function () {
        ast.likeAction.disabled = false;
        ast.dislikeAction.disabled = false;
      });
    }
    ast.likeAction.addEventListener('click', function () { feedback('positive'); });
    ast.dislikeAction.addEventListener('click', function () { feedback('negative'); });
    ast.branchAction.addEventListener('click', function () {
      if (running || !ast.turnMeta || typeof ast.turnMeta.branchSeq !== 'number') return;
      var epoch = identityEpoch;
      ast.branchAction.disabled = true;
      postJson(routePath('/branch'), { conversationId: conversationId, atSeq: ast.turnMeta.branchSeq })
        .then(function (result) { if (epoch === identityEpoch) openConversation(result.conversationId); })
        .catch(function (error) {
          ast.branchAction.disabled = false;
          actionMessage(ast, error.message || '创建分支失败', true);
        });
    });
    ast.usageAction.button.addEventListener('click', function (event) { event.stopPropagation(); toggleAnswerPopover(ast.usageAction); });
    ast.timeAction.button.addEventListener('click', function (event) { event.stopPropagation(); toggleAnswerPopover(ast.timeAction); });
    ast.usageAction.popover.addEventListener('click', function (event) { event.stopPropagation(); });
    ast.timeAction.popover.addEventListener('click', function (event) { event.stopPropagation(); });
  }

  function applyTurnMeta(ast, meta, rating, feedbackAvailable) {
    if (!meta) return;
    ast.turnMeta = meta;
    bindAnswerActions(ast);
    ast.actions.hidden = false;
    ast.copyAction.hidden = answerText(ast) === '';
    var hasMessage = typeof meta.messageId === 'string' && meta.messageId !== '';
    ast.likeAction.hidden = !hasMessage;
    ast.dislikeAction.hidden = !hasMessage;
    if (feedbackAvailable === false && hasMessage) {
      ast.likeAction.disabled = true;
      ast.dislikeAction.disabled = true;
      ast.likeAction.removeAttribute('aria-pressed');
      ast.dislikeAction.removeAttribute('aria-pressed');
      ast.likeAction.title = '评价状态暂时无法恢复';
      ast.dislikeAction.title = '评价状态暂时无法恢复';
      ast.likeAction.setAttribute('aria-label', '好回答，评价状态暂时无法恢复');
      ast.dislikeAction.setAttribute('aria-label', '差回答，评价状态暂时无法恢复');
      actionMessage(ast, '评价状态暂时无法恢复', true);
    } else {
      setFeedbackState(ast, rating);
    }
    ast.branchAction.hidden = typeof meta.branchSeq !== 'number';
    var usage = meta.usage;
    ast.usageAction.wrap.hidden = !usage;
    if (usage) {
      ast.usageAction.label.textContent = '用量 ' + compactTokens(usage.totalTokens);
      var usageRows = [
        ['未缓存输入', exactTokens(usage.inputTokens)],
        ['输出', exactTokens(usage.outputTokens)],
        ['总计', exactTokens(usage.totalTokens)],
      ];
      if (usage.cacheReadTokens !== undefined) usageRows.splice(1, 0, ['缓存读取', exactTokens(usage.cacheReadTokens)]);
      if (usage.cacheWriteTokens !== undefined) usageRows.splice(2, 0, ['缓存写入', exactTokens(usage.cacheWriteTokens)]);
      if (usage.reasoningTokens !== undefined) usageRows.push(['其中推理', exactTokens(usage.reasoningTokens)]);
      actionDetails(ast.usageAction.popover, '本轮用量', usageRows);
    }
    var hasRunTime = typeof meta.runMs === 'number';
    ast.timeAction.wrap.hidden = !hasRunTime;
    if (hasRunTime) {
      ast.timeAction.label.textContent = '用时 ' + summaryDuration(meta.runMs);
      var timeRows = [['总用时', compactDuration(meta.runMs)]];
      if (typeof meta.ttftMs === 'number') timeRows.push(['首字延迟', compactDuration(meta.ttftMs)]);
      actionDetails(ast.timeAction.popover, '本轮用时', timeRows);
    }
    var completed = Number(meta.completedAt);
    ast.completedAt.hidden = !Number.isFinite(completed);
    if (Number.isFinite(completed)) {
      var date = new Date(completed);
      ast.completedAt.dateTime = date.toISOString();
      ast.completedAt.textContent = fmtTime(completed).slice(0, 5);
      ast.completedAt.title = date.toLocaleString('zh-CN');
    }
  }

  function reasoningLine(text, done) {
    var lines = String(text || '').split(/\r?\n/).map(function (line) { return line.trim(); }).filter(function (line) { return line && line !== '正在生成…'; });
    if (!lines.length) return '正在生成…';
    return done ? lines[0] : lines[lines.length - 1];
  }

  function updateThinking(ast, text, done) {
    if (!text) return;
    var bodyNearBottom = ast.reasoningBody.scrollHeight - ast.reasoningBody.scrollTop - ast.reasoningBody.clientHeight <= 24;
    ast.reasoning.hidden = false;
    ast.reasoning.classList.toggle('running', !done);
    ast.reasoningPreview.textContent = reasoningLine(text, done);
    ast.reasoningBody.textContent = text;
    if (ast.reasoning.open && bodyNearBottom) ast.reasoningBody.scrollTop = ast.reasoningBody.scrollHeight;
    ast.progressLive.textContent = done ? '思考完成' : '正在思考';
  }

  function renderAnalysis(ast, streaming) {
    var text = ast.hasStructured ? stripMarkdownTables(ast.accumulated) : ast.accumulated;
    ast.analysisHeading.hidden = text.trim() === '';
    ast.md.hidden = text.trim() === '' && !streaming;
    ast.md.innerHTML = mdToHtml(text) + (streaming ? '<span class="cursor"></span>' : '');
    ast.md.dataset.tablesRemoved = String(ast.hasStructured && text !== ast.accumulated);
    ast.turnStatus.hidden = ast.terminalMessage === '';
    ast.turnStatus.textContent = ast.terminalMessage;
    ast.turnStatus.classList.toggle('error', ast.terminalTone === 'error');
    ast.turnStatus.setAttribute('role', ast.terminalTone === 'error' ? 'alert' : 'status');
    ast.turnStatus.setAttribute('aria-live', ast.terminalTone === 'error' ? 'assertive' : 'polite');
  }

  function finishReasonMessage(reason, hasResult) {
    if (!reason || reason === 'completed') return '';
    var messages = {
      aborted: '本轮回答已停止，内容可能不完整。',
      interrupted: '本轮回答因运行中断而未完成。',
      'max-tokens': '本轮回答达到输出上限，内容可能不完整。',
      blocked: '本轮请求被阻止，尚未执行或继续。',
      error: '本轮回答发生错误，未能完整结束。',
    };
    var message = messages[reason] || '本轮回答未正常完成。';
    return message + (hasResult ? ' 上方查询结果已保留，可发送“继续分析”生成或补全结论。' : ' 请重试或补充条件后再次查询。');
  }

  function applyFinishReason(ast, reason) {
    if (reason === 'error' && ast.terminalTone === 'error' && ast.terminalMessage !== '') return;
    var message = finishReasonMessage(reason, ast.hasResult);
    if (!message) return;
    ast.terminalMessage = message;
    ast.terminalTone = reason === 'error' ? 'error' : 'warning';
  }

  function updateProgress(ast, toolCards, done) {
    var count = 0, failed = 0, runningCount = 0, withData = 0, empty = 0;
    for (var key in toolCards) {
      count++;
      if (toolCards[key].phase === 'error') failed++;
      if (toolCards[key].phase === 'calling') runningCount++;
      var state = ast.states[key] || (ast.payloads[key] && ast.payloads[key].state);
      if (state === 'data') withData++;
      else if (state === 'empty') empty++;
    }
    var text = '';
    if (done) {
      text = count === 0 ? '未调用业务查询' : ('已完成 ' + count + ' 项查询：有数据 ' + withData + '、无记录 ' + empty + '、失败 ' + failed);
      ast.bubble.setAttribute('aria-busy', 'false');
    } else if (runningCount > 0) text = '正在查询 ' + runningCount + ' 个数据源';
    else if (count > 0) text = '正在汇总结论';
    ast.toolProgress.hidden = count === 0;
    if (text) ast.progressSummary.textContent = text;
  }

  function renderError(ast, message) {
    ast.terminalMessage = '请求失败：' + message;
    ast.terminalTone = 'error';
    renderAnalysis(ast, false);
  }

  function isNearBottom(m) {
    return m.scrollHeight - m.scrollTop - m.clientHeight <= 24;
  }

  function scrollBottom() {
    if (!followBottom) return;
    var m = $('#messages');
    m.scrollTop = m.scrollHeight;
  }

  function startAssistant() {
    return addAssistant();
  }

  function send(text) {
    if (running || !identityReady) return;
    var epoch = identityEpoch, freshConversation = !conversationId;
    var q = String(text || input.value).trim();
    if (!q) return;
    var admitted=false,modelPayload;try{modelPayload=picker.payload();}catch(error){setStatus('off',error.message);return;}
    input.value = ''; autoGrow();
    followBottom = true;
    addUser(q);
    var ast = startAssistant();
    running = true; picker.setBusy(true); if (sidebar) sidebar.setBusy(true);
    sendBtn.disabled = false;
    sendBtn.classList.add('stop'); sendBtn.innerHTML = IC.stop;
    sendBtn.title = '停止回答';
    sendBtn.setAttribute('aria-label', '停止回答');
    setStatus('thinking', '智能体回答中…');

    var toolCards = {};
    var controller = new AbortController();
    activeChatController = controller;
    var renderQueued = false;
    function scheduleRender(astObj) {
      if (renderQueued) return;
      renderQueued = true;
      requestAnimationFrame(function () {
        renderQueued = false;
        if (epoch !== identityEpoch || controller.signal.aborted) return;
        renderAnalysis(astObj, true);
        scrollBottom();
      });
    }

    businessFetch(routePath('/chat'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(Object.assign({ conversationId: conversationId, message: q },modelPayload)),
      signal: controller.signal,
    }).then(function (resp) {
      if (epoch !== identityEpoch) throw new Error('登录状态已变化');
      if (!resp.ok) {
        return readJson(resp).then(function (j) {
          throw new Error(j && j.error || ('请求失败 HTTP ' + resp.status));
        });
      }
      if (resp.headers.get('content-type') && resp.headers.get('content-type').indexOf('json') >= 0) {
        return readJson(resp).then(function (j) { throw new Error(j && j.error || '未知错误'); });
      }
      return stream(resp, ast);
    }).catch(function (e) {
      if (epoch !== identityEpoch) return;
      if (controller.signal.aborted) {
        applyFinishReason(ast, 'aborted');
        renderAnalysis(ast, false);
      } else {
        if(!admitted&&!input.value){input.value=q;autoGrow();}
        renderError(ast, e.message || String(e));
      }
      finishRunning(ast);
    });

    function finishRunning(astObj) {
      if (epoch !== identityEpoch) return;
      running = false; picker.setBusy(false); if (sidebar) { sidebar.setBusy(false); void sidebar.refresh(); }
      if (activeChatController === controller) activeChatController = null;
      sendBtn.disabled = false;
      sendBtn.classList.remove('stop'); sendBtn.innerHTML = IC.send;
      sendBtn.title = '发送';
      sendBtn.setAttribute('aria-label', '发送');
      setStatus('ok', '智能体就绪');
      cards.finishCards(toolCards);
      updateProgress(astObj, toolCards, true);
      scrollBottom();
    }

    async function stream(resp, astObj) {
      var reader = resp.body.getReader();
      var decoder = new TextDecoder();
      var buf = '';
      try {
        while (true) {
          var step = await reader.read();
          if (epoch !== identityEpoch || controller.signal.aborted) { await reader.cancel(); break; }
          if (step.done) break;
          buf += decoder.decode(step.value, { stream: true });
          var idx;
          while ((idx = buf.indexOf('\n\n')) >= 0) {
            var chunkText = buf.slice(0, idx); buf = buf.slice(idx + 2);
            var lines = chunkText.split('\n');
            for (var li = 0; li < lines.length; li++) {
              var line = lines[li];
              if (line.indexOf('data: ') !== 0) continue;
              var obj;
              try { obj = JSON.parse(line.slice(6)); } catch (e) { continue; }
              handleEvent(obj, astObj);
            }
          }
        }
        finishRunning(astObj);
      } catch (e) {
        if (epoch !== identityEpoch) return;
        if (controller.signal.aborted) {
          applyFinishReason(astObj, 'aborted');
          renderAnalysis(astObj, false);
        } else renderError(astObj, '连接中断：' + (e.message || String(e)));
        finishRunning(astObj);
      }
    }

    function handleEvent(obj, astObj) {
      if (epoch !== identityEpoch || controller.signal.aborted) return;
      switch (obj.type) {
        case 'conversation':
          admitted=true;
          picker.accept(obj.model);
          conversationId = obj.conversationId;
          syncConversationUrl(conversationId);
          if (freshConversation) startTitleRefresh(conversationId);
          if (sidebar) void sidebar.refresh();
          localStorage.setItem(storageKey, conversationId);
          break;
        case 'delta':
          updateProgress(astObj, toolCards, false);
          astObj.accumulated += obj.text;
          scheduleRender(astObj);
          break;
        case 'thinking_snapshot':
          updateThinking(astObj, obj.text || '', Boolean(obj.done));
          break;
        case 'tool_start': {
          // 新查询开始前，把之前已返回的查询标记为完成。
          for (var k in toolCards) {
            var c = toolCards[k];
            if (c.phase === 'ended' || c.phase === 'analyzing') cards.setToolPhase(c, 'done');
          }
          var card = cards.addToolChip(astObj.strip, obj.callId, obj.name);
          card.callAt = Date.now();
          card.chrono.textContent = '调用 ' + fmtTime(card.callAt);
          toolCards[obj.callId] = card;
          astObj.states[obj.callId] = 'loading';
          if (obj.presentation && obj.name !== 'closedoff_device_page') {
            cards.put(astObj, obj.callId, Object.assign({ state: 'loading', count: 0, shown: 0, note: '', cards: [] }, obj.presentation));
            cards.renderCards(obj.callId, astObj);
          }
          updateProgress(astObj, toolCards, false);
          break;
        }
        case 'tool_end': {
          var c = toolCards[obj.callId];
          if (c) {
            var durMs = Date.now() - c.callAt;
            c.chrono.textContent = '· ' + (durMs / 1000).toFixed(1) + 's';
            cards.setToolPhase(c, obj.status === 'error' ? 'error' : 'ended');
          }
          astObj.states[obj.callId] = obj.status === 'error' ? 'error' : 'data';
          var payload = cards.get(astObj, obj.callId);
          if (obj.status === 'error' && payload) {
            payload.state = 'error';
            cards.renderCards(obj.callId, astObj);
          }
          updateProgress(astObj, toolCards, false);
          break;
        }
        case 'fences':
          trajectory.renderFences(cards.key(astObj, obj.callId), obj.callId, obj.payload, cards.ensureResultSection(astObj, 'infrastructure').body);
          astObj.hasStructured = true;
          astObj.hasResult = true;
          renderAnalysis(astObj, true);
          break;
        case 'track':
          var trackKey = cards.key(astObj, obj.callId);
          trajectory.setTrack(trackKey, obj.points, obj.vehicleNo);
          astObj.hasStructured = true;
          astObj.hasResult = true;
          astObj.states[obj.callId] = 'data';
          if (astObj.sources[obj.callId]) {
            astObj.sources[obj.callId].remove();
            delete astObj.sources[obj.callId];
            cards.drop(astObj, obj.callId);
          }
          trajectory.render(trackKey, obj.callId, cards.ensureResultSection(astObj, 'track').body);
          renderAnalysis(astObj, true);
          break;
        case 'media':
          cards.renderVehicleMedia(obj.callId, obj.items, astObj);
          updateProgress(astObj, toolCards, false);
          break;
        case 'cameras':
          var cameraKey = cards.key(astObj, obj.callId);
          trajectory.setCameras(cameraKey, obj.cameras);
          break;
        case 'cards':
          cards.put(astObj, obj.callId, obj.payload);
          astObj.states[obj.callId] = obj.payload.state;
          if (toolCards[obj.callId]) cards.setToolPhase(toolCards[obj.callId], obj.payload.state === 'empty' ? 'empty' : 'done');
          cards.renderCards(obj.callId, astObj);
          updateProgress(astObj, toolCards, false);
          break;
        case 'done':
          cards.finishCards(toolCards);
          renderQueued = false;
          applyFinishReason(astObj, obj.reason);
          renderAnalysis(astObj, false);
          updateProgress(astObj, toolCards, true);
          applyTurnMeta(astObj, obj.meta, null, true);
          break;
        case 'error':
          cards.finishCards(toolCards);
          renderQueued = false;
          renderError(astObj, obj.message || '发生错误');
          updateProgress(astObj, toolCards, true);
          break;
      }
    }
  }

  function autoGrow() {
    input.style.height = 'auto';
    input.style.height = Math.min(input.scrollHeight, 140) + 'px';
  }

  function welcome() {
    inner.appendChild(el('div', 'welcome',
      '<h2>您好，我是<em>封闭化管理助手</em></h2>' +
      '<p>我可以自动调用园区业务接口，为您查询并分析：<br>预约审批、车辆轨迹与实时定位、路网停车、预警报警、出入记录、黑白名单等。</p>' +
      '<div class="caps">' +
      '<span class="cap">' + IC.calendar + ' 预约审批</span><span class="cap">' + IC.track + ' 人车物定位追踪</span>' +
      '<span class="cap">' + IC.route + ' 园区路网</span><span class="cap">' + IC.bell + ' 预警报警</span>' +
      '<span class="cap">' + IC.park + ' 停车区</span><span class="cap">' + IC.chart + ' 园区概览</span>' +
      '</div>'));
  }

  function restore() {
    void picker.refresh(conversationId);
    if (!conversationId) { welcome(); return; }
    var controller = new AbortController();
    activeRestoreController = controller;
    businessFetch(routePath('/history?conversationId=') + encodeURIComponent(conversationId), { signal: controller.signal })
      .then(readJson)
      .then(function (j) {
        if (controller.signal.aborted) return;
        var items = j.history || [];
        var feedbackByMessage = {};
        (j.feedback || []).forEach(function (item) { feedbackByMessage[item.messageId] = item.rating; });
        if (!items.length) { welcome(); return; }
        items.forEach(function (m) {
          if (m.role === 'user') { addUser(m.text); return; }
          var ast = startAssistant();
          ast.accumulated = m.text || '';
          if (m.thinking) updateThinking(ast, m.thinking, Boolean(m.thinkingDone));
          var restoredTools = {};
          (m.tools || []).forEach(function (t) {
            var cardObj = cards.addToolChip(ast.strip, t.callId, t.name);
            restoredTools[t.callId] = cardObj;
            cardObj.callAt = t.time || Date.now();
            if (t.durMs) cardObj.chrono.textContent = '· ' + (t.durMs / 1000).toFixed(1) + 's';
            cards.setToolPhase(cardObj, t.status === 'error' ? 'error' : 'done');
            ast.states[t.callId] = t.status === 'error' ? 'error' : 'data';
            if (t.status === 'error' && t.presentation && t.name !== 'closedoff_device_page') {
              cards.put(ast, t.callId, Object.assign({ state: 'error', count: 0, shown: 0, note: '', cards: [] }, t.presentation));
              cards.renderCards(t.callId, ast);
            }
            var tr = m.tracks && m.tracks[t.callId];
            if (tr && tr.points && tr.points.length) {
              var restoredTrackKey = cards.key(ast, t.callId);
              trajectory.setTrack(restoredTrackKey, tr.points, tr.vehicleNo);
              if (tr.groups) trajectory.setCameras(restoredTrackKey, tr.groups);
              else if (tr.cameras) trajectory.setCameras(restoredTrackKey, tr.cameras);
              ast.hasStructured = true;
              ast.hasResult = true;
              trajectory.render(restoredTrackKey, t.callId, cards.ensureResultSection(ast, 'track').body);
            }
          });
          for (var cid in m.cards) {
            if (m.cards[cid]) {
              cards.put(ast, cid, m.cards[cid]); ast.states[cid] = m.cards[cid].state;
              if (restoredTools[cid]) cards.setToolPhase(restoredTools[cid], m.cards[cid].state === 'empty' ? 'empty' : 'done');
              cards.renderCards(cid, ast);
            }
           }
           for (var fid in (m.fences || {})) {
             trajectory.renderFences(cards.key(ast, fid), fid, m.fences[fid], cards.ensureResultSection(ast, 'infrastructure').body);
             ast.hasStructured = true;
             ast.hasResult = true;
           }
           for (var mid in (m.media || {})) cards.renderVehicleMedia(mid, m.media[mid], ast);
           applyFinishReason(ast, m.finishReason);
           renderAnalysis(ast, false);
           updateProgress(ast, restoredTools, true);
           if (m.finishReason === 'completed') {
             applyTurnMeta(ast, m, m.messageId ? (feedbackByMessage[m.messageId] || null) : null, !j.feedbackUnavailable);
           }
        });
        scrollBottom();
      })
      .catch(function (error) { if (!controller.signal.aborted) { setStatus('off', error.message); welcome(); } })
      .finally(function () { if (activeRestoreController === controller) activeRestoreController = null; });
  }

  sendBtn.addEventListener('click', function () {
    if (running) {
      sendBtn.disabled = true;
      if (activeChatController) activeChatController.abort();
      if (conversationId) {
        businessFetch(routePath('/stop'), {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ conversationId: conversationId }),
        }).catch(function () {}).finally(function () { if (running) sendBtn.disabled = false; });
      }
      return;
    }
    send();
  });
  $('#messages').addEventListener('scroll', function () {
    followBottom = isNearBottom(this);
  });
  input.addEventListener('keydown', function (e) {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); }
  });
  input.addEventListener('input', autoGrow);
  document.addEventListener('click', function () { closeAnswerPopovers(); });
  document.addEventListener('keydown', function (event) {
    if (event.key === 'Escape') closeAnswerPopovers();
  });
  window.addEventListener('resize', function () { closeAnswerPopovers(); });
  document.addEventListener('scroll', function () { closeAnswerPopovers(); }, true);
  function resetViewState() {
    trajectory.reset();
    cards.reset();
  }

  window.addEventListener('pagehide', function () {
    stopTitleRefresh();
    trajectory.dispose();
  });

  function startFreshConversation() {
    if (running || !identityReady) return;
    stopTitleRefresh();
    if (activeRestoreController) activeRestoreController.abort();
    activeRestoreController = null;
    conversationId = '';
    syncConversationUrl(conversationId);
    if (sidebar) sidebar.render();
    void picker.refresh();
    followBottom = true;
    if (storageKey) localStorage.removeItem(storageKey);
    resetViewState();
    inner.innerHTML = '';
    welcome();
  }

  $('#newBtn').addEventListener('click', function () {
    if (running) return;
    startFreshConversation();
  });
  $('#clearBtn').addEventListener('click', function () {
    if (running) return;
    startFreshConversation();
  });
  document.querySelectorAll('.q-item').forEach(function (b) {
    b.addEventListener('click', function () {
      input.value = b.getAttribute('data-q');
      autoGrow();
      send();
    });
  });

  function clearPrivateView() {
    stopTitleRefresh();
    identityEpoch += 1;
    identityReady = false;
    if (activeChatController) activeChatController.abort();
    if (activeRestoreController) activeRestoreController.abort();
    if (storageKey) localStorage.removeItem(storageKey);
    conversationId = '';
    resetViewState();
    inner.innerHTML = '';
    if (sidebar) { sidebar.dispose(); sidebar = null; }
  }

  function readJson(response) {
    var epoch = responseEpochs.has(response) ? responseEpochs.get(response) : identityEpoch;
    return response.json().catch(function () { return {}; }).then(function (data) {
      if (epoch !== identityEpoch) throw new Error('登录状态已变化');
      if (!response.ok) throw new Error(data.error || ('请求失败 HTTP ' + response.status));
      return data;
    });
  }

  function rejectAccess(response) {
    if ([401, 403, 503].indexOf(response.status) < 0) return response;
    clearPrivateView();
    if (response.status === 401) window.location.replace('/auth?returnTo=' + encodeURIComponent(APP_CONFIG.routePrefix));
    setStatus('off', response.status === 503 ? '认证服务暂不可用' : '当前账号没有访问权限');
    return response;
  }

  function checkIdentity() {
    var epoch = identityEpoch;
    return fetch(routePath('/identity'), { cache: 'no-store' }).then(rejectAccess).then(readJson).then(function (identity) {
      if (epoch !== identityEpoch) throw new Error('登录状态已变化');
      if (identityKey && identity.key !== identityKey) {
        clearPrivateView();
        window.location.replace(APP_CONFIG.routePrefix);
        throw new Error('登录账号已变化');
      }
      return identity;
    });
  }

  function businessFetch(path, options) {
    var epoch = identityEpoch;
    return checkIdentity().then(function () { return fetch(path, options); }).then(function (response) {
      if (epoch !== identityEpoch) throw new Error('登录状态已变化，请重新打开页面');
      responseEpochs.set(response, epoch);
      return rejectAccess(response);
    });
  }

  function initHistory() {
    sidebar = createConversationHistory({
      mount: $('.main'), toggle: $('#historyBtn'), currentId: function () { return conversationId; },
      newConversation: startFreshConversation, openConversation: openConversation,
      list: function (args) { return businessFetch(routePath('/conversations?offset=') + args.offset + '&q=' + encodeURIComponent(args.query)).then(readJson).then(acceptTitleList); },
      mutate: function (args) { return postJson(routePath('/conversation-action'), args).then(function (result) { if (args.operation === 'rename' && args.ids.indexOf(conversationId) >= 0) stopTitleRefresh(); return result; }); },
      read: function (id) { return businessFetch(routePath('/history?conversationId=') + encodeURIComponent(id)).then(readJson).then(function (data) { return { messages: data.history }; }); },
      onDeleted: function (ids) { if (ids.indexOf(conversationId) >= 0) startFreshConversation(); },
      storageKey: 'closedoff-history:' + identityKey,
    });
    void sidebar.refresh();
  }
  $('#logoutBtn').addEventListener('click', function () {
    $('#logoutBtn').disabled = true;
    fetch('/auth/api/session', { cache: 'no-store' }).then(readJson).then(function (session) {
      return fetch('/auth/api/logout', { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-dsh-csrf': session.csrf }, body: '{}' });
    }).then(readJson).then(function () {
      localStorage.setItem('dsh_auth_changed', String(Date.now()));
      clearPrivateView(); window.location.replace('/auth');
    }).catch(function (error) { setStatus('off', error.message); }).finally(function () { $('#logoutBtn').disabled = false; });
  });
  window.addEventListener('focus', function () { if (identityReady) checkIdentity().catch(function () {}); });
  window.addEventListener('storage', function (event) {
    if (event.key === 'dsh_auth_changed' && identityReady) { clearPrivateView(); window.location.reload(); }
  });
  window.addEventListener('pageshow', function (event) { if (event.persisted) window.location.reload(); });
  setStatus('thinking', '正在验证访问权限…');
  checkIdentity().then(function (identity) {
    identityKey = identity.key;
    storageKey = 'dsh_closedoff_conversationId:' + identity.key;
    localStorage.removeItem('dsh_closedoff_conversationId');
    var linkedConversation = new URLSearchParams(window.location.search).get('conversationId') || '';
    conversationId = /^closedoff-web-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(linkedConversation)
      ? linkedConversation : localStorage.getItem(storageKey) || '';
    identityReady = true;
    initHistory();
    $('#currentUser').textContent = identity.label;
    $('#accountLink').hidden = $('#logoutBtn').hidden = identity.mode !== 'authenticated';
    if (identity.mode === 'authenticated') fetch('/auth/api/session', { cache: 'no-store' }).then(readJson).then(function (session) {
      $('#currentUser').textContent = session.user.username;
    }).catch(function () {});
    setStatus('ok', '智能体就绪'); restore();
  }).catch(function (error) { setStatus('off', error.message); });
})();
