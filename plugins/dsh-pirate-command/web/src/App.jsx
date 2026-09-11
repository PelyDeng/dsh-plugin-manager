import React, { useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowSquareOut, CaretLeft, CaretRight, Eye,
  PaperPlaneTilt, Plus, SpeakerHigh, SpeakerSlash, Stop, X,
} from "@phosphor-icons/react";
import { createPirateGame } from "./pirate-game.js";
import { isRunning, STATE_LABELS, useMission } from "./use-mission.js";
import { renderMarkdown } from './markdown.js';
import { readApiResponse } from './mission-request.js';
import { getCompassState } from './compass-state.js';
import { CompassArtwork } from './CompassArtwork.jsx';

const CREW = [
  { id: "jack", name: "杰克船长", job: "协调" },
  { id: "barbossa", name: "巴博萨", job: "封闭化" },
  { id: "elizabeth", name: "伊丽莎白", job: "博客" },
];
const NAMES = Object.fromEntries(CREW.map(({ id, name }) => [id, name]));
const ACTOR_FOR_CREW = { closedoff: 'barbossa', blog: 'elizabeth' };
const CREW_FOR_ACTOR = { barbossa: 'closedoff', elizabeth: 'blog', jack: 'jack' };

function modelLabel(catalog, selection) {
  if (!selection) return '未设置';
  const group = catalog?.groups.find(item => item.id === selection.provider);
  return group?.models.find(item => item.id === selection.model)?.name || selection.model;
}

export function App() {
  const hostRef = useRef(null);
  const gameRef = useRef(null);
  const actorRefs = useRef({});
  const bubbleRefs = useRef({});
  const panelRef = useRef(null);
  const panelOpenRef = useRef(false);
  const inputRef = useRef(null);
  const logRef = useRef(null);
  const followLogRef = useRef(true);
  const locateFrameRef = useRef(null);
  const currentMissionRef = useRef('');
  const reducedMotionRef = useRef(false);
  const modelRequestRef = useRef(0);
  const modelReadScopeRef = useRef(null);
  const viewSelectionRef = useRef(0);
  const mission = useMission();
  const accessEpochRef = useRef(mission.accessEpoch);
  accessEpochRef.current = mission.accessEpoch;
  const [snapshot, setSnapshot] = useState({
    phase: "idle", label: "准备场景", elapsed: 0, ready: false,
    error: null, runActive: false, roles: {},
  });
  const [selected, setSelected] = useState("jack");
  const [panelOpen, setPanelOpen] = useState(false);
  const [shortInputOpen, setShortInputOpen] = useState(false);
  const [drafts, setDrafts] = useState({ jack: "", barbossa: "", elizabeth: "" });
  const [muted, setMuted] = useState(true);
  const [audioError, setAudioError] = useState(false);
  const [reducedMotion, setReducedMotion] = useState(() => window.matchMedia("(prefers-reduced-motion: reduce)").matches);
  const [modelCatalog, setModelCatalog] = useState({ id: null, data: null, loading: true, error: '' });
  const [modelDraft, setModelDraft] = useState({ id: null, value: '' });
  const [modelReload, setModelReload] = useState(0);
  const [roundStart, setRoundStart] = useState(null);
  useEffect(() => { setRoundStart(null); }, [mission.accessEpoch]);
  const currentRoundStart = roundStart?.id === mission.id ? roundStart : null;
  const compass = useMemo(() => getCompassState(mission.mission, mission.events, {
    afterSeq: currentRoundStart?.afterSeq ?? 0,
    loading: mission.loading,
  }), [mission.mission, mission.events, mission.loading, currentRoundStart]);
  const running = isRunning(mission.mission);
  const stopping = mission.mission?.state === 'stopping';
  const unavailable = selected !== 'jack' && !mission.crew.some(c => c.id === CREW_FOR_ACTOR[selected] && c.available);
  panelOpenRef.current = panelOpen;
  currentMissionRef.current = mission.id;
  reducedMotionRef.current = reducedMotion;
  const catalog = modelCatalog.id === mission.id ? modelCatalog.data : null;
  const modelsLoading = modelCatalog.id !== mission.id || modelCatalog.loading;
  const modelValue = modelDraft.id === mission.id ? modelDraft.value : '';
  const modelOptions = (catalog?.groups || []).flatMap(group => group.models.map(model => ({
    value: JSON.stringify([group.id, model.id]), selection: { provider: group.id, model: model.id },
  })));
  const invalidModelDraft = modelValue !== '' && modelValue !== 'auth-default' && !modelOptions.some(model => model.value === modelValue);
  const modelSendBlocked = selected === 'jack' && !running && (modelsLoading || !catalog || !modelOptions.length || invalidModelDraft);
  const modelRecoveryHint = selected === 'jack' && mission.retryNeedsModelCatalog && !catalog
    ? '请先刷新船长模型目录，再按原内容重试，无需重新选择模型；刷新不会重新提交指令。' : '';

  useEffect(() => {
    const id = mission.id;
    const sequence = ++modelRequestRef.current;
    const accessVersion = mission.accessEpoch;
    const selectionVersion = mission.selectionEpoch;
    const previous = modelReadScopeRef.current;
    // 清理受保护数据会触发本 effect；拒权后只允许新选择、显式重试或任务读取恢复。
    if (mission.accessDenied && previous?.id === id && previous.selectionEpoch === selectionVersion && previous.reload === modelReload) {
      setModelCatalog({ id, data: null, loading: false, error: mission.error || '当前协作暂时不可访问，请重新登录或刷新页面。' });
      return;
    }
    modelReadScopeRef.current = { id, selectionEpoch: selectionVersion, reload: modelReload };
    const controller = new AbortController();
    setModelCatalog({ id, data: null, loading: true, error: '' });
    async function loadModels() {
      try {
        const response = await fetch(new URL('models' + (id ? '?missionId=' + encodeURIComponent(id) : ''), document.baseURI), {
          credentials: 'same-origin', cache: 'no-store', signal: AbortSignal.any([controller.signal, AbortSignal.timeout(15000)]),
        });
        const data = await readApiResponse(response);
        if (!Array.isArray(data.groups) || !Array.isArray(data.failures)
          || data.failures.some(group => !group || typeof group.id !== 'string' || typeof group.name !== 'string') || data.groups.some(group =>
          typeof group.id !== 'string' || typeof group.name !== 'string' || !Array.isArray(group.models)
          || group.models.some(model => typeof model.id !== 'string' || typeof model.name !== 'string'))) {
          throw new Error('模型目录响应无法读取，请重试。');
        }
        if (!controller.signal.aborted && sequence === modelRequestRef.current && accessVersion === accessEpochRef.current) setModelCatalog({ id, data, loading: false, error: '' });
      } catch (error) {
        if (!controller.signal.aborted && sequence === modelRequestRef.current && accessVersion === accessEpochRef.current) {
          mission.rejectAccess(error, { id, selectionEpoch: selectionVersion, accessEpoch: accessVersion });
          setModelCatalog({ id, data: null, loading: false, error: error.message || '模型目录暂时无法读取。' });
        }
      }
    }
    void loadModels();
    return () => controller.abort();
  }, [mission.id, mission.mission?.state, mission.accessEpoch, mission.selectionEpoch, mission.accessDenied, mission.rejectAccess, modelReload]);

  useEffect(() => { setModelDraft({ id: mission.id, value: '' }); }, [mission.id]);

  function selectMission(id) {
    viewSelectionRef.current++;
    setRoundStart(null);
    setModelDraft({ id, value: '' });
    setModelReload(value => value + 1);
    mission.select(id);
  }

  function openRole(id) {
    if (!NAMES[id]) return;
    setSelected(id);
    setPanelOpen(true);
    setShortInputOpen(false);
    followLogRef.current = false;
    if (locateFrameRef.current !== null) cancelAnimationFrame(locateFrameRef.current);
    const openedMission = currentMissionRef.current;
    locateFrameRef.current = requestAnimationFrame(() => {
      locateFrameRef.current = null;
      const log = logRef.current;
      if (!log || openedMission !== currentMissionRef.current) return;
      const role = CREW_FOR_ACTOR[id];
      const messages = log.querySelectorAll(`[data-message-role="${role}"][data-message-type="message"]`);
      const entries = messages.length ? messages : log.querySelectorAll(`[data-message-role="${role}"]`);
      const latest = entries[entries.length - 1];
      if (!latest) return;
      const top = latest.getBoundingClientRect().top - log.getBoundingClientRect().top + log.scrollTop;
      log.scrollTo({ top: Math.max(0, top - 8), behavior: reducedMotionRef.current ? 'auto' : 'smooth' });
    });
  }

  useEffect(() => {
    let active = true;
    const host = hostRef.current;
    const api = createPirateGame(host, {
      onState(next) {
        if (active) setSnapshot((previous) => ({
          ...previous, ...next,
          roles: { ...previous.roles, ...next.roles },
        }));
      },
      onSelect(id) {
        if (active) openRole(id);
      },
      onFrame(actors) {
        if (!active) return;
        const available = new Set();
        let shownBubbles = 0;
        const placed = [];
        const bubbleWidth = Math.min(208, Math.max(160, host.clientWidth * 0.27));
        const rightEdge = host.clientWidth - (
          panelOpenRef.current ? (panelRef.current?.offsetWidth ?? 0) + 36 : 12
        );
        for (const actor of actors) {
          const button = actorRefs.current[actor.id];
          const bubble = bubbleRefs.current[actor.id];
          if (!button || !bubble) continue;
          available.add(actor.id);
          const width = Math.max(40, actor.width);
          const height = Math.max(48, actor.height);
          button.hidden = false;
          button.style.width = width + "px";
          button.style.height = height + "px";
          button.style.transform = "translate3d(" + (actor.x - width / 2) + "px," + (actor.y - height) + "px,0)";
          const text = typeof actor.bubble === "string" ? actor.bubble : "";
          if (!text || shownBubbles >= 2) {
            bubble.hidden = true;
            continue;
          }
          shownBubbles += 1;
          const left = Math.max(12, Math.min(actor.x - bubbleWidth / 2, rightEdge - bubbleWidth));
          let top = Math.max(66, actor.y - height - 75);
          if (placed.some((other) => Math.abs(other.left - left) < bubbleWidth + 8 && Math.abs(other.top - top) < 72)) {
            top = Math.max(66, top - 76);
          }
          placed.push({ left, top });
          bubble.hidden = false;
          bubble.style.width = bubbleWidth + "px";
          bubble.style.transform = "translate3d(" + left + "px," + top + "px,0)";
          const content = bubble.querySelector(".bubble-copy");
          if (content.textContent !== text) content.textContent = text;
        }
        for (const { id } of CREW) {
          if (!available.has(id)) {
            if (actorRefs.current[id]) actorRefs.current[id].hidden = true;
            if (bubbleRefs.current[id]) bubbleRefs.current[id].hidden = true;
          }
        }
      },
    });
    gameRef.current = api;
    api.setMuted(true);
    return () => {
      active = false;
      gameRef.current = null;
      if (locateFrameRef.current !== null) cancelAnimationFrame(locateFrameRef.current);
      api.destroy();
    };
  }, []);

  useEffect(() => {
    let active = true;
    void gameRef.current?.setMuted(muted).then(enabled => {
      if (active && !muted && !enabled) { setMuted(true); setAudioError(true); }
    });
    return () => { active = false; };
  }, [muted]);
  useEffect(() => { gameRef.current?.setReducedMotion(reducedMotion); }, [reducedMotion]);
  useEffect(() => {
    gameRef.current?.sync(mission.mission, mission.events, {
      restore: mission.restore && !currentRoundStart, loading: mission.loading, roundStart: currentRoundStart,
    });
  }, [mission.mission, mission.events, mission.restore, mission.loading, currentRoundStart]);
  useEffect(() => {
    if (panelOpen || shortInputOpen) inputRef.current?.focus();
  }, [panelOpen, shortInputOpen, selected]);
  useEffect(() => {
    followLogRef.current = true;
  }, [mission.id]);
  useEffect(() => {
    if (panelOpen && followLogRef.current && logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight;
  }, [mission.events.length, panelOpen]);

  function selectRole(id) {
    openRole(id);
    gameRef.current?.selectRole(id);
  }

  async function submit(event) {
    event.preventDefault();
    const text = (drafts[selected] ?? "").trim();
    if (!text || mission.busy || mission.loading || stopping || unavailable || modelSendBlocked) return;
    const recipient = selected;
    const selectionEpoch = viewSelectionRef.current;
    const sendingModel = !running && recipient === 'jack' && modelValue !== '';
    const modelSelection = !sendingModel ? undefined : modelValue === 'auth-default' ? null : modelOptions.find(model => model.value === modelValue).selection;
    const accepted = await mission.send(text, CREW_FOR_ACTOR[recipient], modelSelection, recipient === 'jack' ? modelValue : undefined);
    if (accepted) {
      if (selectionEpoch !== viewSelectionRef.current) return;
      // 仅建立尚未被GET观察到的原请求边界；幂等重试不重新截断已返回的历史。
      if (accepted.roundStart) setRoundStart(accepted.roundStart);
      if (accepted.modelSelectionSent) setModelDraft({ id: currentMissionRef.current, value: '' });
      setModelReload(value => value + 1);
      setDrafts((previous) => ({ ...previous, [recipient]: previous[recipient]?.trim() === text ? "" : previous[recipient] }));
      setPanelOpen(true);
      setShortInputOpen(false);
    }
  }

  const primaryLabel = running ? mission.mission.state === 'stopping' ? '停止中' : '停止' : '新协作';
  const PrimaryIcon = running ? Stop : Plus;
  const missionAlert = mission.error && <div className="mission-alert" role="alert" data-testid="mission-alert">{mission.error}</div>;
  const openDetails = <button className="detail-tab" type="button" onClick={() => { setPanelOpen(true); setShortInputOpen(false); }} aria-expanded={false} aria-controls="collaboration-panel" data-testid="open-details">
    <CaretLeft size={17} /><span>协作详情</span>
  </button>;
  const composer = (
    <form className="composer" onSubmit={submit}>
      <label htmlFor="crew-message">发给{NAMES[selected]}</label>
      {selected === 'jack' && <div className="captain-model-control">
        <div className="model-picker">
          <label htmlFor="captain-model">船长模型</label>
          <select id="captain-model" data-testid="captain-model" value={modelValue}
            disabled={running || mission.busy || mission.loading || modelsLoading || !modelOptions.length}
            aria-describedby="captain-model-note" title="切换后会尝试保存为 Auth 默认；保存失败不影响当前会话切换。船员沿用原插件会话模型。"
            onChange={event => setModelDraft({ id: mission.id, value: event.target.value })}>
            <option value="">{mission.id ? '沿用当前会话' : '自动使用 Auth 默认'}{catalog ? ' · ' + modelLabel(catalog, catalog.selected || catalog.default) : ''}</option>
            <option value="auth-default">使用 Auth 默认{catalog ? ' · ' + modelLabel(catalog, catalog.default) : ''}</option>
            {invalidModelDraft && <option value={modelValue} disabled>所选模型已不在目录中</option>}
            {(catalog?.groups || []).map(group => <optgroup key={group.id} label={group.name}>
              {group.models.map(model => <option key={model.id} value={JSON.stringify([group.id, model.id])}>{model.name}</option>)}
            </optgroup>)}
          </select>
          <button type="button" className="model-retry" data-testid="refresh-models" disabled={modelsLoading}
            onClick={() => setModelReload(value => value + 1)} aria-label="刷新船长模型目录">{modelRecoveryHint ? '刷新模型目录' : modelCatalog.error ? '重试' : '刷新'}</button>
        </div>
        <div id="captain-model-note" className={'model-note' + (modelCatalog.error || invalidModelDraft ? ' model-error' : '')}
          role={modelCatalog.error || invalidModelDraft ? 'alert' : 'status'}>
          {modelsLoading ? '正在读取模型目录…' : modelRecoveryHint || modelCatalog.error || (invalidModelDraft ? '所选模型已不可用，请重新选择。' : !modelOptions.length ? '暂无可用模型，请刷新目录。' :
            running ? '本轮模型已锁定，仍可补充要求。' : catalog.failures.length ? '暂不可用：' + catalog.failures.map(group => group.name || group.id).join('、') : '切换后尝试保存为 Auth 默认；船员沿用原会话。')}
        </div>
      </div>}
      <div className="composer-input">
        <textarea
          id="crew-message"
          ref={inputRef}
          data-testid="message-input"
          data-recipient={selected}
          rows={2}
          maxLength={mission.maxMessageChars}
          value={drafts[selected] ?? ""}
          onChange={(event) => setDrafts((previous) => ({ ...previous, [selected]: event.target.value }))}
          placeholder={selected === "jack" ? "告诉船长你想完成什么…" : "向这位船员提出要求…"}
          disabled={mission.busy || mission.loading || unavailable}
        />
        <button className="send-button" type="submit" disabled={mission.busy || mission.loading || stopping || unavailable || modelSendBlocked || !(drafts[selected] ?? "").trim()} aria-label={"发送给" + NAMES[selected]} data-testid="send-message">
          <PaperPlaneTilt size={19} weight="fill" />
        </button>
      </div>
      <span className="composer-note">{unavailable ? '该岗位的插件未启用，或当前账号无权访问。' : stopping ? '正在等待当前工作收尾。' : running ? '补充要求会在当前步骤结束后纳入协调。' : '发布、删除等操作仍在原插件中确认。'}</span>
    </form>
  );

  return (
    <main className="pirate-app" data-phase={snapshot.phase} data-testid="pirate-app" data-reduced-motion={reducedMotion}>
      <div className="game-host" ref={hostRef} data-testid="game-host" aria-label="半俯视黑珍珠号海战场景" />
      <header className="scene-heading">
        <span>黑珍珠号 · 指挥台</span>
        {snapshot.notice && <span className="simulation-label" role="status">{snapshot.notice}</span>}
      </header>
      <div className="actor-layer" aria-label="甲板船员">
        {CREW.map(({ id, name, job }) => (
          <div key={id}>
            <button
              ref={(node) => { actorRefs.current[id] = node; }}
              className="actor-hotspot"
              hidden
              type="button"
              onClick={() => selectRole(id)}
              aria-label={"与" + name + "交谈，" + job + "岗位"}
              aria-pressed={selected === id && panelOpen}
              data-testid={"actor-" + id}
            >
              <span className="actor-focus-label">{name}</span>
            </button>
            <button
              ref={(node) => { bubbleRefs.current[id] = node; }}
              className="speech-bubble"
              hidden
              type="button"
              onClick={() => selectRole(id)}
              aria-label={"查看" + name + "的交谈详情"}
              data-testid={"bubble-" + id}
            >
              <span className="bubble-name">{name}</span>
              <span className="bubble-copy" />
            </button>
          </div>
        ))}
      </div>
      {!snapshot.ready && !snapshot.error && <div className="scene-notice" role="status">正在准备海面与船员…</div>}
      {snapshot.error && <div className="scene-notice scene-error" role="alert">{String(snapshot.error)}</div>}
      {!panelOpen && !shortInputOpen && <div className="details-reopen">{openDetails}{missionAlert}</div>}
      <aside id="collaboration-panel" ref={panelRef} className="collaboration-panel" hidden={!panelOpen} aria-label="协作详情" data-testid="details-panel">
        <div className="panel-heading">
          <h1>协作详情</h1>
          <button type="button" className="icon-button" onClick={() => setPanelOpen(false)} aria-label="收起协作详情" aria-expanded={panelOpen} aria-controls="collaboration-panel" data-testid="collapse-details"><CaretRight size={21} /></button>
        </div>
        {panelOpen && missionAlert}
        <div className="task-status" role="status"><span className="status-light" /><span>{mission.loading ? '正在读取协作记录' : STATE_LABELS[mission.mission?.state] || '待命航行'}</span></div>
        <label className="history-picker">航海日志
          <select aria-label="打开历史协作" value={mission.id} disabled={mission.busy} onFocus={mission.refreshList} onChange={event => selectMission(event.target.value)}>
            <option value="">新协作</option>
            {mission.id && !mission.missions.some(m => m.id === mission.id) && <option value={mission.id}>{mission.mission?.title || '当前协作'}</option>}
            {mission.missions.map(m => <option key={m.id} value={m.id}>{m.title}</option>)}
          </select>
        </label>
        <nav className="crew-picker" aria-label="选择交谈对象">
          {CREW.map(({ id, name }) => <button key={id} type="button" className={selected === id ? "selected" : ""} aria-pressed={selected === id} onClick={() => selectRole(id)} data-testid={"select-" + id}>{name}</button>)}
        </nav>
        <div className="selected-status">{NAMES[selected]}<span>{snapshot.roles[selected] || "待命"}</span></div>
        <div className="message-log" ref={logRef} role="log" aria-label="协作记录" aria-live="polite" aria-relevant="additions text" data-testid="message-log" onScroll={event => {
          const log = event.currentTarget;
          followLogRef.current = log.scrollHeight - log.scrollTop - log.clientHeight <= 48;
        }}>
          {mission.events.length === 0 && <p className="empty-log">船员正在甲板上活动。向杰克下达指令，或点击船员与其交谈。</p>}
          {mission.events.map((message) => (
            <article className={"message message-" + message.role + ' event-' + message.type} key={message.seq} data-message-role={message.role} data-message-type={message.type}>
              <span className="message-author">{NAMES[ACTOR_FOR_CREW[message.role] || message.role] ?? (message.role === "user" ? "你" : "动态")}</span>
              {message.type === 'artifact' && message.artifact
                ? <a href={message.artifact.path} target="_blank" rel="noopener noreferrer">{message.artifact.title} <ArrowSquareOut size={13} /></a>
                : message.type === 'message' && message.role !== 'user'
                  ? <div className="markdown-body" dangerouslySetInnerHTML={{ __html: renderMarkdown(message.text) }} />
                  : <p>{message.text}</p>}
            </article>
          ))}
        </div>
        {panelOpen && composer}
      </aside>
      {!panelOpen && shortInputOpen && (
        <section className="quick-composer" aria-label="短指令">
          <div className="quick-heading">{openDetails}<button type="button" className="icon-button" onClick={() => setShortInputOpen(false)} aria-label="收起输入"><X size={18} /></button></div>
          {missionAlert}
          {composer}
        </section>
      )}
      <div className="compass-control" data-state={compass.phase}>
      <button className="compass-button" type="button" onClick={() => {
        setSelected("jack");
        if (panelOpen) inputRef.current?.focus();
        else setShortInputOpen((open) => !open);
      }} aria-label="唤起船长指令输入" aria-describedby="compass-description" aria-expanded={panelOpen || shortInputOpen}
        title={compass.description} data-testid="compass-input">
        <CompassArtwork missionId={mission.id} missionState={mission.mission?.state} compass={compass}
          inputOpen={(panelOpen || shortInputOpen) && selected === 'jack'} restore={mission.restore}
          loading={mission.loading} reducedMotion={reducedMotion} />
      </button>
      <div className="compass-caption" aria-hidden="true"><span>阶段示意</span><strong>{compass.label}</strong></div>
      <span id="compass-description" className="sr-only" role="status" aria-live="polite" aria-atomic="true">{compass.description}</span>
      </div>
      <div className="scene-controls" aria-label="协作和场景控制">
        <button className="primary-control" type="button" disabled={mission.busy || mission.mission?.state === 'stopping'} onClick={() => {
          if (running) void mission.stop();
          else { selectMission(''); setSelected('jack'); setPanelOpen(true); setShortInputOpen(false); }
        }} data-testid="primary-control">
          <PrimaryIcon size={17} weight="fill" /><span>{primaryLabel}</span>
        </button>
        <button type="button" onClick={() => { setAudioError(false); setMuted((value) => !value); }} aria-label={audioError ? "音效未能开启，点击重试" : muted ? "开启音效" : "静音"} title={audioError ? "当前浏览器未能开启音效，请重试。" : undefined} aria-pressed={muted} data-testid="mute-control">
          {muted ? <SpeakerSlash size={18} /> : <SpeakerHigh size={18} />}<span className="control-label">{audioError ? "音效未开启" : muted ? "已静音" : "音效开启"}</span>
        </button>
        <button type="button" onClick={() => setReducedMotion((value) => !value)} aria-label="减少动态效果" aria-pressed={reducedMotion} data-testid="motion-control">
          <Eye size={18} /><span className="control-label">减少动态</span>
        </button>
      </div>
    </main>
  );
}
