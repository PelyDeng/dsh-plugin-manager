const PHASES = {
  idle: ['等待指令', -150],
  loading: ['读取状态', -150],
  starting: ['等待拆解', -150],
  thinking: ['理解要求', -135],
  commanding: ['安排分工', -95],
  working: ['船员处理', -55],
  aggregating: ['核对结果', -20],
  completed: ['本轮完成', 0],
  waiting: ['等待处理', -60],
  partial: ['部分完成', -35],
  failed: ['本轮未完成', -135],
  cancelled: ['已停止', -120],
  interrupted: ['协作中断', -150],
  stopping: ['正在停止', -90],
  unknown: ['状态待确认', -150],
};

// 角度只示意公开阶段，不表示工作量、耗时或完成百分比。
export function getCompassState(mission, events = [], { afterSeq = 0, loading = false } = {}) {
  let phase = 'starting';
  let round = afterSeq;
  const ordered = events.filter(event => Number.isSafeInteger(event.seq) && event.seq > afterSeq)
    .sort((a, b) => a.seq - b.seq);
  for (const event of ordered) {
    if (event.type !== 'status') continue;
    if (event.role === 'jack' && event.stage === 'thinking') {
      round = event.seq;
      phase = 'thinking';
    } else if (event.role === 'jack' && event.stage === 'aggregating') {
      phase = 'aggregating';
    } else if (['closedoff', 'blog'].includes(event.role) && ['commanding', 'working', 'returning'].includes(event.stage)) {
      phase = event.stage === 'returning' ? 'working' : event.stage;
    }
  }
  if (loading) phase = 'loading';
  else if (!mission) phase = 'idle';
  else if (mission.state !== 'running') phase = PHASES[mission.state] ? mission.state : 'unknown';
  const [label, angle] = PHASES[phase];
  return { phase, label, angle, round, description: `阶段示意：${label}。指针位置不是完成百分比，仅本轮确认完成时指向 X。` };
}
