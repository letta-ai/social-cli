/**
 * Retry with exponential backoff.
 * Retries on network errors, 429, 5xx. Does not retry 4xx auth/validation.
 */

export interface RetryOpts {
  maxAttempts?: number
  baseDelay?: number // ms
  maxDelay?: number // ms
}

const RETRYABLE_CODES = new Set(["ECONNRESET", "ETIMEDOUT", "ENOTFOUND", "EPIPE", "EAI_AGAIN"])

function isRetryable(err: unknown): boolean {
  if (err instanceof Error) {
    // Network-level errors
    if ("code" in err && RETRYABLE_CODES.has((err as any).code)) return true

    // HTTP status-based errors
    const status = (err as any).status ?? (err as any).statusCode ?? (err as any).data?.status
    if (typeof status === "number") {
      if (status === 429) return true // rate limited
      if (status >= 500) return true // server error
    }

    // twitter-api-v2 wraps rate limits
    if (err.message?.includes("429") || err.message?.includes("Rate limit")) return true
  }
  return false
}

function getRetryAfter(err: unknown): number | null {
  const headers = (err as any)?.headers ?? (err as any)?.rateLimit
  if (headers?.["retry-after"]) {
    const secs = parseInt(headers["retry-after"], 10)
    if (!isNaN(secs)) return secs * 1000
  }
  if (headers?.reset) {
    const resetAt = typeof headers.reset === "number" ? headers.reset * 1000 : Date.parse(headers.reset)
    if (!isNaN(resetAt)) return Math.max(0, resetAt - Date.now())
  }
  return null
}

export async function withRetry<T>(
  fn: () => Promise<T>,
  opts?: RetryOpts,
): Promise<T> {
  const maxAttempts = opts?.maxAttempts ?? 3
  const baseDelay = opts?.baseDelay ?? 1000
  const maxDelay = opts?.maxDelay ?? 30000

  let lastErr: unknown
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      return await fn()
    } catch (err) {
      lastErr = err
      if (attempt >= maxAttempts - 1 || !isRetryable(err)) throw err

      const retryAfter = getRetryAfter(err)
      const delay = retryAfter ?? Math.min(baseDelay * 2 ** attempt, maxDelay)
      await new Promise((r) => setTimeout(r, delay))
    }
  }
  throw lastErr
}
