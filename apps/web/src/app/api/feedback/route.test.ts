import { describe, expect, it, vi, beforeEach } from 'vitest';
import { POST } from './route';

function makeRequest(body: unknown): Request {
  return new Request('http://localhost:3001/api/feedback', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

describe('POST /api/feedback', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.spyOn(console, 'info').mockImplementation(() => {});
  });

  it('returns 201 for valid feedback', async () => {
    const res = await POST(makeRequest({
      type: 'bug',
      message: 'Something broke',
      email: 'test@example.com',
    }) as never);
    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({ ok: true });
  });

  it('returns 400 for missing message', async () => {
    const res = await POST(makeRequest({ type: 'general', message: '' }) as never);
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe('Message is required');
  });

  it('returns 400 for invalid type', async () => {
    const res = await POST(makeRequest({ type: 'spam', message: 'hello' }) as never);
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe('Invalid feedback type');
  });

  it('returns 400 for message exceeding 5000 chars', async () => {
    const res = await POST(makeRequest({
      type: 'general',
      message: 'x'.repeat(5001),
    }) as never);
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe('Message too long (max 5000 chars)');
  });

  it('returns 400 for invalid email format', async () => {
    const res = await POST(makeRequest({
      type: 'general',
      message: 'hello',
      email: 'not-an-email',
    }) as never);
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe('Invalid email format');
  });

  it('accepts feedback without email', async () => {
    const res = await POST(makeRequest({
      type: 'feature',
      message: 'Please add export',
    }) as never);
    expect(res.status).toBe(201);
  });

  it('returns 400 for invalid JSON', async () => {
    const req = new Request('http://localhost:3001/api/feedback', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: 'not-json',
    });
    const res = await POST(req as never);
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe('Invalid JSON');
  });

  it('logs feedback to console', async () => {
    const spy = vi.spyOn(console, 'info');
    await POST(makeRequest({
      type: 'general',
      message: 'Nice app',
    }) as never);
    expect(spy).toHaveBeenCalledWith('[feedback]', expect.stringContaining('"Nice app"'));
  });
});
