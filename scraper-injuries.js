#!/usr/bin/env node
/**
 * scraper-injuries.js — Soccerway injury scraper
 *
 * Discovers EFL team URLs from league match links, then fetches each team's
 * squad page and parses injury/availability status for each player.
 *
 * Usage:
 *   node scraper-injuries.js                        # all three divisions
 *   node scraper-injuries.js --league EL1           # one division (ELC / EL1 / EL2)
 *   node scraper-injuries.js --team "Wycombe Wanderers"  # single team
 *
 * Output: data/injuries.json
 * {
 *   "Wycombe Wanderers": {
 *     "url": "https://www.soccerway.com/team/wycombe/hl2V5JIl/",
 *     "scraped": "2026-06-07T12:00:00.000Z",
 *     "players": [
 *       { "name": "Nicolas Kocik", "status": "Muscle Injury" },
 *       { "name": "Theo Eyoum",   "status": "Inactive" }
 *     ]
 *   }
 * }
 *
 * No external dependencies — uses Node.js built-in https module.
 * Requires Node 18+.
 */

const https = require('https');
const fs    = require('fs');
const path  = require('path');

// ── Soccerway league index URLs ───────────────────────────────────────────────
const LEAGUE_URLS = {
  ELC: 'https://www.soccerway.com/england/championship/',
  EL1: 'https://www.soccerway.com/england/league-one/',
  EL2: 'https://www.soccerway.com/england/league-two/',
};

const BASE = 'https://www.soccerway.com';
const DELAY_MS = 1200; // polite delay between requests

// ── Display name → Soccerway short slug mapping ───────────────────────────────
// Short slug = the first part of the team identifier in Soccerway match URLs
// e.g. /match/rotherham-KMfM7P4b/wycombe-hl2V5JIl/ → slugs: "rotherham", "wycombe"
// These are used to match discovered hashes back to display names.
const SLUG_TO_NAME = {
  // League One
  'wycombe':          'Wycombe Wanderers',
  'rotherham':        'Rotherham United',
  'lincoln-city':     'Lincoln City',
  'bolton':           'Bolton Wanderers',
  'stockport-county': 'Stockport County',
  'bradford-city':    'Bradford City',
  'plymouth':         'Plymouth Argyle',
  'huddersfield':     'Huddersfield Town',
  'peterborough':     'Peterborough United',
  'barnsley':         'Barnsley',
  'luton':            'Luton Town',
  'leyton-orient':    'Leyton Orient',
  'mansfield':        'Mansfield Town',
  'reading':          'Reading',
  'wigan':            'Wigan Athletic',
  'stevenage':        'Stevenage',
  'afc-wimbledon':    'AFC Wimbledon',
  'burton':           'Burton Albion',
  'doncaster':        'Doncaster Rovers',
  'blackpool':        'Blackpool',
  'exeter':           'Exeter City',
  'port-vale':        'Port Vale',
  'northampton':      'Northampton Town',
  'cardiff':          'Cardiff City',
  // Championship
  'burnley':          'Burnley',
  'west-brom':        'West Bromwich Albion',
  'sheffield-utd':    'Sheffield United',
  'sunderland':       'Sunderland',
  'oxford-united':    'Oxford United',
  'swansea':          'Swansea City',
  'charlton':         'Charlton Athletic',
  'millwall':         'Millwall',
  'preston':          'Preston North End',
  'bristol-city':     'Bristol City',
  'middlesbrough':    'Middlesbrough',
  'coventry':         'Coventry City',
  'leeds':            'Leeds United',
  'norwich':          'Norwich City',
  'derby':            'Derby County',
  'hull':             'Hull City',
  'sheffield-wed':    'Sheffield Wednesday',
  'watford':          'Watford',
  'stoke':            'Stoke City',
  'portsmouth':       'Portsmouth',
  'blackburn':        'Blackburn Rovers',
  'qpr':              'Queens Park Rangers',
  'birmingham':       'Birmingham City',
  // League Two
  'wrexham':          'Wrexham',
  'gillingham':       'Gillingham',
  'cambridge-utd':    'Cambridge United',
  'newport-county':   'Newport County',
  'carlisle':         'Carlisle United',
  'bristol-rovers':   'Bristol Rovers',
  'notts-county':     'Notts County',
  'oldham':           'Oldham Athletic',
  'swindon':          'Swindon Town',
  'cheltenham':       'Cheltenham Town',
  'colchester':       'Colchester United',
  'crawley':          'Crawley Town',
  'fleetwood':        'Fleetwood Town',
  'shrewsbury':       'Shrewsbury Town',
  'morecambe':        'Morecambe',
  'salford':          'Salford City',
  'sutton':           'Sutton United',
  'accrington':       'Accrington Stanley',
  'forest-green':     'Forest Green Rovers',
  'crewe':            'Crewe Alexandra',
  'grimsby':          'Grimsby Town',
  'harrogate':        'Harrogate Town',
  'mk-dons':          'MK Dons',
  'tranmere':         'Tranmere Rovers',
  'walsall':          'Walsall',
};

// ── HTTP fetch helper ─────────────────────────────────────────────────────────
function fetchText(url, maxRedirects = 5) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; EFL-Match-Prep-Scraper/1.0)',
        'Accept': 'text/html,application/xhtml+xml',
      },
    }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        if (maxRedirects <= 0) { reject(new Error('Too many redirects')); return; }
        const next = res.headers.location.startsWith('http')
          ? res.headers.location
          : BASE + res.headers.location;
        fetchText(next, maxRedirects - 1).then(resolve).catch(reject);
        return;
      }
      if (res.statusCode !== 200) {
        reject(new Error(`HTTP ${res.statusCode} for ${url}`));
        return;
      }
      let body = '';
      res.on('data', chunk => body += chunk);
      res.on('end', () => resolve({ body, finalUrl: url }));
    });
    req.on('error', reject);
    req.setTimeout(15000, () => { req.destroy(); reject(new Error(`Timeout: ${url}`)); });
  });
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ── Step 1: Discover team URLs from league match links ────────────────────────
// Match links embed team hashes: /match/{slug1}-{hash1}/{slug2}-{hash2}/
// We collect all slug+hash pairs and build a display-name → team-page-URL map.
async function discoverTeamUrls(leagueUrls) {
  const teamUrls = {}; // displayName → full team page URL

  for (const [code, leagueUrl] of Object.entries(leagueUrls)) {
    console.log(`  Discovering teams from ${code} (${leagueUrl})`);
    let html;
    try {
      ({ body: html } = await fetchText(leagueUrl));
    } catch (err) {
      console.warn(`  ✗ Could not fetch ${leagueUrl}: ${err.message}`);
      continue;
    }
    await sleep(DELAY_MS);

    // Extract all team slug+hash pairs from match links
    // Pattern: /match/{slug1}-{hash1}/{slug2}-{hash2}/
    const matchRe = /\/match\/([a-z0-9-]+)-([A-Za-z0-9]{8})\/([a-z0-9-]+)-([A-Za-z0-9]{8})\//g;
    let m;
    while ((m = matchRe.exec(html)) !== null) {
      for (const [slug, hash] of [[m[1], m[2]], [m[3], m[4]]]) {
        const displayName = SLUG_TO_NAME[slug];
        if (displayName && !teamUrls[displayName]) {
          teamUrls[displayName] = `${BASE}/team/${slug}/${hash}/`;
        }
      }
    }
  }

  const found = Object.keys(teamUrls).length;
  console.log(`  Found ${found} team URLs\n`);
  return teamUrls;
}

// ── Step 2: Parse injuries from a team squad page ─────────────────────────────
// Soccerway squad pages are server-rendered. Injury status appears as plain
// text immediately after the player anchor, e.g.:
//   <a href="/player/kocik-nicolas/GWNiNpl0/">Nicolas Kocik</a>Muscle Injury
//
// Known status strings: "Muscle Injury", "Injury", "Inactive",
//   "Knee Injury", "Hamstring Injury", "Back Injury", "Foot Injury",
//   "Ankle Injury", "Suspended", "Illness", "Unknown Injury"
function parseInjuries(html) {
  const injured = [];

  // Match player links followed by optional injury text
  // We look for the player anchor then capture text up to the next tag
  const re = /<a\s+href="\/player\/[^"]+">([^<]+)<\/a>([^<]*)/g;
  let m;
  while ((m = re.exec(html)) !== null) {
    const playerName = m[1].trim();
    const rawStatus  = m[2].trim();

    // Only keep entries that have a recognisable injury/availability status
    if (!rawStatus) continue;

    // Filter out noise — Soccerway sometimes has stray text after player links
    // that isn't a status. Real statuses contain "Injury", "Inactive",
    // "Suspended", "Illness", or similar keywords.
    const isStatus = /injur|inactive|suspended|illness|doubt|unavailable|unknown/i.test(rawStatus)
      || /^[A-Z][a-z]+ (Injury|Inactive|Suspended|Illness)$/.test(rawStatus);

    if (isStatus) {
      injured.push({ name: playerName, status: rawStatus });
    }
  }

  return injured;
}

// ── Step 3: Scrape one team ───────────────────────────────────────────────────
async function scrapeTeam(displayName, teamUrl) {
  let html, finalUrl;
  try {
    ({ body: html, finalUrl } = await fetchText(teamUrl));
  } catch (err) {
    console.warn(`  ✗ Failed to fetch ${teamUrl}: ${err.message}`);
    return null;
  }

  const players = parseInjuries(html);

  if (players.length === 0) {
    console.log(`  ✓ No injuries/unavailability found`);
  } else {
    for (const p of players) {
      console.log(`  ⚠ ${p.name} — ${p.status}`);
    }
  }

  return {
    url: finalUrl || teamUrl,
    scraped: new Date().toISOString(),
    players,
  };
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function main() {
  const args = process.argv.slice(2);
  const leagueArg = args.includes('--league') ? args[args.indexOf('--league') + 1] : null;
  const teamArg   = args.includes('--team')   ? args[args.indexOf('--team') + 1]   : null;

  console.log('\nSoccerway injury scraper');

  const outPath = path.join(__dirname, 'data', 'injuries.json');
  let existing = {};
  if (fs.existsSync(outPath)) {
    try { existing = JSON.parse(fs.readFileSync(outPath, 'utf8')); } catch {}
  }

  // Determine which leagues to discover from
  let leaguesToDiscover;
  if (leagueArg) {
    if (!LEAGUE_URLS[leagueArg]) {
      console.error(`Unknown league "${leagueArg}". Use ELC, EL1, or EL2.`);
      process.exit(1);
    }
    leaguesToDiscover = { [leagueArg]: LEAGUE_URLS[leagueArg] };
  } else {
    leaguesToDiscover = LEAGUE_URLS;
  }

  // Discover team URLs from league pages
  console.log('\nStep 1: Discovering team URLs...');
  const teamUrls = await discoverTeamUrls(leaguesToDiscover);

  // If a specific team was requested, validate it
  if (teamArg) {
    if (!teamUrls[teamArg]) {
      // Fall back to existing URL cache if we have one
      if (existing[teamArg]?.url) {
        teamUrls[teamArg] = existing[teamArg].url;
        console.log(`  Using cached URL for ${teamArg}: ${teamUrls[teamArg]}`);
      } else {
        console.error(`Could not find Soccerway URL for "${teamArg}". Try running without --team first.`);
        process.exit(1);
      }
    }
  }

  // Determine which teams to scrape
  const teamsToScrape = teamArg
    ? [[teamArg, teamUrls[teamArg]]]
    : Object.entries(teamUrls);

  // Scrape injuries
  console.log(`Step 2: Scraping injuries for ${teamsToScrape.length} teams...\n`);
  let success = 0, fail = 0;
  for (const [displayName, url] of teamsToScrape) {
    console.log(`${displayName}`);
    await sleep(DELAY_MS);
    const result = await scrapeTeam(displayName, url);
    if (result) {
      existing[displayName] = result;
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
