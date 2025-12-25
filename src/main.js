// Zoopla Property Scraper - Production-grade Camoufox stealth scraper (Apify recommended pattern)
import { Actor, log } from 'apify';
import { Dataset } from 'crawlee';
import { load as cheerioLoad } from 'cheerio';
import { launchOptions as camoufoxLaunchOptions } from 'camoufox-js';
import { firefox } from 'playwright';
import { randomUUID } from 'node:crypto';
import { URL } from 'node:url';

// Authentic Firefox user agents for Camoufox
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

const warmupSession = async (session, proxyConfiguration) => {
    log.info('Running Playwright bootstrap to obtain fresh cookies...');
    try {
        const pg = await ensurePage(session, proxyConfiguration);

        // Visit homepage first to establish session
        await pg.goto('https://www.zoopla.co.uk/', {
            waitUntil: 'networkidle',
            timeout: 45000
        });

        // Check for Cloudflare challenge
        const content = await pg.content();
        if (content.includes('cf-browser-verification') || content.includes('Just a moment')) {
            log.info('Cloudflare challenge on homepage, waiting...');
            await pg.waitForLoadState('networkidle', { timeout: 15000 });
            await delay(2000);
        }

        // Add some human-like interactions
        await pg.mouse.move(300 + Math.random() * 200, 200 + Math.random() * 100);
        await delay(500 + Math.random() * 500);

        log.info('Session warmup successful!');
        return true;
    } catch (error) {
        log.warning(`Playwright bootstrap failed: ${error.message}`);
        await closeContext();
        return false;
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

    // Get proxy URL for Camoufox
    let proxyUrl = null;
    if (proxyConfiguration) {
        proxyUrl = await proxyConfiguration.newUrl();
    }

    // Launch Firefox with Camoufox options (Apify recommended pattern)
    browser = await firefox.launch(await camoufoxLaunchOptions({
        headless: true,
        proxy: proxyUrl,
        geoip: true,  // Enable GeoIP spoofing for better stealth
        args: [
            '--no-sandbox',
            '--disable-dev-shm-usage',
        ],
    }));

    context = await browser.newContext({
        userAgent: session.userAgent,
        viewport: { width: 1920, height: 1080 },
        locale: 'en-GB',
        timezoneId: 'Europe/London',
        permissions: ['geolocation'],
        geolocation: { longitude: -0.1276, latitude: 51.5074 }, // London coordinates
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

    // Camoufox has built-in stealth, minimal extra scripts needed
    await context.addInitScript(() => {
        // Additional Chrome object for compatibility
        window.chrome = {
            runtime: {},
            loadTimes: function () { },
            csi: function () { },
        };
    });

    page = await context.newPage();

    // Add random mouse movements to simulate human behavior
    await page.mouse.move(Math.random() * 100, Math.random() * 100);

    return page;
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
    const $ = cheerioLoad(html);
    const embedded = extractEmbeddedJson(html);
    const listingsFromJson = embedded ? findListingArray(embedded) : null;
    const nextFromJson = embedded ? findNextFromJson(embedded, currentUrl) : null;

    if (listingsFromJson?.length) {
        return { listings: listingsFromJson, nextPage: nextFromJson || findNextFromHtml($, currentUrl), source: 'json' };
    }

    const jsonLdListings = extractJsonLdListings($, currentUrl);
    if (jsonLdListings.length) {
        return { listings: jsonLdListings, nextPage: nextFromJson || findNextFromHtml($, currentUrl), source: 'jsonld' };
    }

    const htmlListings = extractHtmlListings($, currentUrl);
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

    const listingId =
        raw.listingId ||
        raw.listing_id ||
        raw.id ||
        (typeof url === 'string' ? url.match(/details\/(\d+)/)?.[1] : null) ||
        raw.propertyId ||
        raw.slug ||
        null;

    const address = raw.displayAddress || raw.address || raw.location || raw.streetAddress || raw.name || null;
    const price =
        raw.price ||
        raw.priceText ||
        raw.formattedPrice ||
        raw.displayPrice ||
        raw.amount ||
        (raw.offers && (raw.offers.price || raw.offers.priceCurrency)) ||
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
        propertyType: raw.propertyType || raw.property_type || raw.type || null,
        bedrooms: raw.numBedrooms || raw.bedrooms || raw.numberOfBedrooms || null,
        bathrooms: raw.numBathrooms || raw.bathrooms || raw.numberOfBathrooms || null,
        receptions: raw.numReceptions || raw.receptions || null,
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
    const counters = { json: 0, jsonld: 0, html: 0, detailEnhanced: 0, pages: 0 };

    // Warm up session to bypass Cloudflare before scraping
    await warmupSession(session, proxyConf);

    for (const seed of startList) {
        let currentUrl = seed;
        let page = 1;

        while (currentUrl && saved < RESULTS_WANTED && page <= MAX_PAGES) {
            log.info(`Processing page ${page}/${MAX_PAGES} (saved: ${saved}/${RESULTS_WANTED}) - ${currentUrl}`);
            const response = await fetchPage(currentUrl, session, proxyConf, { isJson: false });
            if (!response) {
                log.warning(`No response for ${currentUrl}, stopping this seed`);
                break;
            }

            counters.pages += 1;
            const { listings, nextPage, source } = extractSearchPayload(response.body, currentUrl);
            if (!listings.length) {
                log.warning('No listings found on this page, stopping pagination for this seed');
                break;
            }
            if (source) counters[source] = (counters[source] || 0) + 1;
            log.info(`Extracted ${listings.length} listings from ${source || 'unknown'} source`);

            for (const raw of listings) {
                if (saved >= RESULTS_WANTED) break;
                const normalized = normalizeListing(raw, listingType, location, currentUrl);
                const key = normalized.listingId || normalized.url;
                if (!key) continue;
                if (seen.has(key)) continue;
                seen.add(key);

                if (includeDetails && normalized.url) {
                    // Add realistic delay before fetching detail page
                    await delay(500 + Math.random() * 500);
                    // Try bolt-on API first if we have an ID, then detail page
                    const bolt = await fetchBoltOn(normalized.listingId, session, proxyConf, currentUrl);
                    if (bolt?.data) {
                        mergeDetail(normalized, bolt.data);
                        counters.detailEnhanced += 1;
                    } else {
                        const detail = await enrichWithDetail(normalized.url, session, proxyConf, currentUrl);
                        if (detail) {
                            mergeDetail(normalized, detail);
                            counters.detailEnhanced += 1;
                        }
                    }
                }

                await Dataset.pushData(cleanItem(normalized));
                saved += 1;
                if (saved % 10 === 0) {
                    log.info(`Progress: ${saved}/${RESULTS_WANTED} properties saved`);
                }
            }

            if (!nextPage) {
                log.info('No further pagination link found, stopping this seed');
                break;
            }

            currentUrl = nextPage;
            page += 1;
            // Longer delays between pages to appear more human-like
            await delay(800 + Math.random() * 1200);
        }

        if (saved >= RESULTS_WANTED) break;
    }

    log.info(
        `Scraping completed. Saved ${saved} properties. Pages: ${counters.pages}. Sources -> JSON: ${counters.json}, JSON-LD: ${counters.jsonld}, HTML: ${counters.html}. Detail enrichments: ${counters.detailEnhanced}.`,
    );
} catch (error) {
    log.exception(error, 'Actor failed');
    throw error;
} finally {
    await Actor.exit();
}
