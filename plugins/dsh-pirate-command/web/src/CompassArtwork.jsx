import React, { useEffect, useLayoutEffect, useState } from 'react';
import { COMPASS_FAILURE_MS, updateCompassPresentation } from './compass-presentation.js';

export function CompassArtwork({ missionId, missionState, compass, inputOpen, restore, loading, reducedMotion }) {
  const [systemReduced, setSystemReduced] = useState(() => window.matchMedia('(prefers-reduced-motion: reduce)').matches);
  const reduce = reducedMotion || systemReduced;
  const options = { missionId, round: compass.round, missionState, restore, loading, reducedMotion: reduce };
  const [presentation, setPresentation] = useState(() => updateCompassPresentation(null, options, performance.now()));
  useEffect(() => {
    const media = window.matchMedia('(prefers-reduced-motion: reduce)');
    const changed = () => setSystemReduced(media.matches);
    media.addEventListener('change', changed);
    return () => media.removeEventListener('change', changed);
  }, []);
  useLayoutEffect(() => {
    setPresentation(previous => updateCompassPresentation(previous, options, performance.now()));
  }, [missionId, compass.round, missionState, restore, loading, reduce]);
  useEffect(() => {
    if (!presentation.spinUntil) return;
    const { key, spinUntil } = presentation;
    const timer = setTimeout(() => setPresentation(previous =>
      previous.key === key && previous.spinUntil === spinUntil
        ? updateCompassPresentation(previous, options, Math.max(spinUntil, performance.now())) : previous),
    Math.max(0, spinUntil - performance.now()));
    return () => clearTimeout(timer);
  }, [presentation.key, presentation.spinUntil, missionId, compass.round, missionState, restore, loading, reduce]);

  const animate = !restore && !loading && !reduce;
  const same = presentation.key === JSON.stringify([missionId || '', compass.round]);
  const failure = missionState === 'failed' ? same && animate && presentation.mode === 'spinning' ? 'spinning' : 'broken' : 'intact';
  return <span className="compass-artwork" aria-hidden="true" data-testid="compass-artwork"
    data-open={compass.phase !== 'idle' || inputOpen} data-failure={failure} data-failed={missionState === 'failed'} data-animate={animate}
    data-lid-animate={!loading && !reduce && (compass.phase === 'idle' || !restore)}
    style={{ '--compass-angle': `${compass.angle}deg`, '--compass-failure-ms': `${COMPASS_FAILURE_MS}ms` }}>
    <img className="compass-base compass-intact-base" src="./assets/compass-base-v01.png" alt="" draggable="false" />
    <img className="compass-base compass-damaged-base" src="./assets/compass-base-damaged-v01.png" alt="" draggable="false" />
    <span key={`${missionId}:${compass.round}`} className="compass-needle" style={{ transform: `rotate(${compass.angle}deg)` }}
      data-animate={animate && failure === 'intact' && !['starting', 'thinking'].includes(compass.phase)}>
      <img className="compass-whole-needle" src="./assets/compass-needle-v01.png" alt="" draggable="false" />
      <img className="compass-broken-needle" src="./assets/compass-needle-stem-broken-v01.png" alt="" draggable="false" />
      <img className="compass-broken-needle compass-broken-tip" src="./assets/compass-needle-tip-broken-v01.png" alt="" draggable="false" />
    </span>
    <img className="compass-lid" src="./assets/compass-lid-v01.png" alt="" draggable="false" />
  </span>;
}
