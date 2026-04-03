const { connect } = require("puppeteer-real-browser");

let _browser = null;
let _page = null;
let _launching = null; // prevents concurrent launches

/**
 * Get or launch the persistent browser with Turnstile auto-solve
 */
async function getBrowser() {
  if (_browser && _browser.connected) return _browser;

  // If already launching, wait for it
  if (_launching) return _launching;

  _launching = (async () => {
    console.log("[CF-BYPASS] Launching real browser with Turnstile solver...");

    const { page, browser } = await connect({
      headless: false, // Headed mode via xvfb
      turnstile: true, // Auto-solve Cloudflare Turnstile
      args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage"],
    });

    _browser = browser;
    _page = page; // Keep a reference to the initial page

    _launching = null;

    // Auto-relaunch if browser disconnects
    browser.on("disconnected", () => {
      console.log("[CF-BYPASS] Browser disconnected, will relaunch on next request");
      _browser = null;
      _page = null;
    });

    console.log("[CF-BYPASS] Real browser launched successfully");
    return browser;
  })();

  return _launching;
}

/**
 * Close browser instance
 */
async function closeBrowser() {
  try {
    if (_browser) await _browser.close().catch(() => {});
  } catch {}
  _browser = null;
  _page = null;
}

const closeChrome = closeBrowser;

/**
 * Wait for Cloudflare challenge to resolve on a page
 */
async function waitForCfChallenge(page, maxWaitMs = 60000) {
  const startTime = Date.now();

  while (Date.now() - startTime < maxWaitMs) {
    let title;
    try {
      title = await page.title();
    } catch {
      await new Promise((r) => setTimeout(r, 2000));
      continue;
    }

    if (
      !title.includes("Just a moment") &&
      !title.includes("Attention Required")
    ) {
      return true;
    }

    console.log("[CF-BYPASS] Waiting for CF challenge...");
    await new Promise((r) => setTimeout(r, 2000));
  }

  return false;
}

/**
 * Solve Cloudflare challenge and extract cookies.
 */
async function solveCloudflareCookies(targetUrl, maxWaitMs = 60000) {
  const browser = await getBrowser();
  const page = await browser.newPage();

  try {
    console.log(`[CF-BYPASS] Navigating to ${targetUrl}...`);
    await page.goto(targetUrl, { waitUntil: "domcontentloaded", timeout: 45000 });

    const resolved = await waitForCfChallenge(page, maxWaitMs);
    if (resolved) {
      console.log("[CF-BYPASS] Cloudflare challenge solved!");
    } else {
      console.warn("[CF-BYPASS] Challenge timeout, extracting cookies anyway");
    }

    const allCookies = await page.cookies();
    const userAgent = await page.evaluate(() => navigator.userAgent);

    const cookieString = allCookies
      .map((c) => `${c.name}=${c.value}`)
      .join("; ");

    console.log(`[CF-BYPASS] Got ${allCookies.length} cookies: ${allCookies.map(c => c.name).join(", ")}`);

    await page.close();

    return {
      cookies: cookieString,
      cookieArray: allCookies,
      userAgent,
    };
  } catch (err) {
    await page.close().catch(() => {});
    throw err;
  }
}

/**
 * Fetch a page using the browser directly.
 * puppeteer-real-browser auto-solves Turnstile.
 */
async function browserFetch(url) {
  const browser = await getBrowser();
  const page = await browser.newPage();

  try {
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 45000 });

    // Wait for CF if needed
    const title = await page.title().catch(() => "");
    if (title.includes("Just a moment")) {
      console.log("[CF-BYPASS] Challenge on fetched page, waiting...");
      await waitForCfChallenge(page, 30000);
    }

    // Wait a bit for JS rendering
    await new Promise((r) => setTimeout(r, 500));

    const content = await page.content();
    const cookies = await page.cookies();
    const userAgent = await page.evaluate(() => navigator.userAgent);
    const cookieString = cookies.map((c) => `${c.name}=${c.value}`).join("; ");

    await page.close();

    return {
      body: content,
      cookies: cookieString,
      cookieArray: cookies,
      userAgent,
    };
  } catch (err) {
    await page.close().catch(() => {});
    throw err;
  }
}

// Cleanup on exit
process.on("exit", () => {
  closeChrome();
});

module.exports = {
  solveCloudflareCookies,
  browserFetch,
  closeChrome,
};
