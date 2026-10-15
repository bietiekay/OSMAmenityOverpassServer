export function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith('--')) throw new Error(`Unexpected argument: ${arg}`);
    const name = arg.slice(2); const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) args[name] = true;
    else { args[name] = next; i += 1; }
  }
  return args;
}
export function flagBool(args, name, fallback) {
  if (!(name in args)) return fallback;
  if (args[name] === true) return true;
  const value = String(args[name]).toLowerCase();
  if (['true', '1', 'yes', 'on'].includes(value)) return true;
  if (['false', '0', 'no', 'off'].includes(value)) return false;
  throw new Error(`Flag --${name} expects true/false, got: ${args[name]}`);
}
export function flagInt(args, name, fallback) {
  if (!(name in args)) return fallback;
  const value = Number(args[name]);
  if (!Number.isInteger(value) || value <= 0) throw new Error(`--${name} must be a positive integer, got: ${args[name]}`);
  return value;
}
export function parseStages(raw) {
  if (raw === undefined) return [0];
  const match = String(raw).match(/^(\d+)(?:-(\d+))?$/);
  if (!match) throw new Error(`--stages must be like "0" or "0-4", got: ${raw}`);
  const from = Number(match[1]); const to = match[2] === undefined ? from : Number(match[2]);
  if (from < 0 || to > 4 || from > to) throw new Error(`--stages must be within 0..4, got: ${raw}`);
  return Array.from({ length: to - from + 1 }, (_, i) => from + i);
}
