import type { Result } from "./types";
import * as util from "./util";

export class Nursery<E, R> {
  // event queue, these functions are ensured to execute sequentially
  private q: Array<() => void> = [];

  // the function the nursery is instantiated with, added to the
  // queue when holds are released
  private f: () => void;

  // the callback the nursery is instantiated with, called once when
  // the nursery is done and all holds are released
  private c: (r: Result<R>) => void;

  // the return value done is called with, if any
  private r?: Result<R>;

  private holds = 0;
  private running = false;
  private completed = false;

  constructor(f: (n: Nursery<E, R>) => void, c: (r: Result<R>) => void) {
    this.f = () => f(this);
    this.c = c;

    // kick off the nursery
    this.enqueue(this.f);
  }

  hold(f: (f: () => void) => void) {
    if (!this.running || this.completed) return;
    this.holds++;

    f(() => {
      this.holds--;

      if (this.completed) {
        this.complete();
      } else {
        this.enqueue(this.f);
      }
    });
  }

  cont() {
    this.running = false;

    if (this.completed) {
      this.complete();
    } else {
      this.execute();
    }
  }

  done(res?: Result<R>) {
    if (this.completed) return;

    this.r = res;
    this.running = false;
    this.completed = true;
    this.complete();
  }

  all<T, U, E>(
    list: T[],
    func: (item: T, done: (err?: E, res?: U) => void) => void,
    done: (err?: E, res?: U[]) => void,
  ) {
    const results: U[] = new Array(list.length);

    let remaining = list.length;
    let completed = false;

    const finalize = (err?: E) => {
      if (completed) return;
      completed = true;
      done(err, results);
    };

    list.forEach((item, index) => {
      func(item, (err, res) => {
        if (completed) return;
        if (err) return finalize(err);

        results[index] = res!;
        remaining--;

        if (remaining === 0) {
          finalize();
        }
      });
    });
  }

  private enqueue(f: () => void) {
    this.q.push(f);
    this.execute();
  }

  private execute() {
    if (this.running) return;

    const f = this.q.shift();
    if (f) {
      this.running = true;
      f();
    }
  }

  private complete() {
    if (!this.completed || this.holds > 0) return;
    if (this.r) {
      this.c(this.r);
    }

  }
}
