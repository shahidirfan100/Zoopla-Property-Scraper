# Zoopla Property Scraper

<p>Fast and reliable UK property data extraction from <strong>Zoopla.co.uk</strong>. Extract property listings with prices, locations, specifications, agent details, and images for real estate market analysis, property research, and investment opportunities.</p>

## What does Zoopla Property Scraper do?

<p>This scraper extracts comprehensive UK property data from Zoopla, one of the UK's leading property platforms. Perfect for real estate investors, market researchers, property developers, and data analysts who need structured property information at scale.</p>

### Key Features

<ul>
  <li><strong>Efficient Data Extraction</strong> - Uses advanced JSON API extraction with HTML parsing fallback for reliable data collection</li>
  <li><strong>Flexible Search</strong> - Filter by location, property type, price range, bedrooms, and search radius</li>
  <li><strong>Comprehensive Data</strong> - Extracts prices, addresses, descriptions, images, agent details, EPC ratings, and property features</li>
  <li><strong>Multiple Listing Types</strong> - Support for sale properties, rental properties, and new homes</li>
  <li><strong>Smart Pagination</strong> - Automatically handles multi-page results with configurable limits</li>
  <li><strong>Detail Scraping</strong> - Optional deep scraping of individual property pages for maximum data richness</li>
</ul>

## Use Cases

<dl>
  <dt><strong>Real Estate Investment Analysis</strong></dt>
  <dd>Compare property prices across different locations to identify investment opportunities and market trends.</dd>
  
  <dt><strong>Market Research</strong></dt>
  <dd>Gather data on property availability, pricing patterns, and market dynamics for comprehensive analysis.</dd>
  
  <dt><strong>Property Portfolio Management</strong></dt>
  <dd>Monitor property listings and market changes for portfolio optimization and strategic decisions.</dd>
  
  <dt><strong>Price Comparison</strong></dt>
  <dd>Track property values and rental rates across regions for competitive analysis.</dd>
  
  <dt><strong>Lead Generation</strong></dt>
  <dd>Collect property listings and agent contact information for real estate business development.</dd>
</dl>

## Input Configuration

<p>Configure the scraper using these parameters to customize your data extraction:</p>

<table>
  <thead>
    <tr>
      <th>Parameter</th>
      <th>Type</th>
      <th>Description</th>
      <th>Example</th>
    </tr>
  </thead>
  <tbody>
    <tr>
      <td><code>location</code></td>
      <td>String</td>
      <td>UK location to search (city, town, or postcode)</td>
      <td><code>"london"</code>, <code>"manchester"</code></td>
    </tr>
    <tr>
      <td><code>listingType</code></td>
      <td>Select</td>
      <td>Type of listing: for-sale, to-rent, or new-homes</td>
      <td><code>"for-sale"</code></td>
    </tr>
    <tr>
      <td><code>propertyType</code></td>
      <td>Select</td>
      <td>Property category: property, houses, flats, or bungalows</td>
      <td><code>"houses"</code></td>
    </tr>
    <tr>
      <td><code>minBedrooms</code></td>
      <td>Integer</td>
      <td>Minimum number of bedrooms (0-10)</td>
      <td><code>2</code></td>
    </tr>
    <tr>
      <td><code>maxBedrooms</code></td>
      <td>Integer</td>
      <td>Maximum number of bedrooms (0-10)</td>
      <td><code>4</code></td>
    </tr>
    <tr>
      <td><code>minPrice</code></td>
      <td>Integer</td>
      <td>Minimum property price in GBP</td>
      <td><code>200000</code></td>
    </tr>
    <tr>
      <td><code>maxPrice</code></td>
      <td>Integer</td>
      <td>Maximum property price in GBP</td>
      <td><code>500000</code></td>
    </tr>
    <tr>
      <td><code>radius</code></td>
      <td>Number</td>
      <td>Search radius from location in miles (0-40)</td>
      <td><code>5</code></td>
    </tr>
    <tr>
      <td><code>includeDetails</code></td>
      <td>Boolean</td>
      <td>Extract detailed property information from detail pages</td>
      <td><code>true</code></td>
    </tr>
    <tr>
      <td><code>resultsWanted</code></td>
      <td>Integer</td>
      <td>Maximum number of properties to extract</td>
      <td><code>100</code></td>
    </tr>
    <tr>
      <td><code>maxPages</code></td>
      <td>Integer</td>
      <td>Maximum search result pages to process</td>
      <td><code>20</code></td>
    </tr>
    <tr>
      <td><code>startUrl</code></td>
      <td>String</td>
      <td>Direct Zoopla search URL (overrides other filters)</td>
      <td><code>"https://www.zoopla.co.uk/..."</code></td>
    </tr>
    <tr>
      <td><code>proxyConfiguration</code></td>
      <td>Object</td>
      <td>Proxy settings (residential proxies recommended)</td>
      <td>See examples below</td>
    </tr>
  </tbody>
</table>

### Input Examples

<h4>Basic Property Search</h4>

```json
{
  "location": "london",
  "listingType": "for-sale",
  "propertyType": "property",
  "resultsWanted": 50,
  "includeDetails": true
}
```

<h4>Filtered Search with Price and Bedrooms</h4>

```json
{
  "location": "manchester",
  "listingType": "for-sale",
  "propertyType": "houses",
  "minBedrooms": 3,
  "maxBedrooms": 5,
  "minPrice": 250000,
  "maxPrice": 450000,
  "radius": 10,
  "resultsWanted": 100,
  "maxPages": 10,
  "includeDetails": true,
  "proxyConfiguration": {
    "useApifyProxy": true,
    "apifyProxyGroups": ["RESIDENTIAL"]
  }
}
```

<h4>Rental Properties Search</h4>

```json
{
  "location": "birmingham",
  "listingType": "to-rent",
  "propertyType": "flats",
  "minBedrooms": 2,
  "maxPrice": 1500,
  "resultsWanted": 50,
  "includeDetails": false
}
```

<h4>Using Direct URL</h4>

```json
{
  "startUrl": "https://www.zoopla.co.uk/for-sale/property/london/?q=London&search_source=for-sale",
  "resultsWanted": 100,
  "includeDetails": true
}
```

## Output Data Structure

<p>Each property listing includes the following fields:</p>

<table>
  <thead>
    <tr>
      <th>Field</th>
      <th>Type</th>
      <th>Description</th>
    </tr>
  </thead>
  <tbody>
    <tr>
      <td><code>listingId</code></td>
      <td>String</td>
      <td>Unique Zoopla listing identifier</td>
    </tr>
    <tr>
      <td><code>title</code></td>
      <td>String</td>
      <td>Property headline or title</td>
    </tr>
    <tr>
      <td><code>address</code></td>
      <td>String</td>
      <td>Full property address</td>
    </tr>
    <tr>
      <td><code>price</code></td>
      <td>String</td>
      <td>Property price or rental amount</td>
    </tr>
    <tr>
      <td><code>propertyType</code></td>
      <td>String</td>
      <td>Type of property (e.g., House, Flat, Terraced)</td>
    </tr>
    <tr>
      <td><code>bedrooms</code></td>
      <td>Number</td>
      <td>Number of bedrooms</td>
    </tr>
    <tr>
      <td><code>bathrooms</code></td>
      <td>Number</td>
      <td>Number of bathrooms</td>
    </tr>
    <tr>
      <td><code>receptions</code></td>
      <td>Number</td>
      <td>Number of reception rooms</td>
    </tr>
    <tr>
      <td><code>description</code></td>
      <td>String</td>
      <td>Full property description</td>
    </tr>
    <tr>
      <td><code>agent</code></td>
      <td>String</td>
      <td>Estate agent or agency name</td>
    </tr>
    <tr>
      <td><code>agentPhone</code></td>
      <td>String</td>
      <td>Agent contact phone number</td>
    </tr>
    <tr>
      <td><code>tenure</code></td>
      <td>String</td>
      <td>Property tenure (Freehold, Leasehold)</td>
    </tr>
    <tr>
      <td><code>councilTaxBand</code></td>
      <td>String</td>
      <td>UK Council Tax band</td>
    </tr>
    <tr>
      <td><code>epcRating</code></td>
      <td>String</td>
      <td>Energy Performance Certificate rating</td>
    </tr>
    <tr>
      <td><code>images</code></td>
      <td>Array</td>
      <td>Property image URLs</td>
    </tr>
    <tr>
      <td><code>features</code></td>
      <td>Array</td>
      <td>Key property features and amenities</td>
    </tr>
    <tr>
      <td><code>floorplan</code></td>
      <td>String</td>
      <td>Floor plan image URL (if available)</td>
    </tr>
    <tr>
      <td><code>coordinates</code></td>
      <td>Object</td>
      <td>Geographic coordinates (latitude, longitude)</td>
    </tr>
    <tr>
      <td><code>url</code></td>
      <td>String</td>
      <td>Direct link to property listing</td>
    </tr>
    <tr>
      <td><code>location</code></td>
      <td>String</td>
      <td>Search location used</td>
    </tr>
    <tr>
      <td><code>category</code></td>
      <td>String</td>
      <td>Listing category (for-sale, to-rent, new-homes)</td>
    </tr>
  </tbody>
</table>

### Output Example

```json
{
  "listingId": "71410260",
  "title": "2 bedroom flat for sale",
  "address": "Southgate Road, De Beauvoir, London N1",
  "price": "800000",
  "propertyType": "Flat",
  "bedrooms": 2,
  "bathrooms": 1,
  "receptions": 1,
  "description": "Perched on the seventh floor of a modern residential building on Southgate Road, this 862 sq ft apartment combines generous space with stunning views...",
  "agent": "Urban Spaces Loft Living & Unique Properties",
  "agentPhone": "+44 20 1234 5678",
  "tenure": "Leasehold",
  "councilTaxBand": "D",
  "epcRating": "B",
  "images": [
    "https://lid.zoocdn.com/645/430/...",
    "https://lid.zoocdn.com/645/430/..."
  ],
  "features": [
    "Balcony",
    "Penthouse",
    "Chain free",
    "Modern kitchen",
    "Open plan living"
  ],
  "floorplan": "https://lc.zoocdn.com/...",
  "coordinates": {
    "latitude": 51.5372,
    "longitude": -0.0835
  },
  "url": "https://www.zoopla.co.uk/for-sale/details/71410260/",
  "location": "london",
  "category": "for-sale"
}
```

## Performance and Efficiency

<ul>
  <li><strong>Fast Extraction</strong> - Optimized for speed using HTTP requests with efficient data parsing</li>
  <li><strong>Smart Data Recovery</strong> - Prioritizes JSON API data extraction, falls back to HTML parsing when needed</li>
  <li><strong>Resource Efficient</strong> - No browser automation overhead, making it cost-effective for large-scale scraping</li>
  <li><strong>Concurrent Processing</strong> - Handles multiple requests simultaneously for faster completion</li>
  <li><strong>Automatic Deduplication</strong> - Prevents duplicate property entries in results</li>
</ul>

## Best Practices

<h3>Proxy Configuration</h3>

<p>For reliable scraping and to avoid rate limiting, use <strong>Apify Residential Proxies</strong>. Zoopla may block datacenter IPs, so residential proxies ensure consistent data extraction.</p>

```json
{
  "proxyConfiguration": {
    "useApifyProxy": true,
    "apifyProxyGroups": ["RESIDENTIAL"]
  }
}
```

<h3>Result Limits</h3>

<p>Set appropriate <code>resultsWanted</code> and <code>maxPages</code> values based on your needs. For exploratory searches, start with 50-100 results. For comprehensive market analysis, increase limits as needed.</p>

<h3>Detail Scraping</h3>

<p>Enable <code>includeDetails: true</code> when you need comprehensive property information including descriptions, images, and features. Disable it for faster scraping when only basic listing data is sufficient.</p>

<h3>Search Optimization</h3>

<p>Use specific filters (price range, bedrooms, property type) to narrow results and improve data relevance. This reduces scraping time and focuses on properties matching your criteria.</p>

## Technical Implementation

<p>This scraper uses modern web scraping techniques optimized for Zoopla's structure:</p>

<ol>
  <li><strong>JSON API Extraction</strong> - Detects and extracts embedded JSON data from page source for maximum accuracy</li>
  <li><strong>JSON-LD Parsing</strong> - Reads structured data from JSON-LD schema markup when available</li>
  <li><strong>HTML Parsing Fallback</strong> - Uses CSS selectors and DOM parsing as backup method</li>
  <li><strong>Intelligent Pagination</strong> - Automatically follows next page links and handles URL parameters</li>
  <li><strong>Error Handling</strong> - Robust error recovery ensures continued operation even if individual pages fail</li>
</ol>

## Cost and Performance

<table>
  <thead>
    <tr>
      <th>Scenario</th>
      <th>Results</th>
      <th>Est. Time</th>
      <th>Est. Cost</th>
    </tr>
  </thead>
  <tbody>
    <tr>
      <td>Quick Search (list only)</td>
      <td>50 properties</td>
      <td>1-2 minutes</td>
      <td>$0.05 - $0.10</td>
    </tr>
    <tr>
      <td>Standard Search (with details)</td>
      <td>100 properties</td>
      <td>5-10 minutes</td>
      <td>$0.20 - $0.40</td>
    </tr>
    <tr>
      <td>Comprehensive Analysis</td>
      <td>500 properties</td>
      <td>20-30 minutes</td>
      <td>$1.00 - $2.00</td>
    </tr>
    <tr>
      <td>Market Research</td>
      <td>1000+ properties</td>
      <td>45-60 minutes</td>
      <td>$2.50 - $5.00</td>
    </tr>
  </tbody>
</table>

<p><em>Estimates based on Apify platform pricing with residential proxies. Actual costs vary based on concurrency, proxy usage, and Apify plan.</em></p>

## Compliance and Ethics

<p>This scraper extracts publicly available property data from Zoopla. When using this tool:</p>

<ul>
  <li>Respect Zoopla's terms of service and robots.txt directives</li>
  <li>Use appropriate rate limiting and delays to avoid server overload</li>
  <li>Handle personal data (agent contact information) in compliance with UK GDPR</li>
  <li>Use extracted data responsibly and legally</li>
  <li>Consider reaching out to Zoopla for API access if you have high-volume commercial needs</li>
</ul>

## Troubleshooting

<h3>No Results Returned</h3>

<ul>
  <li>Verify the location name is correct (try "london" instead of "London, UK")</li>
  <li>Check that price and bedroom filters aren't too restrictive</li>
  <li>Ensure <code>resultsWanted</code> is set to a reasonable number (try 50-100)</li>
  <li>Confirm proxy configuration is enabled with residential proxies</li>
</ul>

<h3>Scraper Timing Out</h3>

<ul>
  <li>Reduce <code>maxPages</code> and <code>resultsWanted</code> for faster completion</li>
  <li>Disable <code>includeDetails</code> if only basic data is needed</li>
  <li>Check that proxy configuration is correct and proxies are available</li>
</ul>

<h3>Missing Property Data</h3>

<ul>
  <li>Enable <code>includeDetails: true</code> to extract comprehensive information</li>
  <li>Some fields may be unavailable depending on the listing (e.g., EPC rating, floor plan)</li>
  <li>Verify the property listing is still active on Zoopla</li>
</ul>

<h3>Blocked or Rate Limited</h3>

<ul>
  <li>Always use residential proxies via <code>proxyConfiguration</code></li>
  <li>Reduce concurrency if experiencing frequent blocks</li>
  <li>Add delays between requests in high-volume scenarios</li>
</ul>

## Related Scrapers

<p>Expand your UK property data collection with these complementary tools:</p>

<ul>
  <li><strong>Rightmove Scraper</strong> - Extract properties from the UK's largest property portal</li>
  <li><strong>OnTheMarket Scraper</strong> - Collect listings from OnTheMarket.com</li>
  <li><strong>PrimeLocation Scraper</strong> - Scrape premium UK property listings</li>
</ul>

## Support and Feedback

<p>Need help or have suggestions? We're here to assist:</p>

<ul>
  <li>📧 <strong>Technical Support</strong> - Contact through Apify Console</li>
  <li>💬 <strong>Community</strong> - Join discussions in Apify Discord</li>
  <li>📝 <strong>Issues & Features</strong> - Report bugs or request features via Apify platform</li>
  <li>⭐ <strong>Rate This Scraper</strong> - Share your experience to help others</li>
</ul>

---

<p align="center">
  <strong>Built with ❤️ for the UK real estate community</strong><br>
  Powered by <a href="https://apify.com">Apify</a> | Data extraction made simple
</p>
