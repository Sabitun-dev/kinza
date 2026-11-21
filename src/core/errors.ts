/** An error whose message is safe to show to the user (already in Uzbek). */
export class AppError extends Error {
  constructor(
    message: string,
    public status = 400,
    public code = 'bad_request',
    public details?: unknown,
  ) {
    super(message);
  }
}

export const forbidden = (msg = "Bu amal uchun ruxsat yo'q") => new AppError(msg, 403, 'forbidden');
export const notFound = (msg = 'Topilmadi') => new AppError(msg, 404, 'not_found');
export const bad = (msg: string, details?: unknown) => new AppError(msg, 400, 'bad_request', details);
