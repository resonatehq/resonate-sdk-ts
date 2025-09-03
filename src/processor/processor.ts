import { ResonateError } from "../exceptions";
import type { Result } from "../types";

type F = () => Promise<unknown>;

export interface Processor {
  process(id: string, func: F, cb: (result: Result<unknown>) => void): void;
}

export class AsyncProcessor implements Processor {
  // TODO: I think this can cause deadlock
  private seen = new Set<string>();

  process(id: string, func: F, cb: (result: Result<unknown>) => void): void {
    // If already seen, ignore, either we are already working on it, or it was already completed
    if (this.seen.has(id)) {
      return;
    }

    this.seen.add(id);

    func()
      .then((value) => {
        cb({ success: true, value });
      })
      .catch((error) => {
        if (error instanceof ResonateError) {
          // remove from seen so we can retry
          this.seen.delete(id);
        }

        cb({ success: false, error });
      });
  }
}
