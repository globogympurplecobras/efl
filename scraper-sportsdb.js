#!/usr/bin/env node
/**
 * scraper-sportsdb.js — TheSportsDB build-time data scraper
 *
 * Free alternative to scraper-sofascore.js. Uses TheSportsDB's public API
 * (free key "123") — no account or payment required.
 *
 * Covers Championship, League One, League Two, and World Cup 2026.
 * Outputs the same JSON files as scraper-sofascore.js so app.js loads them unchanged.
 *
 * Usage:
 *   node scraper-sportsdb.js --comp ELC --date 2026-08-10   # list fixtures on a date
 *   node scraper-sportsdb.js --match 1234567                # fetch full data for a match
 *
 * Output files:
 *   data/teams.json    — squad + coach + colours per team id
 *   data/tables.json   — standings per competition code
 *   data/h2h.json      — head-to-head per match id (best-effort on free tier)
 *   data/form.json     — recent matches per team id
 *   data/matches.json  — fixture index: matchId → basic match object
 *
 * Free tier limits (key "123"):
 *   - 30 requests/minute
 *   - eventslast/eventsnext: limited to 5 events (all events, not just home)
 *   - eventsseason: up to 15 results (used for form fallback)
 *   - lookup_all_players: up to 30 players per team
 *   - lookuptable: up to 5 rows (featured leagues only — EFL included)
 *
 * Requires Node 18+. No external dependencies.
 */

const https  = require('https');
const http   = require('http');
const fs     = require('fs');
const path   = require('path');
const zlib   = require('zlib');

// ── Competition config ────────────────────────────────────────────────────────
// TheSportsDB league IDs — verify at thesportsdb.com/browse_leagues if wrong
const COMPS = {
  ELC: { name: 'Sky Bet Championship',  leagueId: 4329, season: '2025-2026' },
  EL1: { name: 'Sky Bet League One',    leagueId: 4396, season: '2025-2026' },
  EL2: { name: 'Sky Bet League Two',    leagueId: 4397, season: '2025-2026' },
  WC:  { name: 'FIFA World Cup 2026',   leagueId: 4429, season: '2026'      },
};

const BASE     = 'https://www.thesportsdb.com/api/v1/json/123';
const DATA_DIR = path.join(__dirname, 'data');
const DELAY_MS = 400; // well under the 30 req/min limit

// ── HTTP helper ───────────────────────────────────────────────────────────────
function apiGet(endpoint) {
  return new Promise((resolve, reject) => {
    const url = BASE + endpoint;
    const mod = url.startsWith('https') ? https : http;
    const req = mod.get(url, {
      headers: {
        'User-Agent':      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
        'Accept':          'application/json',
        'Accept-Encoding': 'gzip, deflate',
      }
    }, (res) => {
      if (res.statusCode === 429) { reject(new Error('RATE_LIMIT')); return; }
      if (res.statusCode === 301 || res.statusCode === 302) {
        // follow redirect
        const loc = res.headers.location;
        if (!loc) { reject(new Error('Redirect with no location')); return; }
        const full = loc.startsWith('http') ? loc : new URL(loc, url).href;
        apiGetRaw(full).then(resolve).catch(reject);
        return;
      }
      if (res.statusCode !== 200) {
        reject(new Error(`HTTP ${res.statusCode} for ${endpoint}`)); return;
      }
      const enc = res.headers['content-encoding'];
      let stream = res;
      if (enc === 'gzip')    stream = res.pipe(zlib.createGunzip());
      if (enc === 'deflate') stream = res.pipe(zlib.createInflate());
      let body = '';
      stream.on('data', c => body += c);
      stream.on('end', () => {
        try { resolve(JSON.parse(body)); }
        catch { reject(new Error(`JSON parse error for ${endpoint}`)); }
      });
    });
    req.on('error', reject);
    req.setTimeout(15000, () => { req.destroy(); reject(new Error(`Timeout: ${endpoint}`)); });
  });
}

// Raw URL variant for redirects
function apiGetRaw(url) {
  return new Promise((resolve, reject) => {
    const mod = url.startsWith('https') ? https : http;
    const req = mod.get(url, {
      headers: { 'User-Agent': 'Mozilla/5.0', 'Accept': 'application/json', 'Accept-Encoding': 'gzip, deflate' }
    }, (res) => {
      const enc = res.headers['content-encoding'];
      let stream = res;
      if (enc === 'gzip')    stream = res.pipe(zlib.createGunzip());
      if (enc === 'deflate') stream = res.pipe(zlib.createInflate());
      let body = '';
      stream.on('data', c => body += c);
      stream.on('end', () => {
        try { resolve(JSON.parse(body)); }
        catch { reject(new Error('JSON parse error')); }
      });
    });
    req.on('error', reject);
    req.setTimeout(15000, () => { req.destroy(); reject(new Error('Timeout')); });
  });
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ── File helpers ──────────────────────────────────────────────────────────────
function readJson(filename) {
  const p = path.join(DATA_DIR, filename);
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); }
  catch { return {}; }
}

function writeJson(filename, data) {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(path.join(DATA_DIR, filename), JSON.stringify(data, null, 2));
  console.log(`  → data/${filename} written`);
}

// ── Data transformers ─────────────────────────────────────────────────────────

/**
 * Convert a TheSportsDB event object to the internal match shape.
 * Internal shape mirrors football-data.org / scraper-sofascore output.
 */
function eventToMatch(ev, comp) {
  const hScore = ev.intHomeScore != null ? parseInt(ev.intHomeScore) : null;
  const aScore = ev.intAwayScore != null ? parseInt(ev.intAwayScore) : null;
  return {
    id:       String(ev.idEvent),
    utcDate:  ev.strTimestamp || `${ev.dateEvent}T${ev.strTime || '12:00:00'}Z`,
    status:   (ev.strStatus === 'Match Finished' || (hScore !== null && aScore !== null)) ? 'FINISHED' : 'SCHEDULED',
    venue:    ev.strVenue || null,
    compCode: comp,
    homeTeam: { id: String(ev.idHomeTeam), name: ev.strHomeTeam, tla: tla(ev.strHomeTeam) },
    awayTeam: { id: String(ev.idAwayTeam), name: ev.strAwayTeam, tla: tla(ev.strAwayTeam) },
    score: {
      fullTime: { home: hScore, away: aScore }
    },
  };
}

/** Make a rough 3-letter abbreviation from a team name */
function tla(name) {
  if (!name) return '???';
  const words = name.replace(/\bFC\b|\bAFC\b|\bUnited\b/gi, '').trim().split(/\s+/);
  if (words.length === 1) return words[0].slice(0, 3).toUpperCase();
  return words.map(w => w[0]).join('').slice(0, 3).toUpperCase();
}

/**
 * Convert TheSportsDB team + players into internal team shape.
 * colors.primary comes from strColourPrimary (e.g. "#FF0000").
 */
function buildTeam(teamData, players, comp) {
  const t = teamData;
  const primary   = t.strColourPrimary   ? `#${t.strColourPrimary.replace('#','')}` : null;
  const secondary = t.strColourSecondary ? `#${t.strColourSecondary.replace('#','')}` : null;

  const squad = (players || []).map(p => ({
    id:          String(p.idPlayer),
    name:        p.strPlayer,
    position:    positionMap(p.strPosition),
    nationality: p.strNationality || null,
    shirtNumber: p.strNumber ? parseInt(p.strNumber) : null,
    age:         p.dateBorn ? ageFromDob(p.dateBorn) : null,
  }));

  return {
    id:     String(t.idTeam),
    name:   t.strTeam,
    tla:    tla(t.strTeam),
    crest:  t.strBadge || null,
    venue:  t.strStadium || null,
    colors: { primary, secondary },
    coach:  null, // TheSportsDB free tier doesn't expose current manager — set manually or leave null
    squad,
  };
}

function positionMap(str) {
  if (!str) return 'Unknown';
  const s = str.toLowerCase();
  if (s.includes('goalkeeper') || s === 'gk') return 'Goalkeeper';
  if (s.includes('defender') || s === 'cb' || s === 'lb' || s === 'rb') return 'Defender';
  if (s.includes('midfielder') || s === 'cm' || s === 'dm' || s === 'am') return 'Midfielder';
  if (s.includes('forward') || s.includes('striker') || s === 'cf' || s === 'lw' || s === 'rw') return 'Attacker';
  return str;
}

function ageFromDob(dob) {
  if (!dob) return null;
  const diff = Date.now() - new Date(dob).getTime();
  return Math.floor(diff / (1000 * 60 * 60 * 24 * 365.25));
}

/**
 * Convert TheSportsDB standings rows to internal table shape.
 * Internal shape: { competition, standings: [{ table: [{position,team,points,...}] }] }
 */
function buildTable(rows, comp) {
  if (!rows || !rows.length) return null;
  const table = rows.map(r => ({
    position:       parseInt(r.intRank),
    team:           { id: String(r.idTeam), name: r.strTeam, tla: tla(r.strTeam) },
    playedGames:    parseInt(r.intPlayed || 0),
    won:            parseInt(r.intWin    || 0),
    draw:           parseInt(r.intDraw   || 0),
    lost:           parseInt(r.intLoss   || 0),
    points:         parseInt(r.intPoints || 0),
    goalsFor:       parseInt(r.intGoalsFor  || 0),
    goalsAgainst:   parseInt(r.intGoalsAgainst || 0),
    goalDifference: parseInt(r.intGoalDifference || 0),
  }));
  return {
    competition: { code: comp, name: COMPS[comp]?.name || comp },
    standings:   [{ type: 'TOTAL', table }],
  };
}

/**
 * Convert a list of TheSportsDB events (past matches) into the internal form shape.
 * Internal shape: { matches: [ {id, utcDate, status, homeTeam, awayTeam, score, competition} ] }
 */
function buildForm(events, comp) {
  const matches = (events || [])
    .map(ev => eventToMatch(ev, comp))
    .filter(m => m.score.fullTime.home !== null);
  return { matches };
}

/**
 * Build an H2H object from a list of past meetings between two teams.
 * Internal shape mirrors scraper-sofascore fetchH2H output.
 */
function buildH2H(meetings, hId, aId) {
  const finished = (meetings || []).filter(ev => ev.strStatus === 'Match Finished');
  let hWins = 0, aWins = 0, draws = 0;
  for (const ev of finished) {
    const hs = parseInt(ev.intHomeScore), as = parseInt(ev.intAwayScore);
    const evHId = String(ev.idHomeTeam), evAId = String(ev.idAwayTeam);
    if (hs > as) { if (evHId === hId) hWins++; else aWins++; }
    else if (as > hs) { if (evAId === aId) aWins++; else hWins++; }
    else draws++;
  }
  return {
    aggregates: {
      numberOfMatches: finished.length,
      homeTeam: { wins: hWins },
      awayTeam: { wins: aWins },
      draws,
    },
    matches: finished.map(ev => eventToMatch(ev, 'UNKNOWN')).reverse(),
  };
}

// ── API fetch helpers ─────────────────────────────────────────────────────────

async function fetchFixturesOnDate(leagueId, date) {
  // eventsday returns all sports; filter by leagueId
  const data = await apiGet(`/eventsday.php?d=${date}&l=${leagueId}`);
  return data.events || [];
}

async function fetchTeamData(teamId) {
  const data = await apiGet(`/lookupteam.php?id=${teamId}`);
  return (data.teams || [])[0] || null;
}

async function fetchPlayers(teamId) {
  const data = await apiGet(`/lookup_all_players.php?id=${teamId}`);
  return data.player || [];
}

async function fetchTable(leagueId) {
  const data = await apiGet(`/lookuptable.php?l=${leagueId}`);
  return data.table || [];
}

async function fetchLastEvents(teamId) {
  const data = await apiGet(`/eventslast.php?id=${teamId}`);
  return data.results || [];
}

async function fetchH2HEvents(eventId) {
  // TheSportsDB doesn't have a direct H2H endpoint on free tier.
  // We use the event lookup to get both team IDs, then fetch last events for each
  // and find matches they played against each other.
  const data = await apiGet(`/lookupevent.php?id=${eventId}`);
  return (data.events || [])[0] || null;
}

async function fetchEventsByTeamPair(teamAId, teamBId) {
  // Fetch last ~5 events for team A and filter for games vs team B
  const data = await apiGet(`/eventslast.php?id=${teamAId}`);
  const events = data.results || [];
  return events.filter(ev =>
    String(ev.idHomeTeam) === teamBId || String(ev.idAwayTeam) === teamBId
  );
}

// ── Main flows ────────────────────────────────────────────────────────────────

async function listFixtures(comp, date) {
  const cfg = COMPS[comp];
  if (!cfg) { console.error(`Unknown comp: ${comp}. Use: ${Object.keys(COMPS).join(', ')}`); process.exit(1); }

  console.log(`\nFetching ${cfg.name} fixtures for ${date}…`);
  let events;
  try {
    events = await fetchFixturesOnDate(cfg.leagueId, date);
  } catch (err) {
    console.error(`Error: ${err.message}`); process.exit(1);
  }

  if (!events.length) {
    console.log(`  No fixtures found for ${cfg.name} on ${date}.`);
    console.log(`  (Check the date, or this competition may have no games that day)`);
    return;
  }

  console.log(`\n  Found ${events.length} fixture(s):\n`);
  events.forEach((ev, i) => {
    const time = ev.strTime ? ev.strTime.slice(0,5) : '??:??';
    console.log(`  [${i + 1}] Event ID ${ev.idEvent}: ${ev.strHomeTeam} vs ${ev.strAwayTeam} (${time} UTC)`);
  });
  console.log(`\n  Run with --match <id> to fetch full data for a fixture.`);
}

async function fetchMatchData(eventId) {
  console.log(`\nFetching match data for event ${eventId}…`);

  const teams   = readJson('teams.json');
  const tables  = readJson('tables.json');
  const h2h     = readJson('h2h.json');
  const form    = readJson('form.json');
  const matches = readJson('matches.json');

  // 1. Event details
  console.log(`  Fetching event details…`);
  const evData = await apiGet(`/lookupevent.php?id=${eventId}`);
  const ev = (evData.events || [])[0];
  if (!ev) { console.error(`  ✗ Event ${eventId} not found.`); process.exit(1); }

  const hId   = String(ev.idHomeTeam);
  const aId   = String(ev.idAwayTeam);
  let comp = null;
  for (const [code, cfg] of Object.entries(COMPS)) {
    if (String(cfg.leagueId) === String(ev.idLeague)) { comp = code; break; }
  }
  comp = comp || 'UNKNOWN';

  const match = eventToMatch(ev, comp);
  matches[eventId] = match;
  console.log(`    ✓ ${ev.strHomeTeam} vs ${ev.strAwayTeam} · ${ev.dateEvent} · ${COMPS[comp]?.name || comp}`);

  // 2. Home team
  await sleep(DELAY_MS);
  if (!teams[hId]) {
    console.log(`  Fetching home team (${ev.strHomeTeam})…`);
    try {
      const [tData, players] = await Promise.all([
        fetchTeamData(hId),
        (await sleep(DELAY_MS), fetchPlayers(hId)),
      ]);
      teams[hId] = buildTeam(tData, players, comp);
      console.log(`    ✓ Squad: ${teams[hId].squad.length} players`);
    } catch (err) { console.warn(`    ✗ Home team: ${err.message}`); }
  } else {
    console.log(`  Home team cached (${ev.strHomeTeam})`);
  }

  // 3. Away team
  await sleep(DELAY_MS);
  if (!teams[aId]) {
    console.log(`  Fetching away team (${ev.strAwayTeam})…`);
    try {
      const [tData, players] = await Promise.all([
        fetchTeamData(aId),
        (await sleep(DELAY_MS), fetchPlayers(aId)),
      ]);
      teams[aId] = buildTeam(tData, players, comp);
      console.log(`    ✓ Squad: ${teams[aId].squad.length} players`);
    } catch (err) { console.warn(`    ✗ Away team: ${err.message}`); }
  } else {
    console.log(`  Away team cached (${ev.strAwayTeam})`);
  }

  // 4. Table
  await sleep(DELAY_MS);
  if (!tables[comp] && comp !== 'UNKNOWN') {
    console.log(`  Fetching standings (${comp})…`);
    try {
      const rows = await fetchTable(COMPS[comp].leagueId);
      tables[comp] = buildTable(rows, comp);
      console.log(`    ✓ ${rows.length} rows`);
    } catch (err) { console.warn(`    ✗ Standings: ${err.message}`); }
  }

  // 5. Home form
  await sleep(DELAY_MS);
  console.log(`  Fetching home form…`);
  try {
    const events = await fetchLastEvents(hId);
    form[hId] = buildForm(events, comp);
    console.log(`    ✓ ${form[hId].matches.length} recent matches`);
  } catch (err) { console.warn(`    ✗ Home form: ${err.message}`); }

  // 6. Away form
  await sleep(DELAY_MS);
  console.log(`  Fetching away form…`);
  try {
    const events = await fetchLastEvents(aId);
    form[aId] = buildForm(events, comp);
    console.log(`    ✓ ${form[aId].matches.length} recent matches`);
  } catch (err) { console.warn(`    ✗ Away form: ${err.message}`); }

  // 7. H2H (best-effort — limited on free tier)
  await sleep(DELAY_MS);
  console.log(`  Fetching H2H (best-effort)…`);
  try {
    const meetings = await fetchEventsByTeamPair(hId, aId);
    h2h[eventId] = buildH2H(meetings, hId, aId);
    console.log(`    ✓ ${h2h[eventId].aggregates.numberOfMatches} recent meetings found`);
    if (!meetings.length) console.log(`    (Free tier H2H is limited — may show 0 even if meetings exist)`);
  } catch (err) { console.warn(`    ✗ H2H: ${err.message}`); }

  // Write files
  console.log('');
  writeJson('teams.json',   teams);
  writeJson('tables.json',  tables);
  writeJson('h2h.json',     h2h);
  writeJson('form.json',    form);
  writeJson('matches.json', matches);

  console.log(`\n✓ Done. Reload the app and select event ${eventId}.`);
  if (teams[hId]?.crest) console.log(`  Home crest: ${teams[hId].crest}`);
  if (teams[aId]?.crest) console.log(`  Away crest: ${teams[aId].crest}`);
}

// ── CLI ───────────────────────────────────────────────────────────────────────
async function main() {
  const args    = process.argv.slice(2);
  const matchId = args.includes('--match') ? args[args.indexOf('--match') + 1] : null;
  const comp    = args.includes('--comp')  ? args[args.indexOf('--comp')  + 1] : null;
  const date    = args.includes('--date')  ? args[args.indexOf('--date')  + 1] : null;

  if (!matchId && !comp) {
    console.log(`
TheSportsDB build-time scraper — free alternative to scraper-sofascore.js

Usage:
  node scraper-sportsdb.js --comp ELC --date 2026-08-10   # list fixtures on a date
  node scraper-sportsdb.js --comp WC  --date 2026-06-15   # World Cup fixtures
  node scraper-sportsdb.js --match 1234567                # fetch full data for a match

Competition codes:  ELC  EL1  EL2  WC

Notes:
  - Uses TheSportsDB free API (key 123) — no account needed
  - League IDs are configured in COMPS at the top of this file
  - Verify league IDs at: https://www.thesportsdb.com/browse_leagues
  - Manager data is not available on the free tier (squad only)
  - H2H is limited to recent events visible via the team schedule endpoint
`);
    process.exit(0);
  }

  if (matchId) {
    await fetchMatchData(matchId);
  } else {
    const d = date || new Date().toISOString().slice(0, 10);
    await listFixtures(comp, d);
  }
}

main().catch(err => { console.error(err.message); process.exit(1); });
