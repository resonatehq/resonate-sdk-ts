interface IClock {
  now(): number;
  setTimeout(callback: () => void, delay: number): number;
}

export const Clock: IClock = {
  now: Date.now,
  setTimeout: setTimeout,
};

export class TestClock implements IClock {
  t: number = 0;
  i: number = 0;

  now(): number {
    return this.t;
  }

  setTimeout(callback: () => void, delay: number): number {
    // bump the clock
    this.t += delay;

    // call the callback asynchronously
    new Promise((resolve) => resolve(callback()));

    return this.i++;
  }
}
