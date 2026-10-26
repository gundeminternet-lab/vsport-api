// Sunucu hata türü. code: 'invalid-argument' | 'not-found' | 'failed-precondition' | 'permission-denied' |
// 'subscription-required' | 'resource-exhausted' | 'unavailable' | 'internal'. HTTP karşılıkları app.js'tedir.
export class AppError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}
