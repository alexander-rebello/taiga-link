export class TaigaError extends Error {
  readonly exitCode: number;

  constructor(message: string, exitCode = 1) {
    super(message);
    this.name = 'TaigaError';
    this.exitCode = exitCode;
  }
}
