export class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}
export const httpError = (status, message) => new HttpError(status, message);

// Setup problems (missing Vercel variables) are shown to the admin with their real cause.
export const configError = (message) => {
  const err = new Error(message);
  err.status = 503;
  err.expose = true;
  return err;
};
