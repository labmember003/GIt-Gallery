type Job<T> = () => Promise<T>;

export class JobQueue {
  private current: Promise<unknown> = Promise.resolve();
  private size = 0;

  enqueue<T>(job: Job<T>): Promise<T> {
    this.size += 1;
    const wrapped = this.current.then(() => job());
    this.current = wrapped.catch(() => {});
    return wrapped.finally(() => {
      this.size = Math.max(0, this.size - 1);
    });
  }

  get pending(): number {
    return this.size;
  }
}
