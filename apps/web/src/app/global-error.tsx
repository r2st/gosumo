'use client';

export default function GlobalError({
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <html lang="en">
      <body>
        <style dangerouslySetInnerHTML={{ __html: `
          body { margin: 0; font-family: system-ui, sans-serif; background-color: #fafafa; color: #111; }
          .ge-wrap { display: flex; flex-direction: column; align-items: center; justify-content: center; min-height: 100vh; padding: 1rem; text-align: center; }
          .ge-heading { font-size: 1.25rem; font-weight: 600; margin-bottom: 0.5rem; }
          .ge-body { font-size: 0.875rem; color: #666; max-width: 28rem; margin-bottom: 1rem; }
          .ge-btn { padding: 0.5rem 1rem; font-size: 0.875rem; font-weight: 500; border: 1px solid #ddd; border-radius: 0.375rem; cursor: pointer; background-color: #fff; color: #111; }
          @media (prefers-color-scheme: dark) {
            body { background-color: #0A0A0B; color: #e5e5e5; }
            .ge-body { color: #999; }
            .ge-btn { background-color: #1a1a1b; border-color: #333; color: #e5e5e5; }
          }
        ` }} />
        <div className="ge-wrap">
          <h1 className="ge-heading">Something went wrong</h1>
          <p className="ge-body">
            An unexpected error occurred. Please try again, or contact support if the problem persists.
          </p>
          <button onClick={reset} className="ge-btn">
            Try again
          </button>
        </div>
      </body>
    </html>
  );
}
