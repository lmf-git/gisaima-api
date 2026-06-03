import { apiError } from '../core/auth.js';

const MAX_BODY_BYTES = 1e6; // 1 MB

export async function readBody(req) {
  return new Promise((resolve, reject) => {
    let raw  = '';
    let done = false;
    const fail = (err) => { if (done) return; done = true; req.destroy(); reject(err); };

    req.on('data', c => {
      if (done) return;
      raw += c;
      // Stop buffering the moment we exceed the cap so a flood can't grow memory.
      if (raw.length > MAX_BODY_BYTES) fail(apiError(413, 'too large'));
    });
    req.on('end', () => {
      if (done) return;
      done = true;
      if (!raw) return resolve({});
      try { resolve(JSON.parse(raw)); }
      catch { reject(apiError(400, 'invalid JSON')); }
    });
    req.on('error', fail);
  });
}
