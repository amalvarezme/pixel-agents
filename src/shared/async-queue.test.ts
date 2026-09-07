import { describe, expect, it } from 'vitest';
import { createAsyncQueue } from './async-queue';

describe('createAsyncQueue (browser-entrypoint work unit) — bridges push-based producers into AsyncIterable', () => {
  it('yields an item pushed before iteration starts', async () => {
    const queue = createAsyncQueue<string>();
    queue.push('first');

    const iterator = queue[Symbol.asyncIterator]();
    const result = await iterator.next();

    expect(result).toEqual({ value: 'first', done: false });
  });

  it('yields items pushed AFTER iteration has already started waiting (the async-wakeup path)', async () => {
    const queue = createAsyncQueue<number>();
    const iterator = queue[Symbol.asyncIterator]();

    const pending = iterator.next();
    queue.push(42);

    expect(await pending).toEqual({ value: 42, done: false });
  });

  it('preserves FIFO order across multiple pushes and pulls', async () => {
    const queue = createAsyncQueue<number>();
    queue.push(1);
    queue.push(2);
    queue.push(3);

    const collected: number[] = [];
    for (let i = 0; i < 3; i++) {
      const { value } = await queue[Symbol.asyncIterator]().next();
      collected.push(value as number);
    }

    expect(collected).toEqual([1, 2, 3]);
  });

  it('end() resolves a pending next() with done:true instead of hanging forever', async () => {
    const queue = createAsyncQueue<number>();
    const iterator = queue[Symbol.asyncIterator]();
    const pending = iterator.next();

    queue.end();

    expect(await pending).toEqual({ value: undefined, done: true });
  });

  it('a for-await loop stops cleanly once end() is called, having consumed every pushed item first', async () => {
    const queue = createAsyncQueue<number>();
    queue.push(10);
    queue.push(20);
    queue.end();

    const collected: number[] = [];
    for await (const item of queue) {
      collected.push(item);
    }

    expect(collected).toEqual([10, 20]);
  });
});
