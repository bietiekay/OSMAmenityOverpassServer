export const formatDuration = (seconds) => {
  if (!Number.isFinite(seconds) || seconds < 0) return 'unknown';
  const whole = Math.ceil(seconds);
  const days = Math.floor(whole / 86400);
  const hours = Math.floor((whole % 86400) / 3600);
  const minutes = Math.floor((whole % 3600) / 60);
  const secs = whole % 60;
  if (days) return `${days}d ${hours}h`;
  if (hours) return `${hours}h ${minutes}m`;
  if (minutes) return `${minutes}m ${secs}s`;
  return `${secs}s`;
};

const formatAmount = (value, unit) => {
  if (unit === 'bytes') {
    const mib = value / (1024 * 1024);
    return `${mib >= 1024 ? (mib / 1024).toFixed(2) + ' GiB' : mib.toFixed(0) + ' MiB'}`;
  }
  return Math.floor(value).toLocaleString('en-US');
};

/** Emit a concise phase heartbeat with a rolling phase rate and estimated time remaining. */
export function createProgressLogger(onLog = console.log, intervalMs = 30_000) {
  let current = null;
  let batch = null;
  let timer = null;

  const emit = () => {
    if (!current) return;
    const now = Date.now();
    const elapsedSeconds = Math.max(0.001, (now - current.startedAt) / 1000);
    const completed = Math.max(0, current.completed - current.startCompleted);
    const ratePerSecond = completed / elapsedSeconds;
    const rateLabel = current.unit === 'bytes'
      ? `${(ratePerSecond / (1024 * 1024)).toFixed(1)} MiB/s`
      : `${(ratePerSecond * 60).toFixed(1)} ${current.unit}/min`;
    const amount = current.total === null
      ? `${formatAmount(current.completed, current.unit)} ${current.unit}`
      : `${formatAmount(current.completed, current.unit)}/${formatAmount(current.total, current.unit)} ${current.unit}`;
    const percent = current.total > 0 ? ` (${Math.min(100, current.completed / current.total * 100).toFixed(1)}%)` : '';
    const eta = current.showEta && current.total !== null && ratePerSecond > 0
      ? ` | ETA ${formatDuration((current.total - current.completed) / ratePerSecond)}`
      : '';
    const detail = current.detail ? ` | ${current.detail}` : '';
    let batchLabel = '';
    if (batch?.completed >= batch?.total) {
      batchLabel = ` | replication diffs prepared ${formatAmount(batch.completed, 'diffs')}/${formatAmount(batch.total, 'diffs')}`;
    } else if (batch?.completed > 0) {
      const batchElapsed = Math.max(0.001, (now - batch.startedAt) / 1000);
      const batchRate = batch.completed / batchElapsed * 60;
      const batchEta = batchRate > 0 && batch.completed < batch.total
        ? `, ETA ${formatDuration((batch.total - batch.completed) / (batchRate / 60))}`
        : '';
      batchLabel = ` | diff batch ${formatAmount(batch.completed, 'diffs')}/${formatAmount(batch.total, 'diffs')} (${batchRate.toFixed(1)} diffs/min${batchEta})`;
    }
    onLog(`update progress: ${current.phase}: ${amount}${percent} | ${rateLabel} | elapsed ${formatDuration(elapsedSeconds)}${eta}${batchLabel}${detail}`);
    current.lastEmitAt = now;
  };

  return {
    setBatchProgress(completed, total) {
      if (!batch || batch.total !== total) batch = { completed, total, startedAt: Date.now() };
      else batch.completed = completed;
    },
    report(phase, completed = 0, total = null, unit = 'items', detail = '', showEta = true) {
      const now = Date.now();
      if (!current || current.phase !== phase || completed < current.completed) {
        current = { phase, completed, total, unit, detail, showEta, startedAt: now, startCompleted: completed, lastEmitAt: 0 };
        emit();
        if (!timer) {
          timer = setInterval(emit, intervalMs);
          timer.unref?.();
        }
        return;
      }
      current.completed = completed;
      current.total = total;
      current.unit = unit;
      current.detail = detail;
      current.showEta = showEta;
      if ((total !== null && completed >= total) || now - current.lastEmitAt >= intervalMs) emit();
    },
    close() {
      if (timer) clearInterval(timer);
      timer = null;
      current = null;
    }
  };
}
