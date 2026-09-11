import { useCallback, useEffect, useRef, useState } from 'react';
import { canRetryMissionRead, createMutationGate, isAccessRejection, prepareMissionSubmission, readApiResponse, unobservedSubmissionRound } from './mission-request.js';

export const isRunning = (mission) => ['running', 'stopping'].includes(mission?.state);
export const STATE_LABELS = {
  running: '协作进行中', stopping: '正在停止，等待船员收尾', completed: '本轮协作结束',
  partial: '部分完成，已返回的成果保留', waiting: '等待你的输入或原插件确认', cancelled: '协作已停止', failed: '本轮未完成', interrupted: '宿主重启，协作已中断',
};

async function request(path, payload, signal) {
  const timeout = AbortSignal.timeout(15000);
  const response = await fetch(new URL(path, document.baseURI), {
    method: payload ? 'POST' : 'GET', credentials: 'same-origin', cache: 'no-store', signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
    ...(payload ? { headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) } : {}),
  });
  return readApiResponse(response);
}

// 刷新只恢复阅读；读取历史和重连从来不会重新提交业务指令。
export function useMission() {
  const [id, setId] = useState(() => new URL(location.href).searchParams.get('mission') || '');
  const [data, setData] = useState({ mission: null, events: [], crewSessions: [], restore: true });
  const [crew, setCrew] = useState([]);
  const [maxMessageChars, setMaxMessageChars] = useState(8000);
  const [missions, setMissions] = useState([]);
  const [readError, setReadError] = useState('');
  const [actionError, setActionError] = useState('');
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(Boolean(id));
  const pending = useRef(null);
  const submitting = useRef(false);
  const currentId = useRef(id);
  const generation = useRef(0);
  const liveSelection = useRef(false);
  const accessEpoch = useRef(0);
  const accessFailure = useRef(null);
  const mutationGate = useRef(null);
  const latestData = useRef(data);
  latestData.current = data;
  mutationGate.current ??= createMutationGate();

  const clearProtectedData = useCallback((error) => {
    accessEpoch.current++;
    accessFailure.current = error;
    if (!error?.routeUnavailable) pending.current = null;
    setData({ mission: null, events: [], crewSessions: [], restore: true });
    setMissions([]); setCrew([]); setLoading(false);
  }, []);

  // 模型等独立读取的拒权也立即清理；旧选中项或旧访问回包不能清掉新内容。
  const rejectAccess = useCallback((error, scope) => {
    if (!isAccessRejection(error) || scope.id !== currentId.current
      || scope.selectionEpoch !== generation.current || scope.accessEpoch !== accessEpoch.current) return false;
    setReadError(error.message);
    clearProtectedData(error);
    return true;
  }, [clearProtectedData]);

  const refreshList = useCallback(async () => {
    const epoch = accessEpoch.current;
    try { const result = await request('missions'); if (accessEpoch.current === epoch) setMissions(result.missions); }
    catch (e) {
      if (accessEpoch.current === epoch && isAccessRejection(e)) { setReadError(e.message); clearProtectedData(e); }
    }
  }, [clearProtectedData]);

  const refreshCrew = useCallback(async (signal) => {
    const epoch = accessEpoch.current;
    try {
      const result = await request('crew', undefined, signal);
      if (!signal?.aborted && accessEpoch.current === epoch) { setCrew(result.crew); setMaxMessageChars(result.maxMessageChars); }
    } catch (e) {
      if (!signal?.aborted && accessEpoch.current === epoch) {
        setReadError(e.message);
        if (isAccessRejection(e)) clearProtectedData(e);
      }
    }
  }, [clearProtectedData]);

  const select = useCallback((next, { live = false } = {}) => {
    generation.current += 1;
    currentId.current = next;
    liveSelection.current = live;
    pending.current = null;
    setId(next);
    setReadError(''); setActionError('');
    setLoading(Boolean(next));
    setData({ mission: null, events: [], crewSessions: [], restore: !live });
    const url = new URL(location.href);
    if (next) url.searchParams.set('mission', next); else url.searchParams.delete('mission');
    history.replaceState(null, '', url);
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    void refreshCrew(controller.signal);
    void refreshList();
    return () => controller.abort();
  }, [refreshList, refreshCrew]);

  useEffect(() => {
    if (!id) return;
    const controller = new AbortController();
    const selectionEpoch = generation.current;
    let timer, cursor = 0, first = true, hydrating = !liveSelection.current, routeRetries = 0;
    let handledAccessEpoch = accessEpoch.current;
    function retryUnavailable(error) {
      if (!error?.routeUnavailable) return;
      cursor = 0; first = true; hydrating = true;
      if (canRetryMissionRead(error, routeRetries)) {
        routeRetries++;
        setReadError(`协作入口暂时不可用，正在重新读取（${routeRetries}/3）；不会重新提交指令。`);
        timer = setTimeout(poll, 3000);
      } else setReadError(error.message);
    }
    function handleAccessChange() {
      if (handledAccessEpoch === accessEpoch.current) return false;
      handledAccessEpoch = accessEpoch.current;
      retryUnavailable(accessFailure.current);
      return true;
    }
    async function poll() {
      if (handleAccessChange()) return;
      const readVersion = mutationGate.current.snapshot();
      const accessVersion = accessEpoch.current;
      try {
        const result = await request('mission?id=' + encodeURIComponent(id) + '&after=' + cursor, undefined, controller.signal);
        if (controller.signal.aborted || id !== currentId.current || selectionEpoch !== generation.current) return;
        if (accessVersion !== accessEpoch.current) { handleAccessChange(); return; }
        if (!mutationGate.current.accepts(readVersion)) { timer = setTimeout(poll, submitting.current ? 250 : 0); return; }
        if (result.events.length) cursor = result.events.at(-1).seq;
        const initialPage = first;
        const restore = hydrating;
        const recovered = first && routeRetries > 0;
        hydrating = hydrating && result.events.length === 200;
        first = false; routeRetries = 0; accessFailure.current = null;
        setData(previous => ({ ...result, events: initialPage ? result.events : [...previous.events, ...result.events], restore }));
        setLoading(hydrating);
        setReadError('');
        if (recovered) { void refreshCrew(controller.signal); void refreshList(); }
        // 满页立刻取下一页，防止长会话在刷新后遗漏后半段。
        timer = setTimeout(poll, result.events.length === 200 ? 0 : isRunning(result.mission) ? 1000 : 4000);
      } catch (e) {
        if (controller.signal.aborted || id !== currentId.current || selectionEpoch !== generation.current) return;
        if (accessVersion !== accessEpoch.current) { handleAccessChange(); return; }
        if (!mutationGate.current.accepts(readVersion)) { timer = setTimeout(poll, submitting.current ? 250 : 0); return; }
        setLoading(false);
        setReadError(e.message || '连接暂时中断，正在重新读取状态');
        if (isAccessRejection(e)) {
          clearProtectedData(e);
          handleAccessChange();
          return;
        }
        timer = setTimeout(poll, 3000);
      }
    }
    void poll();
    return () => { controller.abort(); clearTimeout(timer); };
  }, [id, clearProtectedData, refreshCrew, refreshList]);

  async function send(message, target, modelSelection, modelIntent) {
    if (submitting.current) return false;
    submitting.current = true; setBusy(true); setActionError('');
    const finishMutation = mutationGate.current.begin();
    const before = currentId.current;
    const epoch = generation.current;
    const accessVersion = accessEpoch.current;
    const input = { message, target, ...(before ? { missionId: before } : {}), ...(modelSelection !== undefined ? { modelSelection } : {}) };
    const signature = JSON.stringify({ message, target, missionId: before, modelIntent: modelIntent === undefined ? { modelSelection } : modelIntent });
    // 网络结果不明确时保留同一个请求号；用户重试不会重复创建或派单。
    pending.current = prepareMissionSubmission(pending.current, signature, data.mission, data.events, input);
    const submission = pending.current;
    try {
      const result = await request('message', { ...submission.payload, requestId: submission.requestId });
      finishMutation();
      if (generation.current !== epoch || accessVersion !== accessEpoch.current) return false;
      pending.current = null;
      const roundStart = unobservedSubmissionRound(submission, result.mission.id, latestData.current.events);
      if (result.mission.id !== before) select(result.mission.id, { live: true });
      setData(previous => ({ ...previous, mission: result.mission }));
      void refreshList();
      return { roundStart, modelSelectionSent: Object.hasOwn(submission.payload, 'modelSelection') };
    } catch (e) {
      const uncertain = !e.status || e.status >= 500 || e.routeUnavailable;
      if (generation.current === epoch && accessVersion === accessEpoch.current) {
        if (!uncertain) pending.current = null;
        setActionError(uncertain ? '发送结果暂时无法确认，请保留原内容重试，避免重复派单。' : e.message);
        if (isAccessRejection(e)) clearProtectedData(e);
      }
      return false;
    } finally { finishMutation(); submitting.current = false; setBusy(false); }
  }

  async function stop() {
    if (!currentId.current || submitting.current) return;
    submitting.current = true; setBusy(true); setActionError('');
    const finishMutation = mutationGate.current.begin();
    const before = currentId.current;
    const epoch = generation.current;
    const accessVersion = accessEpoch.current;
    try {
      const result = await request('stop', { missionId: before });
      finishMutation();
      if (currentId.current === before && generation.current === epoch && accessVersion === accessEpoch.current) setData(previous => ({ ...previous, mission: result.mission }));
    } catch (e) {
      if (currentId.current === before && generation.current === epoch && accessVersion === accessEpoch.current) {
        setActionError(e.message);
        if (isAccessRejection(e)) clearProtectedData(e);
      }
    }
    finally { finishMutation(); submitting.current = false; setBusy(false); }
  }

  const error = [...new Set([actionError, readError].filter(Boolean))].join(' ');
  return { ...data, id, crew, maxMessageChars, missions, error, busy, loading, accessEpoch: accessEpoch.current,
    retryNeedsModelCatalog: id === '' && Boolean(pending.current) && accessFailure.current?.routeUnavailable === true,
    selectionEpoch: generation.current, accessDenied: Boolean(accessFailure.current), rejectAccess, select, send, stop, refreshList };
}
