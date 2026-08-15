import {
  AUDIO_CONTENT_TYPE_PREFIXES,
  MAX_MEDIA_DOWNLOAD_BYTES,
  MediaTooLargeError,
  UnexpectedContentTypeError,
  assertContentType,
  isFetchableMediaUrl,
  readBodyWithLimit,
} from './media-download.util';

/**
 * A Response whose body streams `chunks` back one at a time.
 *
 * Built by hand rather than with `new Response(...)` so a test can declare a
 * `content-length` that disagrees with what the body actually sends — which is
 * the whole hostile case the running total exists to catch.
 */
function streamingResponse(
  chunks: Uint8Array[],
  headers: Record<string, string> = {},
): { response: Response; cancelled: () => boolean } {
  let cancelled = false;
  let i = 0;
  const reader = {
    read: () =>
      Promise.resolve(
        i < chunks.length ? { done: false, value: chunks[i++]! } : { done: true, value: undefined },
      ),
    cancel: () => {
      cancelled = true;
      return Promise.resolve();
    },
  };
  const response = {
    headers: new Headers(headers),
    body: { getReader: () => reader },
  } as unknown as Response;
  return { response, cancelled: () => cancelled };
}

function bytes(n: number): Uint8Array {
  return new Uint8Array(n).fill(7);
}

describe('readBodyWithLimit', () => {
  it('returns the whole body when it is under the limit', async () => {
    const { response } = streamingResponse([bytes(4), bytes(6)]);

    const buf = await readBodyWithLimit(response, { service: 'Test' });

    expect(buf).toHaveLength(10);
    expect(buf[0]).toBe(7);
  });

  it('refuses an oversized content-length before reading a byte', async () => {
    const { response, cancelled } = streamingResponse([bytes(1)], {
      'content-length': String(MAX_MEDIA_DOWNLOAD_BYTES + 1),
    });

    await expect(readBodyWithLimit(response, { service: 'Test' })).rejects.toBeInstanceOf(
      MediaTooLargeError,
    );
    // Never opened the stream at all.
    expect(cancelled()).toBe(false);
  });

  it('stops a body that exceeds the limit despite a small declared length', async () => {
    // The header says 4 bytes; the body keeps going. Only the running total
    // catches this one.
    const { response, cancelled } = streamingResponse([bytes(4), bytes(4), bytes(4)], {
      'content-length': '4',
    });

    await expect(
      readBodyWithLimit(response, { service: 'Test', maxBytes: 6 }),
    ).rejects.toBeInstanceOf(MediaTooLargeError);
    // And the connection is released rather than left dangling mid-stream.
    expect(cancelled()).toBe(true);
  });

  it('stops a chunked body that declares no length at all', async () => {
    const { response } = streamingResponse([bytes(5), bytes(5), bytes(5)]);

    await expect(
      readBodyWithLimit(response, { service: 'Test', maxBytes: 8 }),
    ).rejects.toThrow(/over the 8-byte limit/);
  });

  it('reports the service it was downloading for', async () => {
    const { response } = streamingResponse([bytes(9)]);

    await expect(
      readBodyWithLimit(response, { service: 'WhatsApp Media', maxBytes: 2 }),
    ).rejects.toThrow(/WhatsApp Media/);
  });

  it('treats a body-less response as empty rather than an error', async () => {
    const response = { headers: new Headers(), body: null } as unknown as Response;

    await expect(readBodyWithLimit(response, { service: 'Test' })).resolves.toHaveLength(0);
  });

  it('ignores a missing or unparseable content-length', async () => {
    const { response } = streamingResponse([bytes(3)], { 'content-length': 'banana' });

    await expect(readBodyWithLimit(response, { service: 'Test' })).resolves.toHaveLength(3);
  });
});

describe('assertContentType', () => {
  it.each(['audio/ogg', 'audio/mpeg; codecs=mp3', 'video/mp4', 'application/octet-stream'])(
    'accepts %s',
    (contentType) => {
      expect(() => assertContentType('Test', contentType)).not.toThrow();
    },
  );

  it.each(['text/html', 'application/json', 'text/plain;charset=utf-8'])(
    'rejects %s — the shape an SSRF target answers in',
    (contentType) => {
      expect(() => assertContentType('Test', contentType)).toThrow(UnexpectedContentTypeError);
    },
  );

  it('is case-insensitive', () => {
    expect(() => assertContentType('Test', 'AUDIO/OGG')).not.toThrow();
  });

  it('allows a missing header — the size cap is the real bound', () => {
    expect(() => assertContentType('Test', null)).not.toThrow();
  });

  it('names what it expected', () => {
    expect(() => assertContentType('Test', 'text/html')).toThrow(
      new RegExp(AUDIO_CONTENT_TYPE_PREFIXES[0]!),
    );
  });
});

describe('isFetchableMediaUrl', () => {
  it('accepts an https URL', () => {
    expect(isFetchableMediaUrl('https://cdn.example.com/voice.ogg')).toBe(true);
  });

  it.each([
    ['http://169.254.169.254/latest/meta-data/', 'the cloud metadata endpoint'],
    ['http://localhost:6379/', 'a local service'],
    ['http://10.0.0.5/internal', 'a private-range host'],
    ['file:///etc/passwd', 'a local file'],
    ['ftp://example.com/voice.ogg', 'another scheme'],
  ])('rejects %s (%s)', (url) => {
    expect(isFetchableMediaUrl(url)).toBe(false);
  });

  it.each(['', 'not a url', '//example.com/voice.ogg'])('rejects the unparseable %p', (url) => {
    expect(isFetchableMediaUrl(url)).toBe(false);
  });
});
