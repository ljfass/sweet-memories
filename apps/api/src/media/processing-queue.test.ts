// @vitest-environment node

import { describe, expect, it, vi } from 'vitest';

import {
  ProcessingQueue,
  ProcessingQueueClosedError,
} from './processing-queue.js';

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, reject, resolve };
}

async function nextTurn(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
}

describe('ProcessingQueue', () => {
  it('runs one job at a time and starts pending jobs in FIFO order', async () => {
    const queue = new ProcessingQueue();
    const first = deferred<string>();
    const second = deferred<string>();
    const order: string[] = [];

    const firstResult = queue.run(async () => {
      order.push('first-start');
      const value = await first.promise;
      order.push('first-end');
      return value;
    });
    const secondResult = queue.run(async () => {
      order.push('second-start');
      const value = await second.promise;
      order.push('second-end');
      return value;
    });

    expect(queue.concurrency).toBe(1);
    expect(queue.maxPending).toBe(9);
    expect(queue.activeCount).toBe(1);
    expect(queue.pendingCount).toBe(1);
    expect(order).toEqual(['first-start']);

    first.resolve('one');
    await expect(firstResult).resolves.toBe('one');
    await nextTurn();
    expect(order).toEqual(['first-start', 'first-end', 'second-start']);
    expect(queue.activeCount).toBe(1);
    expect(queue.pendingCount).toBe(0);

    second.resolve('two');
    await expect(secondResult).resolves.toBe('two');
    expect(order).toEqual(['first-start', 'first-end', 'second-start', 'second-end']);
    expect(queue.activeCount).toBe(0);
    expect(queue.pendingCount).toBe(0);
  });

  it('admits one active plus nine pending jobs and rejects the eleventh', async () => {
    const queue = new ProcessingQueue();
    const blocker = deferred<void>();
    const jobs = Array.from({ length: 10 }, (_, index) => queue.run(async () => {
      await blocker.promise;
      return index;
    }));
    const eleventhJob = vi.fn(async () => 10);

    expect(queue.activeCount).toBe(1);
    expect(queue.pendingCount).toBe(9);
    await expect(queue.run(eleventhJob)).rejects.toMatchObject({
      code: 'UPLOAD_QUEUE_FULL',
    });
    expect(eleventhJob).not.toHaveBeenCalled();
    expect(queue.activeCount).toBe(1);
    expect(queue.pendingCount).toBe(9);

    blocker.resolve();
    await expect(Promise.all(jobs)).resolves.toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
  });

  it('releases the active slot after asynchronous rejection', async () => {
    const queue = new ProcessingQueue();
    const failure = deferred<void>();
    const first = queue.run(async () => {
      await failure.promise;
      return 'unreachable';
    });
    const secondJob = vi.fn(async () => 'recovered');
    const second = queue.run(secondJob);

    failure.reject(new Error('processing failed'));
    await expect(first).rejects.toThrow('processing failed');
    await expect(second).resolves.toBe('recovered');
    expect(secondJob).toHaveBeenCalledOnce();
    expect(queue.activeCount).toBe(0);
    expect(queue.pendingCount).toBe(0);
  });

  it('releases the active slot after a synchronous throw', async () => {
    const queue = new ProcessingQueue();
    const first = queue.run(() => {
      throw new Error('synchronous failure');
    });
    const second = queue.run(async () => 'next');

    await expect(first).rejects.toThrow('synchronous failure');
    await expect(second).resolves.toBe('next');
    expect(queue.activeCount).toBe(0);
    expect(queue.pendingCount).toBe(0);
  });

  it('seals admission, rejects every pending job and lets only the active job settle', async () => {
    const queue = new ProcessingQueue();
    const active = deferred<string>();
    const pendingJob = vi.fn(async () => 'must not run');
    const otherPendingJob = vi.fn(async () => 'must not run either');
    const activeResult = queue.run(() => active.promise);
    const pendingResult = queue.run(pendingJob);
    const otherPendingResult = queue.run(otherPendingJob);

    queue.seal();
    queue.seal();

    expect(queue.isAccepting).toBe(false);
    expect(queue.activeCount).toBe(1);
    expect(queue.pendingCount).toBe(0);
    await Promise.all([
      expect(pendingResult).rejects.toBeInstanceOf(ProcessingQueueClosedError),
      expect(otherPendingResult).rejects.toMatchObject({
        code: 'UPLOAD_QUEUE_CLOSED',
        name: 'ProcessingQueueClosedError',
      }),
    ]);
    const rejectedJob = vi.fn(async () => 'also must not run');
    await expect(queue.run(rejectedJob)).rejects.toBeInstanceOf(
      ProcessingQueueClosedError,
    );
    expect(rejectedJob).not.toHaveBeenCalled();

    active.reject(new Error('late active failure'));
    await expect(activeResult).rejects.toThrow('late active failure');
    await nextTurn();
    expect(pendingJob).not.toHaveBeenCalled();
    expect(otherPendingJob).not.toHaveBeenCalled();
    expect(queue.activeCount).toBe(0);
    expect(queue.pendingCount).toBe(0);
  });
});
