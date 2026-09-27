import { createStreamServer } from '../adapters/driving/http/stream';

export function status(): number {
  return createStreamServer();
}
