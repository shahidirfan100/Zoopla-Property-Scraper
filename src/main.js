// Zoopla Property Scraper - JSON-first with resilient fallbacks
import { Actor, log } from 'apify';
import { Dataset } from 'crawlee';
import { load as cheerioLoad } from 'cheerio';
import { gotScraping } from 'got-scraping';
import { HeaderGenerator } from 'header-generator';
import { CookieJar } from 'tough-cookie';
import { randomUUID } from 'node:crypto';
import { URL } from 'node:url';

const headerGenerator = new HeaderGenerator({
    browsers: [{ name: 'chrome', minVersion: 120 }],
    devices: ['desktop'],
    operatingSystems: ['windows', 'macos'],
    locales: ['en-GB', 'en-US'],
});

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

const MAX_SEARCH_RETRIES = 4;
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
    return {
        id: seed,
        cookieJar: new CookieJar(),
        headers: headerGenerator.getHeaders({
            sessionToken: seed,
            locales: ['en-GB', 'en-US'],
            devices: ['desktop'],
            operatingSystems: ['windows'],
        }),
    };
};

const rotateSession = (session) => {
    const fresh = createSession();
    session.id = fresh.id;
    session.cookieJar = fresh.cookieJar;
    session.headers = fresh.headers;
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
    for (let attempt = 1; attempt <= MAX_SEARCH_RETRIES; attempt++) {
        try {
            const proxyUrl = proxyConfiguration ? await proxyConfiguration.newUrl() : undefined;
            const response = await gotScraping({
                url,
                method: 'GET',
                headers: {
                    ...(isJson ? JSON_HEADERS : HTML_HEADERS),
                    ...session.headers,
                    ...(referer ? { referer } : {}),
                },
                cookieJar: session.cookieJar,
                proxyUrl,
                throwHttpErrors: false,
                followRedirect: true,
                timeout: { request: 30000 },
                http2: true,
            });

            const { statusCode } = response;
            if (statusCode === 403 || statusCode === 429) {
                log.warning(`Request blocked (${statusCode}) on attempt ${attempt}, rotating session and retrying...`);
                rotateSession(session);
                await delay(500 * attempt);
                continue;
            }

            if (statusCode >= 500) {
                log.warning(`Server error ${statusCode} on attempt ${attempt} for ${url}`);
                await delay(400 * attempt);
                continue;
            }

            return response;
        } catch (error) {
            lastError = error;
            log.warning(`Fetch attempt ${attempt} failed for ${url}: ${error.message}`);
            await delay(400 * attempt);
        }
    }
    log.error(`Failed to fetch ${url} after ${MAX_SEARCH_RETRIES} attempts: ${lastError?.message || 'Unknown error'}`);
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
    if (!proxyConf) log.warning('No proxy configuration provided. Zoopla may block datacenter IPs.');

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
                    await delay(300 + Math.random() * 400);
                    const detail = await enrichWithDetail(normalized.url, session, proxyConf, currentUrl);
                    if (detail) {
                        mergeDetail(normalized, detail);
                        counters.detailEnhanced += 1;
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
            await delay(600 + Math.random() * 1200);
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
