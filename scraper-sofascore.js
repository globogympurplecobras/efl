#!/usr/bin/env node
/**
 * scraper-sofascore.js — Sofascore build-time data scraper
 *
 * Fetches match data from Sofascore's unofficial public API and writes
 * static JSON files to data/. No API key required.
 *
 * Covers all three EFL divisions AND World Cup — replacing the football-data.org
 * scraper (scraper-data.js) which requires a paid tier for L1/L2.
 *
 * Usage:
 *   node scraper-sofascore.js --comp EL1 --date 2026-08-10   # list fixtures
 *   node scraper-sofascore.js --match <sofascore-event-id>   # fetch full data
 *
 * Output files (same format as scraper-data.js — app.js loads these unchanged):
 *   data/teams.json     — squad + manager + colours per Sofascore team id
 *   data/tables.json    — standings per competition code (ELC / EL1 / EL2 / WC)
 *   data/h2h.json       — head-to-head aggregate + recent meetings per match id
 *   data/form.json      — last 10 finished matches per team id
 *   data/matches.json   — fixture index: matchId → basic match object
 *
 * Requires Node 18+. No external dependencies.
 */

const https = require('https');
const fs    = require('fs');
const path  = require('path');

// ── Competition config ────────────────────────────────────────────────────────
// Sofascore unique-tournament IDs and current season IDs.
// Season IDs change each year — the scraper auto-refreshes them at runtime.
const COMPS = {
  ELC: { name: 'Sky Bet Championship',   tournamentId: 18 },
  EL1: { name: 'Sky Bet League One',     tournamentId: 24 },
  EL2: { name: 'Sky Bet League Two',     tournamentId: 25 },
  WC:  { name: 'FIFA World Cup 2026',    tournamentId: 16 },
};

const BASE     = 'https://api.sofascore.com/api/v1';
const IMG_BASE = 'https://img.sofascore.com/api/v1';
const DATA_DIR = path.join(__dirname, 'data');
const DELAY_MS = 800; // polite delay between requests

// ── HTTP helper ───────────────────────────────────────────────────────────────
function apiGet(path) {
  return new Promise((resolve, reject) => {
    const url = BASE + path;
    const req = https.get(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
        'Accept': 'application/json',
        'Accept-Language': 'en-GB,en;q=0.9',
        'Referer': 'https://www.sofascore.com/',
      }
    }, (res) => {
      if (res.statusCode === 429) { reject(new Error('RATE_LIMIT')); return; }
      if (res.statusCode !== 200) {
        reject(new Error(`HTTP ${res.statusCode} for ${path}`)); return;
      }
      let body = '';
      res.on('data', c => body += c);
      res.on('end', () => {
        try { resolve(JSON.parse(body)); }
        catch { reject(new Error(`JSON parse error for ${path}`)); }
      });
    });
    req.on('error', reject);
    req.setTimeout(20000, () => { req.destroy(); reject(new Error(`Timeout: ${path}`)); });
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

// ── Season lookup — find current season ID for a tournament ──────────────────
async function getCurrentSeasonId(tournamentId) {
  const data = await apiGet(`/unique-tournament/${tournamentId}/seasons`);
  const seasons = data.seasons || [];
  // First season in list is always the most recent
  if (!seasons.length) throw new Error(`No seasons found for tournament ${tournamentId}`);
  return seasons[0].id;
}

// ── Shape converters — Sofascore → internal (football-data.org compatible) ───

function tsToIso(ts) {
  return ts ? new Date(ts * 1000).toISOString() : null;
}

function sfStatusToInternal(status) {
  const t = status?.type;
  if (t === 'finished') return 'FINISHED';
  if (t === 'inprogress') return 'IN_PLAY';
  if (t === 'notstarted') return 'SCHEDULED';
  if (t === 'postponed') return 'POSTPONED';
  if (t === 'canceled') return 'CANCELLED';
  return t?.toUpperCase() || 'UNKNOWN';
}

function sfPositionToInternal(pos) {
  const map = { G: 'Goalkeeper', D: 'Defender', M: 'Midfielder', F: 'Attacker' };
  return map[pos] || pos || '';
}

// Convert a Sofascore event object into the internal match shape app.js expects
function sfEventToMatch(ev) {
  const hScore = ev.homeScore?.current ?? null;
  const aScore = ev.awayScore?.current ?? null;
  return {
    id:       ev.id,
    utcDate:  tsToIso(ev.startTimestamp),
    status:   sfStatusToInternal(ev.status),
    venue:    ev.venue?.name ?? ev.homeTeam?.venue?.name ?? null,
    homeTeam: { id: ev.homeTeam.id, name: ev.homeTeam.name, tla: ev.homeTeam.nameCode },
    awayTeam: { id: ev.awayTeam.id, name: ev.awayTeam.name, tla: ev.awayTeam.nameCode },
    score: {
      fullTime: { home: hScore, away: aScore },
    },
    goals:    [], // populated separately via event detail fetch if needed
    // Sofascore extras — used by future rendering enhancements
    teamColors: {
      home: ev.homeTeam.teamColors,
      away: ev.awayTeam.teamColors,
    },
  };
}

// Convert a Sofascore team+squad response into the internal team shape
function sfTeamToInternal(teamData, playersData) {
  const team = teamData.team || teamData;
  const players = playersData?.players || [];

  // Manager may come from a separate /team/{id}/manager call,
  // or be embedded in the event object. We attach it if present.
  const coach = team.manager ? {
    id:          team.manager.id,
    name:        team.manager.name,
    nationality: team.manager.country?.name ?? null,
  } : null;

  return {
    id:     team.id,
    name:   team.name,
    tla:    team.nameCode,
    crest:  `${IMG_BASE}/team/${team.id}/image`,
    venue:  team.venue?.name ?? null,
    colors: team.teamColors ?? null,
    coach,
    squad: players.map(entry => {
      const p = entry.player || entry;
      return {
        id:          p.id,
        name:        p.name,
        position:    sfPositionToInternal(p.position),
        dateOfBirth: p.dateOfBirthTimestamp ? tsToIso(p.dateOfBirthTimestamp).slice(0, 10) : null,
        nationality: p.nationality?.name ?? null,
        shirtNumber: p.shirtNumber ?? entry.shirtNumber ?? null,
      };
    }),
  };
}

// Convert Sofascore standings into the internal shape app.js expects
function sfStandingsToInternal(data, comp) {
  const sfRows = (data.standings || [])[0]?.rows || [];
  const table = sfRows.map(r => ({
    position:    r.position,
    team:        { id: r.team.id, name: r.team.name, tla: r.team.nameCode },
    playedGames: r.matches,
    won:         r.wins,
    draw:        r.draws,
    lost:        r.losses,
    goalsFor:    r.scoresFor,
    goalsAgainst:r.scoresAgainst,
    goalDifference: r.scoresFor - r.scoresAgainst,
    points:      r.points,
  }));

  return {
    competition: { code: comp, name: COMPS[comp]?.name || comp },
    season: {},
    standings: [{ type: 'TOTAL', table }],
  };
}

// Convert Sofascore H2H data into the internal H2H shape
function sfH2HToInternal(aggregate, matchEvents, hId, aId) {
  const duel = aggregate.teamDuel || {};
  // homeWins/awayWins are from the perspective of the current match's home/away
  const hWins = duel.homeWins ?? 0;
  const aWins = duel.awayWins ?? 0;
  const draws = duel.draws ?? 0;
  const total = hWins + aWins + draws;

  const matches = (matchEvents || [])
    .filter(ev => sfStatusToInternal(ev.status) === 'FINISHED')
    .map(sfEventToMatch)
    .sort((a, b) => new Date(b.utcDate) - new Date(a.utcDate));

  return {
    aggregates: {
      numberOfMatches: total,
      homeTeam: { wins: hWins },
      awayTeam: { wins: aWins },
    },
    matches,
  };
}

// Convert Sofascore team events (form) into the internal form shape
function sfFormToInternal(eventsData) {
  const events = eventsData?.events || [];
  const finished = events
    .filter(ev => sfStatusToInternal(ev.status) === 'FINISHED')
    .map(sfEventToMatch)
    .sort((a, b) => new Date(b.utcDate) - new Date(a.utcDate))
    .slice(0, 10);

  return { matches: finished };
}

// ── Fetch routines ────────────────────────────────────────────────────────────

async function fetchStandings(comp, tournamentId, seasonId) {
  console.log(`  Fetching standings (${comp})…`);
  await sleep(DELAY_MS);
  const data = await apiGet(`/unique-tournament/${tournamentId}/season/${seasonId}/standings/total`);
  const result = sfStandingsToInternal(data, comp);
  console.log(`    ✓ ${(result.standings[0]?.table || []).length} teams`);
  return result;
}

async function fetchTeam(teamId) {
  const [teamData, playersData] = await Promise.all([
    apiGet(`/team/${teamId}`).catch(() => null),
    apiGet(`/team/${teamId}/players`).catch(() => null),
  ]);
  return sfTeamToInternal(teamData || { id: teamId }, playersData);
}

async function fetchForm(teamId) {
  // Fetch last 2 pages (10 events each) to get enough finished matches
  const [page0, page1] = await Promise.all([
    apiGet(`/team/${teamId}/events/last/0`).catch(() => ({ events: [] })),
    apiGet(`/team/${teamId}/events/last/1`).catch(() => ({ events: [] })),
  ]);
  const combined = {
    events: [...(page0.events || []), ...(page1.events || [])],
  };
  return sfFormToInternal(combined);
}

async function fetchH2H(eventId, homeTeamId, awayTeamId) {
  const [aggregate, matchEvents] = await Promise.all([
    apiGet(`/event/${eventId}/h2h`).catch(() => ({ teamDuel: {} })),
    apiGet(`/event/${eventId}/h2h/events`).catch(() => null),
  ]);

  // h2h/events may be empty (Sofascore sometimes returns nothing for completed seasons)
  // Fall back to filtering team form events for meetings between the two sides
  let meetings = matchEvents?.events || null;
  if (!meetings || !meetings.length) {
    console.log(`    ℹ H2H match list unavailable from Sofascore — aggregate only`);
  }

  return sfH2HToInternal(aggregate, meetings, homeTeamId, awayTeamId);
}

// ── List fixtures on a date ───────────────────────────────────────────────────
async function listFixtures(comp, date) {
  const cfg = COMPS[comp];
  if (!cfg) { console.error(`Unknown competition: ${comp}`); process.exit(1); }

  console.log(`\nFetching ${cfg.name} fixtures for ${date}…`);
  await sleep(DELAY_MS);

  const seasonId = await getCurrentSeasonId(cfg.tournamentId);
  await sleep(DELAY_MS);

  // Fetch last + next pages and filter by date
  const targetTs = new Date(date).getTime() / 1000;
  const dayStart = targetTs;
  const dayEnd   = targetTs + 86400;

  const [lastPage, nextPage] = await Promise.all([
    apiGet(`/unique-tournament/${cfg.tournamentId}/season/${seasonId}/events/last/0`).catch(() => ({ events: [] })),
    apiGet(`/unique-tournament/${cfg.tournamentId}/season/${seasonId}/events/next/0`).catch(() => ({ events: [] })),
  ]);

  const all = [...(lastPage.events || []), ...(nextPage.events || [])];
  const onDate = all.filter(ev => ev.startTimestamp >= dayStart && ev.startTimestamp < dayEnd);

  if (!onDate.length) {
    console.log(`  No fixtures found on ${date} for ${cfg.name}.`);
    console.log(`  (Check the date, or the season may be between rounds)`);
    return;
  }

  console.log(`\n  Found ${onDate.length} fixture(s):\n`);
  onDate.forEach((ev, i) => {
    const t = new Date(ev.startTimestamp * 1000).toISOString().slice(11, 16);
    console.log(`  [${i + 1}] Event ID ${ev.id}: ${ev.homeTeam.name} vs ${ev.awayTeam.name} (${t} UTC)`);
  });
  console.log(`\nRun with --match <id> to fetch full data for a fixture.`);
}

// ── Fetch full data for one match ─────────────────────────────────────────────
async function fetchForMatch(eventId) {
  console.log(`\nFetching data for event ${eventId}…`);

  // 1. Fetch event detail
  await sleep(DELAY_MS);
  let ev;
  try {
    const data = await apiGet(`/event/${eventId}`);
    ev = data.event;
    console.log(`  Match: ${ev.homeTeam.name} vs ${ev.awayTeam.name}`);
  } catch (err) {
    console.error(`  ✗ Could not fetch event ${eventId}: ${err.message}`);
    return;
  }

  const hId   = ev.homeTeam.id;
  const aId   = ev.awayTeam.id;
  const comp  = ev.uniqueTournament?.id
    ? Object.keys(COMPS).find(k => COMPS[k].tournamentId === ev.uniqueTournament.id) || 'UNKNOWN'
    : 'UNKNOWN';

  // Load existing data files
  const teams   = readJson('teams.json');
  const tables  = readJson('tables.json');
  const h2h     = readJson('h2h.json');
  const form    = readJson('form.json');
  const matches = readJson('matches.json');

  // 2. Store the match itself
  matches[eventId] = sfEventToMatch(ev);
  matches[eventId].compCode = comp;

  // 3. Home team (squad + players)
  if (!teams[hId]) {
    console.log(`  Fetching home team (${ev.homeTeam.name})…`);
    await sleep(DELAY_MS);
    try {
      const team = await fetchTeam(hId);
      // Manager may be in the event object — attach if squad fetch didn't get it
      if (!team.coach && ev.homeTeam.manager) {
        team.coach = {
          id:          ev.homeTeam.manager.id,
          name:        ev.homeTeam.manager.name,
          nationality: ev.homeTeam.manager.country?.name ?? null,
        };
      }
      teams[hId] = team;
      console.log(`    ✓ Squad: ${team.squad.length} players, Manager: ${team.coach?.name || 'unknown'}`);
    } catch (err) { console.warn(`    ✗ ${err.message}`); }
  } else {
    console.log(`  Home team cached (${ev.homeTeam.name})`);
    // Always refresh manager from live event — it changes more often than squad
    if (ev.homeTeam.manager) {
      teams[hId].coach = {
        id:          ev.homeTeam.manager.id,
        name:        ev.homeTeam.manager.name,
        nationality: ev.homeTeam.manager.country?.name ?? null,
      };
    }
  }

  // 4. Away team
  if (!teams[aId]) {
    console.log(`  Fetching away team (${ev.awayTeam.name})…`);
    await sleep(DELAY_MS);
    try {
      const team = await fetchTeam(aId);
      if (!team.coach && ev.awayTeam.manager) {
        team.coach = {
          id:          ev.awayTeam.manager.id,
          name:        ev.awayTeam.manager.name,
          nationality: ev.awayTeam.manager.country?.name ?? null,
        };
      }
      teams[aId] = team;
      console.log(`    ✓ Squad: ${team.squad.length} players, Manager: ${team.coach?.name || 'unknown'}`);
    } catch (err) { console.warn(`    ✗ ${err.message}`); }
  } else {
    console.log(`  Away team cached (${ev.awayTeam.name})`);
    if (ev.awayTeam.manager) {
      teams[aId].coach = {
        id:          ev.awayTeam.manager.id,
        name:        ev.awayTeam.manager.name,
        nationality: ev.awayTeam.manager.country?.name ?? null,
      };
    }
  }

  // 5. Standings
  if (comp !== 'UNKNOWN') {
    console.log(`  Fetching standings (${comp})…`);
    await sleep(DELAY_MS);
    try {
      const cfg = COMPS[comp];
      const seasonId = ev.season?.id || await getCurrentSeasonId(cfg.tournamentId);
      tables[comp] = await fetchStandings(comp, cfg.tournamentId, seasonId);
    } catch (err) { console.warn(`    ✗ Standings: ${err.message}`); }
  }

  // 6. H2H
  console.log(`  Fetching H2H…`);
  await sleep(DELAY_MS);
  try {
    h2h[eventId] = await fetchH2H(eventId, hId, aId);
    const agg = h2h[eventId].aggregates;
    console.log(`    ✓ ${agg.numberOfMatches} meetings (H ${agg.homeTeam.wins} D ${agg.numberOfMatches - agg.homeTeam.wins - agg.awayTeam.wins} A ${agg.awayTeam.wins})`);
  } catch (err) { console.warn(`    ✗ H2H: ${err.message}`); }

  // 7. Home form
  console.log(`  Fetching home form…`);
  await sleep(DELAY_MS);
  try {
    form[hId] = await fetchForm(hId);
    console.log(`    ✓ ${form[hId].matches.length} finished matches`);
  } catch (err) { console.warn(`    ✗ Home form: ${err.message}`); }

  // 8. Away form
  console.log(`  Fetching away form…`);
  await sleep(DELAY_MS);
  try {
    form[aId] = await fetchForm(aId);
    console.log(`    ✓ ${form[aId].matches.length} finished matches`);
  } catch (err) { console.warn(`    ✗ Away form: ${err.message}`); }

  // Write all files
  writeJson('teams.json',   teams);
  writeJson('tables.json',  tables);
  writeJson('h2h.json',     h2h);
  writeJson('form.json',    form);
  writeJson('matches.json', matches);

  console.log(`\n✓ Done. Reload the app and select event ${eventId}.`);
  console.log(`  Team badge URLs: ${IMG_BASE}/team/${hId}/image  /  ${IMG_BASE}/team/${aId}/image`);
}

// ── CLI ───────────────────────────────────────────────────────────────────────
async function main() {
  const args    = process.argv.slice(2);
  const matchId = args.includes('--match') ? args[args.indexOf('--match') + 1] : null;
  const comp    = args.includes('--comp')  ? args[args.indexOf('--comp') + 1]  : null;
  const date    = args.includes('--date')  ? args[args.indexOf('--date') + 1]  : null;

  if (!matchId && !comp) {
    console.log(`
Sofascore build-time scraper — covers Championship, League One, League Two, World Cup

Usage:
  node scraper-sofascore.js --comp EL1 --date 2026-08-10    # list fixtures on a date
  node scraper-sofascore.js --comp WC  --date 2026-06-15    # World Cup fixtures
  node scraper-sofascore.js --match 14060002                # fetch full data for a match

Competition codes:  ELC  EL1  EL2  WC
`);
    process.exit(0);
  }

  if (matchId) {
    await fetchForMatch(parseInt(matchId, 10));
  } else if (comp && date) {
    await listFixtures(comp, date);
  } else {
    console.error('Provide both --comp and --date, or --match <id>');
    process.exit(1);
  }
}

main().catch(err => { console.error(err); process.exit(1); });
