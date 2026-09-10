/** @param {import('node:http').ServerResponse} res */
function requestTooLarge(res) {
  res.writeHead(413, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ error: 'payload_too_large' }));
}

/**
 * Buffers a request only up to its configured limit. This must happen before
 * authentication because unauthenticated clients control the request body.
 *
 * @param {import('node:http').IncomingMessage} req
 * @param {import('node:http').ServerResponse} res
 * @param {number} maxBytes
 * @returns {Promise<string|null>} null means a 413 response was sent
 */
export function readRequestBody(req, res, maxBytes) {
  return new Promise((resolve) => {
    /** @type {Buffer[]} */
    const chunks = [];
    let size = 0;
    let rejected = false;

    req.on('data', (chunk) => {
      if (rejected) return;
      size += chunk.length;
      if (size > maxBytes) {
        rejected = true;
        requestTooLarge(res);
        // Continue draining without retaining data so the 413 response can be
        // delivered while an attacker cannot grow this process's memory.
        req.resume();
        resolve(null);
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (!rejected) resolve(Buffer.concat(chunks).toString('utf8'));
    });
    req.on('error', () => {
      if (!rejected) resolve(null);
    });
  });
}
