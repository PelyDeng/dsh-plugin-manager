export const ACTOR_FOR_CREW = { closedoff: 'barbossa', blog: 'elizabeth' };
export const STOPS_SCENE = new Set(['stopping', 'cancelled', 'interrupted']);
const STAGE_LABELS = {
  thinking: '理解要求', commanding: '接收分工', working: '处理中', returning: '本轮已返回',
  aggregating: '核对结果', waiting: '等待用户', failed: '未完成', cancelled: '已停止',
};
const MISSION_LABELS = {
  running: '协作进行中', stopping: '正在停止，等待船员收尾', completed: '本轮协作结束',
  partial: '部分工作已完成', waiting: '等待用户处理', cancelled: '协作已停止',
  failed: '本轮未完成', interrupted: '上次协作已中断',
};

/** 气泡仅截取已经公开的事件文本，不生成额外回复。 */
export function previewText(text, limit = 32) {
  const characters = Array.from(String(text ?? '').replace(/\s+/g, ' ').trim());
  return characters.length > limit ? characters.slice(0, limit - 1).join('') + '…' : characters.join('');
}

/** 在素材准备前也消费游标，恢复分页不会混进待演事件。 */
export function createSceneEventFeed() {
  let id = null, cursor = 0, current, queued = [], initialize = false, restoreWorld = false, hasTurn = false, roundAfterSeq = null;
  return {
    push(mission, events = [], { restore = false, loading = false, roundStart = null } = {}) {
      const nextId = mission?.id ?? null;
      const changed = nextId !== id;
      if (changed) { id = nextId; cursor = 0; queued = []; initialize = true; restoreWorld = restore; hasTurn = false; roundAfterSeq = null; }
      if (restore) { queued = []; initialize = true; restoreWorld = true; roundAfterSeq = null; }
      if (!restore && roundStart?.id === nextId && Number.isSafeInteger(roundStart.afterSeq)
        && roundStart.afterSeq >= 0 && roundStart.afterSeq !== roundAfterSeq) {
        // 成功的新轮 POST 已确认轮次变化，不能把仍在页面的上一轮历史当成当前状态。
        roundAfterSeq = roundStart.afterSeq; queued = []; initialize = true; restoreWorld = false; hasTurn = false;
        cursor = Math.max(cursor, roundAfterSeq);
      }
      let ordered = events.filter(event => Number.isSafeInteger(event.seq)).slice().sort((a, b) => a.seq - b.seq);
      if (roundAfterSeq !== null) {
        const beginning = ordered.find(event => event.seq > roundAfterSeq && event.role === 'jack' && event.stage === 'thinking');
        ordered = beginning ? ordered.filter(event => event.seq >= beginning.seq) : [];
      }
      const turnEvents = ordered.filter(event => ['jack', 'closedoff', 'blog'].includes(event.role));
      let fresh = ordered.filter(event => event.seq > cursor);
      const newTurn = fresh.findLast(event => event.role === 'jack' && event.stage === 'thinking');
      if (!restore && newTurn) {
        queued = [];
        // 新任务的空占位或用户消息已使世界入场；首轮 thinking 沿用它，后续轮次才重置。
        if (hasTurn || turnEvents.some(event => event.seq < newTurn.seq)) initialize = true;
        fresh = fresh.filter(event => event.seq >= newTurn.seq);
      }
      // 不依赖待演队列或游标：排空、128 条截断和历史分页都不能忘记已开始的轮次。
      hasTurn ||= turnEvents.length > 0 || Boolean(mission && mission.state !== 'running');
      if (ordered.length) cursor = Math.max(cursor, ordered.at(-1).seq);
      const roleStages = {}, commands = {}, replies = {}, commandsBySeq = new Map();
      let latestStage = 'thinking', topic = '';
      for (const event of ordered) {
        const actor = ACTOR_FOR_CREW[event.role] ?? (event.role === 'jack' ? 'jack' : null);
        if (event.role === 'jack' && event.stage === 'thinking') {
          for (const values of [roleStages, commands, replies]) for (const key of Object.keys(values)) delete values[key];
          topic = '';
        }
        if (event.role === 'jack' && event.type === 'topic') topic = previewText(event.text, 30);
        if (event.stage) {
          latestStage = event.stage;
          if (actor) roleStages[actor] = event.stage;
        }
        if (actor && event.stage === 'commanding') delete replies[actor];
        if (actor && event.type === 'message' && event.text) replies[actor] = previewText(event.text);
        if (event.role === 'jack' && event.type === 'message') {
          for (const [name, crew] of [['巴博萨', 'barbossa'], ['伊丽莎白', 'elizabeth']]) {
            if (event.text.startsWith(name + '：')) commands[crew] = previewText(event.text.slice(name.length + 1));
          }
        }
        if (event.stage === 'commanding' && actor) commandsBySeq.set(event.seq, commands[actor] ?? previewText(event.text));
      }
      const perform = mission?.state === 'running';
      const stop = !mission || STOPS_SCENE.has(mission.state);
      if (stop) queued = [];
      // 终态同批到达的真实结果仍需可见；停止只允许新公开反馈，不继续分工或炮击。
      if (!restore && mission) queued.push(...fresh.filter(event => !stop ||
        (event.type === 'message' && event.role !== 'user' && !/^巴博萨：|^伊丽莎白：/.test(event.text)) ||
        (event.type === 'status' && ['waiting', 'failed', 'cancelled'].includes(event.stage)) || event.role === 'system')
        .map(event => commandsBySeq.has(event.seq)
        ? { ...event, commandText: commandsBySeq.get(event.seq) } : event));
      // 保留最近的公开动作；长时间后台加载不会积压几百场已经过时的会面。
      queued = queued.slice(-128);
      const roles = Object.fromEntries(['jack', 'barbossa', 'elizabeth'].map(actor => [actor, STAGE_LABELS[roleStages[actor]] ?? '待命']));
      if (mission && !perform) roles.jack = MISSION_LABELS[mission.state] ?? '待命';
      current = {
        mission, perform, stop, runActive: perform || mission?.state === 'stopping', roleStages, commands, replies, roles,
        topic: stop || loading ? '' : topic,
        phase: !mission ? 'idle' : perform ? latestStage : mission.state === 'completed' ? 'complete' : mission.state,
        label: mission ? MISSION_LABELS[mission.state] ?? '协作记录' : '待命航行',
      };
    },
    drain() {
      if (!current) return null;
      const snapshot = { ...current, events: queued, initialize, restoreWorld };
      queued = []; initialize = false; restoreWorld = false;
      return snapshot;
    },
  };
}
