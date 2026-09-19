export interface ApiErrorBody {
  error?: string;
  suggestion?: string;
  code?: string;
  category?: string;
  retryable?: boolean;
}

/** `apiRequest` throws `Error("<status>: <response body>")`. Returns the parsed JSON body when the message has that shape. */
export function readApiErrorBody(message: string): ApiErrorBody | null {
  const match = /^\d{3}:\s*(\{[\s\S]*\})\s*$/.exec(message);
  if (!match) return null;
  try {
    const parsed = JSON.parse(match[1]);
    if (!parsed || typeof parsed !== "object") return null;
    const text = (key: string): string | undefined => (typeof parsed[key] === "string" ? parsed[key] : undefined);
    return {
      error: text("error"),
      suggestion: text("suggestion"),
      code: text("code"),
      category: text("category"),
      retryable: typeof parsed.retryable === "boolean" ? parsed.retryable : undefined,
    };
  } catch {
    return null;
  }
}

/** The most useful text for a failed API call: the server's suggestion, else its error, else the raw message. */
export function apiErrorText(error: unknown, fallback: string): string {
  const message = error instanceof Error ? error.message : String(error ?? "");
  const body = readApiErrorBody(message);
  return body?.suggestion || body?.error || message || fallback;
}
