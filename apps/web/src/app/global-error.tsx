'use client';

export default function GlobalError({
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <html lang="en">
      <body style={{ margin: 0, fontFamily: 'system-ui, sans-serif', backgroundColor: '#fafafa', color: '#111' }}>
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', minHeight: '100vh', padding: '1rem', textAlign: 'center' }}>
          <h1 style={{ fontSize: '1.25rem', fontWeight: 600, marginBottom: '0.5rem' }}>Something went wrong</h1>
          <p style={{ fontSize: '0.875rem', color: '#666', maxWidth: '28rem', marginBottom: '1rem' }}>
            An unexpected error occurred. Please try again, or contact support if the problem persists.
          </p>
          <button
            onClick={reset}
            style={{ padding: '0.5rem 1rem', fontSize: '0.875rem', fontWeight: 500, border: '1px solid #ddd', borderRadius: '0.375rem', cursor: 'pointer', backgroundColor: '#fff' }}
          >
            Try again
          </button>
        </div>
      </body>
    </html>
  );
}
