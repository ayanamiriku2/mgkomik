/**
 * Cloudflare Worker — Fetch Proxy for mgkomik mirror
 * 
 * Deploy this Worker on Cloudflare (free plan: 100k req/day).
 * It fetches content from id.mgkomik.cc WITHOUT any Cloudflare challenge,
 * because Workers run inside Cloudflare's trusted network.
 *
 * SETUP:
 * 1. Go to https://dash.cloudflare.com → Workers & Pages → Create
 * 2. Name it e.g. "mgkomik-proxy" 
 * 3. Paste this code and Deploy
 * 4. Copy the Worker URL (e.g. https://mgkomik-proxy.YOUR-SUBDOMAIN.workers.dev)
 * 5. Set WORKER_URL=https://mgkomik-proxy.YOUR-SUBDOMAIN.workers.dev in Railway env vars
 *
 * Optional: Add a secret AUTH_KEY for security:
 * - In Worker Settings → Variables → add AUTH_KEY = "your-secret-key"
 * - In Railway env vars → add WORKER_AUTH_KEY = "your-secret-key"
 */

const SOURCE_HOST = "id.mgkomik.cc";
const SOURCE_ORIGIN = `https://${SOURCE_HOST}`;

export default {
  async fetch(request, env) {
    // Optional: Verify auth key
    if (env.AUTH_KEY) {
      const authHeader = request.headers.get("X-Auth-Key");
      if (authHeader !== env.AUTH_KEY) {
        return new Response("Unauthorized", { status: 403 });
      }
    }

    const url = new URL(request.url);
    
    // Build upstream URL
    const upstreamUrl = `${SOURCE_ORIGIN}${url.pathname}${url.search}`;

    // Forward headers, replacing host
    const headers = new Headers(request.headers);
    headers.set("Host", SOURCE_HOST);
    headers.delete("X-Auth-Key"); // Don't forward auth key upstream

    // Fetch from origin
    const response = await fetch(upstreamUrl, {
      method: request.method,
      headers: headers,
      body: request.method !== "GET" && request.method !== "HEAD" ? request.body : undefined,
      redirect: "manual",
    });

    // Return response with CORS headers so Railway can fetch it
    const newHeaders = new Headers(response.headers);
    newHeaders.set("Access-Control-Allow-Origin", "*");
    // Remove security headers that would block the mirror
    newHeaders.delete("Content-Security-Policy");
    newHeaders.delete("X-Frame-Options");

    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers: newHeaders,
    });
  },
};
