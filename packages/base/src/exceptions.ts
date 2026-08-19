/**
 * Signals a *platform* failure on the request/response path: a timeout, a
 * dropped connection, a malformed response — anything that is not a valid
 * protocol response. The SDK treats these as retriable and distinct from
 * protocol-level errors, so every `Network` implementation must throw this
 * (and only this) for platform failures.
 */
export class ResonateTimeoutException extends Error {
  constructor(cause: string) {
    super(`platform failure: ${cause}`);
    this.name = "ResonateTimeoutException";
  }
}
