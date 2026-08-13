/** Matches Java AtomicBoolean used as a cancel flag. */
export class AtomicBoolean {
  constructor(private v = false) {}

  get(): boolean {
    return this.v;
  }

  set(v: boolean): void {
    this.v = v;
  }
}
