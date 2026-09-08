/**
 * Minimal pull-based async queue (browser-entrypoint work unit). Bridges callback-driven
 * producers — chokidar's `add`/`change` handlers in `discover.ts`/`tail.ts` — into the
 * `AsyncIterable` shape `ports/activity-source.port.ts`'s `ActivitySource` contract requires,
 * without buffering unboundedly or busy-polling. `push` never blocks the producer; a consumer
 * pulling via `for await` receives items in FIFO order, waiting only when the queue is empty.
 */

export interface AsyncQueue<T> extends AsyncIterable<T> {
  push(item: T): void;
  end(): void;
}

export function createAsyncQueue<T>(): AsyncQueue<T> {
  const buffered: T[] = [];
  const waiting: Array<(result: IteratorResult<T>) => void> = [];
  let ended = false;

  return {
    push(item: T): void {
      if (ended) return;
      const resolve = waiting.shift();
      if (resolve) {
        resolve({ value: item, done: false });
      } else {
        buffered.push(item);
      }
    },
    end(): void {
      if (ended) return;
      ended = true;
      while (waiting.length > 0) {
        waiting.shift()?.({ value: undefined, done: true });
      }
    },
    [Symbol.asyncIterator](): AsyncIterator<T> {
      return {
        next(): Promise<IteratorResult<T>> {
          if (buffered.length > 0) {
            return Promise.resolve({ value: buffered.shift() as T, done: false });
          }
          if (ended) {
            return Promise.resolve({ value: undefined, done: true });
          }
          return new Promise((resolve) => waiting.push(resolve));
        },
      };
    },
  };
}
