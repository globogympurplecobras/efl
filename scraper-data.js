#!/usr/bin/env node
/**
 * scraper-data.js — football-data.org build-time data scraper
 *
 * Fetches all slow-changing match data from football-data.org and writes
 * static JSON files to data/. The browser app loads these files at startup
 * instead of making live API calls, which avoids CORS proxies and rate limits.
 *
 * Run this the day before (or morning of) a match. Data changes at most daily.
 *
 * Usage:
 *   node scraper-data.js --match <matchId>
 *   node scraper-data.js --comp WC --date 2026-06-15
 *   node scraper-data.js --comp ELC --date 2026-08-10
 *
 * Output files (all merged — existing entries preserved):
 *   data/teams.json       — squad + manager per team id
 *   data/tables.json      — standings per competition code
 *   data/h2h.json         — head-to-head per matchId
 *   data/form.json        — last 10 finished matches per team id
 *   data/matches.json     — fixture index: matchId → basic match object
 *
 * Requires Node 18+, no external dependencies.
 * API key read from env var FOOTBALL_DATA_KEY or .env file.
 */

const https = require('https');
const fs    = require('fs');
const path  = require('path');

// ── Config ────────────────────────────────────────────────────────────────────
const DATA_DIR = path.join(__dirname, 'data');

// Load API key from .env if present
function loadEnv() {
  const envPath = path.join(__dirname, '.env');
  if (!fs.existsSync(envPath)) return;
  fs.readFileSync(envPath, 'utf8').split('\n').forEach(line => {
    const [k, ...v] = line.split('=');
    if (k && v.length && !process.env[k.trim()]) {
      process.env[k.trim()] = v.join('=').trim().replace(/^["']|["']$/g, '');
    }
  });
}
loadEnv();

const API_KEY  = process.env.FOOTBALL_DATA_KEY || '';
const API_BASE = 'https://api.football-data.org/v4';

if (!API_KEY) {
  console.error('Error: FOOTBALL_DATA_KEY environment variable not set.');
  console.error('Add it to a .env file: FOOTBALL_DATA_KEY=your_key_here');
  process.exit(1);
}

// ── HTTP helper ───────────────────────────────────────────────────────────────
function apiGet(endpoint) {
  return new Promise((resolve, reject) => {
    const url = API_BASE + endpoint;
    const req = https.get(url, {
      headers: {
        'X-Auth-Token': API_KEY,
        'Accept': 'application/json',
      }
    }, (res) => {
      let body = '';
      res.on('data', c => body += c);
      res.on('end', () => {
        if (res.statusCode === 429) {
          reject(new Error('RATE_LIMIT'));
          return;
        }
        if (res.statusCode !== 200) {
          reject(new Error(`HTTP ${res.statusCode} for ${endpoint}: ${body.slice(0,200)}`));
          return;
        }
        try { resolve(JSON.parse(body)); }
        catch (e) { reject(new Error(`JSON parse error for ${endpoint}`)); }
      });
    });
    req.on('error', reject);
    req.setTimeout(20000, () => { req.destroy(); reject(new Error(`Timeout: ${endpoint}`)); });
  });
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ── JSON file helpers ─────────────────────────────────────────────────────────
function readJson(filename) {
  const p = path.join(DATA_DIR, filename);
  if (!fs.existsSync(p)) return {};
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return {}; }
}

function writeJson(filename, data) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(path.join(DATA_DIR, filename), JSON.stringify(data, null, 2));
  console.log(`  → wrote data/${filename}`);
}

// ── Data normalisers (match football-data.org shapes app.js already expects) ──

function normaliseTeam(teamData) {
  // /teams/{id} response — keep only what app.js uses
  return {
    id:      teamData.id,
    name:    teamData.name,
    tla:     teamData.tla,
    crest:   teamData.crest,
    venue:   teamData.venue,
    coach: teamData.coach ? {
      id:          teamData.coach.id,
      name:        teamData.coach.name,
      nationality: teamData.coach.nationality,
    } : null,
    squad: (teamData.squad || []).map(p => ({
      id:          p.id,
      name:        p.name,
      position:    p.position,
      dateOfBirth: p.dateOfBirth,
      nationality: p.nationality,
      shirtNumber: p.shirtNumber ?? null,
    })),
  };
}

function normaliseStandings(standingsData) {
  // /competitions/{comp}/standings response
  return {
    competition: standingsData.competition,
    season:      standingsData.season,
    standings:   standingsData.standings,
  };
}

function normaliseH2H(h2hData) {
  // /matches/{id}/head2head response — keep full shape, app.js uses aggregates + matches
  return {
    aggregates: h2hData.aggregates,
    matches: (h2hData.matches || []).map(m => ({
      id:       m.id,
      utcDate:  m.utcDate,
      status:   m.status,
      venue:    m.venue ?? null,
      homeTeam: { id: m.homeTeam.id, name: m.homeTeam.name },
      awayTeam: { id: m.awayTeam.id, name: m.awayTeam.name },
      score:    m.score,
      goals:    m.goals || [],
    })),
  };
}

function normaliseForm(matchesData) {
  // /teams/{id}/matches response — keep full shape, app.js uses matches[]
  return {
    matches: (matchesData.matches || []).map(m => ({
      id:       m.id,
      utcDate:  m.utcDate,
      status:   m.status,
      venue:    m.venue ?? null,
      homeTeam: { id: m.homeTeam.id, name: m.homeTeam.name },
      awayTeam: { id: m.awayTeam.id, name: m.awayTeam.name },
      score:    m.score,
      goals:    m.goals || [],
    })),
  };
}

function normaliseMatch(m) {
  return {
    id:       m.id,
    utcDate:  m.utcDate,
    status:   m.status,
    venue:    m.venue ?? null,
    homeTeam: { id: m.homeTeam.id, name: m.homeTeam.name, tla: m.homeTeam.tla },
    awayTeam: { id: m.awayTeam.id, name: m.awayTeam.name, tla: m.awayTeam.tla },
    score:    m.score,
    goals:    m.goals || [],
    odds:     m.odds ?? null,
  };
}

// ── Main fetch routines ───────────────────────────────────────────────────────

async function fetchForMatch(matchId) {
  console.log(`\nFetching data for match ${matchId}…`);

  // 1. Fetch the match itself to get team IDs and competition
  let match;
  try {
    const data = await apiGet(`/matches/${matchId}`);
    match = data;
    console.log(`  Match: ${match.homeTeam.name} vs ${match.awayTeam.name}`);
  } catch (err) {
    console.error(`  ✗ Could not fetch match ${matchId}: ${err.message}`);
    return;
  }

  const hId   = match.homeTeam.id;
  const aId   = match.awayTeam.id;
  const comp  = match.competition.code;
  const today = new Date().toISOString().split('T')[0];
  // Form window: for tournament (WC/EC) use competition start; for league use season start Aug
  const isTournament = !['ELC','EL1','EL2','PL'].includes(comp);
  const seasonStart  = isTournament
    ? (match.season?.startDate || `${new Date().getFullYear()}-01-01`)
    : `${new Date().getMonth() >= 7 ? new Date().getFullYear() : new Date().getFullYear() - 1}-08-01`;

  // Load existing data
  const teams   = readJson('teams.json');
  const tables  = readJson('tables.json');
  const h2h     = readJson('h2h.json');
  const form    = readJson('form.json');
  const matches = readJson('matches.json');

  // 2. Store the match itself
  matches[matchId] = normaliseMatch(match);

  // 3. Home team
  if (!teams[hId]) {
    console.log(`  Fetching home team (${match.homeTeam.name})…`);
    await sleep(600);
    try {
      const data = await apiGet(`/teams/${hId}`);
      teams[hId] = normaliseTeam(data);
      console.log(`    ✓ Squad: ${teams[hId].squad.length} players, Manager: ${teams[hId].coach?.name || 'unknown'}`);
    } catch (err) { console.warn(`    ✗ ${err.message}`); }
  } else {
    console.log(`  Home team cached (${match.homeTeam.name})`);
  }

  // 4. Away team
  if (!teams[aId]) {
    console.log(`  Fetching away team (${match.awayTeam.name})…`);
    await sleep(600);
    try {
      const data = await apiGet(`/teams/${aId}`);
      teams[aId] = normaliseTeam(data);
      console.log(`    ✓ Squad: ${teams[aId].squad.length} players, Manager: ${teams[aId].coach?.name || 'unknown'}`);
    } catch (err) { console.warn(`    ✗ ${err.message}`); }
  } else {
    console.log(`  Away team cached (${match.awayTeam.name})`);
  }

  // 5. Standings
  console.log(`  Fetching standings (${comp})…`);
  await sleep(600);
  try {
    const data = await apiGet(`/competitions/${comp}/standings`);
    tables[comp] = normaliseStandings(data);
    const count = (data.standings || []).reduce((n, s) => n + (s.table?.length || 0), 0);
    console.log(`    ✓ ${count} table entries`);
  } catch (err) { console.warn(`    ✗ Standings: ${err.message}`); }

  // 6. H2H
  console.log(`  Fetching H2H…`);
  await sleep(600);
  try {
    const data = await apiGet(`/matches/${matchId}/head2head?limit=10`);
    h2h[matchId] = normaliseH2H(data);
    console.log(`    ✓ ${h2h[matchId].matches.length} meetings`);
  } catch (err) { console.warn(`    ✗ H2H: ${err.message}`); }

  // 7. Home form
  console.log(`  Fetching home form…`);
  await sleep(600);
  try {
    const data = await apiGet(`/teams/${hId}/matches?status=FINISHED&dateFrom=${seasonStart}&dateTo=${today}&limit=10`);
    form[hId] = normaliseForm(data);
    console.log(`    ✓ ${form[hId].matches.length} matches`);
  } catch (err) { console.warn(`    ✗ Home form: ${err.message}`); }

  // 8. Away form
  console.log(`  Fetching away form…`);
  await sleep(600);
  try {
    const data = await apiGet(`/teams/${aId}/matches?status=FINISHED&dateFrom=${seasonStart}&dateTo=${today}&limit=10`);
    form[aId] = normaliseForm(data);
    console.log(`    ✓ ${form[aId].matches.length} matches`);
  } catch (err) { console.warn(`    ✗ Away form: ${err.message}`); }

  // Write all files
  writeJson('teams.json',   teams);
  writeJson('tables.json',  tables);
  writeJson('h2h.json',     h2h);
  writeJson('form.json',    form);
  writeJson('matches.json', matches);

  console.log(`\nDone. Reload the app and select match ${matchId}.`);
}

async function fetchFixturesForDate(comp, date) {
  console.log(`\nFetching fixtures for ${comp} on ${date}…`);
  try {
    const data = await apiGet(`/competitions/${comp}/matches?dateFrom=${date}&dateTo=${date}`);
    const ms = data.matches || [];
    if (!ms.length) { console.log('  No fixtures on this date.'); return; }
    console.log(`\n  Found ${ms.length} fixture(s):\n`);
    ms.forEach((m, i) => {
      console.log(`  [${i + 1}] Match ID ${m.id}: ${m.homeTeam.name} vs ${m.awayTeam.name} (${m.utcDate.slice(11,16)} UTC)`);
    });
    console.log(`\nRun with --match <id> to fetch full data for a specific fixture.`);
  } catch (err) {
    console.error(`  ✗ ${err.message}`);
  }
}

// ── CLI ───────────────────────────────────────────────────────────────────────
async function main() {
  const args    = process.argv.slice(2);
  const matchId = args.includes('--match') ? args[args.indexOf('--match') + 1] : null;
  const comp    = args.includes('--comp')  ? args[args.indexOf('--comp') + 1]  : null;
  const date    = args.includes('--date')  ? args[args.indexOf('--date') + 1]  : null;

  if (!matchId && !comp) {
    console.log(`
Usage:
  node scraper-data.js --comp WC --date 2026-06-15     # list fixtures on a date
  node scraper-data.js --match 521234                   # fetch full data for a match
`);
    process.exit(0);
  }

  if (matchId) {
    await fetchForMatch(matchId);
  } else if (comp && date) {
    await fetchFixturesForDate(comp, date);
  } else {
    console.error('Provide both --comp and --date, or --match <id>');
    process.exit(1);
  }
}

main().catch(err => { console.error(err); process.exit(1); });
