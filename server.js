const express = require("express");
const fetch = require("node-fetch");
const cheerio = require("cheerio");
const compression = require("compression");
const zlib = require("zlib");
const { HttpsProxyAgent } = require("https-proxy-agent");
const { HttpProxyAgent } = require("http-proxy-agent");

// ============================================================
// CONFIGURATION
// ============================================================
const SOURCE_HOST = process.env.SOURCE_HOST || "id.mgkomik.cc";
const SOURCE_ORIGIN = `https://${SOURCE_HOST}`;
const MIRROR_HOST = process.env.MIRROR_HOST || "mgkomik.co";
const PORT = process.env.PORT || 3000;
const WORKER_URL = process.env.WORKER_URL || "";

// ============================================================
// RESIDENTIAL PROXY ROTATION
// ============================================================
// Format per line: IP:PORT:USER:PASS
const PROXY_LIST_RAW = (process.env.PROXY_LIST || `
209.74.82.48:30000:mgproxy:MgProxy1775215572
209.74.82.48:30001:mgproxy:MgProxy1775215572
209.74.82.48:30002:mgproxy:MgProxy1775215572
209.74.82.48:30003:mgproxy:MgProxy1775215572
209.74.82.48:30004:mgproxy:MgProxy1775215572
209.74.82.48:30005:mgproxy:MgProxy1775215572
209.74.82.48:30006:mgproxy:MgProxy1775215572
209.74.82.48:30007:mgproxy:MgProxy1775215572
209.74.82.48:30008:mgproxy:MgProxy1775215572
209.74.82.48:30009:mgproxy:MgProxy1775215572
`).trim().split("\n").map(l => l.trim()).filter(Boolean);

const proxyUrls = PROXY_LIST_RAW.map(line => {
  const [host, port, user, pass] = line.split(":");
  return `http://${encodeURIComponent(user)}:${encodeURIComponent(pass)}@${host}:${port}`;
});

let proxyIndex = 0;
function getNextProxyUrl() {
  if (proxyUrls.length === 0) return null;
  const url = proxyUrls[proxyIndex % proxyUrls.length];
  proxyIndex++;
  return url;
}

// Create agent for a given proxy URL and target protocol
function makeAgent(proxyUrl, targetUrl) {
  if (targetUrl.startsWith("https:")) {
    return new HttpsProxyAgent(proxyUrl);
  }
  return new HttpProxyAgent(proxyUrl);
}

const MAX_PROXY_RETRIES = Math.min(proxyUrls.length, 3); // try up to 3 different proxies

console.log(`[CONFIG] ${proxyUrls.length} residential proxies (round-robin, ${MAX_PROXY_RETRIES} retries)`);
if (WORKER_URL) console.log(`[CONFIG] CF Worker fallback: ${WORKER_URL}`);

// ============================================================
// RESPONSE CACHE
// ============================================================
const responseCache = new Map();
const CACHE_TTL_HTML = 5 * 60 * 1000;   // 5 minutes for HTML pages
const CACHE_TTL_STATIC = 60 * 60 * 1000; // 1 hour for static assets
const CACHE_MAX_SIZE = 500;

function getCached(key) {
  const entry = responseCache.get(key);
  if (!entry) return null;
  if (Date.now() > entry.expires) {
    responseCache.delete(key);
    return null;
  }
  return entry;
}

function setCache(key, data, ttl) {
  // Evict oldest entries if cache is full
  if (responseCache.size >= CACHE_MAX_SIZE) {
    const oldest = responseCache.keys().next().value;
    responseCache.delete(oldest);
  }
  responseCache.set(key, { ...data, expires: Date.now() + ttl });
}

// ============================================================
// APP SETUP
// ============================================================
const app = express();
app.use(compression());

// Trust proxy for Railway/Render (correct proto detection behind LB)
app.set("trust proxy", true);

// ============================================================
// HELPERS
// ============================================================

/**
 * Determine the mirror origin from the incoming request
 */
function getMirrorOrigin(req) {
  if (MIRROR_HOST) return `https://${MIRROR_HOST}`;
  const proto = req.protocol || "https";
  const host = req.get("x-forwarded-host") || req.get("host") || req.hostname;
  return `${proto}://${host}`;
}

function getMirrorHost(req) {
  if (MIRROR_HOST) return MIRROR_HOST;
  return req.get("x-forwarded-host") || req.get("host") || req.hostname;
}

/**
 * Replace source domain with mirror domain in text.
 * Only replaces the hostname when it appears in a URL/hostname position,
 * NOT when it appears inside a URL path segment (e.g., /cache/perfmatters/id.mgkomik.cc/css/).
 */
function rewriteUrls(text, mirrorOrigin, mirrorHost) {
  if (!text) return text;

  const escapedHost = escapeRegex(SOURCE_HOST);

  // Replace https://SOURCE_HOST and http://SOURCE_HOST
  let result = text.replace(
    new RegExp(`https?://${escapedHost}`, "g"),
    mirrorOrigin
  );

  // Replace protocol-relative //SOURCE_HOST
  result = result.replace(
    new RegExp(`//${escapedHost}(?=/|["'\\s?#]|$)`, "g"),
    `//${mirrorHost}`
  );

  // Replace bare hostname only when it looks like a hostname context:
  // - after quotes: "id.mgkomik.cc  or 'id.mgkomik.cc
  // - standalone word (not preceded by / which would make it a path segment)
  result = result.replace(
    new RegExp(`(?<![/\\w.-])${escapedHost}(?![/\\w.-])`, "g"),
    mirrorHost
  );

  // Replace URL-encoded hostname (e.g. in oembed query params: https%3A%2F%2Fid.mgkomik.cc)
  // Only match when preceded by URL-encoded protocol separator (%2F%2F or %3A%2F%2F)
  const encodedMirror = encodeURIComponent(mirrorHost);
  result = result.replace(
    new RegExp(`(%2F%2F)${escapedHost}`, "gi"),
    `$1${encodedMirror}`
  );

  return result;
}

function escapeRegex(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Decompress response body from fetch
 */
async function getResponseBuffer(res) {
  const chunks = [];
  for await (const chunk of res.body) {
    chunks.push(chunk);
  }
  const raw = Buffer.concat(chunks);

  const encoding = (res.headers.get("content-encoding") || "").trim().toLowerCase();
  try {
    if (encoding === "gzip" || encoding === "x-gzip") {
      return zlib.gunzipSync(raw);
    } else if (encoding === "br") {
      return zlib.brotliDecompressSync(raw);
    } else if (encoding === "deflate") {
      try {
        return zlib.inflateSync(raw);
      } catch {
        return zlib.inflateRawSync(raw);
      }
    }
  } catch (e) {
    // If decompression fails, try returning raw (server may have lied about encoding)
    console.warn(`Decompression (${encoding}) failed, using raw body:`, e.message);
  }
  return raw;
}

/**
 * Check if content type is HTML
 */
function isHtml(contentType) {
  return contentType && contentType.includes("text/html");
}

function isXml(contentType) {
  return (
    contentType &&
    (contentType.includes("text/xml") ||
      contentType.includes("application/xml") ||
      contentType.includes("application/rss+xml") ||
      contentType.includes("application/atom+xml"))
  );
}

function isCssOrJs(contentType) {
  return (
    contentType &&
    (contentType.includes("text/css") ||
      contentType.includes("application/javascript") ||
      contentType.includes("text/javascript") ||
      contentType.includes("application/json"))
  );
}

function isText(contentType) {
  return contentType && contentType.includes("text/");
}

// ============================================================
// GAMBLING / SLOT ADS REMOVAL
// ============================================================

const GAMBLING_AD_DOMAINS = [
  "bergurukecina.fun",
  "menujupenta.site",
  "gacor.zone",
  "terbangrusia.site",
  "akseskaiko.cam",
  "orangarab.fun",
  "kegz.site",
  "goid.space",
  "injd.site",
  "goratu.site",
  "cek.to",
];

const GAMBLING_AD_IMAGES = [
  "cina777",
  "pentaslot",
  "rusia777",
  "kaikoslot",
  "arab777",
  "gaza88",
  "indo666",
  "judi89",
  "ratu89",
  "koko-1",
  "klikhoki",
];

function isGamblingLink(href) {
  if (!href) return false;
  const lower = href.toLowerCase();
  return GAMBLING_AD_DOMAINS.some((d) => lower.includes(d));
}

function isGamblingImage(src) {
  if (!src) return false;
  const lower = src.toLowerCase();
  return GAMBLING_AD_IMAGES.some((k) => lower.includes(k));
}

function removeGamblingAds($) {
  // 1. Remove floating bottom ads container entirely
  $("#floating_ads_bottom_textcss_container").remove();

  // 2. Remove ad divs that contain gambling links (e.g. .c-ads, .body-top-ads, .body-bottom-ads)
  $("div.c-ads, div.body-top-ads, div.body-bottom-ads").each((_, el) => {
    const html = $(el).html() || "";
    if (GAMBLING_AD_DOMAINS.some((d) => html.includes(d)) ||
        GAMBLING_AD_IMAGES.some((k) => html.includes(k))) {
      $(el).remove();
    }
  });

  // 3. Remove standalone gambling <a> tags anywhere in the page
  $("a[rel='nofollow']").each((_, el) => {
    const href = $(el).attr("href") || "";
    const img = $(el).find("img");
    const imgSrc = img.length ? img.attr("src") || "" : "";
    const imgAlt = img.length ? img.attr("alt") || "" : "";

    if (isGamblingLink(href) || isGamblingImage(imgSrc)) {
      $(el).remove();
    }
  });

  // 4. Clean up leftover ad-related images
  $("img").each((_, el) => {
    const src = $(el).attr("src") || "";
    if (isGamblingImage(src)) {
      $(el).remove();
    }
  });
}

// ============================================================
// HTML REWRITING (SEO-focused)
// ============================================================

function rewriteHtml(html, mirrorOrigin, mirrorHost, requestPath) {
  const $ = cheerio.load(html, { decodeEntities: false });

  // --- 0. REMOVE GAMBLING/SLOT ADS ---
  removeGamblingAds($);

  // --- 0b. REPLACE HISTATS COUNTER ---
  $("#histats_counter").remove();
  // Insert inside the footer, centered, with matching dark background
  const histatsHtml = `<!-- Histats.com (div with counter) --><div id="histats_counter" style="display:flex;justify-content:center;padding:10px 0;background:inherit;"></div>
<style>#histats_counter,#histats_counter *{background:transparent!important;}#histats_counter canvas{border-radius:4px;}</style>
<!-- Histats.com START (aync)-->
<script type="text/javascript">var _Hasync= _Hasync|| [];
_Hasync.push(['Histats.start', '1,5018261,4,16,150,30,00010001']);
_Hasync.push(['Histats.fasi', '1']);
_Hasync.push(['Histats.track_hits', '']);
(function() {
var hs = document.createElement('script'); hs.type = 'text/javascript'; hs.async = true;
hs.src = ('//s10.histats.com/js15_as.js');
(document.getElementsByTagName('head')[0] || document.getElementsByTagName('body')[0]).appendChild(hs);
})();</script>
<noscript><a href="/" target="_blank"><img src="//sstatic1.histats.com/0.gif?5018261&101" alt="" border="0"></a></noscript>
<!-- Histats.com END -->`;
  // Try to place inside footer, otherwise append to body
  if ($("footer").length) {
    $("footer").append(histatsHtml);
  } else {
    $("body").append(histatsHtml);
  }

  const canonicalUrl = `${mirrorOrigin}${requestPath}`;

  // --- 1. FIX CANONICAL TAG ---
  // Remove all existing canonical links and add exactly one correct one
  $('link[rel="canonical"]').remove();
  $("head").append(`<link rel="canonical" href="${canonicalUrl}" />`);

  // --- 2. FIX OG:URL ---
  $('meta[property="og:url"]').attr("content", canonicalUrl);

  // --- 3. FIX ALTERNATE/HREFLANG LINKS ---
  $('link[rel="alternate"]').each((_, el) => {
    const href = $(el).attr("href");
    if (href) {
      $(el).attr("href", rewriteUrls(href, mirrorOrigin, mirrorHost));
    }
  });

  // --- 4. FIX ALL HREF AND SRC ATTRIBUTES ---
  $("[href]").each((_, el) => {
    const href = $(el).attr("href");
    if (href && href.includes(SOURCE_HOST)) {
      $(el).attr("href", rewriteUrls(href, mirrorOrigin, mirrorHost));
    }
  });
  $("[src]").each((_, el) => {
    const src = $(el).attr("src");
    if (src && src.includes(SOURCE_HOST)) {
      $(el).attr("src", rewriteUrls(src, mirrorOrigin, mirrorHost));
    }
  });
  $("[srcset]").each((_, el) => {
    const srcset = $(el).attr("srcset");
    if (srcset && srcset.includes(SOURCE_HOST)) {
      $(el).attr("srcset", rewriteUrls(srcset, mirrorOrigin, mirrorHost));
    }
  });
  $("[action]").each((_, el) => {
    const action = $(el).attr("action");
    if (action && action.includes(SOURCE_HOST)) {
      $(el).attr("action", rewriteUrls(action, mirrorOrigin, mirrorHost));
    }
  });
  $("[data-src]").each((_, el) => {
    const src = $(el).attr("data-src");
    if (src && src.includes(SOURCE_HOST)) {
      $(el).attr("data-src", rewriteUrls(src, mirrorOrigin, mirrorHost));
    }
  });
  $("[data-lazy-src]").each((_, el) => {
    const src = $(el).attr("data-lazy-src");
    if (src && src.includes(SOURCE_HOST)) {
      $(el).attr("data-lazy-src", rewriteUrls(src, mirrorOrigin, mirrorHost));
    }
  });

  // --- 5. FIX JSON-LD STRUCTURED DATA ---
  $('script[type="application/ld+json"]').each((_, el) => {
    try {
      let jsonText = $(el).html();
      if (!jsonText) return;

      // Rewrite URLs in JSON-LD
      jsonText = rewriteUrls(jsonText, mirrorOrigin, mirrorHost);

      // Parse and validate/fix the JSON-LD
      let jsonData = JSON.parse(jsonText);
      jsonData = fixStructuredData(jsonData, mirrorOrigin, mirrorHost, requestPath);
      $(el).html(JSON.stringify(jsonData));
    } catch (e) {
      // If JSON is malformed, try to fix it by rewriting URLs only
      let jsonText = $(el).html();
      if (jsonText) {
        $(el).html(rewriteUrls(jsonText, mirrorOrigin, mirrorHost));
      }
    }
  });

  // --- 6. FIX INLINE SCRIPTS (rewrite URLs in JS) ---
  $("script:not([src]):not([type])").each((_, el) => {
    let content = $(el).html();
    if (content && content.includes(SOURCE_HOST)) {
      $(el).html(rewriteUrls(content, mirrorOrigin, mirrorHost));
    }
  });
  $('script[type="text/javascript"]').each((_, el) => {
    if (!$(el).attr("src")) {
      let content = $(el).html();
      if (content && content.includes(SOURCE_HOST)) {
        $(el).html(rewriteUrls(content, mirrorOrigin, mirrorHost));
      }
    }
  });

  // --- 7. FIX INLINE STYLES ---
  $("style").each((_, el) => {
    let content = $(el).html();
    if (content && content.includes(SOURCE_HOST)) {
      $(el).html(rewriteUrls(content, mirrorOrigin, mirrorHost));
    }
  });

  // --- 8. FIX META REFRESH REDIRECTS ---
  $('meta[http-equiv="refresh"]').each((_, el) => {
    const content = $(el).attr("content");
    if (content && content.includes(SOURCE_HOST)) {
      $(el).attr("content", rewriteUrls(content, mirrorOrigin, mirrorHost));
    }
  });

  return $.html();
}

// ============================================================
// STRUCTURED DATA FIXER
// ============================================================

function fixStructuredData(data, mirrorOrigin, mirrorHost, requestPath) {
  if (Array.isArray(data)) {
    return data.map((item) =>
      fixStructuredData(item, mirrorOrigin, mirrorHost, requestPath)
    );
  }

  if (typeof data !== "object" || data === null) {
    return data;
  }

  const fixed = {};
  for (const [key, value] of Object.entries(data)) {
    if (key === "@id" || key === "url" || key === "mainEntityOfPage") {
      if (typeof value === "string") {
        fixed[key] = rewriteUrls(value, mirrorOrigin, mirrorHost);
      } else if (typeof value === "object" && value !== null) {
        fixed[key] = fixStructuredData(value, mirrorOrigin, mirrorHost, requestPath);
      } else {
        fixed[key] = value;
      }
    } else if (key === "itemListElement" && Array.isArray(value)) {
      // Fix BreadcrumbList items
      fixed[key] = value.map((item, index) => {
        const fixedItem = fixStructuredData(
          item,
          mirrorOrigin,
          mirrorHost,
          requestPath
        );
        // Ensure position is a number (fixes "Data terstruktur tidak dapat diurai")
        if (fixedItem.position !== undefined) {
          fixedItem.position = Number(fixedItem.position) || index + 1;
        }
        // Ensure item URL is valid
        if (fixedItem.item) {
          if (typeof fixedItem.item === "string") {
            fixedItem.item = rewriteUrls(fixedItem.item, mirrorOrigin, mirrorHost);
          } else if (typeof fixedItem.item === "object" && fixedItem.item["@id"]) {
            fixedItem.item["@id"] = rewriteUrls(
              fixedItem.item["@id"],
              mirrorOrigin,
              mirrorHost
            );
          }
        }
        return fixedItem;
      });
    } else if (typeof value === "string" && value.includes(SOURCE_HOST)) {
      fixed[key] = rewriteUrls(value, mirrorOrigin, mirrorHost);
    } else if (typeof value === "object") {
      fixed[key] = fixStructuredData(value, mirrorOrigin, mirrorHost, requestPath);
    } else {
      fixed[key] = value;
    }
  }

  return fixed;
}

// ============================================================
// HEALTH CHECK
// ============================================================

app.get("/health", (req, res) => {
  res.status(200).json({ status: "ok", proxies: proxyUrls.length });
});

// ============================================================
// PROXY HANDLER
// ============================================================

app.all("*", async (req, res) => {
  try {
    const mirrorOrigin = getMirrorOrigin(req);
    const mirrorHost = getMirrorHost(req);

    // Build upstream URL
    let upstreamPath = req.originalUrl;
    if (mirrorHost && upstreamPath.includes(mirrorHost)) {
      upstreamPath = upstreamPath.split(mirrorHost).join(SOURCE_HOST);
    }
    const reqHost = req.get("host") || "";
    if (reqHost && reqHost !== mirrorHost && upstreamPath.includes(reqHost)) {
      upstreamPath = upstreamPath.split(reqHost).join(SOURCE_HOST);
    }

    const upstreamUrl = `${SOURCE_ORIGIN}${upstreamPath}`;

    // Build headers to send upstream
    const upstreamHeaders = {};
    const skipHeaders = new Set([
      "host",
      "cf-connecting-ip",
      "cf-ray",
      "cf-visitor",
      "cf-ipcountry",
      "x-forwarded-for",
      "x-forwarded-proto",
      "x-forwarded-host",
      "x-real-ip",
      "connection",
      "transfer-encoding",
      "content-length",
      // Strip Client Hints — mobile browsers send these and CF detects
      // the mismatch with our desktop user-agent → triggers challenge
      "sec-ch-ua",
      "sec-ch-ua-mobile",
      "sec-ch-ua-platform",
      "sec-ch-ua-platform-version",
      "sec-ch-ua-full-version",
      "sec-ch-ua-full-version-list",
      "sec-ch-ua-arch",
      "sec-ch-ua-bitness",
      "sec-ch-ua-model",
      "sec-ch-ua-wow64",
      "sec-fetch-dest",
      "sec-fetch-mode",
      "sec-fetch-site",
      "sec-fetch-user",
    ]);

    for (const [key, value] of Object.entries(req.headers)) {
      if (!skipHeaders.has(key.toLowerCase())) {
        upstreamHeaders[key] = value;
      }
    }

    upstreamHeaders["host"] = SOURCE_HOST;
    upstreamHeaders["accept-encoding"] = "identity";
    upstreamHeaders["user-agent"] = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";
    // Send matching desktop Client Hints so CF doesn't detect a mismatch
    upstreamHeaders["sec-ch-ua"] = '"Google Chrome";v="131", "Chromium";v="131", "Not_A Brand";v="24"';
    upstreamHeaders["sec-ch-ua-mobile"] = "?0";
    upstreamHeaders["sec-ch-ua-platform"] = '"Windows"';
    upstreamHeaders["sec-fetch-dest"] = "document";
    upstreamHeaders["sec-fetch-mode"] = "navigate";
    upstreamHeaders["sec-fetch-site"] = "none";
    upstreamHeaders["sec-fetch-user"] = "?1";

    // Rewrite Referer and Origin headers
    if (upstreamHeaders["referer"]) {
      upstreamHeaders["referer"] = upstreamHeaders["referer"]
        .replace(mirrorOrigin, SOURCE_ORIGIN)
        .replace(mirrorHost, SOURCE_HOST);
    }
    if (upstreamHeaders["origin"]) {
      upstreamHeaders["origin"] = SOURCE_ORIGIN;
    }

    // Buffer body for POST/PUT/PATCH (needed for retries)
    let reqBody = null;
    if (["POST", "PUT", "PATCH"].includes(req.method)) {
      const bodyChunks = [];
      for await (const chunk of req) {
        bodyChunks.push(chunk);
      }
      const body = Buffer.concat(bodyChunks);
      if (body.length > 0) {
        reqBody = body;
      }
    }

    // Fetch with retry: try proxies first, then fallback to direct
    let upstream = null;
    let lastErr = null;

    // 1) Try through residential proxies (round-robin, up to MAX_PROXY_RETRIES)
    for (let attempt = 0; attempt < MAX_PROXY_RETRIES; attempt++) {
      const proxyUrl = getNextProxyUrl();
      if (!proxyUrl) break;
      try {
        const opts = {
          method: req.method,
          headers: { ...upstreamHeaders },
          redirect: "manual",
          agent: makeAgent(proxyUrl, upstreamUrl),
          timeout: 15000,
        };
        if (reqBody) {
          opts.body = reqBody;
          if (req.headers["content-type"]) opts.headers["content-type"] = req.headers["content-type"];
        }
        upstream = await fetch(upstreamUrl, opts);
        break; // success
      } catch (err) {
        const short = proxyUrl.replace(/\/\/.*@/, "//***@");
        console.warn(`[PROXY ${attempt+1}/${MAX_PROXY_RETRIES}] ${short} failed: ${err.message}`);
        lastErr = err;
      }
    }

    // 2) Fallback: direct connection (no proxy)
    if (!upstream) {
      try {
        console.log(`[FALLBACK] All proxies failed, trying direct connection...`);
        const opts = {
          method: req.method,
          headers: { ...upstreamHeaders },
          redirect: "manual",
          timeout: 20000,
        };
        if (reqBody) {
          opts.body = reqBody;
          if (req.headers["content-type"]) opts.headers["content-type"] = req.headers["content-type"];
        }
        upstream = await fetch(upstreamUrl, opts);
      } catch (err) {
        console.error(`[FALLBACK] Direct also failed: ${err.message}`);
        throw lastErr || err;
      }
    }

    // --- Handle redirects: rewrite Location header ---
    if ([301, 302, 303, 307, 308].includes(upstream.status)) {
      let location = upstream.headers.get("location") || "";

      // Rewrite the redirect location to mirror domain
      if (location) {
        location = rewriteUrls(location, mirrorOrigin, mirrorHost);

        // Handle relative redirects
        if (location.startsWith("/")) {
          location = mirrorOrigin + location;
        }
      }

      res.set("Location", location);
      // Copy cache headers
      copyHeaders(upstream, res);
      return res.status(upstream.status).end();
    }

    // --- Copy response headers ---
    copyHeaders(upstream, res);

    // Remove headers that could cause issues
    res.removeHeader("content-encoding");
    res.removeHeader("content-length");
    res.removeHeader("transfer-encoding");

    // Add security headers
    res.set("X-Content-Type-Options", "nosniff");
    res.set("X-Frame-Options", "SAMEORIGIN");

    // Add cache headers for static assets (speed up loading)
    const isStaticAsset = /\.(js|css|png|jpg|jpeg|gif|webp|svg|ico|woff2?|ttf|eot|otf)(\?|$)/i.test(req.path);
    if (isStaticAsset && upstream.status === 200) {
      res.set("Cache-Control", "public, max-age=86400, s-maxage=86400"); // 1 day
    }

    const contentType = upstream.headers.get("content-type") || "";

    // --- PROCESS HTML ---
    if (isHtml(contentType)) {
      const buffer = await getResponseBuffer(upstream);
      let html = buffer.toString("utf-8");

      // Detect CF challenge page — don't serve it to users
      if (
        html.includes("Just a moment") ||
        html.includes("challenge-platform") ||
        html.includes("cf-chl-widget")
      ) {
        console.warn(`[CF-CHALLENGE] Blocked on ${req.path} — serving from cache or error`);

        // Try serving from cache
        const cached = getCached(`html:${req.path}`);
        if (cached) {
          console.log(`[CACHE] Serving cached version of ${req.path}`);
          res.set("Content-Type", "text/html; charset=utf-8");
          res.set("X-Cache", "HIT-CF-FALLBACK");
          return res.status(200).send(cached.body);
        }

        // No cache — return friendly reload page
        return res.status(503).set("Retry-After", "5").send(
          `<!DOCTYPE html><html><head><meta charset="utf-8"><title>Loading...</title>` +
          `<meta http-equiv="refresh" content="5">` +
          `</head><body style="font-family:sans-serif;text-align:center;padding:60px">` +
          `<h2>Halaman sedang dimuat...</h2>` +
          `<p>Refresh otomatis dalam 5 detik.</p></body></html>`
        );
      }

      // --- REWRITE HTML ---
      html = rewriteHtml(html, mirrorOrigin, mirrorHost, req.path);

      // Final pass: rewrite any remaining URLs in the raw HTML string
      html = rewriteUrls(html, mirrorOrigin, mirrorHost);

      // Cache the successful response
      setCache(`html:${req.path}`, { body: html, contentType }, CACHE_TTL_HTML);

      res.set("Content-Type", contentType);
      res.set("X-Cache", "MISS");
      return res.status(upstream.status).send(html);
    }

    // --- REWRITE XML (sitemaps, RSS feeds) ---
    if (isXml(contentType) || req.path.match(/sitemap.*\.xml/i) || req.path === "/robots.txt") {
      const buffer = await getResponseBuffer(upstream);
      let text = buffer.toString("utf-8");
      text = rewriteUrls(text, mirrorOrigin, mirrorHost);

      res.set("Content-Type", contentType || "text/xml; charset=utf-8");
      return res.status(upstream.status).send(text);
    }

    // --- REWRITE CSS / JS / JSON ---
    if (isCssOrJs(contentType)) {
      const buffer = await getResponseBuffer(upstream);
      let text = buffer.toString("utf-8");
      text = rewriteUrls(text, mirrorOrigin, mirrorHost);

      res.set("Content-Type", contentType);
      return res.status(upstream.status).send(text);
    }

    // --- REWRITE robots.txt ---
    if (req.path === "/robots.txt") {
      const buffer = await getResponseBuffer(upstream);
      let text = buffer.toString("utf-8");
      text = rewriteUrls(text, mirrorOrigin, mirrorHost);

      // Ensure sitemap URL points to mirror
      if (!text.includes("Sitemap:")) {
        text += `\nSitemap: ${mirrorOrigin}/sitemap.xml\n`;
      }

      res.set("Content-Type", "text/plain; charset=utf-8");
      return res.status(upstream.status).send(text);
    }

    // --- OTHER TEXT CONTENT ---
    if (isText(contentType)) {
      const buffer = await getResponseBuffer(upstream);
      let text = buffer.toString("utf-8");
      text = rewriteUrls(text, mirrorOrigin, mirrorHost);

      res.set("Content-Type", contentType);
      return res.status(upstream.status).send(text);
    }

    // --- BINARY (images, fonts, etc.) - stream directly ---
    res.status(upstream.status);
    upstream.body.pipe(res);
  } catch (err) {
    console.error(`[PROXY ERROR] ${req.method} ${req.originalUrl}:`, err.message);

    // Return 502 instead of 404 for upstream errors (so Google knows it's temporary)
    res.status(502).send("Bad Gateway - upstream temporarily unavailable");
  }
});

/**
 * Copy response headers from upstream, excluding problematic ones
 */
function copyHeaders(upstream, res) {
  const skip = new Set([
    "content-encoding",
    "content-length",
    "transfer-encoding",
    "connection",
    "keep-alive",
    "alt-svc",
    "strict-transport-security",
    "content-security-policy",
    "x-frame-options",
  ]);

  upstream.headers.forEach((value, key) => {
    if (!skip.has(key.toLowerCase())) {
      res.set(key, value);
    }
  });
}

// ============================================================
// START SERVER
// ============================================================
app.listen(PORT, "0.0.0.0", () => {
  console.log(`Mirror proxy running on port ${PORT}`);
  console.log(`Proxying: ${SOURCE_ORIGIN} -> http://0.0.0.0:${PORT}`);
  console.log(`Mirror host: ${MIRROR_HOST || "(auto-detect from request)"}`);
  console.log(`Proxies: ${proxyUrls.length} residential IPs (round-robin, ${MAX_PROXY_RETRIES} retries, direct fallback)`);
});

// Graceful shutdown
process.on("SIGINT", () => process.exit(0));
process.on("SIGTERM", () => process.exit(0));

// Prevent unhandled errors from crashing the server
process.on("unhandledRejection", (err) => {
  console.error("[UNHANDLED REJECTION]", err);
});
process.on("uncaughtException", (err) => {
  console.error("[UNCAUGHT EXCEPTION]", err);
});
