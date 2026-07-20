/** Edge runtime entry point for the application. */
import { handleImageOptimization, DEFAULT_DEVICE_SIZES, DEFAULT_IMAGE_SIZES } from "vinext/server/image-optimization";
import handler from "vinext/server/app-router-entry";

interface AssetFetcher {
  fetch(request: Request): Promise<Response>;
}

interface Env {
  ASSETS: AssetFetcher;
  IMAGES: {
    input(stream: ReadableStream): {
      transform(options: Record<string, unknown>): {
        output(options: { format: string; quality: number }): Promise<{ response(): Response }>;
      };
    };
  };
}

interface ExecutionContext {
  waitUntil(promise: Promise<unknown>): void;
  passThroughOnException(): void;
}

const BASE_SECURITY_HEADERS: Readonly<Record<string, string>> = {
  "Cross-Origin-Resource-Policy": "same-origin",
  "Permissions-Policy": "camera=(), geolocation=(), microphone=()",
  "Referrer-Policy": "no-referrer",
  "Strict-Transport-Security": "max-age=31536000; includeSubDomains",
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
};

function contentSecurityPolicy(scriptNonce?: string): string {
  return [
    "default-src 'self'",
    "base-uri 'self'",
    "connect-src 'self'",
    "font-src 'self' data:",
    "form-action 'self'",
    "frame-ancestors 'none'",
    "img-src 'self' data: blob:",
    "object-src 'none'",
    `script-src 'self'${scriptNonce ? ` 'nonce-${scriptNonce}'` : ""}`,
    "script-src-attr 'none'",
    "style-src 'self' 'unsafe-inline'",
    "worker-src 'self' blob:",
  ].join("; ");
}

function createScriptNonce(): string {
  const bytes = new Uint8Array(18);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function withSecurityHeaders(response: Response, scriptNonce?: string): Response {
  const headers = new Headers(response.headers);
  Object.entries(BASE_SECURITY_HEADERS).forEach(([name, value]) => headers.set(name, value));
  headers.set("Content-Security-Policy", contentSecurityPolicy(scriptNonce));
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

function requestWithCspNonce(request: Request): { request: Request; nonce?: string } {
  const acceptsHtml = /(?:^|,)\s*text\/html\b/i.test(request.headers.get("accept") ?? "");
  if (!acceptsHtml) return { request };

  const nonce = createScriptNonce();
  const headers = new Headers(request.headers);
  headers.set("x-nonce", nonce);
  // Next/vinext reads the request CSP during SSR and applies its nonce only to
  // framework-generated scripts. The response body remains streaming.
  headers.set("Content-Security-Policy", contentSecurityPolicy(nonce));
  return { request: new Request(request, { headers }), nonce };
}

// Image security config. SVG sources with .svg extension auto-skip the
// optimization endpoint on the client side (served directly, no proxy).
// To route SVGs through the optimizer (with security headers), set
// dangerouslyAllowSVG: true in next.config.js and uncomment below:
// const imageConfig: ImageConfig = { dangerouslyAllowSVG: true };

const worker = {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/_vinext/image") {
      const allowedWidths = [...DEFAULT_DEVICE_SIZES, ...DEFAULT_IMAGE_SIZES];
      const response = await handleImageOptimization(request, {
        fetchAsset: (path) => env.ASSETS.fetch(new Request(new URL(path, request.url))),
        transformImage: async (body, { width, format, quality }) => {
          const result = await env.IMAGES.input(body).transform(width > 0 ? { width } : {}).output({ format, quality });
          return result.response();
        },
      }, allowedWidths);
      return withSecurityHeaders(response);
    }

    const securedRequest = requestWithCspNonce(request);
    return withSecurityHeaders(
      await handler.fetch(securedRequest.request, env, ctx),
      securedRequest.nonce,
    );
  },
};

export default worker;
