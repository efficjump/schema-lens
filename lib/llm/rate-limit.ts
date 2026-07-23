import { getLlmConfig, getLlmRateLimitPerMinute } from "@/lib/llm/config";
import { LlmServiceError } from "@/lib/llm/provider";

const WINDOW_MS = 60_000;
const buckets = new Map<string, { count: number; resetAt: number }>();

function requesterIdentity(request: Request): string {
  const authenticatedUser = request.headers.get("x-authenticated-user-email");
  if (authenticatedUser) return `user:${authenticatedUser}`;

  const connectingIp = request.headers.get("cf-connecting-ip");
  if (connectingIp) return `ip:${connectingIp}`;

  const forwardedIp = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim();
  if (forwardedIp) return `ip:${forwardedIp}`;

  return "anonymous";
}

function pruneExpiredBuckets(now: number): void {
  if (buckets.size < 1_000) return;
  for (const [key, bucket] of buckets) {
    if (bucket.resetAt <= now) buckets.delete(key);
  }
}

/**
 * Best-effort per-isolate cost guard. Production deployments should also use
 * platform access control and a distributed rate limit at the edge.
 */
export function enforceLlmRateLimit(request: Request): void {
  if (!getLlmConfig().configured) return;

  const limit = getLlmRateLimitPerMinute();
  if (limit === 0) return;

  const now = Date.now();
  pruneExpiredBuckets(now);
  const key = requesterIdentity(request);
  const current = buckets.get(key);
  const bucket =
    current && current.resetAt > now
      ? current
      : { count: 0, resetAt: now + WINDOW_MS };

  if (bucket.count >= limit) {
    const retryAfterSeconds = Math.max(1, Math.ceil((bucket.resetAt - now) / 1_000));
    throw new LlmServiceError({
      code: "LLM_RATE_LIMITED",
      message: "Too many LLM requests were received. Try again shortly.",
      httpStatus: 429,
      retryable: true,
      retryAfterSeconds,
    });
  }

  bucket.count += 1;
  buckets.set(key, bucket);
}
