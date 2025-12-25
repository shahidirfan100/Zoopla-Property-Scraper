// Zoopla Property Scraper - Direct JSON API with fallback to HTML parsing
import { Actor, log } from 'apify';
import { CheerioCrawler, Dataset } from 'crawlee';
import { load as cheerioLoad } from 'cheerio';
import { gotScraping } from 'got-scraping';
import { HeaderGenerator } from 'header-generator';

// Initialize Actor
await Actor.init();

// Initialize header generator for realistic browser headers
const headerGenerator = new HeaderGenerator({
    browsers: [{ name: 'chrome', minVersion: 120 }, { name: 'firefox', minVersion: 115 }],
    devices: ['desktop'],
    operatingSystems: ['windows', 'macos'],
    locales: ['en-GB', 'en-US']
});

/**
 * Retry wrapper with exponential backoff
 * @param {Function} fn - Async function to retry
 * @param {number} maxRetries - Maximum number of retries
 * @param {string} operation - Operation name for logging
 * @returns {Promise<any>} Result of the function
 */
async function retryWithBackoff(fn, maxRetries = 3, operation = 'operation') {
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
        try {
            return await fn();
        } catch (error) {
            if (attempt === maxRetries) {
                log.error(`${operation} failed after ${maxRetries} attempts: ${error.message}`);
                throw error;
            }
            
            const delay = Math.min(1000 * Math.pow(2, attempt - 1), 10000); // Max 10s
            log.warning(`${operation} failed (attempt ${attempt}/${maxRetries}), retrying in ${delay}ms: ${error.message}`);
            await new Promise(resolve => setTimeout(resolve, delay));
        }
    }
}

/**
 * Initialize session with Zoopla to get cookies and tokens
 * @param {object} proxyConf - Proxy configuration
 * @returns {Promise<{cookies: string, headers: object}>} Session data with cookies and headers
 */
async function initializeSession(proxyConf) {
    log.info('Initializing Zoopla session...');
    
    try {
        const generatedHeaders = headerGenerator.getHeaders({
            operatingSystem: 'windows',
            browser: 'chrome',
            devices: ['desktop'],
            locales: ['en-GB']
        });
        
        const response = await gotScraping({
            url: 'https://www.zoopla.co.uk/',
            method: 'GET',
            headers: {
                ...generatedHeaders,
                'accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
                'accept-language': 'en-GB,en;q=0.9',
                'cache-control': 'no-cache',
                'pragma': 'no-cache',
                'sec-fetch-dest': 'document',
                'sec-fetch-mode': 'navigate',
                'sec-fetch-site': 'none',
                'upgrade-insecure-requests': '1'
            },
            proxyUrl: proxyConf ? await proxyConf.newUrl() : undefined,
            throwHttpErrors: false,
            followRedirect: true
        });
        
        // Extract cookies from Set-Cookie headers
        const cookies = response.headers['set-cookie'] || [];
        const cookieMap = new Map();
        
        for (const cookie of cookies) {
            const parts = cookie.split(';')[0].split('=');
            if (parts.length >= 2) {
                const name = parts[0].trim();
                const value = parts.slice(1).join('=').trim();
                cookieMap.set(name, value);
            }
        }
        
        // Build cookie string
        const cookieString = Array.from(cookieMap.entries())
            .map(([name, value]) => `${name}=${value}`)
            .join('; ');
        
        log.info(`Session initialized with ${cookieMap.size} cookies`);
        
        return {
            cookies: cookieString,
            headers: {
                ...generatedHeaders,
                'accept': 'application/json, text/plain, */*',
                'accept-language': 'en-GB,en;q=0.9',
                'cache-control': 'no-cache',
                'pragma': 'no-cache',
                'referer': 'https://www.zoopla.co.uk/',
                'sec-fetch-dest': 'empty',
                'sec-fetch-mode': 'cors',
                'sec-fetch-site': 'same-origin',
                cookie: cookieString
            }
        };
    } catch (error) {
        log.warning(`Session initialization failed: ${error.message}`);
        
        // Return default headers if session init fails
        const generatedHeaders = headerGenerator.getHeaders({
            operatingSystem: 'windows',
            browser: 'chrome'
        });
        
        return {
            cookies: '',
            headers: {
                ...generatedHeaders,
                'accept': 'application/json, text/plain, */*',
                'accept-language': 'en-GB,en;q=0.9',
                'referer': 'https://www.zoopla.co.uk/',
            }
        };
    }
}

/**
 * Call Zoopla's internal JSON API for search results
 * @param {object} params - Search parameters
 * @param {object} session - Session data with cookies and headers
 * @param {object} proxyConf - Proxy configuration
 * @returns {Promise<object>} API response data
 */
async function callZooplaSearchAPI(params, session, proxyConf) {
    const {
        location = 'london',
        propertyType = 'property',
        listingType = 'for-sale',
        minPrice,
        maxPrice,
        radius,
        pageNumber = 1
    } = params;
    
    return await retryWithBackoff(async () => {
        // Build search URL
        const cleanLoc = String(location).toLowerCase().trim().replace(/\s+/g, '-');
        const cleanPropType = String(propertyType).toLowerCase().trim();
        const cleanListType = String(listingType).toLowerCase().trim();
        
        const queryParams = new URLSearchParams();
        queryParams.set('q', location);
        queryParams.set('search_source', cleanListType);
        if (minPrice) queryParams.set('price_min', String(minPrice));
        if (maxPrice) queryParams.set('price_max', String(maxPrice));
        if (radius) queryParams.set('radius', String(radius));
        if (pageNumber > 1) queryParams.set('pn', String(pageNumber));
        
        const searchUrl = `https://www.zoopla.co.uk/${cleanListType}/${cleanPropType}/${cleanLoc}/?${queryParams.toString()}`;
        
        log.debug(`Fetching search page ${pageNumber}: ${searchUrl}`);
        
        // Fetch the HTML page to extract API endpoint or embedded data
        const response = await gotScraping({
            url: searchUrl,
            method: 'GET',
            headers: {
                ...session.headers,
                'accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
                'sec-fetch-dest': 'document',
                'sec-fetch-mode': 'navigate'
            },
            proxyUrl: proxyConf ? await proxyConf.newUrl() : undefined,
            throwHttpErrors: false,
            followRedirect: true,
            timeout: { request: 30000 }
        });
        
        if (response.statusCode === 429) {
            throw new Error('Rate limited - will retry with backoff');
        }
        
        if (response.statusCode !== 200) {
            log.warning(`Search page returned status ${response.statusCode}`);
            return null;
        }
        
        // Extract window.__PRELOADED_STATE__ or similar JSON data
        const html = response.body;
        const windowDataMatch = html.match(/window\.__PRELOADED_STATE__\s*=\s*({.+?});/s) ||
                               html.match(/window\.__INITIAL_STATE__\s*=\s*({.+?});/s) ||
                               html.match(/window\.__PAGE_MODEL__\s*=\s*({.+?});/s);
        
        if (windowDataMatch && windowDataMatch[1]) {
            try {
                const jsonData = JSON.parse(windowDataMatch[1]);
                log.info(`✅ Successfully extracted embedded JSON data from page ${pageNumber}`);
                return {
                    success: true,
                    data: jsonData,
                    source: 'window_data',
                    url: searchUrl
                };
            } catch (parseError) {
                log.debug(`Failed to parse window data: ${parseError.message}`);
            }
        }
        
        // If no window data, return HTML for fallback parsing
        log.info(`Falling back to HTML extraction for page ${pageNumber}`);
        return {
            success: false,
            html: html,
            source: 'html',
            url: searchUrl
        };
    }, 3, `Search API call (page ${pageNumber})`);
}

/**
 * Call Zoopla's bolt-on API for development/property details
 * @param {string} id - Property or development ID
 * @param {object} session - Session data
 * @param {object} proxyConf - Proxy configuration  
 * @returns {Promise<object>} API response
 */
async function callZooplaBoltOnAPI(id, session, proxyConf) {
    const apiUrl = `https://www.zoopla.co.uk/api/search/bolt-on/${id}/`;
    
    log.debug(`Fetching bolt-on API: ${apiUrl}`);
    
    try {
        const response = await gotScraping({
            url: apiUrl,
            method: 'GET',
            headers: session.headers,
            proxyUrl: proxyConf ? await proxyConf.newUrl() : undefined,
            responseType: 'json',
            throwHttpErrors: false
        });
        
        if (response.statusCode === 200 && response.body) {
            return response.body;
        }
        
        log.debug(`Bolt-on API returned status ${response.statusCode}`);
        return null;
    } catch (error) {
        log.debug(`Bolt-on API failed: ${error.message}`);
        return null;
    }
}

async function main() {
    try {
        const input = (await Actor.getInput()) || {};
        const {
            location = 'london',
            propertyType = 'property',
            listingType = 'for-sale',
            minPrice,
            maxPrice,
            radius,
            resultsWanted: RESULTS_WANTED_RAW = 100,
            maxPages: MAX_PAGES_RAW = 20,
            includeDetails = true,
            startUrl,
            startUrls,
            url,
            proxyConfiguration,
        } = input;

        const RESULTS_WANTED = Number.isFinite(+RESULTS_WANTED_RAW) ? Math.max(1, +RESULTS_WANTED_RAW) : Number.MAX_SAFE_INTEGER;
        const MAX_PAGES = Number.isFinite(+MAX_PAGES_RAW) ? Math.max(1, +MAX_PAGES_RAW) : 20;

        const proxyConf = proxyConfiguration ? await Actor.createProxyConfiguration({ ...proxyConfiguration }) : undefined;

        // Initialize session with proper cookies and headers
        const session = await initializeSession(proxyConf);
        
        let saved = 0;
        let currentPage = 1;

        // Fetch and process search results
        while (saved < RESULTS_WANTED && currentPage <= MAX_PAGES) {
            log.info(`Processing page ${currentPage}/${MAX_PAGES} (saved: ${saved}/${RESULTS_WANTED})`);
            
            // Add delay between requests for stealth
            if (currentPage > 1) {
                const delay = 1000 + Math.random() * 2000; // 1-3 seconds
                log.debug(`Waiting ${Math.round(delay)}ms before next page`);
                await new Promise(resolve => setTimeout(resolve, delay));
            }
            
            const apiResponse = await callZooplaSearchAPI({
                location,
                propertyType,
                listingType,
                minPrice,
                maxPrice,
                radius,
                pageNumber: currentPage
            }, session, proxyConf);
            
            if (!apiResponse) {
                log.warning(`No response for page ${currentPage}, stopping`);
                break;
            }
            
            let properties = [];
            
            if (apiResponse.success && apiResponse.data) {
                // Extract listings from window data
                const data = apiResponse.data;
                const listings = data?.listings?.regular || 
                               data?.searchResults?.listings ||
                               data?.regularListings ||
                               data?.results || [];
                
                if (Array.isArray(listings) && listings.length > 0) {
                    properties = listings;
                    log.info(`Extracted ${properties.length} properties from JSON API`);
                } else {
                    log.warning('No listings found in JSON data');
                }
            } else if (apiResponse.html) {
                // Fallback to HTML parsing
                log.info('Falling back to HTML parsing');
                const $ = cheerioLoad(apiResponse.html);
                
                // Extract property cards from HTML
                const cards = [];
                $('[data-testid="search-result"], .listing-results-wrapper > div').each((_, el) => {
                    const card = $(el);
                    
                    // Extract basic data from HTML
                    const href = card.find('a[href*="/details/"]').first().attr('href');
                    if (!href) return;
                    
                    const title = card.find('h2, h3, [class*="title"]').first().text().trim();
                    const price = card.find('[class*="price"]').first().text().trim();
                    const address = card.find('[class*="address"]').first().text().trim();
                    
                    const listingIdMatch = href.match(/\/details\/(\d+)/);
                    const listingId = listingIdMatch ? listingIdMatch[1] : null;
                    
                    cards.push({
                        listingId,
                        title: title || address,
                        address,
                        price,
                        url: href.startsWith('http') ? href : `https://www.zoopla.co.uk${href}`
                    });
                });
                
                properties = cards;
                log.info(`Extracted ${properties.length} properties from HTML`);
            }
            
            if (properties.length === 0) {
                log.info('No properties found on this page, stopping pagination');
                break;
            }
            
            // Process and save properties
            const remaining = RESULTS_WANTED - saved;
            const toProcess = properties.slice(0, remaining);
            
            for (const prop of toProcess) {
                try {
                    const item = {
                        listingId: prop.listingId || prop.id || null,
                        title: prop.title || prop.displayAddress || null,
                        address: prop.displayAddress || prop.address || null,
                        price: prop.price || prop.priceText || null,
                        propertyType: prop.propertyType || null,
                        bedrooms: prop.numBedrooms || prop.bedrooms || null,
                        bathrooms: prop.numBathrooms || prop.bathrooms || null,
                        receptions: prop.numReceptions || prop.receptions || null,
                        description: prop.summaryDescription || prop.description || null,
                        agent: prop.branch?.name || prop.agentName || null,
                        agentPhone: prop.branch?.telephone || null,
                        tenure: prop.tenure || null,
                        images: prop.image ? [prop.image] : (prop.images || null),
                        features: prop.features || null,
                        coordinates: prop.location?.coordinates || null,
                        url: prop.listingUris?.detail ? `https://www.zoopla.co.uk${prop.listingUris.detail}` : prop.url,
                        category: listingType,
                        location: location,
                    };
                    
                    // If includeDetails is true and we have a URL, fetch detailed data
                    if (includeDetails && item.url) {
                        log.debug(`Fetching details for ${item.listingId}`);
                        
                        // Add delay for stealth
                        await new Promise(resolve => setTimeout(resolve, 500 + Math.random() * 1000));
                        
                        try {
                            await retryWithBackoff(async () => {
                                const detailResponse = await gotScraping({
                                    url: item.url,
                                    method: 'GET',
                                    headers: {
                                        ...session.headers,
                                        'accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
                                        'referer': apiResponse.url,
                                        'sec-fetch-dest': 'document',
                                        'sec-fetch-mode': 'navigate'
                                    },
                                    proxyUrl: proxyConf ? await proxyConf.newUrl() : undefined,
                                    throwHttpErrors: false,
                                    timeout: { request: 30000 }
                                });
                                
                                if (detailResponse.statusCode === 429) {
                                    throw new Error('Rate limited - will retry');
                                }
                                
                                if (detailResponse.statusCode === 200) {
                                    const html = detailResponse.body;
                                    
                                    // Extract window data from detail page
                                    const windowMatch = html.match(/window\.__PRELOADED_STATE__\s*=\s*({.+?});/s);
                                    if (windowMatch) {
                                        try {
                                            const detailData = JSON.parse(windowMatch[1]);
                                            const listing = detailData?.listing || detailData?.propertyDetails;
                                            
                                            if (listing) {
                                                // Merge detailed data
                                                item.description = listing.detailedDescription || listing.description || item.description;
                                                item.tenure = listing.tenure || item.tenure;
                                                item.councilTaxBand = listing.councilTaxBand || null;
                                                item.epcRating = listing.epcRating || null;
                                                item.images = listing.images || listing.propertyImages || item.images;
                                                item.features = listing.features || listing.keyFeatures || item.features;
                                                item.floorplan = listing.floorplan || null;
                                                item.bathrooms = listing.numBathrooms || item.bathrooms;
                                                item.receptions = listing.numReceptions || item.receptions;
                                                log.debug(`✅ Enhanced details for ${item.listingId}`);
                                            }
                                        } catch (e) {
                                            log.debug(`Failed to parse detail JSON: ${e.message}`);
                                        }
                                    }
                                } else {
                                    log.debug(`Detail page returned status ${detailResponse.statusCode}`);
                                }
                            }, 2, `Detail fetch for ${item.listingId}`);
                        } catch (detailError) {
                            log.softFail(`Failed to fetch details for ${item.listingId}: ${detailError.message}`);
                        }
                    }
                    
                    await Dataset.pushData(item);
                    saved++;
                    
                    if (saved % 10 === 0) {
                        log.info(`Progress: ${saved}/${RESULTS_WANTED} properties saved`);
                    }
                    
                } catch (itemError) {
                    log.error(`Failed to process property: ${itemError.message}`);
                }
            }
            
            log.info(`Page ${currentPage} completed. Total saved: ${saved}/${RESULTS_WANTED}`);
            currentPage++;
        }
        
        log.info(`✅ Scraping completed successfully! Total properties: ${saved}`);
        
    } catch (error) {
        log.error(`❌ Actor failed: ${error.message}`, { stack: error.stack });
        throw error;
    } finally {
        await Actor.exit();
    }
}

main().catch(err => { 
    log.exception(err, 'Actor crashed');
    process.exit(1); 
});
