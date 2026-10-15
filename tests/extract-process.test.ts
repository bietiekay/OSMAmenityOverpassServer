import { describe, expect, it } from 'vitest';
import { run, runPipeline, pool } from '../scripts/extract/process.mjs';

describe('native extraction process supervision', () => {
  it('captures bounded diagnostics and respects explicitly accepted native exit codes', async () => {
    const result = await run(process.execPath, ['-e', 'process.stdout.write("123456789");process.stderr.write("abcdefghi");process.exitCode=1'], { acceptCodes: [1], maxOutputBytes: 4 });
    expect(result).toMatchObject({ code: 1, stdout: '6789', stderr: 'fghi' });
    await expect(run(process.execPath, ['-e', 'console.error("native failed");process.exitCode=2'])).rejects.toThrow('native failed');
    await expect(run('/nonexistent/osmium-test-binary', [])).rejects.toThrow('ENOENT');
  });

  it('streams a native pipeline and propagates a failed stage', async () => {
    expect(() => runPipeline([])).toThrow('at least two');
    const copy = 'process.stdin.pipe(process.stdout)';
    const pipeline = runPipeline([
      [process.execPath, ['-e', 'process.stdout.write("reference-record")']],
      [process.execPath, ['-e', copy]]
    ], { maxRssMb: 256 });
    let output = '';
    for await (const bytes of pipeline.stdout) output += bytes;
    await expect(pipeline.done).resolves.toHaveLength(2);
    expect(output).toBe('reference-record');
    const failed = runPipeline([
      [process.execPath, ['-e', 'console.error("bad source");process.exitCode=2']],
      [process.execPath, ['-e', copy]]
    ]);
    failed.stdout.resume();
    await expect(failed.done).rejects.toThrow('bad source');
  });

  it('terminates native jobs exceeding a measured process-tree RSS budget', async () => {
    if (process.platform !== 'linux') return;
    await expect(run(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { maxRssMb: 1 })).rejects.toThrow('exceeded 1 MiB RSS');
    const pipeline = runPipeline([
      [process.execPath, ['-e', 'setInterval(()=>{},1000)']],
      [process.execPath, ['-e', 'process.stdin.pipe(process.stdout)']]
    ], { maxRssMb: 1 });
    pipeline.stdout.resume();
    await expect(pipeline.done).rejects.toThrow('combined RSS');
  }, 10000);

  it('stops a streaming producer when the downstream command exits early', async () => {
    const pipeline = runPipeline([
      [process.execPath, ['-e', 'setInterval(()=>process.stdout.write(Buffer.alloc(65536)),1)']],
      [process.execPath, ['-e', 'process.exit(7)']]
    ]);
    pipeline.stdout.resume();
    await expect(pipeline.done).rejects.toThrow(/native pipeline/);
  }, 5000);

  it('limits concurrency and stops scheduling work after a task failure', async () => {
    let running = 0; let peak = 0;
    await pool([1, 2, 3, 4], 2, async () => {
      running++; peak = Math.max(peak, running);
      await new Promise((resolve) => setImmediate(resolve)); running--;
    });
    expect(peak).toBe(2);
    const started: number[] = [];
    await expect(pool([1, 2, 3], 1, async (item: number) => {
      started.push(item); throw new Error('invalid chunk');
    })).rejects.toThrow('invalid chunk');
    expect(started).toEqual([1]);
    await expect(pool([], 4, async () => {})).resolves.toBeUndefined();
  });
});
