'use strict';

require('dotenv').config();
const express = require('express');
const puppeteer = require('puppeteer-core');

const app = express();
app.use(express.json({ limit: '50mb' }));

// ── State ─────────────────────────────────────────────────
let cachedBrowser   = null;
let requestCount    = 0;
let lastRequestTime = 0;
let isLaunching     = false;

const MAX_REQUESTS_BEFORE_RECYCLE = 8;
const MAX_IDLE_MS = 3 * 60 * 1000;

async function closeBrowser(browser) {
  if (!browser) return;
  try { await browser.close(); } catch (_) {}
  // Force-kill by PID if the process is still alive after close()
  try {
    const proc = browser.process();
    if (proc && proc.pid) {
      process.kill(proc.pid, 'SIGKILL');
      console.log(`Force-killed chromium pid ${proc.pid}`);
    }
  } catch (_) {}
}

// ── Chrome args ────────────────────────────────────────────
const CHROME_ARGS = [
  '--no-sandbox',
  '--disable-setuid-sandbox',
  '--disable-dev-shm-usage',
  '--disable-gpu',
  '--no-zygote',
  '--hide-scrollbars',
  '--disable-notifications',
  '--disable-extensions',
  '--disable-software-rasterizer',
  '--disable-web-security',
  '--disable-features=IsolateOrigins,site-per-process',
  '--font-render-hinting=none',
  '--disable-crash-reporter',
  '--no-first-run',
];

function withTimeout(promise, ms, label) {
  return Promise.race([
    promise,
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms)
    )
  ]);
}

async function launchBrowser() {
  if (isLaunching) {
    console.log('Browser already launching — waiting...');
    await new Promise(r => setTimeout(r, 2000));
    return cachedBrowser;
  }

  isLaunching = true;
  try {
    cachedBrowser = await puppeteer.launch({
      headless: 'new',
      executablePath: process.env.CHROMIUM_PATH || '/usr/bin/chromium',
      args: CHROME_ARGS,
      ignoreHTTPSErrors: true,
      timeout: 60000,
      protocolTimeout: 60000,
    });
    console.log('Browser launched successfully');
    return cachedBrowser;
  } finally {
    isLaunching = false;
  }
}

async function getBrowser() {
  const idleMs = Date.now() - lastRequestTime;
  if (cachedBrowser && lastRequestTime > 0 && idleMs > MAX_IDLE_MS) {
    console.log(`Idle ${Math.round(idleMs / 1000)}s — relaunching`);
    await closeBrowser(cachedBrowser);
    cachedBrowser = null;
    requestCount  = 0;
  }

  if (cachedBrowser) {
    try {
      const t = await withTimeout(cachedBrowser.newPage(), 3000, 'health-check');
      await t.close();
      return cachedBrowser;
    } catch (e) {
      console.log('Health check failed:', e.message);
      await closeBrowser(cachedBrowser);
      cachedBrowser = null;
      requestCount  = 0;
    }
  }

  return launchBrowser();
}

// ── Health check ───────────────────────────────────────────
app.get('/health', (req, res) => {
  res.json({ status: 'ok', browser: cachedBrowser ? 'ready' : 'not started' });
});

// ── PDF generation ─────────────────────────────────────────
app.post('/generate', async (req, res) => {
  const { html, url, options = {} } = req.body;
  let page = null;

  if (!html && !url) {
    return res.status(400).json({ error: 'Either html or url must be provided' });
  }

  try {
    requestCount++;
    console.log(`Request #${requestCount} of ${MAX_REQUESTS_BEFORE_RECYCLE}`);

    if (requestCount >= MAX_REQUESTS_BEFORE_RECYCLE) {
      await closeBrowser(cachedBrowser);
      cachedBrowser   = null;
      requestCount    = 0;
      lastRequestTime = 0;
    }

    const browser = await getBrowser();
    page = await browser.newPage();

    page.on('framenavigated', (frame) => {
      if (frame === page.mainFrame() && page.url() !== 'about:blank') {
        console.log('Navigation detected during render — ignoring');
      }
    });

    page.setDefaultNavigationTimeout(30000);
    page.setDefaultTimeout(60000);

    await page.setRequestInterception(true);
    page.on('request', (interceptedReq) => {
      const u    = interceptedReq.url();
      const type = interceptedReq.resourceType();
      if (
        type === 'media'                     ||
        type === 'font'                      ||
        u.includes('fonts.googleapis.com')   ||
        u.includes('fonts.gstatic.com')      ||
        u.includes('cdn.jsdelivr.net')       ||
        u.includes('bootstrapcdn.com')       ||
        u.includes('quickchart.io')
      ) {
        interceptedReq.abort();
      } else {
        interceptedReq.continue();
      }
    });

    if (options.viewport) await page.setViewport(options.viewport);

    if (url) {
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
    } else {
      console.log(`Setting HTML (${html.length} chars)...`);
      await page.setContent(html, { waitUntil: 'domcontentloaded', timeout: 30000 });
    }

    console.log('Generating PDF...');
    const pdf = await page.pdf({
      format:              options.format              || 'A4',
      printBackground:     options.printBackground     !== false,
      preferCSSPageSize:   options.preferCSSPageSize   || false,
      landscape:           options.landscape           || false,
      displayHeaderFooter: options.displayHeaderFooter || false,
      headerTemplate:      options.headerTemplate      || '<div></div>',
      footerTemplate:      options.footerTemplate      || '<div></div>',
      margin:              options.margin              || { top: '20px', right: '20px', bottom: '20px', left: '20px' },
      timeout:             60000,
      ...options,
    });

    console.log(`PDF generated: ${pdf.length} bytes`);

    await page.close();
    page = null;
    lastRequestTime = Date.now();

    res.set('Content-Type', 'application/pdf');
    res.set('Content-Disposition', `attachment; filename="${options.filename || 'document.pdf'}"`);
    res.send(Buffer.from(pdf));

  } catch (error) {
    console.error('PDF generation error:', error.message);
    if (page) { try { await page.close(); } catch (_) {} }

    const browserDead = (
      error.message.includes('Target closed')         ||
      error.message.includes('broken pipe')           ||
      error.message.includes('Session closed')        ||
      error.message.includes('Protocol error')        ||
      error.message.includes('Timed out')             ||
      error.message.includes('context was destroyed') ||
      error.message.includes('health-check')          ||
      error.message.includes('EAGAIN')                ||
      error.message.includes('Failed to launch')
    );

    if (browserDead) {
      console.log('Browser dead — relaunching on next request');
      await closeBrowser(cachedBrowser);
      cachedBrowser   = null;
      requestCount    = 0;
      lastRequestTime = 0;
    }

    res.status(500).json({ error: 'Failed to generate PDF', message: error.message });
  }
});

app.listen(3001, () => console.log('Puppeteer service listening on port 3001'));
