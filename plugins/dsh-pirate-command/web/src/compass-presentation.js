export const COMPASS_FAILURE_MS = 780;

// 仅管理短暂的失败演出；业务阶段、轮次和针角仍由公开状态决定。
export function updateCompassPresentation(previous, {
  missionId, round, missionState, restore = false, loading = false, reducedMotion = false,
}, now) {
  const key = JSON.stringify([missionId || '', round]);
  const same = previous?.key === key;
  const failed = missionState === 'failed';
  let spinUntil = same ? previous.spinUntil : 0;
  if (!failed || restore || loading || reducedMotion) spinUntil = 0;
  else if (!same || !previous.failed) spinUntil = now + COMPASS_FAILURE_MS;
  else if (spinUntil <= now) spinUntil = 0;
  const mode = failed ? spinUntil > now ? 'spinning' : 'broken' : 'intact';
  if (same && previous.failed === failed && previous.spinUntil === spinUntil && previous.mode === mode) return previous;
  return { key, failed, spinUntil, mode };
}
