import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import { run, runPipeline } from '../scripts/extract/process.mjs';

describe('RSS budget fallback when the OS cannot report process memory', () => {
  afterEach(() => vi.restoreAllMocks());

  it('warns once and still waits for a command when /proc is unavailable', async () => {
    vi.spyOn(fs, 'existsSync').mockImplementation((file) => file === '/proc' ? false : false);
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await expect(run(process.execPath, ['-e', 'setTimeout(()=>{},350)'], { maxRssMb: 256 })).resolves.toMatchObject({ code: 0 });
    expect(warning).toHaveBeenCalledTimes(1);
    expect(warning.mock.calls[0][0]).toMatch(/RSS supervision unavailable/);
  }, 5000);

  it('reports unavailable combined RSS for a native pipeline without rejecting valid output', async () => {
    vi.spyOn(fs, 'existsSync').mockReturnValue(false);
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const pipeline = runPipeline([
      [process.execPath, ['-e', 'setTimeout(()=>process.stdout.write("ok"),350)']],
      [process.execPath, ['-e', 'process.stdin.pipe(process.stdout)']]
    ], { maxRssMb: 256 });
    let output = '';
    for await (const part of pipeline.stdout) output += part.toString();
    await expect(pipeline.done).resolves.toHaveLength(2);
    expect(output).toBe('ok');
    expect(warning).toHaveBeenCalledTimes(1);
    expect(warning.mock.calls[0][0]).toMatch(/RSS supervision unavailable for pipeline/);
  }, 5000);
});
