import { apiError } from '../core/auth.js';

export async function readBody(req) {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', c => { raw += c; if (raw.length > 1e6) reject(apiError(413, 'too large')); });
    req.on('end', () => {
      if (!raw) return resolve({});
      try { resolve(JSON.parse(raw)); }
      catch { reject(apiError(400, 'invalid JSON')); }
    });
    req.on('error', reject);
  });
}
