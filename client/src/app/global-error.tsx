/* Last-resort boundary: catches throws in the ROOT layout itself (providers,
   i18n bootstrap), where app/error.tsx can't help. Replaces the entire document,
   so it must render its own <html>/<body> and cannot rely on globals.css or the
   design system having loaded — styles are self-contained by design. */
"use client";

export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <html lang="en">
      <body
        style={{
          margin: 0,
          minHeight: "100vh",
          display: "grid",
          placeItems: "center",
          background: "#0d1117",
          color: "#e6edf3",
          fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif",
        }}
      >
        <div style={{ textAlign: "center", padding: 24, maxWidth: 420 }}>
          <h1 style={{ fontSize: 18, marginBottom: 8 }}>DevDigest crashed</h1>
          <p style={{ fontSize: 14, color: "#8b949e", lineHeight: 1.5 }}>
            The app shell failed to render{error.digest ? ` (digest ${error.digest})` : ""}. Try
            again, or restart the dev server if it persists.
          </p>
          <button
            onClick={reset}
            style={{
              marginTop: 16,
              padding: "8px 18px",
              borderRadius: 8,
              border: "1px solid #30363d",
              background: "#21262d",
              color: "#e6edf3",
              fontSize: 14,
              cursor: "pointer",
            }}
          >
            Try again
          </button>
        </div>
      </body>
    </html>
  );
}
