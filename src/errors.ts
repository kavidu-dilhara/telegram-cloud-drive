/** Thrown when the database cannot answer, so the request fails as a service problem (503), not as bad input. */
export class ServiceUnavailableError extends Error {
  constructor(message = "A required service is unavailable") {
    super(message);
    this.name = "ServiceUnavailableError";
  }
}
