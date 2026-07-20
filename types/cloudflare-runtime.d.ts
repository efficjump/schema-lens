declare module "cloudflare:workers" {
  /** Runtime bindings injected by Cloudflare Workers. */
  export const env: Record<string, unknown>;
}
