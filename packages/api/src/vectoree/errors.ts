export class VectoreeConfigError extends Error {
  readonly status: 400 | 502;

  constructor(message: string, status: 400 | 502 = 400) {
    super(message);
    this.name = 'VectoreeConfigError';
    this.status = status;
  }
}
