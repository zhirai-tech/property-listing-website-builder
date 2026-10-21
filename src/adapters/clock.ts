/**
 * 时钟适配器。
 *
 * 方案第 7 阶段验收要求「用可控测试时间验证规则，不需要真实等待 7/15 天」，
 * 因此所有与「现在」相关的逻辑都必须通过 Clock 获取时间，禁止直接 new Date()。
 */

export interface Clock {
  now(): Date;
  /** 便于测试推进时间 */
  advanceDays(days: number): void;
  advanceMs(ms: number): void;
  set(instant: Date | string): void;
}

/** 生产环境：真实时间 */
export class SystemClock implements Clock {
  now(): Date {
    return new Date();
  }

  advanceDays(): void {
    throw new Error('SystemClock 不支持推进时间');
  }

  advanceMs(): void {
    throw new Error('SystemClock 不支持推进时间');
  }

  set(): void {
    throw new Error('SystemClock 不支持设置时间');
  }
}

/** 测试与演示环境：可控时间 */
export class FakeClock implements Clock {
  private current: Date;

  constructor(start: Date | string = new Date('2026-01-01T00:00:00.000Z')) {
    this.current = typeof start === 'string' ? new Date(start) : new Date(start.getTime());
  }

  now(): Date {
    return new Date(this.current.getTime());
  }

  advanceDays(days: number): void {
    this.advanceMs(days * 24 * 60 * 60 * 1000);
  }

  advanceMs(ms: number): void {
    this.current = new Date(this.current.getTime() + ms);
  }

  set(instant: Date | string): void {
    this.current = typeof instant === 'string' ? new Date(instant) : new Date(instant.getTime());
  }
}
