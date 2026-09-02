export class ProcessingQueueError extends Error {
  readonly code = 'UPLOAD_QUEUE_FULL';

  constructor() {
    super('图片处理队列已满');
    this.name = 'ProcessingQueueError';
  }
}

export class ProcessingQueueClosedError extends Error {
  readonly code = 'UPLOAD_QUEUE_CLOSED';

  constructor() {
    super('图片处理队列已关闭');
    this.name = 'ProcessingQueueClosedError';
  }
}

interface PendingJob {
  readonly job: () => Promise<unknown>;
  readonly reject: (reason?: unknown) => void;
  readonly resolve: (value: unknown) => void;
}

export class ProcessingQueue {
  readonly concurrency = 1;
  readonly maxPending = 9;

  private active = 0;
  private accepting = true;
  private readonly pending: PendingJob[] = [];

  get isAccepting(): boolean {
    return this.accepting;
  }

  get activeCount(): number {
    return this.active;
  }

  get pendingCount(): number {
    return this.pending.length;
  }

  run<T>(job: () => Promise<T>): Promise<T> {
    if (!this.accepting) {
      return Promise.reject(new ProcessingQueueClosedError());
    }
    if (this.active >= this.concurrency && this.pending.length >= this.maxPending) {
      return Promise.reject(new ProcessingQueueError());
    }

    return new Promise<T>((resolve, reject) => {
      const pendingJob: PendingJob = {
        job,
        resolve: (value) => resolve(value as T),
        reject,
      };
      if (this.active < this.concurrency) {
        this.start(pendingJob);
      } else {
        this.pending.push(pendingJob);
      }
    });
  }

  seal(): void {
    if (!this.accepting) return;
    this.accepting = false;
    for (const pendingJob of this.pending.splice(0)) {
      pendingJob.reject(new ProcessingQueueClosedError());
    }
  }

  private start(pendingJob: PendingJob): void {
    this.active += 1;
    void this.execute(pendingJob);
  }

  private async execute(pendingJob: PendingJob): Promise<void> {
    let result: unknown;
    let failure: unknown;
    let succeeded = false;
    try {
      result = await pendingJob.job();
      succeeded = true;
    } catch (error) {
      failure = error;
    } finally {
      this.finish();
    }

    if (succeeded) {
      pendingJob.resolve(result);
    } else {
      pendingJob.reject(failure);
    }
  }

  private finish(): void {
    this.active -= 1;
    if (!this.accepting) {
      for (const pendingJob of this.pending.splice(0)) {
        pendingJob.reject(new ProcessingQueueClosedError());
      }
      return;
    }
    const next = this.pending.shift();
    if (next !== undefined) {
      this.start(next);
    }
  }
}
