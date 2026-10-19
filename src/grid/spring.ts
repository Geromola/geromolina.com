/**
 * Spring parameterised the way Apple does it: `response` (seconds, how fast it
 * gets there) and `damping` (1 = critically damped, < 1 overshoots).
 * Always animates from the current value, so retargeting mid-flight is seamless.
 */
export class Spring {
  value: number;
  target: number;
  velocity = 0;

  constructor(
    value: number,
    public response = 0.3,
    public damping = 1,
  ) {
    this.value = value;
    this.target = value;
  }

  step(dt: number): number {
    const w = (2 * Math.PI) / this.response;
    let remaining = Math.min(dt, 0.1);
    while (remaining > 0) {
      const h = Math.min(remaining, 1 / 240);
      const accel = w * w * (this.target - this.value) - 2 * this.damping * w * this.velocity;
      this.velocity += accel * h;
      this.value += this.velocity * h;
      remaining -= h;
    }
    return this.value;
  }

  snap(value: number) {
    this.value = this.target = value;
    this.velocity = 0;
  }
}
