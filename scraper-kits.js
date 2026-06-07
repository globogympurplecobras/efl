#!/usr/bin/env node
/**
 * scraper-kits.js — Football Kit Archive scraper
 *
 * Fetches home and away kit image URLs for EFL clubs and writes data/kits.json.
 * Run manually before a new season or when kit images need refreshing.
 *
 * Usage:
 *   node scraper-kits.js
 *   node scraper-kits.js --season 2026-27   (override season, default: auto-detected)
 *   node scraper-kits.js --team wycombe-wanderers  (single team for testing)
 *
 * Output: data/kits.json
 * {
 *   "Wycombe Wanderers": {
 *     "home": "https://www.footballkitarchive.com/cdn/2025/07/05/.../wycombe-wanderers-2025-26-home-kit.jpg",
 *     "away": "https://www.footballkitarchive.com/cdn/2025/07/05/.../wycombe-wanderers-2025-26-away-kit.jpg",
 *     "third": "https://www.footballkitarchive.com/cdn/..."   // if available
 *   },
 *   ...
 * }
 *
 * No external dependencies — uses Node.js built-in https module.
 * Requires Node 18+ for globalThis.fetch, or falls back to https module.
 */

const https = require('https');
const fs = require('fs');
const path = require('path');

// ── Season detection ──────────────────────────────────────────────────────────
// EFL season runs Aug–May. If we're in Jun–Jul, the new season kits may be
// released early — try current+1 first, fall back to current.
function currentSeason() {
  const now = new Date();
  const year = now.getFullYear();
  const month = now.getMonth() + 1; // 1-based
  const startYear = month >= 6 ? year : year - 1;
  const short = (y) => String(y).slice(2);
  return `${startYear}-${short(startYear + 1)}`;
}

// ── EFL team slug map ─────────────────────────────────────────────────────────
// Key = display name (must match TEAM_COLORS keys in app.js)
// Value = Football Kit Archive slug
const TEAMS = {
  // League One 2025-26
  'Wycombe Wanderers':    'wycombe-wanderers',
  'Rotherham United':     'rotherham-united',
  'Lincoln City':         'lincoln-city',
  'Bolton Wanderers':     'bolton-wanderers',
  'Stockport County':     'stockport-county',
  'Bradford City':        'bradford-city',
  'Plymouth Argyle':      'plymouth-argyle',
  'Huddersfield Town':    'huddersfield-town',
  'Peterborough United':  'peterborough-united',
  'Barnsley':             'barnsley',
  'Luton Town':           'luton-town',
  'Leyton Orient':        'leyton-orient',
  'Mansfield Town':       'mansfield-town',
  'Reading':              'reading',
  'Wigan Athletic':       'wigan-athletic',
  'Stevenage':            'stevenage',
  'AFC Wimbledon':        'afc-wimbledon',
  'Burton Albion':        'burton-albion',
  'Doncaster Rovers':     'doncaster-rovers',
  'Blackpool':            'blackpool-fc',
  'Exeter City':          'exeter-city',
  'Port Vale':            'port-vale',
  'Northampton Town':     'northampton-town',
  // Championship
  'Cardiff City':         'cardiff-city',
  'Burnley':              'burnley',
  'West Bromwich Albion': 'west-bromwich-albion',
  'Sheffield United':     'sheffield-united',
  'Sunderland':           'sunderland-afc',
  'Oxford United':        'oxford-united',
  'Swansea City':         'swansea-city',
  'Charlton Athletic':    'charlton-athletic',
  'Millwall':             'millwall',
  'Preston North End':    'preston-north-end',
  'Bristol City':         'bristol-city',
  'Middlesbrough':        'middlesbrough',
  'Coventry City':        'coventry-city',
  'Leeds United':         'leeds-united',
  'Norwich City':         'norwich-city',
  'Derby County':         'derby-county',
  'Hull City':            'hull-city',
  'Sheffield Wednesday':  'sheffield-wednesday',
  'Watford':              'watford',
  'Stoke City':           'stoke-city',
  'Portsmouth':           'portsmouth',
  'Blackburn Rovers':     'blackburn-rovers',
  'Queens Park Rangers':  'queens-park-rangers',
  'Birmingham City':      'birmingham-city',
  // League Two
  'Wrexham':              'wrexham',
  'Gillingham':           'gillingham',
  'Cambridge United':     'cambridge-united',
  'Newport County':       'newport-county',
  'Carlisle United':      'carlisle-united',
  'Bristol Rovers':       'bristol-rovers',
  'Notts County':         'notts-county',
  'Oldham Athletic':      'oldham-athletic',
  'Swindon Town':         'swindon-town',
  'Cheltenham Town':      'cheltenham-town',
  'Colchester United':    'colchester-united',
  'Crawley Town':         'crawley-town',
  'Fleetwood Town':       'fleetwood-town',
  'Shrewsbury Town':      'shrewsbury-town',
  'Morecambe':            'morecambe',
  'Salford City':         'salford-city',
  'Sutton United':        'sutton-united',
  'Accrington Stanley':   'accrington-stanley',
  'Forest Green Rovers':  'forest-green-rovers',
  'Crewe Alexandra':      'crewe-alexandra',
  'Grimsby Town':         'grimsby-town',
  'Harrogate Town':       'harrogate-town',
  'MK Dons':              'mk-dons',
  'Tranmere Rovers':      'tranmere-rovers',
  'Walsall':              'walsall',
};

const BASE = 'https://www.footballkitarchive.com';
const DELAY_MS = 1000; // polite delay between requests

// ── HTTP fetch helper ─────────────────────────────────────────────────────────
function fetchText(url) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; EFL-Match-Prep-Scraper/1.0)',
        'Accept': 'text/html',
      }
    }, (res) => {
      // Follow redirects
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        const redirectUrl = res.headers.location.startsWith('http')
          ? res.headers.location
          : BASE + res.headers.location;
        fetchText(redirectUrl).then(resolve).catch(reject);
        return;
      }
      if (res.statusCode !== 200) {
        reject(new Error(`HTTP ${res.statusCode} for ${url}`));
        return;
      }
      let body = '';
      res.on('data', chunk => body += chunk);
      res.on('end', () => resolve(body));
    });
    req.on('error', reject);
    req.setTimeout(15000, () => { req.destroy(); reject(new Error(`Timeout: ${url}`)); });
  });
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ── Parsers ───────────────────────────────────────────────────────────────────

// From team kits page, extract links to individual kit pages for a given season
// Returns { home, away, third } — each a relative path or null
function parseKitLinks(html, slug, season) {
  const kitLinks = { home: null, away: null, third: null };
  // Match hrefs like /wycombe-wanderers-2025-26-home-kit-385535/
  const re = new RegExp(
    `href="(/${slug}-${season}-(home|away|third)-kit-\\d+/)"`,
    'gi'
  );
  let m;
  while ((m = re.exec(html)) !== null) {
    const type = m[2].toLowerCase();
    if (type in kitLinks && !kitLinks[type]) {
      kitLinks[type] = m[1];
    }
  }
  return kitLinks;
}

// From an individual kit page, extract the first /cdn/... image URL
function parseKitImageUrl(html) {
  // Links like: href="/cdn/2025/07/05/V2KTGcc6ryxGi5Z/wycombe-wanderers-2025-26-home-kit.jpg"
  const m = html.match(/href="(\/cdn\/[\d/]+\/[^/]+\/[^"]+\.(?:jpg|png|webp))"/i);
  if (m) return BASE + m[1];
  // Also try <a href=...> pattern without quotes difference
  const m2 = html.match(/\(\/cdn\/([\d/]+\/[^/]+\/[^)]+\.(?:jpg|png|webp))\)/i);
  if (m2) return `${BASE}/cdn/${m2[1]}`;
  return null;
}

// ── Scrape one team ───────────────────────────────────────────────────────────
async function scrapeTeam(displayName, slug, season) {
  const teamUrl = `${BASE}/${slug}-kits/`;
  let teamHtml;
  try {
    teamHtml = await fetchText(teamUrl);
  } catch (err) {
    console.warn(`  ✗ Failed to fetch team page for ${displayName}: ${err.message}`);
    return null;
  }

  const kitLinks = parseKitLinks(teamHtml, slug, season);

  // If no kits found for this season, try the prior season as fallback
  if (!kitLinks.home && !kitLinks.away) {
    const [startYr] = season.split('-').map(Number);
    const prevSeason = `${startYr - 1}-${String(startYr).slice(2)}`;
    const fallbackLinks = parseKitLinks(teamHtml, slug, prevSeason);
    if (fallbackLinks.home || fallbackLinks.away) {
      console.log(`  ↩ No ${season} kits found, falling back to ${prevSeason}`);
      Object.assign(kitLinks, fallbackLinks);
    }
  }

  if (!kitLinks.home && !kitLinks.away) {
    console.warn(`  ✗ No kit links found for ${displayName} (${season})`);
    return null;
  }

  const result = {};
  for (const type of ['home', 'away', 'third']) {
    if (!kitLinks[type]) continue;
    await sleep(DELAY_MS);
    try {
      const kitHtml = await fetchText(BASE + kitLinks[type]);
      const imgUrl = parseKitImageUrl(kitHtml);
      if (imgUrl) {
        result[type] = imgUrl;
        console.log(`  ✓ ${type}: ${imgUrl.split('/').slice(-1)[0]}`);
      } else {
        console.warn(`  ✗ Could not parse image URL from ${kitLinks[type]}`);
      }
    } catch (err) {
      console.warn(`  ✗ Failed to fetch ${type} kit page: ${err.message}`);
    }
  }

  return Object.keys(result).length > 0 ? result : null;
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function main() {
  const args = process.argv.slice(2);
  const seasonArg = args.includes('--season')
    ? args[args.indexOf('--season') + 1]
    : null;
  const teamArg = args.includes('--team')
    ? args[args.indexOf('--team') + 1]
    : null;

  const season = seasonArg || currentSeason();
  console.log(`\nFootball Kit Archive scraper`);
  console.log(`Season: ${season}`);
  console.log(`Output: data/kits.json\n`);

  // Load existing kits.json so we can merge/update
  const outPath = path.join(__dirname, 'data', 'kits.json');
  let existing = {};
  if (fs.existsSync(outPath)) {
    try { existing = JSON.parse(fs.readFileSync(outPath, 'utf8')); } catch {}
  }

  const teamsToScrape = teamArg
    ? Object.entries(TEAMS).filter(([, slug]) => slug === teamArg)
    : Object.entries(TEAMS);

  if (teamsToScrape.length === 0) {
    console.error(`No team found with slug "${teamArg}"`);
    process.exit(1);
  }

  let success = 0, fail = 0;
  for (const [displayName, slug] of teamsToScrape) {
    console.log(`${displayName} (${slug})`);
    await sleep(DELAY_MS);
    const kits = await scrapeTeam(displayName, slug, season);
    if (kits) {
      existing[displayName] = kits;
      success++;
    } else {
      fail++;
    }
  }

  // Write output
  fs.mkdirSync(path.join(__dirname, 'data'), { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify(existing, null, 2));

  console.log(`\nDone. ${success} succeeded, ${fail} failed.`);
  console.log(`Written to ${outPath}`);
}

main().catch(err => {
  console.error('Fatal:', err);
  process.exit(1);
});
