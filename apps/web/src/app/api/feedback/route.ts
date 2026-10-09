import { NextResponse, type NextRequest } from 'next/server';

interface FeedbackPayload {
  type: 'bug' | 'feature' | 'general';
  message: string;
  email?: string;
  url?: string;
  userAgent?: string;
}

const VALID_TYPES = new Set(['bug', 'feature', 'general']);

export async function POST(req: NextRequest) {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
  }

  const { type, message, email, url, userAgent } = body as FeedbackPayload;

  if (!type || !VALID_TYPES.has(type)) {
    return NextResponse.json({ error: 'Invalid feedback type' }, { status: 400 });
  }
  if (!message || typeof message !== 'string' || message.trim().length === 0) {
    return NextResponse.json({ error: 'Message is required' }, { status: 400 });
  }
  if (message.length > 5000) {
    return NextResponse.json({ error: 'Message too long (max 5000 chars)' }, { status: 400 });
  }
  if (email && typeof email === 'string' && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return NextResponse.json({ error: 'Invalid email format' }, { status: 400 });
  }

  const feedback = {
    type,
    message: message.trim(),
    email: email?.trim(),
    url,
    userAgent,
    timestamp: new Date().toISOString(),
  };

  // Log for now; swap for a database insert or external service later.
  console.info('[feedback]', JSON.stringify(feedback));

  return NextResponse.json({ ok: true }, { status: 201 });
}
