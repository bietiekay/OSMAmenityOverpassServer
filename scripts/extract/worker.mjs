import { stage1Chunk } from './stages.mjs';
import path from 'node:path'; import { pathToFileURL } from 'node:url';

export async function runWorker(input = process.argv[2]) {
  if (!input) throw new Error('worker requires its JSON work item');
  return stage1Chunk(typeof input === 'string' ? JSON.parse(input) : input);
}

export async function runWorkerMain(input = process.argv[2], onError = console.error, onResult = () => {}) {
  try { onResult(await runWorker(input)); return 0; }
  catch (error) { onError(error); return 1; }
}
export async function startWorker(argv = process.argv, moduleUrl = import.meta.url, onError = console.error, onResult = () => {}) {
  if (!argv[1] || pathToFileURL(path.resolve(argv[1])).href !== moduleUrl) return null;
  return runWorkerMain(argv[2], onError, onResult);
}

const exitCode = await startWorker(process.argv, import.meta.url, console.error, (didWork) => console.log(didWork ? 'stage1-chunk:written' : 'stage1-chunk:resumed'));
if (exitCode !== null) process.exitCode = exitCode;
