#!/usr/bin/env node
/**
 * scraper-injuries.js — Soccerway squad + injury scraper
 *
 * Discovers EFL team URLs from league match links, fetches each team's
 * Soccerway page, and extracts coach, stadium, full squad (League One block),
 * and injury/availability status for each player.
 *
 * Usage:
 *   node scraper-injuries.js                             # all three divisions
 *   node scraper-injuries.js --league EL1                # one division (ELC / EL1 / EL2)
 *   node scraper-injuries.js --team "Wycombe Wanderers"  # single team
 *
 * Outputs:
 *   data/injuries.json  — backward-compatible: { teamName: { url, scraped, players[] } }
 *   data/squads.json    — full data:
 *     {
 *       "Wycombe Wanderers": {
 *         "url": "https://www.soccerway.com/team/wycombe/hl2V5JIl/",
 *         "scraped": "2026-06-08T12:00:00.000Z",
 *         "coach": "Michael Duff",
 *         "stadium": "Adams Park (High Wycombe)",
 *         "capacity": 10137,
 *         "squad": [
 *           { "number": 50, "name": "Will Norris", "position": "GK", "age": 32,
 *             "status": null, "apps": 34, "goals": 0, "assists": 0, "yellows": 9, "reds": 0 },
 *           { "number": 17, "name": "Dan Casey", "position": "DEF", "age": 28,
 *             "status": "Hamstring Injury", ... }
 *         ]
 *       }
 *     }
 *
 * Both files are cumulative — re-running adds/updates without wiping other teams.
 * No external dependencies — uses Node.js built-in https module. Requires Node 18+.
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

// ── Name helper ───────────────────────────────────────────────────────────────
// Soccerway stores names as "Surname Firstname". Swap to "Firstname Surname"
// for two-part names. For ambiguous multi-part names, store as-is with a note.
function swapName(raw) {
  const parts = raw.trim().split(/\s+/);
  if (parts.length === 2) return `${parts[1]} ${parts[0]}`;
  // 3+ parts: can't reliably split — return as-is (Soccerway order)
  return raw.trim();
}

// ── Step 2: Parse full team data from a Soccerway squad page ─────────────────
// Extracts: stadium, capacity, coach, squad (position/number/age/stats/status)
//
// The page repeats the squad for each competition tab (League One, EFL Cup,
// FA Cup, EFL Trophy, Total). We parse only the first block by stopping at
// the first Coach entry, which terminates the League One section.
//
// Player row HTML pattern:
//   <td>{shirt}</td><td><a href="/player/...">Surname Firstname</a>{status?}</td>
//   <td>{age|?}</td><td>{apps}</td><td>{mins}</td><td>{g}</td><td>{a}</td>
//   <td>{y}</td><td>{r}</td>
//
// Known injury status strings: "Muscle Injury", "Hamstring Injury", "Injury",
//   "Inactive", "Knee Injury", "Ankle Injury", "Suspended", "Illness", etc.
function parseTeamData(html) {
  const out = {
    stadium: null,
    capacity: null,
    coach: null,
    squad: [],    // League One block only
    injured: [],  // subset of squad with a non-null status
  };

  // Stadium & capacity ─────────────────────────────────────────────────────────
  let m = html.match(/Stadium:\s*([^(<\r\n]+)/);
  if (m) out.stadium = m[1].trim();

  m = html.match(/Capacity:\s*([\d\s]+)/);
  if (m) out.capacity = parseInt(m[1].replace(/\D/g, ''), 10) || null;

  // Limit to first competition block (League One) ──────────────────────────────
  // The first "Coach" section header ends the League One squad table.
  // We grab a little extra past it to capture the coach's player link.
  const coachTagIdx = html.search(/>\s*Coach\s*</);
  const squadHtml   = coachTagIdx > 0 ? html.slice(0, coachTagIdx + 800) : html;

  // Coach ──────────────────────────────────────────────────────────────────────
  if (coachTagIdx > 0) {
    const snippet = html.slice(coachTagIdx, coachTagIdx + 800);
    m = snippet.match(/href="\/player\/[^"]+">([^<]+)<\/a>/);
    if (m) out.coach = swapName(m[1].trim());
  }

  // Squad ──────────────────────────────────────────────────────────────────────
  // Single-pass scan: track current position group, then pick up player rows.
  const POS = { Goalkeepers: 'GK', Defenders: 'DEF', Midfielders: 'MID', Forwards: 'FWD' };
  let currentPos = null;

  // Matches either:
  //   (A) a position section header  — group 1
  //   (B) a player row with shirt #  — groups 2–11
  const scanner = new RegExp(
    // (A) position header inside any tag
    '(?:>\\s*(Goalkeepers|Defenders|Midfielders|Forwards)\\s*<)' +
    '|' +
    // (B) shirt td, then player td with link + optional status, then age td,
    //     then optionally apps / mins / goals / assists / yellows / reds tds
    '(?:<td[^>]*>(\\d{1,3})<\\/td>' +               // [2] shirt number
    '\\s*<td[^>]*>' +
    '<a\\s[^>]*href="\\/player\\/[^"]+">([^<]+)<\\/a>' + // [3] name (Surname First)
    '([^<]*)<\\/td>' +                               // [4] status text (may be empty)
    '\\s*<td[^>]*>(\\d+|\\?)<\\/td>' +              // [5] age
    '(?:' +
      '\\s*<td[^>]*>(\\d+)<\\/td>' +                // [6] apps
      '\\s*<td[^>]*>(\\d+)<\\/td>' +                // [7] mins
      '\\s*<td[^>]*>(\\d+)<\\/td>' +                // [8] goals
      '\\s*<td[^>]*>(\\d+)<\\/td>' +                // [9] assists
      '\\s*<td[^>]*>(\\d+)<\\/td>' +                // [10] yellows
      '\\s*<td[^>]*>(\\d+)<\\/td>' +                // [11] reds
    ')?)',
    'g'
  );

  let match;
  while ((match = scanner.exec(squadHtml)) !== null) {
    if (match[1]) {
      // Position section header
      currentPos = POS[match[1]] || null;
    } else if (match[2] && match[3] && currentPos) {
      // Player row
      const statusRaw = (match[4] || '').trim();
      const isInjury  = /injur|inactive|suspended|illness|doubt|unavailable|unknown/i.test(statusRaw);
      const status    = isInjury ? statusRaw : null;

      const player = {
        number:   parseInt(match[2], 10),
        name:     swapName(match[3].trim()),
        position: currentPos,
        age:      match[5] === '?' ? null : parseInt(match[5], 10),
        status,
        // Stats are null if the optional stats group didn't match
        apps:     match[6]  != null ? parseInt(match[6],  10) : null,
        goals:    match[8]  != null ? parseInt(match[8],  10) : null,
        assists:  match[9]  != null ? parseInt(match[9],  10) : null,
        yellows:  match[10] != null ? parseInt(match[10], 10) : null,
        reds:     match[11] != null ? parseInt(match[11], 10) : null,
      };

      out.squad.push(player);
      if (status) out.injured.push({ name: player.name, status });
    }
  }

  // Fallback: if the stats regex didn't fire (HTML varies), populate injured
  // list from the simpler existing approach so we never silently lose that data.
  if (out.squad.length === 0) {
    const fallbackRe = /<a\s+href="\/player\/[^"]+">([^<]+)<\/a>([^<]*)/g;
    while ((m = fallbackRe.exec(squadHtml)) !== null) {
      const rawStatus = m[2].trim();
      if (/injur|inactive|suspended|illness|doubt|unavailable|unknown/i.test(rawStatus)) {
        out.injured.push({ name: swapName(m[1].trim()), status: rawStatus });
      }
    }
  }

  return out;
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

  const data = parseTeamData(html);

  // Console summary
  if (data.coach)    console.log(`  👤 Coach: ${data.coach}`);
  if (data.stadium)  console.log(`  🏟  Stadium: ${data.stadium} (cap. ${data.capacity?.toLocaleString()})`);
  console.log(`  👥 Squad: ${data.squad.length} players parsed`);
  if (data.injured.length === 0) {
    console.log(`  ✓ No injuries/unavailability found`);
  } else {
    for (const p of data.injured) console.log(`  ⚠ ${p.name} — ${p.status}`);
  }

  return {
    url:      finalUrl || teamUrl,
    scraped:  new Date().toISOString(),
    coach:    data.coach,
    stadium:  data.stadium,
    capacity: data.capacity,
    squad:    data.squad,
    // injuries key kept for backward compatibility with existing injuries.json consumer
    players:  data.injured,
  };
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function main() {
  const args = process.argv.slice(2);
  const leagueArg = args.includes('--league') ? args[args.indexOf('--league') + 1] : null;
  const teamArg   = args.includes('--team')   ? args[args.indexOf('--team') + 1]   : null;

  console.log('\nSoccerway squad + injury scraper');

  const injuriesPath = path.join(__dirname, 'data', 'injuries.json');
  const squadsPath   = path.join(__dirname, 'data', 'squads.json');

  // Load existing data (cumulative — re-runs add/update without wiping other teams)
  let existingInjuries = {};
  let existingSquads   = {};
  if (fs.existsSync(injuriesPath)) {
    try { existingInjuries = JSON.parse(fs.readFileSync(injuriesPath, 'utf8')); } catch {}
  }
  if (fs.existsSync(squadsPath)) {
    try { existingSquads = JSON.parse(fs.readFileSync(squadsPath, 'utf8')); } catch {}
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
      const cachedUrl = existingSquads[teamArg]?.url || existingInjuries[teamArg]?.url;
      if (cachedUrl) {
        teamUrls[teamArg] = cachedUrl;
        console.log(`  Using cached URL for ${teamArg}: ${cachedUrl}`);
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

  // Scrape
  console.log(`Step 2: Scraping ${teamsToScrape.length} teams...\n`);
  let success = 0, fail = 0;
  for (const [displayName, url] of teamsToScrape) {
    console.log(`${displayName}`);
    await sleep(DELAY_MS);
    const result = await scrapeTeam(displayName, url);
    if (result) {
      // injuries.json — backward-compatible: just url, scraped, players (injured only)
      existingInjuries[displayName] = {
        url:     result.url,
        scraped: result.scraped,
        players: result.players,
      };
      // squads.json — full team data
      existingSquads[displayName] = {
        url:      result.url,
        scraped:  result.scraped,
        coach:    result.coach,
        stadium:  result.stadium,
        capacity: result.capacity,
        squad:    result.squad,
      };
      success++;
    } else {
      fail++;
    }
  }

  // Write outputs
  fs.mkdirSync(path.join(__dirname, 'data'), { recursive: true });
  fs.writeFileSync(injuriesPath, JSON.stringify(existingInjuries, null, 2));
  fs.writeFileSync(squadsPath,   JSON.stringify(existingSquads,   null, 2));

  console.log(`\nDone. ${success} succeeded, ${fail} failed.`);
  console.log(`Written to ${injuriesPath}`);
  console.log(`Written to ${squadsPath}`);
}

main().catch(err => {
  console.error('Fatal:', err);
  process.exit(1);
});
