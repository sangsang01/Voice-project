export class AdmissionPool {
  private active = 0;

  public constructor(private readonly capacity: number) {}

  public reserve(): (() => void) | undefined {
    if (this.active >= this.capacity) return undefined;
    this.active += 1;
    let released = false;
    return () => {
      if (!released) {
        released = true;
        this.active -= 1;
      }
    };
  }
}
