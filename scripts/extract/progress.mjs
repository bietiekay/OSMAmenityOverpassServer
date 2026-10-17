/** Small, throttled progress logger with a moving ETA. */
export function createProgress(label, total, logger = console.log) {
  const started = Date.now();
  let lastPercent = -1;
  let lastTime = 0;
  const report = (completed, force = false) => {
    if (!(total > 0)) return;
    const done = Math.min(completed, total);
    const percent = Math.floor((done / total) * 100);
    const now = Date.now();
    if (!force && percent < lastPercent + 1 && now - lastTime < 5000) return;
    const elapsed = now - started;
    const etaMs = done > 0 ? Math.max(0, elapsed * (total - done) / done) : null;
    logger(`${label}: ${done.toLocaleString('en-US')}/${total.toLocaleString('en-US')} (${((done / total) * 100).toFixed(1)}%) | ETA ${etaMs === null ? 'wird berechnet' : formatDuration(etaMs)}`);
    lastPercent = percent;
    lastTime = now;
  };
  report(0, true);
  return report;
}

function formatDuration(ms) {
  let seconds = Math.ceil(ms / 1000);
  const hours = Math.floor(seconds / 3600); seconds %= 3600;
  const minutes = Math.floor(seconds / 60); seconds %= 60;
  if (hours) return `ca. ${hours} h ${minutes} min`;
  if (minutes) return `ca. ${minutes} min ${seconds} s`;
  return `ca. ${seconds} s`;
}
