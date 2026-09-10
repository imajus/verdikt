import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import { readRequestBody } from './request-body.js';

function fakeRequest() {
  const req = new EventEmitter();
  req.resume = vi.fn();
  return req;
}

function fakeResponse() {
  return { writeHead: vi.fn(), end: vi.fn() };
}

describe('readRequestBody', () => {
  it('returns the complete body when it is within the limit', async () => {
    const req = fakeRequest();
    const res = fakeResponse();
    const body = readRequestBody(req, res, 5);

    req.emit('data', Buffer.from('hello'));
    req.emit('end');

    await expect(body).resolves.toBe('hello');
    expect(res.writeHead).not.toHaveBeenCalled();
  });

  it('returns 413 and does not retain chunks after the byte limit', async () => {
    const req = fakeRequest();
    const res = fakeResponse();
    const body = readRequestBody(req, res, 3);

    req.emit('data', Buffer.from('toolong'));
    req.emit('data', Buffer.alloc(1024 * 1024));
    req.emit('end');

    await expect(body).resolves.toBeNull();
    expect(res.writeHead).toHaveBeenCalledWith(413, { 'content-type': 'application/json' });
    expect(req.resume).toHaveBeenCalled();
  });
});
