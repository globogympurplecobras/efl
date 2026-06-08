#!/usr/bin/env node
/**
 * scraper-kits-wc.js — Football Kit Archive scraper for World Cup 2026
 *
 * Fetches home and away kit image URLs for all 48 WC nations and writes
 * (merges) into data/kits.json alongside existing EFL club data.
 *
 * Usage:
 *   node scraper-kits-wc.js
 *   node scraper-kits-wc.js --team spain   (single team slug for testing)
 *
 * Output: data/kits.json (merged — EFL entries are preserved)
 *
 * No external dependencies — Node 18+ only.
 */

const https = require('https');
const fs    = require('fs');
const path  = require('path');

// ── WC 2026 team map ──────────────────────────────────────────────────────────
// Key   = exact display name as returned by football-data.org API
// Value = Football Kit Archive slug
const TEAMS = {
  // Group A
  'United States':          'united-states',
  'Panama':                 'panama',
  'Canada':                 'canada',
  'Uruguay':                'uruguay',
  // Group B
  'Argentina':              'argentina',
  'Chile':                  'chile',
  'Peru':                   'peru',
  'Australia':              'australia',
  // Group C
  'Mexico':                 'mexico',
  'Ecuador':                'ecuador',
  'Venezuela':              'venezuela',
  'Cameroon':               'cameroon',
  // Group D
  'Portugal':               'portugal',
  'Turkey':                 'turkey',
  'Czech Republic':         'czech-republic',
  'Georgia':                'georgia',
  // Group E
  'Germany':                'germany',
  'Scotland':               'scotland',
  'Hungary':                'hungary',
  'Switzerland':            'switzerland',
  // Group F
  'Brazil':                 'brazil',
  'Paraguay':               'paraguay',
  'Colombia':               'colombia',
  'Japan':                  'japan',
  // Group G
  'France':                 'france',
  'Morocco':                'morocco',
  'Senegal':                'senegal',
  'South Korea':            'south-korea',
  // Group H
  'Spain':                  'spain',
  'Netherlands':            'netherlands',
  'Croatia':                'croatia',
  'Serbia':                 'serbia',
  // Group I
  'England':                'england',
  'Saudi Arabia':           'saudi-arabia',
  'Nigeria':                'nigeria',
  'Algeria':                'algeria',
  // Group J
  'Belgium':                'belgium',
  'Austria':                'austria',
  'Ukraine':                'ukraine',
  'Egypt':                  'egypt',
  // Group K
  'Poland':                 'poland',
  'Denmark':                'denmark',
  'Slovenia':               'slovenia',
  'Costa Rica':             'costa-rica',
  // Group L
  'Italy':                  'italy',
  'New Zealand':            'new-zealand',
  'Qatar':                  'qatar',
  'Honduras':               'honduras',
};

const BASE     = 'https://www.footballkitarchive.com';
const SEASON   = '2026'; // international kits use a single year, not "2025-26"
const DELAY_MS = 1200;

// ── HTTP fetch helper (identical to scraper-kits.js) ─────────────────────────
function fetchText(url) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; EFL-Match-Prep-Scraper/1.0)',
        'Accept': 'text/html',
      }
    }, (res) => {
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

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ── Parsers ───────────────────────────────────────────────────────────────────

function parseKitLinks(html, slug, season) {
  const kitLinks = { home: null, away: null, third: null };
  const re = new RegExp(
    `href="(/${slug}-${season}-(home|away|third)-kit-\\d+/)"`,
    'gi'
  );
  let m;
  while ((m = re.exec(html)) !== null) {
    const type = m[2].toLowerCase();
    if (type in kitLinks && !kitLinks[type]) kitLinks[type] = m[1];
  }
  return kitLinks;
}

function parseKitImageUrl(html) {
  const m = html.match(/href="(\/cdn\/[\d/]+\/[^/]+\/[^"]+\.(?:jpg|png|webp))"/i);
  if (m) return BASE + m[1];
  const m2 = html.match(/\(\/cdn\/([\d/]+\/[^/]+\/[^)]+\.(?:jpg|png|webp))\)/i);
  if (m2) return `${BASE}/cdn/${m2[1]}`;
  return null;
}

// ── Scrape one team ───────────────────────────────────────────────────────────
async function scrapeTeam(displayName, slug) {
  const teamUrl = `${BASE}/${slug}-kits/`;
  let teamHtml;
  try {
    teamHtml = await fetchText(teamUrl);
  } catch (err) {
    console.warn(`  ✗ Failed to fetch team page for ${displayName}: ${err.message}`);
    return null;
  }

  const kitLinks = parseKitLinks(teamHtml, slug, SEASON);

  if (!kitLinks.home && !kitLinks.away) {
    // Try without the hyphen for slugs like "south-korea" that may use a different pattern
    console.warn(`  ✗ No ${SEASON} kit links found for ${displayName} on slug "${slug}"`);
    return null;
  }

  const result = {};
  for (const type of ['home', 'away', 'third']) {
    if (!kitLinks[type]) continue;
    await sleep(DELAY_MS);
    try {
      const kitHtml = await fetchText(BASE + kitLinks[type]);
      const imgUrl  = parseKitImageUrl(kitHtml);
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
  const args    = process.argv.slice(2);
  const teamArg = args.includes('--team') ? args[args.indexOf('--team') + 1] : null;

  console.log(`\nFootball Kit Archive — World Cup 2026 scraper`);
  console.log(`Season: ${SEASON}`);
  console.log(`Output: data/kits.json (merged)\n`);

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
    const kits = await scrapeTeam(displayName, slug);
    if (kits) {
      existing[displayName] = kits;
      success++;
    } else {
      fail++;
    }
  }

  fs.mkdirSync(path.join(__dirname, 'data'), { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify(existing, null, 2));
  console.log(`\nDone. ${success} teams scraped, ${fail} failed.`);
  console.log(`Written to data/kits.json`);

  if (fail > 0) {
    console.log(`\nFor failed teams, check:`);
    console.log(`  1. Team name in TEAMS map matches football-data.org exactly`);
    console.log(`  2. Football Kit Archive slug is correct (try /{slug}-kits/ in browser)`);
    console.log(`  3. 2026 kits have been added to Football Kit Archive for that team`);
  }
}

main().catch(err => { console.error(err); process.exit(1); });
