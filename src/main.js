// Zoopla Property Scraper - Hybrid: Playwright for search pages, HTTP for details
import { Actor, log } from 'apify';
import { Dataset } from 'crawlee';
import { load as cheerioLoad } from 'cheerio';
import { gotScraping } from 'got-scraping';
import { HeaderGenerator } from 'header-generator';
import { launchOptions as camoufoxLaunchOptions } from 'camoufox-js';
import { firefox } from 'playwright';
import { randomUUID } from 'node:crypto';
import { URL } from 'node:url';

const headerGenerator = new HeaderGenerator({
    browsers: [{ name: 'firefox', minVersion: 120 }],
    devices: ['desktop'],
    operatingSystems: ['windows'],
    locales: ['en-GB', 'en-US'],
});

const FIREFOX_USER_AGENTS = [
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:122.0) Gecko/20100101 Firefox/122.0',
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:121.0) Gecko/20100101 Firefox/121.0',
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:123.0) Gecko/20100101 Firefox/123.0',
];


const HTML_HEADERS = {
    accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    'accept-language': 'en-GB,en;q=0.9',
    'cache-control': 'no-cache',
    pragma: 'no-cache',
    'upgrade-insecure-requests': '1',
};

const JSON_HEADERS = {
    accept: 'application/json, text/plain, */*',
    'accept-language': 'en-GB,en;q=0.9',
};

const DETAIL_RETRIES = 2;

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const toAbsoluteUrl = (href, base) => {
    if (!href) return null;
    try {
        return new URL(href, base).toString();
    } catch {
        return href;
    }
};

const pick = (obj, path) => path.reduce((acc, key) => (acc && acc[key] !== undefined ? acc[key] : undefined), obj);

const cleanItem = (item) =>
    Object.fromEntries(
        Object.entries(item).filter(([_, v]) => {
            if (v === undefined || v === null) return false;
            if (typeof v === 'string' && v.trim() === '') return false;
            if (Array.isArray(v) && v.length === 0) return false;
            if (typeof v === 'object' && !Array.isArray(v) && Object.keys(v).length === 0) return false;
            return true;
        }),
    );

const createSession = () => {
    const seed = randomUUID();
    // Select random Firefox user agent for variety
    const userAgent = FIREFOX_USER_AGENTS[Math.floor(Math.random() * FIREFOX_USER_AGENTS.length)];

    return {
        id: seed,
        userAgent,
        headers: {
            'User-Agent': userAgent,
            'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
            'Accept-Language': 'en-GB,en-US;q=0.9,en;q=0.8',
            'Accept-Encoding': 'gzip, deflate, br',
            'DNT': '1',
            'Connection': 'keep-alive',
            'Upgrade-Insecure-Requests': '1',
        },
    };
};

const rotateSession = (session) => {
    const fresh = createSession();
    session.id = fresh.id;
    session.userAgent = fresh.userAgent;
    session.headers = fresh.headers;
};

// Browser globals for Playwright/Camoufox
let browser;
let context;
let page;

const closeContext = async () => {
    try {
        if (context) await context.close();
    } catch { }
    try {
        if (browser) await browser.close();
    } catch { }
    browser = undefined;
    context = undefined;
    page = undefined;
};

const ensurePage = async (session, proxyConfiguration) => {
    if (page && !page.isClosed()) return page;
    await closeContext();

    let proxyUrl = null;
    if (proxyConfiguration) {
        proxyUrl = await proxyConfiguration.newUrl();
    }

    browser = await firefox.launch(await camoufoxLaunchOptions({
        headless: true,
        proxy: proxyUrl,
        geoip: true,
        args: ['--no-sandbox', '--disable-dev-shm-usage'],
    }));

    context = await browser.newContext({
        userAgent: session.userAgent,
        viewport: { width: 1920, height: 1080 },
        locale: 'en-GB',
        timezoneId: 'Europe/London',
        permissions: ['geolocation'],
        geolocation: { longitude: -0.1276, latitude: 51.5074 },
        colorScheme: 'light',
        extraHTTPHeaders: {
            'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
            'Accept-Language': 'en-GB,en-US;q=0.9,en;q=0.8',
            'Accept-Encoding': 'gzip, deflate, br',
            'DNT': '1',
            'Connection': 'keep-alive',
            'Upgrade-Insecure-Requests': '1',
            'Sec-Fetch-Dest': 'document',
            'Sec-Fetch-Mode': 'navigate',
            'Sec-Fetch-Site': 'none',
            'Sec-Fetch-User': '?1',
            'Cache-Control': 'max-age=0',
        },
    });

    await context.addInitScript(() => {
        window.chrome = { runtime: {}, loadTimes: function () { }, csi: function () { } };
    });

    page = await context.newPage();
    await page.mouse.move(Math.random() * 100, Math.random() * 100);
    return page;
};

const warmupSession = async (session, proxyConfiguration) => {
    log.info('Warming up session with Playwright/Camoufox...');
    try {
        const pg = await ensurePage(session, proxyConfiguration);
        await pg.goto('https://www.zoopla.co.uk/', { waitUntil: 'networkidle', timeout: 45000 });

        const content = await pg.content();
        if (content.includes('cf-browser-verification') || content.includes('Just a moment')) {
            log.info('Cloudflare challenge detected, waiting...');
            await pg.waitForLoadState('networkidle', { timeout: 15000 });
            await delay(2000);
        }

        await pg.mouse.move(300 + Math.random() * 200, 200 + Math.random() * 100);
        await delay(500 + Math.random() * 500);

        log.info('Session warmup successful!');
        return true;
    } catch (error) {
        log.warning(`Session warmup failed: ${error.message}`);
        await closeContext();
        return false;
    }
};

const extractListingUrlsFromPage = async (page) => {
    try {
        // Wait for page to fully load with multiple selector strategies
        log.info('Waiting for listing elements to appear...');

        // Try multiple selectors - Zoopla uses different structures
        const selectors = [
            '[data-testid="search-result"]',
            '[data-testid="listing-card"]',
            'a[href*="/details/"]',
            'article a[href*="/for-sale/"]',
            '.css-wfndrn', // Common listing container class
        ];

        let foundSelector = null;
        for (const selector of selectors) {
            try {
                await page.waitForSelector(selector, { timeout: 5000 });
                foundSelector = selector;
                log.info(`Found listings using selector: ${selector}`);
                break;
            } catch {
                // Try next selector
            }
        }

        if (!foundSelector) {
            // Last resort: wait for any links and extract
            log.warning('No listing selector found, waiting for page to stabilize...');
            await delay(5000);
        }

        // Extract all URLs that look like property listings
        const urls = await page.evaluate(() => {
            const uniqueUrls = new Set();

            // Get all links on the page
            const allLinks = Array.from(document.querySelectorAll('a[href]'));

            for (const link of allLinks) {
                const href = link.getAttribute('href');
                if (!href) continue;

                // Match various listing URL patterns
                if (href.includes('/details/') && href.match(/\/\d{6,}/)) {
                    const absolute = href.startsWith('http') ? href : `https://www.zoopla.co.uk${href}`;
                    // Skip contact pages
                    if (!absolute.includes('/contact/')) {
                        uniqueUrls.add(absolute);
                    }
                }
            }

            return Array.from(uniqueUrls);
        });

        log.info(`Extracted ${urls.length} listing URLs from Playwright page`);
        return urls;
    } catch (error) {
        log.warning(`Failed to extract listing URLs: ${error.message}`);
        return [];
    }
};

// Fetch search page HTML using got-scraping
const fetchSearchPageWithGot = async (url, session, proxyConfiguration) => {
    try {
        let proxyUrl = null;
        if (proxyConfiguration) {
            proxyUrl = await proxyConfiguration.newUrl();
        }

        const response = await gotScraping({
            url,
            method: 'GET',
            proxyUrl,
            headers: {
                'User-Agent': session.userAgent,
                'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
                'Accept-Language': 'en-GB,en-US;q=0.9,en;q=0.8',
                'Accept-Encoding': 'gzip, deflate, br',
                'DNT': '1',
                'Connection': 'keep-alive',
                'Upgrade-Insecure-Requests': '1',
                'Sec-Fetch-Dest': 'document',
                'Sec-Fetch-Mode': 'navigate',
                'Sec-Fetch-Site': 'none',
                'Sec-Fetch-User': '?1',
                'Cache-Control': 'max-age=0',
            },
            timeout: {
                request: 30000,
            },
        });

        return response.body;
    } catch (error) {
        log.warning(`got-scraping failed for ${url}: ${error.message}`);
        return null;
    }
};

// Extract listing URLs from search page HTML using Cheerio
const extractListingUrlsFromHtml = (html) => {
    try {
        const $ = cheerioLoad(html);
        const urls = new Set();

        // Find all links to detail pages
        $('a[href*="/for-sale/details/"], a[href*="/to-rent/details/"], a[href*="/details/"]').each((_, el) => {
            const href = $(el).attr('href');
            if (href && href.includes('/details/')) {
                // Convert to absolute URL
                const absolute = href.startsWith('http') ? href : `https://www.zoopla.co.uk${href}`;
                urls.add(absolute);
            }
        });

        const urlArray = Array.from(urls);
        log.info(`Extracted ${urlArray.length} listing URLs from HTML`);
        return urlArray;
    } catch (error) {
        log.warning(`Failed to extract listing URLs from HTML: ${error.message}`);
        return [];
    }
};

// Extract next page URL from search page HTML
const extractNextPageUrl = (html, currentUrl) => {
    try {
        const $ = cheerioLoad(html);

        // Look for next page link
        const nextHref = $('link[rel="next"]').attr('href') ||
            $('a[rel="next"]').attr('href') ||
            $('a[aria-label*="Next"]').attr('href') ||
            $('a[title*="Next"]').attr('href');

        if (nextHref) {
            return nextHref.startsWith('http') ? nextHref : `https://www.zoopla.co.uk${nextHref}`;
        }

        return null;
    } catch (error) {
        log.debug(`Failed to extract next page URL: ${error.message}`);
        return null;
    }
};

// Fetch detail page HTML using got-scraping (fast and cheap)
const fetchDetailPageWithGot = async (url, session, proxyConfiguration) => {
    try {
        let proxyUrl = null;
        if (proxyConfiguration) {
            proxyUrl = await proxyConfiguration.newUrl();
        }

        const response = await gotScraping({
            url,
            method: 'GET',
            proxyUrl,
            headers: {
                'User-Agent': session.userAgent,
                'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
                'Accept-Language': 'en-GB,en-US;q=0.9,en;q=0.8',
                'Accept-Encoding': 'gzip, deflate, br',
                'DNT': '1',
                'Connection': 'keep-alive',
                'Upgrade-Insecure-Requests': '1',
                'Sec-Fetch-Dest': 'document',
                'Sec-Fetch-Mode': 'navigate',
                'Sec-Fetch-Site': 'none',
                'Sec-Fetch-User': '?1',
                'Cache-Control': 'max-age=0',
            },
            timeout: {
                request: 30000,
            },
        });

        return response.body;
    } catch (error) {
        log.warning(`got-scraping failed for ${url}: ${error.message}`);
        return null;
    }
};

const buildSearchUrl = ({ location, listingType, propertyType, minPrice, maxPrice, radius, page }) => {
    const cleanLoc = String(location || '').trim().toLowerCase().replace(/\s+/g, '-');
    const cleanListing = String(listingType || 'for-sale').trim().toLowerCase();
    const cleanProp = String(propertyType || 'property').trim().toLowerCase();

    const params = new URLSearchParams();
    if (location) params.set('q', location);
    params.set('search_source', cleanListing);
    if (minPrice) params.set('price_min', String(minPrice));
    if (maxPrice) params.set('price_max', String(maxPrice));
    if (radius) params.set('radius', String(radius));
    if (page && page > 1) params.set('pn', String(page));

    return `https://www.zoopla.co.uk/${cleanListing}/${cleanProp}/${cleanLoc}/?${params.toString()}`;
};

const getStartUrls = (input) => {
    const seeds = [];
    if (input.startUrl) seeds.push(input.startUrl);
    if (Array.isArray(input.startUrls)) {
        for (const entry of input.startUrls) {
            if (typeof entry === 'string' && entry) seeds.push(entry);
            if (entry && typeof entry === 'object' && entry.url) seeds.push(entry.url);
        }
    }
    if (seeds.length === 0) {
        seeds.push(
            buildSearchUrl({
                location: input.location || 'london',
                listingType: input.listingType || 'for-sale',
                propertyType: input.propertyType || 'property',
                minPrice: input.minPrice,
                maxPrice: input.maxPrice,
                radius: input.radius,
                page: 1,
            }),
        );
    }
    return [...new Set(seeds.map((u) => toAbsoluteUrl(u, 'https://www.zoopla.co.uk/')))].filter(Boolean);
};

const fetchPage = async (url, session, proxyConfiguration, { isJson = false, referer } = {}) => {
    let lastError;
    const maxRetries = 3; // Reduced to avoid repeated blocks

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
        try {
            const pg = await ensurePage(session, proxyConfiguration);

            // Add random delay to simulate human behavior
            if (attempt > 1) {
                const exponentialDelay = 1000 * attempt + Math.random() * 500;
                await delay(exponentialDelay);
                log.info(`Retry attempt ${attempt}/${maxRetries} after ${Math.round(exponentialDelay)}ms delay`);
            }

            const headers = {
                ...(isJson ? JSON_HEADERS : HTML_HEADERS),
                ...session.headers,
                ...(referer ? { referer } : {}),
            };

            if (isJson) {
                const response = await context.request.get(url, {
                    headers,
                    timeout: 45000, // Increased timeout for Cloudflare challenges
                });
                const statusCode = response.status();

                if (statusCode === 403 || statusCode === 429) {
                    log.warning(`Request blocked (${statusCode}) on attempt ${attempt}, rotating session and retrying...`);
                    rotateSession(session);
                    await closeContext();
                    continue;
                }

                if (statusCode >= 500) {
                    log.warning(`Server error ${statusCode} on attempt ${attempt} for ${url}`);
                    await delay(500 * attempt);
                    continue;
                }

                const body = await response.text();
                return { statusCode, body };
            }

            // For HTML requests, use page.goto with network idle
            await context.setExtraHTTPHeaders(headers);

            // Navigate with longer timeout to handle Cloudflare challenges
            const response = await pg.goto(url, {
                waitUntil: 'networkidle',
                timeout: 45000
            });

            const statusCode = response?.status() ?? 0;

            // Check for Cloudflare challenge page
            const pageContent = await pg.content();
            const isCloudflareChallenge = pageContent.includes('cf-browser-verification') ||
                pageContent.includes('Just a moment') ||
                pageContent.includes('Checking your browser');

            if (isCloudflareChallenge) {
                log.info('Cloudflare challenge detected, waiting for resolution...');
                try {
                    // Wait for Cloudflare to resolve (max 15 seconds)
                    await pg.waitForLoadState('networkidle', { timeout: 15000 });
                    await delay(2000); // Additional wait for JS to execute

                    // Check if we're past the challenge
                    const newContent = await pg.content();
                    if (newContent.includes('cf-browser-verification') || newContent.includes('Just a moment')) {
                        log.warning('Cloudflare challenge not resolved, will retry...');
                        rotateSession(session);
                        await closeContext();
                        continue;
                    }

                    log.info('Cloudflare challenge passed!');
                } catch (cfError) {
                    log.warning(`Cloudflare wait timeout: ${cfError.message}`);
                    rotateSession(session);
                    await closeContext();
                    continue;
                }
            }

            if (statusCode === 403 || statusCode === 429) {
                log.warning(`Request blocked (${statusCode}) on attempt ${attempt}, rotating session and retrying...`);
                rotateSession(session);
                await closeContext();
                continue;
            }

            if (statusCode >= 500) {
                log.warning(`Server error ${statusCode} on attempt ${attempt} for ${url}`);
                await delay(500 * attempt);
                continue;
            }

            const body = response ? await response.text() : await pg.content();
            return { statusCode, body };

        } catch (error) {
            lastError = error;
            log.warning(`Fetch attempt ${attempt} failed for ${url}: ${error.message}`);

            // Rotate session on any error
            if (attempt < maxRetries) {
                rotateSession(session);
                await closeContext();
            }
        }
    }

    log.error(`Failed to fetch ${url} after ${maxRetries} attempts: ${lastError?.message || 'Unknown error'}`);
    return null;
};

const extractEmbeddedJson = (html) => {
    const nextDataMatch = html.match(/<script[^>]+id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/);
    if (nextDataMatch) {
        try {
            return JSON.parse(nextDataMatch[1]);
        } catch (error) {
            log.debug(`Failed to parse __NEXT_DATA__: ${error.message}`);
        }
    }

    const preloadMatch =
        html.match(/window\.__PRELOADED_STATE__\s*=\s*({[\s\S]+?});/) ||
        html.match(/window\.__INITIAL_STATE__\s*=\s*({[\s\S]+?});/);
    if (preloadMatch) {
        try {
            return JSON.parse(preloadMatch[1]);
        } catch (error) {
            log.debug(`Failed to parse window state: ${error.message}`);
        }
    }
    return null;
};

const findListingArray = (data) => {
    const seen = new Set();
    const stack = [data];
    while (stack.length) {
        const node = stack.pop();
        if (!node || typeof node !== 'object') continue;
        if (seen.has(node)) continue;
        seen.add(node);

        if (Array.isArray(node)) {
            const looksLikeListings = node.some(
                (item) =>
                    item &&
                    typeof item === 'object' &&
                    (item.listingId ||
                        item.listing_id ||
                        item.id ||
                        item.propertyId ||
                        item.listingUris ||
                        item.displayAddress),
            );
            if (looksLikeListings && node.length > 0) return node;
        }

        for (const value of Object.values(node)) {
            if (value && typeof value === 'object') stack.push(value);
        }
    }
    return null;
};

const findNextFromJson = (data, currentUrl) => {
    const candidates = [
        pick(data, ['props', 'pageProps', 'searchResults', 'pagination', 'next', 'link']),
        pick(data, ['props', 'pageProps', 'searchResults', 'pagination', 'nextUrl']),
        pick(data, ['searchResults', 'pagination', 'next', 'link']),
        pick(data, ['searchResults', 'pagination', 'nextUrl']),
        pick(data, ['pagination', 'next', 'link']),
        pick(data, ['pagination', 'nextUrl']),
        pick(data, ['pagination', 'next']),
        pick(data, ['nextUrl']),
    ];

    for (const candidate of candidates) {
        if (typeof candidate === 'string' && candidate) {
            return toAbsoluteUrl(candidate, currentUrl);
        }
        if (typeof candidate === 'number') {
            const urlObj = new URL(currentUrl);
            urlObj.searchParams.set('pn', String(candidate));
            return urlObj.toString();
        }
    }
    return null;
};

const extractJsonLdListings = ($, baseUrl) => {
    const results = [];
    $('script[type="application/ld+json"]').each((_, el) => {
        try {
            const raw = $(el).contents().text();
            const parsed = JSON.parse(raw);
            const payloads = Array.isArray(parsed) ? parsed : [parsed];
            for (const payload of payloads) {
                if (payload?.['@type'] === 'ItemList' && Array.isArray(payload.itemListElement)) {
                    for (const entry of payload.itemListElement) {
                        if (entry?.item) {
                            results.push({
                                ...entry.item,
                                url: toAbsoluteUrl(entry.item.url || entry.item['@id'], baseUrl),
                            });
                        } else if (entry?.url) {
                            results.push({
                                url: toAbsoluteUrl(entry.url, baseUrl),
                                title: entry.name,
                                price: entry.price,
                            });
                        }
                    }
                } else if (payload?.['@type'] && payload.url) {
                    results.push({
                        ...payload,
                        url: toAbsoluteUrl(payload.url, baseUrl),
                    });
                }
            }
        } catch (error) {
            log.debug(`Failed to parse JSON-LD: ${error.message}`);
        }
    });
    return results;
};

const extractHtmlListings = ($, baseUrl) => {
    const results = [];
    $('[data-testid="search-result"], .listing-results-wrapper > div, article').each((_, el) => {
        const card = $(el);
        const href =
            card.find('a[href*="/for-sale/details"], a[href*="/to-rent/details"], a[href*="/details/"]').attr('href') ||
            card.find('a').attr('href');
        if (!href) return;

        const title = card.find('h2, h3, [class*="title"]').first().text().trim();
        const price = card.find('[class*="price"], [data-testid*="price"]').first().text().trim();
        const address = card.find('[class*="address"]').first().text().trim();
        const listingIdMatch = href.match(/details\/(\d+)/);

        results.push({
            url: toAbsoluteUrl(href, baseUrl),
            title: title || address || null,
            price: price || null,
            address: address || null,
            listingId: listingIdMatch ? listingIdMatch[1] : null,
        });
    });
    return results;
};

const findNextFromHtml = ($, currentUrl) => {
    const linkHref = $('link[rel="next"]').attr('href');
    if (linkHref) return toAbsoluteUrl(linkHref, currentUrl);

    const anchorHref =
        $('a[rel="next"]').attr('href') ||
        $('a[aria-label*="Next"]').attr('href') ||
        $('a[title*="Next"]').attr('href');
    if (anchorHref) return toAbsoluteUrl(anchorHref, currentUrl);

    return null;
};

const extractSearchPayload = (html, currentUrl) => {
    log.info(`Extracting data from HTML (length: ${html.length} chars)`);

    const $ = cheerioLoad(html);
    const embedded = extractEmbeddedJson(html);

    if (embedded) {
        log.info('Found embedded JSON (__NEXT_DATA__ or window state)');
        log.debug(`Embedded JSON keys: ${Object.keys(embedded).join(', ')}`);
    } else {
        log.warning('No embedded JSON found in HTML');
        // Log first 500 chars to see what we got
        log.debug(`HTML preview: ${html.substring(0, 500)}`);
    }

    const listingsFromJson = embedded ? findListingArray(embedded) : null;
    const nextFromJson = embedded ? findNextFromJson(embedded, currentUrl) : null;

    if (listingsFromJson?.length) {
        log.info(`Found ${listingsFromJson.length} listings from embedded JSON`);
        return { listings: listingsFromJson, nextPage: nextFromJson || findNextFromHtml($, currentUrl), source: 'json' };
    }

    const jsonLdListings = extractJsonLdListings($, currentUrl);
    if (jsonLdListings.length) {
        log.info(`Found ${jsonLdListings.length} listings from JSON-LD`);
        return { listings: jsonLdListings, nextPage: nextFromJson || findNextFromHtml($, currentUrl), source: 'jsonld' };
    }

    const htmlListings = extractHtmlListings($, currentUrl);
    log.info(`Found ${htmlListings.length} listings from HTML parsing`);

    if (htmlListings.length === 0) {
        log.warning('No listings found by any extraction method!');
        // Check if page has search results container
        const hasSearchResults = $('[data-testid="search-result"]').length > 0 ||
            $('.listing-results-wrapper').length > 0 ||
            $('article').length > 0;
        log.info(`Page has search results container: ${hasSearchResults}`);

        // Log what scripts are on the page
        const scriptCount = $('script').length;
        const nextDataScript = $('script#__NEXT_DATA__').length;
        const jsonLdScripts = $('script[type="application/ld+json"]').length;
        log.info(`Scripts found: ${scriptCount} total, __NEXT_DATA__: ${nextDataScript}, JSON-LD: ${jsonLdScripts}`);
    }

    return { listings: htmlListings, nextPage: findNextFromHtml($, currentUrl), source: 'html' };
};

const normalizeListing = (raw, listingType, searchLocation, fallbackUrl) => {
    const url =
        raw.url ||
        raw.listingUrl ||
        raw.permalink ||
        (raw.listingUris && raw.listingUris.detail && `https://www.zoopla.co.uk${raw.listingUris.detail}`) ||
        fallbackUrl ||
        null;

    // Handle various URL patterns for listing ID extraction
    const listingId =
        raw.listingId ||
        raw.listing_id ||
        raw.id ||
        (typeof url === 'string' ? url.match(/\/(\d{6,})(?:\/|\?|$)/)?.[1] : null) ||
        raw.propertyId ||
        raw.slug ||
        null;

    // Extract address from various possible fields
    const address = raw.displayAddress || raw.address || raw.location || raw.streetAddress ||
        (raw.name && !raw.name.includes('bed') ? raw.name : null) || null;

    // Handle price - support both formatted and numeric
    const price =
        raw.price ||
        raw.priceText ||
        raw.formattedPrice ||
        raw.displayPrice ||
        raw.amount ||
        (raw.offers?.price ? `£${Number(raw.offers.price).toLocaleString()}` : null) ||
        null;

    // Store numeric price for sorting/filtering
    const priceNumeric = raw.priceNumeric || raw.offers?.price ||
        (typeof price === 'string' ? parseInt(price.replace(/[^0-9]/g, '')) : null) ||
        null;

    const images = [];
    if (raw.image) images.push(raw.image);
    if (Array.isArray(raw.images)) images.push(...raw.images);
    if (Array.isArray(raw.propertyImages)) images.push(...raw.propertyImages);

    const features = raw.features || raw.keyFeatures || raw.amenities || null;

    const coordinates =
        raw.coordinates ||
        raw.location?.coordinates ||
        (raw.geo && { latitude: raw.geo.latitude, longitude: raw.geo.longitude }) ||
        null;

    return cleanItem({
        listingId,
        title: raw.title || raw.name || address || null,
        address,
        price,
        priceNumeric,
        propertyType: raw.propertyType || raw.property_type || raw.type || null,
        bedrooms: raw.numBedrooms || raw.bedrooms || raw.numberOfBedrooms || null,
        bathrooms: raw.numBathrooms || raw.bathrooms || raw.numberOfBathrooms || null,
        receptions: raw.numReceptions || raw.receptions || null,
        floorSize: raw.floorSize || raw.floorArea || null,
        description: raw.summaryDescription || raw.description || raw.detailedDescription || null,
        agent: raw.branch?.name || raw.agentName || raw.seller?.name || null,
        agentPhone: raw.branch?.telephone || raw.phoneNumber || raw.telephone || null,
        tenure: raw.tenure || null,
        images: images.length ? images : null,
        features,
        coordinates,
        url,
        category: listingType,
        location: searchLocation,
    });
};

const fetchBoltOn = async (listingId, session, proxyConfiguration, referer) => {
    if (!listingId) return null;
    const apiUrl = `https://www.zoopla.co.uk/api/search/bolt-on/${listingId}/`;
    const response = await fetchPage(apiUrl, session, proxyConfiguration, { isJson: true, referer });
    if (!response) return null;
    if (response.statusCode !== 200) return null;
    try {
        return typeof response.body === 'object' ? response.body : JSON.parse(response.body);
    } catch (err) {
        log.debug(`Bolt-on parse failed for ${listingId}: ${err.message}`);
        return null;
    }
};

const extractDetailFromJson = (embedded) => {
    if (!embedded || typeof embedded !== 'object') return null;
    const candidates = [
        pick(embedded, ['props', 'pageProps', 'listingDetails']),
        pick(embedded, ['props', 'pageProps', 'listing']),
        pick(embedded, ['listing']),
        pick(embedded, ['pageProps', 'listingDetails']),
        pick(embedded, ['pageProps', 'listing']),
    ];
    for (const candidate of candidates) {
        if (candidate && typeof candidate === 'object') return candidate;
    }
    return null;
};

const extractDetailFromJsonLd = ($, url) => {
    let detail = null;
    $('script[type="application/ld+json"]').each((_, el) => {
        if (detail) return;
        try {
            const raw = $(el).contents().text();
            const parsed = JSON.parse(raw);
            const payloads = Array.isArray(parsed) ? parsed : [parsed];

            for (const payload of payloads) {
                // Prioritize RealEstateListing schema (Zoopla's primary schema)
                if (payload?.['@type'] === 'RealEstateListing') {
                    log.info('Found RealEstateListing JSON-LD schema');

                    // Extract bedrooms, bathrooms from additionalProperty array
                    let bedrooms = null;
                    let bathrooms = null;
                    let floorSize = null;

                    if (Array.isArray(payload.additionalProperty)) {
                        for (const prop of payload.additionalProperty) {
                            if (prop.name === 'Bedrooms') bedrooms = parseInt(prop.value) || null;
                            if (prop.name === 'Bathrooms') bathrooms = parseInt(prop.value) || null;
                            if (prop.name === 'Floor size') floorSize = prop.value;
                        }
                    }

                    // Extract price from offers object
                    const price = payload.offers?.price || null;
                    const priceCurrency = payload.offers?.priceCurrency || 'GBP';

                    detail = {
                        title: payload.name,
                        description: payload.description,
                        price: price ? `£${Number(price).toLocaleString()}` : null,
                        priceNumeric: price,
                        priceCurrency,
                        bedrooms,
                        bathrooms,
                        floorSize,
                        images: payload.image ? [payload.image] : null,
                        url: toAbsoluteUrl(payload.url || payload['@id'], url),
                        '@type': 'RealEstateListing',
                    };
                    return;
                }

                // Fallback for other schema types
                if (
                    payload?.['@type'] &&
                    payload['@type'] !== 'BreadcrumbList' &&
                    (payload.url || payload['@id'] || payload.address)
                ) {
                    detail = {
                        ...payload,
                        url: toAbsoluteUrl(payload.url || payload['@id'], url),
                    };
                    return;
                }
            }
        } catch (error) {
            log.debug(`Failed to parse detail JSON-LD: ${error.message}`);
        }
    });
    return detail;
};

const mergeDetail = (base, detail) => {
    if (!detail) return;
    const overwriteIfMissing = [
        'description',
        'tenure',
        'councilTaxBand',
        'epcRating',
        'bathrooms',
        'bedrooms',
        'receptions',
    ];
    for (const key of overwriteIfMissing) {
        if (!base[key] && detail[key]) base[key] = detail[key];
    }
    if (detail.images && detail.images.length) base.images = base.images || detail.images;
    if (detail.features && detail.features.length) base.features = base.features || detail.features;
    if (detail.floorplan) base.floorplan = base.floorplan || detail.floorplan;
    if (detail.coordinates && !base.coordinates) base.coordinates = detail.coordinates;
};

// Extract property data from detail page HTML
const extractDetailFromHtml = (html, url, listingType, searchLocation) => {
    try {
        const $ = cheerioLoad(html);

        // Try to extract __NEXT_DATA__
        const embedded = extractEmbeddedJson(html);
        if (embedded) {
            const detailJson = extractDetailFromJson(embedded);
            if (detailJson) {
                log.debug(`Extracted detail from __NEXT_DATA__ for ${url}`);
                return normalizeListing(detailJson, listingType, searchLocation, url);
            }
        }

        // Try JSON-LD
        const detailLd = extractDetailFromJsonLd($, url);
        if (detailLd) {
            log.debug(`Extracted detail from JSON-LD for ${url}`);
            return normalizeListing(detailLd, listingType, searchLocation, url);
        }

        // Fallback to HTML parsing
        // Handle various URL patterns: /details/123/, /details/contact/123/, /new-homes/details/123/
        const listingId = url.match(/\/(\d{6,})(?:\/|\?|$)/)?.[1];

        // Try multiple selectors for title
        const title = $('h1').first().text().trim() ||
            $('[data-testid="listing-title"]').first().text().trim() ||
            $('[data-testid="address-line-1"]').first().text().trim();

        // Try multiple selectors for price
        const price = $('[data-testid="price"]').first().text().trim() ||
            $('[data-testid*="price"]').first().text().trim() ||
            $('.ui-pricing').first().text().trim() ||
            $('p:contains("£")').first().text().trim();

        // Try multiple selectors for address
        const address = $('[data-testid="address-line-1"]').first().text().trim() ||
            $('[data-testid*="address"]').first().text().trim() ||
            $('.ui-property-summary__address').first().text().trim() ||
            $('address').first().text().trim();

        const description = $('[data-testid="truncated-description-text"]').first().text().trim() ||
            $('[data-testid="description"]').first().text().trim() ||
            $('.dp-description__text').first().text().trim();

        // Extract bedrooms, bathrooms
        const bedroomsText = $('[data-testid*="bed"], .c-PJLV').text();
        const bathroomsText = $('[data-testid*="bath"], .c-PJLV').text();
        const bedrooms = bedroomsText.match(/(\d+)/)?.[1];
        const bathrooms = bathroomsText.match(/(\d+)/)?.[1];

        // Extract images
        const images = [];
        $('img[src*="zoopla"], img[data-src*="zoopla"]').each((_, img) => {
            const src = $(img).attr('src') || $(img).attr('data-src');
            if (src && !src.includes('logo') && !src.includes('icon')) {
                images.push(src);
            }
        });

        if (!listingId && !title && !price) {
            log.warning(`Could not extract minimal data from ${url}`);
            // Log HTML snippet for debugging
            log.debug(`HTML preview: ${html.substring(0, 500)}`);
            return null;
        }

        log.debug(`HTML extraction - ID: ${listingId}, Title: ${title?.substring(0, 50)}, Price: ${price}`);

        log.debug(`Extracted detail from HTML parsing for ${url}`);
        return cleanItem({
            listingId,
            title: title || address,
            address,
            price,
            description,
            bedrooms: bedrooms ? parseInt(bedrooms) : null,
            bathrooms: bathrooms ? parseInt(bathrooms) : null,
            images: images.length > 0 ? images : null,
            url,
            category: listingType,
            location: searchLocation,
        });
    } catch (error) {
        log.warning(`Failed to extract detail from ${url}: ${error.message}`);
        return null;
    }
};

const enrichWithDetail = async (url, session, proxyConfiguration, referer) => {
    let lastError;
    for (let attempt = 1; attempt <= DETAIL_RETRIES; attempt++) {
        try {
            const response = await fetchPage(url, session, proxyConfiguration, { isJson: false, referer });
            if (!response) return null;

            const html = response.body;
            const embedded = extractEmbeddedJson(html);
            const detailJson = extractDetailFromJson(embedded);
            const $ = cheerioLoad(html);
            const detailLd = extractDetailFromJsonLd($, url);
            const detail = detailJson || detailLd;
            if (!detail) return null;
            return normalizeListing(detail, null, null, url);
        } catch (error) {
            lastError = error;
            log.warning(`Detail fetch attempt ${attempt} failed for ${url}: ${error.message}`);
            await delay(400 * attempt);
        }
    }
    log.softFail(`Failed to fetch detail for ${url}: ${lastError?.message || 'Unknown error'}`);
    return null;
};

await Actor.init();

try {
    const input = (await Actor.getInput()) || {};
    const {
        location = 'london',
        propertyType = 'property',
        listingType = 'for-sale',
        minPrice,
        maxPrice,
        radius,
        resultsWanted: resultsWantedRaw = 100,
        maxPages: maxPagesRaw = 20,
        includeDetails = true,
        startUrl,
        startUrls,
        proxyConfiguration,
    } = input;

    if (!location && !startUrl && (!startUrls || startUrls.length === 0)) {
        throw new Error('Provide either location or startUrl/startUrls.');
    }

    const RESULTS_WANTED = Number.isFinite(+resultsWantedRaw) ? Math.max(1, +resultsWantedRaw) : Number.MAX_SAFE_INTEGER;
    const MAX_PAGES = Number.isFinite(+maxPagesRaw) ? Math.max(1, +maxPagesRaw) : 20;

    const proxyConf = proxyConfiguration ? await Actor.createProxyConfiguration(proxyConfiguration) : undefined;
    if (!proxyConf) log.warning('No proxy configuration provided. Zoopla blocks datacenter IPs; residential proxy is required.');

    const session = createSession();
    const startList = getStartUrls({
        startUrl,
        startUrls,
        location,
        listingType,
        propertyType,
        minPrice,
        maxPrice,
        radius,
    });

    let saved = 0;
    const seen = new Set();
    const counters = { json: 0, jsonld: 0, html: 0, detailEnhanced: 0, pages: 0, urls: 0 };

    // Warm up session with Playwright/Camoufox to bypass Cloudflare
    await warmupSession(session, proxyConf);

    for (const seed of startList) {
        let currentUrl = seed;
        let pageNum = 1;

        while (currentUrl && saved < RESULTS_WANTED && pageNum <= MAX_PAGES) {
            log.info(`Processing page ${pageNum}/${MAX_PAGES} (saved: ${saved}/${RESULTS_WANTED}) - ${currentUrl}`);

            // Step 1: Use Playwright to load page and extract listing URLs
            const pg = await ensurePage(session, proxyConf);

            try {
                await pg.goto(currentUrl, { waitUntil: 'networkidle', timeout: 60000 });

                // Check for Cloudflare challenge and wait longer for it to resolve
                const pageContent = await pg.content();
                const isCloudflareChallenge = pageContent.includes('cf-browser-verification') ||
                    pageContent.includes('Just a moment') ||
                    pageContent.includes('Checking your browser');

                if (isCloudflareChallenge) {
                    log.info('Cloudflare challenge detected, waiting for resolution...');
                    await pg.waitForLoadState('networkidle', { timeout: 30000 });
                    await delay(8000); // Wait longer for Cloudflare to fully resolve
                }

                // Scroll down to trigger lazy loading of listings
                await pg.evaluate(() => window.scrollTo(0, 500));
                await delay(1000);
                await pg.evaluate(() => window.scrollTo(0, 1000));
                await delay(1000);

                // Step 2: Extract listing URLs from the page
                const listingUrls = await extractListingUrlsFromPage(pg);
                counters.urls += listingUrls.length;

                if (listingUrls.length === 0) {
                    log.warning('No listing URLs found on this page, stopping pagination');
                    break;
                }

                log.info(`Found ${listingUrls.length} listing URLs, fetching details via HTTP...`);

                // Step 3: Fetch each listing detail page using got-scraping (fast & cheap)
                for (const listingUrl of listingUrls) {
                    if (saved >= RESULTS_WANTED) break;

                    // Check if we've already processed this listing
                    // Handle various URL patterns: /details/123/, /details/contact/123/, /new-homes/details/123/
                    const listingId = listingUrl.match(/\/(\d{6,})(?:\/|\?|$)/)?.[1];
                    if (!listingId) {
                        log.debug(`Skipping URL without listing ID: ${listingUrl}`);
                        continue;
                    }

                    if (seen.has(listingId)) {
                        log.debug(`Skipping duplicate listing ID: ${listingId}`);
                        continue;
                    }
                    seen.add(listingId);

                    log.debug(`Fetching details for listing ${listingId}: ${listingUrl}`);
                    await delay(300 + Math.random() * 300); // Realistic delay

                    const detailHtml = await fetchDetailPageWithGot(listingUrl, session, proxyConf);
                    if (!detailHtml) {
                        log.warning(`Failed to fetch HTML for ${listingUrl}`);
                        continue;
                    }

                    log.debug(`Fetched ${detailHtml.length} chars HTML, extracting property data...`);

                    // Extract property data from detail page HTML
                    const property = extractDetailFromHtml(detailHtml, listingUrl, listingType, location);
                    if (property && property.listingId) {
                        await Dataset.pushData(cleanItem(property));
                        saved += 1;
                        counters.detailEnhanced += 1;
                        log.info(`✓ Saved property ${saved}/${RESULTS_WANTED}: ${property.address || property.title}`);

                        if (saved % 10 === 0) {
                            log.info(`Progress: ${saved}/${RESULTS_WANTED} properties saved`);
                        }
                    } else {
                        log.warning(`Failed to extract property data from ${listingUrl}`);
                    }
                }

                counters.pages += 1;

                // Step 4: Find next page URL
                const nextPageUrl = await pg.evaluate(() => {
                    const nextLink = document.querySelector('a[rel=\"next\"], a[aria-label*=\"Next\"], a[title*=\"Next\"]');
                    return nextLink ? nextLink.href : null;
                });

                if (!nextPageUrl) {
                    log.info('No next page found, stopping pagination');
                    break;
                }

                currentUrl = nextPageUrl;
                pageNum += 1;
                await delay(800 + Math.random() * 1200); // Delay between pages

            } catch (error) {
                log.error(`Error processing page ${currentUrl}: ${error.message}`);
                break;
            }
        }

        if (saved >= RESULTS_WANTED) break;
    }

    log.info(
        `Scraping completed. Saved ${saved} properties. Pages: ${counters.pages}. URLs extracted: ${counters.urls}. Detail pages fetched: ${counters.detailEnhanced}.`,
    );
} catch (error) {
    log.exception(error, 'Actor failed');
    throw error;
} finally {
    await Actor.exit();
}
