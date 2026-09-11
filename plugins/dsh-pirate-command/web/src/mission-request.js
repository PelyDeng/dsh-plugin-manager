/** 非 JSON 拒绝仍保留 HTTP 状态；成功但内容不可读属于结果不明确。 */
export async function readApiResponse(response) {
  let data, decoded = false;
  try { data = await response.json(); decoded = true; } catch { /* 宿主和反向代理可返回空体或纯文本错误。 */ }
  if (!response.ok) {
    const routeUnavailable = response.status === 404 && !decoded;
    const fallback = response.status === 401 ? '登录状态已失效，请重新登录。'
      : response.status === 403 ? '当前账号无权访问这项协作。'
        : routeUnavailable ? '协作入口暂时不可用，请稍后刷新页面重新读取；刷新不会重新提交指令。'
          : response.status === 404 ? '协作或插件入口已不可用。' : '请求未完成，请稍后重试。';
    throw Object.assign(new Error(typeof data?.error === 'string' ? data.error : fallback), { status: response.status, routeUnavailable });
  }
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('服务响应无法读取，请保留原内容重试。');
  return data;
}

export function isAccessRejection(error) { return [401, 403, 404].includes(error?.status); }

/** 仅用于任务 GET；路由未挂载时也先清空受保护内容，最多自动重读三次。 */
export function canRetryMissionRead(error, attempts) { return error?.status === 404 && error.routeUnavailable === true && attempts < 3; }

/** 同一发送意图固定首次payload、请求号与轮次边界；不明确响应后的重试仍确认原指令。 */
export function prepareMissionSubmission(previous, signature, mission, events = [], payload) {
  if (previous?.signature === signature) return previous;
  return {
    signature, requestId: crypto.randomUUID(), payload: payload && structuredClone(payload),
    roundStart: mission && !['running', 'stopping'].includes(mission.state)
      ? { id: mission.id, afterSeq: events.at(-1)?.seq ?? 0 } : null,
  };
}

/** GET 已发布的新 thinking 已建立该轮；POST 重试回包不能让它再次开始。 */
export function unobservedSubmissionRound(submission, missionId, events = []) {
  const boundary = submission.roundStart;
  if (!boundary || boundary.id !== missionId || events.some(event =>
    Number.isSafeInteger(event.seq) && event.seq > boundary.afterSeq
      && event.type === 'status' && event.role === 'jack' && event.stage === 'thinking')) return null;
  return boundary;
}

/** 提交开始及结束都推进版本，禁止在途旧读取覆盖新任务状态。 */
export function createMutationGate() {
  let version = 0, active = 0;
  return {
    snapshot: () => version,
    accepts: token => active === 0 && token === version,
    begin() {
      version++; active++;
      let finished = false;
      return () => { if (!finished) { finished = true; active--; version++; } };
    },
  };
}
