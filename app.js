/* ═══════════════════════════════════════════════════════
   EFL Match Prep 3.0 — App
   Data: SportMonks API via Cloudflare Worker + static JSON fallbacks
   ═══════════════════════════════════════════════════════ */

'use strict';

// ════════════════════════════════════════════════════════
// CONFIG
// ════════════════════════════════════════════════════════

const WORKER = 'https://efl-worker.hollandtideserver.workers.dev';

// 2026/27 season IDs — update each season
const SEASON_IDS = {
  9:  27903,  // Championship
  12: 28349,  // League One
  14: 28309,  // League Two
  27: 27917,  // Carabao Cup
  39: 28046,  // EFL Trophy
};

const SEASON_LABEL = '2026/27'; // update each season

const COMP_NAME  = { 9:'Championship', 12:'League One', 14:'League Two', 27:'Carabao Cup', 39:'EFL Trophy' };
const COMP_SHORT = { 9:'CHAMP', 12:'L1', 14:'L2', 27:'CC', 39:'EFLT' };

// SportMonks event type IDs
const EV = { GOAL:14, OWN_GOAL:15, PENALTY:16, MISSED_PEN:17, SUB:18, YELLOW:19, RED:20, YELLOW_RED:21 };

// SportMonks position IDs → short label
const POS = { 24:'GK', 25:'DEF', 26:'MID', 27:'ATT' };

// ════════════════════════════════════════════════════════
// STATE
// ════════════════════════════════════════════════════════

const APP = {
  view:           'landing',
  activeTab:      'main',
  editMode:       false,
  useStaticData:  false,
  currentFixture: null,
  selectedDate:   new Date().toISOString().slice(0, 10),
  compFilter:     'all',
  xiSwap:         null,
  loading:        false,
  teamsData:      {},   // teams.json, keyed by SportMonks team ID (string)
  fixturesData:   [],   // fixtures.json flat array
  squadStatsCache: {},  // keyed by teamId, stores raw API response to avoid repeat calls
};

// ════════════════════════════════════════════════════════
// HELPERS
// ════════════════════════════════════════════════════════

function todayISO() { return new Date().toISOString().slice(0, 10); }

function daysAgoISO(n, from) {
  const d = new Date((from || todayISO()) + 'T12:00:00');
  d.setDate(d.getDate() - n);
  return d.toISOString().slice(0, 10);
}

function fmtDate(iso) {
  if (!iso) return '';
  const d = new Date(iso + 'T12:00:00');
  return d.toLocaleDateString('en-GB', { weekday:'short', day:'numeric', month:'short', year:'numeric' });
}

function fmtShortDate(iso) {
  if (!iso) return '';
  const d = new Date(iso + 'T12:00:00');
  return d.toLocaleDateString('en-GB', { weekday:'short', day:'numeric', month:'short' });
}

function fmtH2HDate(iso) {
  if (!iso) return '';
  const d = new Date(iso + 'T12:00:00');
  return d.toLocaleDateString('en-GB', { day:'numeric', month:'short', year:'numeric' });
}

function lastName(fullName) {
  if (!fullName) return '';
  return fullName.trim().split(' ').pop();
}

function fmtInjuryReturn(iso) {
  if (!iso) return '';
  const d = new Date(iso + 'T12:00:00');
  const today = new Date();
  today.setHours(12, 0, 0, 0);
  if (d < today) return 'Est. return passed';
  return 'Est. ' + d.toLocaleDateString('en-GB', { day:'numeric', month:'short' });
}

function ordinal(n) {
  if (!n && n !== 0) return '—';
  const s = ['th','st','nd','rd'], v = n % 100;
  return n + (s[(v-20)%10] || s[v] || s[0]);
}

function textForBg(hex) {
  try {
    const r=parseInt(hex.slice(1,3),16)/255, g=parseInt(hex.slice(3,5),16)/255, b=parseInt(hex.slice(5,7),16)/255;
    return (0.2126*r + 0.7152*g + 0.0722*b) > 0.4 ? '#111111' : '#FFFFFF';
  } catch { return '#FFFFFF'; }
}

function visibleOnWhite(hex) {
  try {
    const r=parseInt(hex.slice(1,3),16)/255, g=parseInt(hex.slice(3,5),16)/255, b=parseInt(hex.slice(5,7),16)/255;
    return (0.2126*r + 0.7152*g + 0.0722*b) < 0.6 ? hex : '#444444';
  } catch { return '#444444'; }
}

function badgeSVG(name, color, size=40) {
  const initials = (name||'?').split(' ').map(w=>w[0]).join('').slice(0,2).toUpperCase();
  const fg = textForBg(color), fs = Math.round(size * 0.38);
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size} ${size}">
      <circle cx="${size/2}" cy="${size/2}" r="${size/2}" fill="${color}"/>
      <text x="${size/2}" y="${size/2+fs*0.37}" font-family="Inter,sans-serif" font-weight="800" font-size="${fs}" text-anchor="middle" fill="${fg}">${initials}</text>
    </svg>`)}`;
}

function avatarSVG(name, color, size=60) {
  const initials = (name||'?').split(' ').map(w=>w[0]).join('').slice(0,2).toUpperCase();
  const fg = textForBg(color), fs = Math.round(size * 0.32);
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size} ${size}">
      <circle cx="${size/2}" cy="${size/2}" r="${size/2}" fill="${color}"/>
      <text x="${size/2}" y="${size/2+fs*0.37}" font-family="Inter,sans-serif" font-weight="700" font-size="${fs}" text-anchor="middle" fill="${fg}">${initials}</text>
    </svg>`)}`;
}

function compClass(comp) {
  return { 'Championship':'champ','League One':'l1','League Two':'l2','Carabao Cup':'carabao','EFL Trophy':'trophy' }[comp] || 'champ';
}

function esc(s) {
  return String(s ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

// Pull a value out of SportMonks' details array by type_id
function detailVal(details, typeId) {
  if (!Array.isArray(details)) return null;
  const d = details.find(x => x.type_id === typeId);
  return d?.value ?? d?.data?.value ?? null;
}

// Pull a value out of SportMonks' metadata array by type_id
function metaVal(metadata, typeId) {
  if (!Array.isArray(metadata)) return null;
  const m = metadata.find(x => x.type_id === typeId);
  return m?.values ?? null;
}

// Resolve a player image: local → cdn → SVG fallback
function playerImg(player, teamColor, size=60) {
  if (player?.image?.local) return player.image.local;
  if (player?.image?.cdn)   return player.image.cdn;
  return avatarSVG(player?.name || '?', teamColor, size);
}

// Render a team badge as an <img> tag: always local /data/badges/{id}.png
function teamBadge(team, size=40) {
  return `<img src="./data/badges/${team?.id}.png" width="${size}" height="${size}" alt="${esc(team?.name||'')}">`;
}


// ════════════════════════════════════════════════════════
// DATA LOADING — startup
// ════════════════════════════════════════════════════════

async function loadAppData(noCache = false) {
  const opts = noCache ? { cache: 'no-cache' } : {};
  const [teamsRes, fixturesRes] = await Promise.allSettled([
    fetch('./data/teams.json', opts),
    fetch('./data/fixtures.json', opts),
  ]);

  if (teamsRes.status === 'fulfilled' && teamsRes.value.ok) {
    APP.teamsData = await teamsRes.value.json();
  } else {
    console.warn('teams.json not loaded');
    APP.teamsData = {};
  }

  if (fixturesRes.status === 'fulfilled' && fixturesRes.value.ok) {
    const json = await fixturesRes.value.json();
    APP.fixturesData = json.fixtures || json || [];
    // If today has no fixtures, jump to the nearest future fixture date
    const today = todayISO();
    const hasToday = APP.fixturesData.some(f => f.date === today);
    if (!hasToday && APP.fixturesData.length) {
      const next = APP.fixturesData.find(f => f.date >= today);
      if (next) APP.selectedDate = next.date;
    }
  } else {
    console.info('fixtures.json not loaded — run seed-fixtures.js');
    APP.fixturesData = [];
  }
}


// ════════════════════════════════════════════════════════
// API LAYER
// ════════════════════════════════════════════════════════

// ── Transfer window date gates ───────────────────────────
// Summer: season start → Sep 7 (show pane)
// Winter: Jan 1 → Feb 7 (show pane)
// New signing badge visible until Sep 14 (summer) or Feb 14 (winter)
function isTransferWindow(date = new Date()) {
  const d = new Date(date);
  const m = d.getMonth() + 1; // 1-based
  const day = d.getDate();
  const summer = (m < 9) || (m === 9 && day <= 7);
  const winter = (m === 1) || (m === 2 && day <= 7);
  return summer || winter;
}

function isNewSigningPeriod(date = new Date()) {
  const d = new Date(date);
  const m = d.getMonth() + 1;
  const day = d.getDate();
  const summer = (m < 9) || (m === 9 && day <= 14);
  const winter = (m === 1) || (m === 2 && day <= 14);
  return summer || winter;
}

// Returns true if a player was signed during the current/most-recent transfer window.
// transferDate should be a YYYY-MM-DD string from the API.
function isNewSigning(transferDate) {
  if (!transferDate || !isNewSigningPeriod()) return false;
  const now = new Date();
  const m = now.getMonth() + 1;
  // Determine which window we're in (or just past)
  const windowStart = (m <= 2)
    ? new Date(now.getFullYear(), 0, 1)   // Jan 1 current year
    : new Date(now.getFullYear(), 5, 1);  // Jun 1 current year (summer)
  return new Date(transferDate) >= windowStart;
}

async function apiCall(path, params = {}, bust = false) {
  const url = new URL(`${WORKER}/api/sportmonks/${path}`);
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null) url.searchParams.set(k, v);
  }
  if (bust) url.searchParams.set('bust', 'true');
  const res = await fetch(url.toString());
  if (!res.ok) throw new Error(`API ${res.status}: ${path}`);
  return res.json();
}

// Golden fixture call — everything needed for match prep in one request
async function fetchGolden(fixtureId, bust = false) {
  return apiCall(
    `fixtures/${fixtureId}`,
    { include: 'participants;lineups.player;lineups.type;sidelined.sideline.player;sidelined.sideline.type;statistics;events;scores;metadata.type;coaches;referees;matchFacts' },
    bust
  );
}

async function fetchRefereeStats(refereeId, bust = false) {
  if (!refereeId) return null;
  return apiCall(`referees/${refereeId}`, { include: 'statistics.details.type' }, bust);
}

async function fetchSquadStats(teamId, seasonId) {
  if (!seasonId) return null;
  const key = `${teamId}:${seasonId}`;
  if (APP.squadStatsCache[key]) return APP.squadStatsCache[key];
  const res = await apiCall(
    `squads/teams/${teamId}`,
    { include: 'player.statistics.details.type', filters: `playerstatisticSeasons:${seasonId}` }
  );
  if (res) APP.squadStatsCache[key] = res;
  return res;
}

// Extract top scorer and top creator from squad stats response.
// Only populates if a player has >0 goals/assists.
function parseSquadStats(res) {
  if (!res?.data) return { topScorer: null, topCreator: null };
  const players = Array.isArray(res.data) ? res.data : [res.data];
  let topScorer = null, topCreator = null;

  for (const entry of players) {
    const stats = entry.player?.statistics?.[0]?.details || [];
    const goals   = stats.find(d => d.type_id === 52)?.data?.value ?? 0;
    const assists  = stats.find(d => d.type_id === 79)?.data?.value ?? 0;
    const name = entry.player?.display_name || entry.player?.name;
    if (!name) continue;
    if (goals > 0 && (!topScorer || goals > topScorer.goals))
      topScorer = { name, goals };
    if (assists > 0 && (!topCreator || assists > topCreator.assists))
      topCreator = { name, assists };
  }
  return { topScorer, topCreator };
}

// Parse referee stats from SportMonks /referees/{id}?include=statistics.details.type
// Returns an object with per-game averages for the given season, or career totals as fallback.
function parseRefereeStats(res, seasonId) {
  if (!res?.data) return null;
  const ref = res.data;
  const name  = ref.display_name || ref.name || 'Referee';
  const image = ref.image_path   || null;

  // Find stats for the target season; fall back to most recent if not found
  const stats = ref.statistics || [];
  let seasonStats = stats.find(s => s.season_id === seasonId);
  if (!seasonStats) seasonStats = stats.sort((a, b) => (b.season_id || 0) - (a.season_id || 0))[0];
  if (!seasonStats) return { name, image, yellows: null, reds: null, yellowReds: null, fouls: null, penalties: null, matches: null };

  const details = seasonStats.details || [];
  const refStat = typeId => details.find(d => d.type_id === typeId);

  // type 84=yellows, 83=reds, 85=yellow-reds, 56=fouls, 47=penalties, 188=matches
  const avgFrom = d => d?.data?.value?.all?.average ?? d?.data?.value?.average ?? null;
  const countFrom = d => d?.data?.value?.all?.count ?? d?.data?.value?.count ?? null;

  return {
    name,
    image,
    seasonId:   seasonStats.season_id,
    matches:    countFrom(refStat(188)),
    yellows:    avgFrom(refStat(84)),
    reds:       avgFrom(refStat(83)),
    yellowReds: avgFrom(refStat(85)),
    fouls:      avgFrom(refStat(56)),
    penalties:  avgFrom(refStat(47)),
  };
}

// Build a Map (player_id → rich player object) from the full squad stats API response.
function parseFullSquadStats(res) {
  if (!res?.data) return new Map();
  const entries = Array.isArray(res.data) ? res.data : [res.data];
  const map = new Map();
  for (const entry of entries) {
    const p = entry.player;
    if (!p) continue;
    const details = p.statistics?.[0]?.details || [];
    const stat = id => { const d = details.find(x => x.type_id === id); return d?.data?.value ?? d?.value ?? null; };
    map.set(entry.player_id, {
      id:             entry.player_id,
      name:           p.display_name || p.name || '',
      image:          p.image_path   || null,
      dob:            p.date_of_birth || null,
      number:         entry.jersey_number ?? null,
      position:       POS[p.position_id]  || null,
      apps:           stat(321),
      starts:         stat(322),
      minutes:        stat(119),
      goals:          stat(52),
      assists:        stat(79),
      yellows:        stat(84),
      rating:         stat(118),
      keyPasses:      stat(117),
      bigChances:     stat(580),
      tackles:        stat(78),
      interceptions:  stat(100),
      passAcc:        stat(1584),
    });
  }
  return map;
}

// Cross-reference transfers with squad to flag new signings on player objects
function applyNewSigningFlags(team) {
  if (!isNewSigningPeriod() || !team.transfers?.length) return;
  const incoming = new Set(
    team.transfers.filter(t => t.direction === 'in' && t.isNewSigning).map(t => t.playerName)
  );
  (team.squad || []).forEach(p => {
    p.isNewSigning = incoming.has(p.name);
  });
}

async function fetchStandings(seasonId, bust = false) {
  return apiCall(`standings/seasons/${seasonId}`, { include: 'details' }, bust);
}

async function fetchH2H(homeId, awayId, bust = false) {
  return apiCall(
    `fixtures/head-to-head/${homeId}/${awayId}`,
    { include: 'participants;scores;events', per_page: 10 },
    bust
  );
}

async function fetchForm(teamId, beforeDate, bust = false) {
  const from = daysAgoISO(120, beforeDate);
  return apiCall(
    `fixtures/between/${from}/${beforeDate}/${teamId}`,
    { include: 'participants;scores;events', per_page: 10 },
    bust
  );
}

async function fetchTeamCoach(teamId) {
  return apiCall(`teams/${teamId}`, { include: 'coaches' });
}

async function fetchCoachDetails(coachId) {
  return apiCall(`coaches/${coachId}`);
}

async function fetchTransfers(teamId) {
  // Fetch transfers for a team in the current calendar year, newest first
  const year = new Date().getFullYear();
  return apiCall(
    `transfers/teams/${teamId}`,
    { include: 'player;fromTeam;toTeam', filters: `transferBetween:${year}-01-01,${year}-12-31`, per_page: 20 }
  );
}

// Parse SportMonks transfers response into a simple array sorted newest first.
// Each entry: { playerName, playerImage, fromTeam, toTeam, type, fee, date, direction, isNewSigning }
function parseTransfers(res, teamId) {
  if (!res?.data) return [];
  const entries = Array.isArray(res.data) ? res.data : [res.data];
  return entries
    .map(t => {
      const player    = t.player   || {};
      const fromTeam  = t.fromTeam || {};
      const toTeam    = t.toTeam   || {};
      const date      = t.date || t.transfer_date || null;
      const direction = String(toTeam.id) === String(teamId) ? 'in' : 'out';
      const feeRaw    = t.amount ?? t.transfer_fee ?? null;
      let fee = null;
      if (feeRaw && feeRaw > 0) {
        fee = feeRaw >= 1000000
          ? `£${(feeRaw / 1000000).toFixed(1).replace(/\.0$/, '')}m`
          : `£${Math.round(feeRaw / 1000)}k`;
      }
      const type = t.type_id === 5 ? 'loan' : fee ? 'permanent' : 'free';
      return {
        playerName:   player.display_name || player.name || 'Unknown',
        playerImage:  player.image_path   || null,
        fromTeam:     fromTeam.name || fromTeam.short_name || '?',
        toTeam:       toTeam.name   || toTeam.short_name   || '?',
        direction,
        type,
        fee,
        date,
        isNewSigning: isNewSigning(date),
      };
    })
    .filter(t => t.date && t.date >= '2026-06-01')  // current window only
    .sort((a, b) => (b.date || '').localeCompare(a.date || ''));
}


// ════════════════════════════════════════════════════════
// DATA TRANSFORMATION — SportMonks → internal shape
// ════════════════════════════════════════════════════════

/*
  Internal fixture shape:
  {
    id, date, kickoff, comp, compShort, leagueId, seasonId, stateId,
    venue, venueCity, venueSlug, lineupConfirmed, attendance,
    home: { ...teamShape },
    away: { ...teamShape },
    h2h: [...],
    events: [...],
    scores: { ht, ft, current },
    standings: [...],
  }

  Team shape:
  {
    id, name, shortName, tla,
    colors: { primary, secondary },
    badge: { local, cdn },
    kits: { home, away, third, active },
    venue, location, nickname,
    position,
    manager: { id, name, image, dob },
    formation,
    squad: [{ id, name, position, shirtNumber, captain, image, _edited,
              formationField }]
      formationField: undefined = not in match squad (or unknown)
                      null      = named bench
                      "row:col" = starting XI
    injuries: [...],
    form: [{ result, score, opponentShort, opponent, home, date, scorers, redCards }],
    lastMatch: form[0] or null,
    stats: { [type_id]: value },
    keyPlayers: [{ role, name, stat }],
    notes: '',
  }
*/

// Build a static fixture object from fixtures.json card + teams.json
function buildStaticFixture(card) {
  const homeStatic = APP.teamsData[String(card.home.id)] || {};
  const awayStatic = APP.teamsData[String(card.away.id)] || {};

  function buildTeam(cardTeam, staticTeam) {
    const squad = (staticTeam.squad || []).map(p => ({ ...p, formationField: undefined }));
    return {
      id:              cardTeam.id,
      name:            cardTeam.name,
      shortName:       cardTeam.shortName  || staticTeam.shortName || cardTeam.name.split(' ')[0],
      tla:             cardTeam.tla        || staticTeam.tla || '',
      colors:          cardTeam.colors     || staticTeam.colors || { primary:'#333333', secondary:'#FFFFFF' },
      badge:           staticTeam.badge    || {},
      kits:            staticTeam.kits     || {},
      venue:           staticTeam.venue    || card.venue || '',
      location:        staticTeam.location || card.venueCity || '',
      nickname:        staticTeam.nickname || '',
      position:        cardTeam.position   || 0,
      manager:         staticTeam.manager || { id:null, name:'TBC', image:null, dob:null },
      formation:       '',
      squad,
      injuries:        [],
      form:            [],
      lastMatch:       null,
      stats:           {},
      keyPlayers: [
        { role:'Captain',     name: (staticTeam.squad||[]).find(p => p.captain)?.name || '', stat:null, image: (staticTeam.squad||[]).find(p => p.captain)?.image || null, shirtNumber: (staticTeam.squad||[]).find(p => p.captain)?.shirtNumber || null },
        { role:'Top Scorer',  name:'', stat:null },
        { role:'Top Creator', name:'', stat:null },
        { role:'Key Player',  name:'', stat:null },
      ],
      notes: '',
    };
  }

  return {
    id:              card.id,
    date:            card.date,
    kickoff:         card.kickoff,
    comp:            card.comp,
    compShort:       card.compShort,
    leagueId:        card.leagueId,
    seasonId:        card.seasonId,
    stateId:         card.stateId || 1,
    venue:           card.venue,
    venueCity:       card.venueCity,
    venueSlug:       card.venueSlug,
    lineupConfirmed: false,
    attendance:      null,
    home:            buildTeam(card.home, homeStatic),
    away:            buildTeam(card.away, awayStatic),
    h2h:             [],
    events:          [],
    scores:          { ht:null, ft:null, current:null },
    standings:       [],
    standingsLoaded: false,
  };
}

// Merge golden fixture API response into the fixture object in place
function mergeGolden(fixture, raw) {
  if (!raw) return;
  const data = raw.data;
  if (!data) return;

  const homeId = fixture.home.id;
  const awayId = fixture.away.id;

  // ── Participants (update position) ──
  (data.participants || []).forEach(p => {
    const side = p.meta?.location === 'home' ? 'home' : 'away';
    if (p.meta?.position) fixture[side].position = p.meta.position;
  });

  // ── Metadata ──
  const metadata      = data.metadata || [];
  const lineupMeta    = metaVal(metadata, 572);
  const formationMeta = metaVal(metadata, 159);
  const homeColorMeta = metaVal(metadata, 161);
  const awayColorMeta = metaVal(metadata, 162);
  const attendanceMeta= metaVal(metadata, 578);

  fixture.lineupConfirmed = lineupMeta?.confirmed || false;
  fixture.attendance      = attendanceMeta?.attendance || null;

  if (formationMeta?.home) fixture.home.formation = formationMeta.home;
  if (formationMeta?.away) fixture.away.formation = formationMeta.away;

  // Per-fixture kit colours override static colours
  if (homeColorMeta?.participant) fixture.home.colors = { ...fixture.home.colors, primary: homeColorMeta.participant };
  if (awayColorMeta?.participant) fixture.away.colors = { ...fixture.away.colors, primary: awayColorMeta.participant };

  // ── Coaches ──
  (data.coaches || []).forEach(c => {
    const side = c.meta?.participant_id === homeId ? 'home' : 'away';
    fixture[side].manager = {
      id:    c.id,
      name:  c.display_name || c.name,
      image: c.image_path || null,
      dob:   c.date_of_birth || null,
    };
  });

  // ── Lineups ──
  const lineups = data.lineups || [];
  // Mark all API-known players as pending (will be set below)
  const apiPlayerIds = new Set(lineups.map(l => String(l.player_id)));
  ['home','away'].forEach(side => {
    fixture[side].squad.forEach(p => {
      if (apiPlayerIds.has(String(p.id))) p.formationField = undefined;
    });
  });

  lineups.forEach(entry => {
    const side = entry.team_id === homeId ? 'home' : 'away';
    const team = fixture[side];
    let player = team.squad.find(p => String(p.id) === String(entry.player_id));

    if (!player) {
      // Not in teams.json — add from API data
      const ap = entry.player || {};
      player = {
        id:             entry.player_id,
        name:           ap.name || ap.display_name || `#${entry.jersey_number}`,
        position:       POS[ap.position_id] || '',
        shirtNumber:    entry.jersey_number,
        captain:        false,
        image:          { local:null, cdn: ap.image_path || null },
        _edited:        false,
        formationField: undefined,
      };
      team.squad.push(player);
    }

    // Update shirt number and image from live API data
    if (!player._edited) player.shirtNumber = entry.jersey_number;
    if (entry.player?.image_path) player.image = { ...player.image, cdn: entry.player.image_path };

    if (entry.type_id === 11) {
      player.formationField = entry.formation_field || '1:1'; // Starting XI
    } else if (entry.type_id === 12) {
      player.formationField = null; // Bench
    }
    // type_id 13 = sidelined in lineup — leave formationField undefined

    // Extract match rating from lineup details (type_id 118)
    const ratingDetail = (entry.details || []).find(d => d.type_id === 118);
    if (ratingDetail) {
      const rv = ratingDetail.data?.value ?? ratingDetail.value;
      player.matchRating = rv != null ? parseFloat(rv) : null;
    } else {
      player.matchRating = null;
    }
  });

  // ── Injuries / sidelined ──
  fixture.home.injuries = [];
  fixture.away.injuries = [];
  (data.sidelined || []).forEach(entry => {
    const sl = entry.sideline;
    if (!sl) return;
    const side = entry.participant_id === homeId ? 'home' : 'away';
    fixture[side].injuries.push({
      playerId:       entry.player_id,
      playerName:     sl.player?.name || sl.player?.display_name || `Player ${entry.player_id}`,
      category:       sl.category || 'injury',
      type:           sl.type?.name || 'Unknown',
      startDate:      sl.start_date || null,
      endDate:        sl.end_date   || null,
      gamesMissed:    sl.games_missed || 0,
      completed:      sl.completed || false,
      status:         sl.completed ? 'Recovered' : sl.end_date ? 'Doubt' : 'Out',
      expectedReturn: sl.end_date || null,
    });
  });

  // ── Statistics ──
  fixture.home.stats = {};
  fixture.away.stats = {};
  (data.statistics || []).forEach(stat => {
    const side = stat.participant_id === homeId ? 'home' : 'away';
    fixture[side].stats[stat.type_id] = stat.data?.value ?? stat.value ?? null;
  });

  // ── Events ──
  fixture.events = (data.events || []).map(ev => ({
    typeId:          ev.type_id,
    minute:          ev.minute,
    extraMinute:     ev.extra_minute || null,
    playerId:        ev.player_id,
    relatedPlayerId: ev.related_player_id || null,
    participantId:   ev.participant_id,
    info:            ev.info || null,
  }));

  // ── Scores ──
  const scores = data.scores || [];
  function getGoals(pId, desc) {
    return scores.find(s => s.participant_id === pId && s.description === desc)?.score?.goals ?? null;
  }
  fixture.scores = {
    ht:      { home: getGoals(homeId,'1ST_HALF'),  away: getGoals(awayId,'1ST_HALF') },
    ft:      { home: getGoals(homeId,'2ND_HALF'),  away: getGoals(awayId,'2ND_HALF') },
    current: { home: getGoals(homeId,'CURRENT'),   away: getGoals(awayId,'CURRENT') },
  };

  // ── Referees ──
  // type_id 6 = main referee
  const mainRef = (data.referees || []).find(r => r.type_id === 6);
  if (mainRef) fixture.refereeId = mainRef.referee_id;

  // ── Match Facts ──
  // Filter to entries with natural_language text only — these are the ready-to-use insights
  fixture.matchFacts = (data.matchfacts || [])
    .filter(mf => mf.natural_language && mf.natural_language.trim())
    .map(mf => ({
      text:        mf.natural_language,
      participant: mf.participant, // 'home' | 'away' | 'both'
      basis:       mf.basis,       // 'h2h' | 'overall' | 'form'
      category:    mf.category,
    }));
}

// Parse form fixtures for a team into internal form array
function resolvePlayerName(playerId, teamId, teamsData) {
  // Try specified team first
  const squad = teamsData[String(teamId)]?.squad || [];
  const p = squad.find(p => String(p.id) === String(playerId));
  if (p) return p.name;
  // Fall back to searching all teams (catches opposition scorers, loanees etc.)
  for (const team of Object.values(teamsData)) {
    const fp = (team.squad || []).find(p => String(p.id) === String(playerId));
    if (fp) return fp.name;
  }
  return null;
}

function parseFormFixtures(fixtures, forTeamId, teamsData) {
  const completed = (fixtures || [])
    .filter(f => f.state_id === 5 || f.state_id === 3)
    .sort((a, b) => (b.starting_at > a.starting_at ? 1 : -1))
    .slice(0, 5);

  return completed.map(f => {
    const parts   = f.participants || [];
    const homePart = parts.find(p => p.meta?.location === 'home');
    const awayPart = parts.find(p => p.meta?.location === 'away');
    if (!homePart || !awayPart) return null;

    const isHome  = homePart.id === forTeamId;
    const oppPart = isHome ? awayPart : homePart;
    const oppStatic = teamsData[String(oppPart.id)] || {};

    const sc = f.scores || [];
    const hg = sc.find(s => s.participant_id === homePart.id && s.description === 'CURRENT')?.score?.goals ?? null;
    const ag = sc.find(s => s.participant_id === awayPart.id && s.description === 'CURRENT')?.score?.goals ?? null;

    let result = 'D';
    if (hg !== null && ag !== null) {
      const myG  = isHome ? hg : ag;
      const oppG = isHome ? ag : hg;
      result = myG > oppG ? 'W' : myG < oppG ? 'L' : 'D';
    }

    const events    = f.events || [];
    const goalEvents = events.filter(e => [EV.GOAL, EV.OWN_GOAL, EV.PENALTY].includes(e.type_id));
    const redEvents  = events.filter(e => [EV.RED, EV.YELLOW_RED].includes(e.type_id));

    return {
      result,
      score:         isHome ? `${hg??'?'}–${ag??'?'}` : `${ag??'?'}–${hg??'?'}`,
      opponentShort: oppStatic.tla || oppPart.short_code || (oppPart.name||'???').slice(0,3).toUpperCase(),
      opponent:      oppPart.name || '?',
      home:          isHome,
      date:          (f.starting_at || '').slice(0, 10),
      homeTeamName:  homePart.name,
      awayTeamName:  awayPart.name,
      homeId:        homePart.id,
      awayId:        awayPart.id,
      scorers:  goalEvents.map(e => ({ playerId:e.player_id, playerName:resolvePlayerName(e.player_id, e.participant_id, teamsData), minute:e.minute, teamId:e.participant_id, typeId:e.type_id })),
      redCards: redEvents.map(e => ({ playerId:e.player_id, playerName:resolvePlayerName(e.player_id, e.participant_id, teamsData), minute:e.minute, teamId:e.participant_id })),
    };
  }).filter(Boolean);
}

// Parse H2H fixtures
function parseH2H(fixtures, homeId, awayId, teamsData) {
  const completed = (fixtures || [])
    .filter(f => f.state_id === 5 || f.state_id === 3)
    .sort((a, b) => (b.starting_at > a.starting_at ? 1 : -1));

  return completed.map(f => {
    const parts    = f.participants || [];
    const homePart = parts.find(p => p.meta?.location === 'home');
    const awayPart = parts.find(p => p.meta?.location === 'away');
    if (!homePart || !awayPart) return null;

    const sc = f.scores || [];
    const hg = sc.find(s => s.participant_id === homePart.id && s.description === 'CURRENT')?.score?.goals ?? null;
    const ag = sc.find(s => s.participant_id === awayPart.id && s.description === 'CURRENT')?.score?.goals ?? null;

    const events     = f.events || [];
    const goalEvents = events.filter(e => [EV.GOAL, EV.OWN_GOAL, EV.PENALTY].includes(e.type_id));
    const redEvents  = events.filter(e => [EV.RED, EV.YELLOW_RED].includes(e.type_id));

    return {
      date:      (f.starting_at || '').slice(0, 10),
      home:      homePart.name,
      away:      awayPart.name,
      homeId:    homePart.id,
      awayId:    awayPart.id,
      homeGoals: hg,
      awayGoals: ag,
      score:     hg !== null ? `${hg}–${ag}` : '?–?',
      scorers:   goalEvents.map(e => ({ playerId:e.player_id, playerName:resolvePlayerName(e.player_id, e.participant_id, teamsData), minute:e.minute, teamId:e.participant_id, typeId:e.type_id })),
      redCards:  redEvents.map(e => ({ playerId:e.player_id, playerName:resolvePlayerName(e.player_id, e.participant_id, teamsData), minute:e.minute, teamId:e.participant_id })),
    };
  }).filter(Boolean);
}

// Parse standings response
function parseStandings(raw, teamsData) {
  return (raw.data || []).map(row => {
    const t       = teamsData[String(row.participant_id)] || {};
    const details = row.details || [];
    const gf = detailVal(details, 133) ?? 0;
    const ga = detailVal(details, 134) ?? 0;
    return {
      position:  row.position,
      teamId:    row.participant_id,
      teamName:  t.name || row.participant?.name || `Team ${row.participant_id}`,
      shortName: t.shortName || '',
      tla:       t.tla || '',
      colors:    t.colors || { primary:'#333' },
      badge:     t.badge  || {},
      points:    row.points || 0,
      played:    detailVal(details, 129) ?? 0,
      won:       detailVal(details, 130) ?? 0,
      drawn:     detailVal(details, 131) ?? 0,
      lost:      detailVal(details, 132) ?? 0,
      gf, ga, gd: gf - ga,
    };
  }).sort((a, b) => a.position - b.position);
}


// ════════════════════════════════════════════════════════
// LOADING STATE
// ════════════════════════════════════════════════════════

function showLoading() {
  APP.loading = true;
  let el = document.getElementById('loading-overlay');
  if (!el) {
    el = document.createElement('div');
    el.id = 'loading-overlay';
    el.innerHTML = `<div class="loading-inner"><div class="loading-spinner"></div><span>Loading latest data…</span></div>`;
    document.getElementById('view-match')?.appendChild(el);
  }
  el.classList.add('visible');
}

function hideLoading() {
  APP.loading = false;
  document.getElementById('loading-overlay')?.classList.remove('visible');
}


// ════════════════════════════════════════════════════════
// LANDING
// ════════════════════════════════════════════════════════

function renderLanding() {
  document.getElementById('fixture-date').value = APP.selectedDate;
  renderFixtureList();
}

function renderFixtureList() {
  const container = document.getElementById('fixture-list');

  let fixtures = APP.fixturesData.filter(f => f.date === APP.selectedDate);
  if (APP.compFilter !== 'all') fixtures = fixtures.filter(f => f.comp === APP.compFilter);

  if (!fixtures.length) {
    container.innerHTML = `<div class="no-fixtures"><div class="no-fixtures-icon">📅</div>
      <h3>No fixtures</h3><p>No matches on ${fmtDate(APP.selectedDate)}</p></div>`;
    return;
  }

  const groups = {};
  fixtures.forEach(f => { if (!groups[f.comp]) groups[f.comp] = []; groups[f.comp].push(f); });

  let html = '';
  Object.entries(groups).forEach(([comp, list]) => {
    if (APP.compFilter === 'all') html += `<div class="fixture-group-label">${comp}</div>`;
    list.forEach(f => { html += renderFixtureCard(f); });
  });
  container.innerHTML = html;

  container.querySelectorAll('.fixture-card').forEach(card => {
    card.addEventListener('click', () => {
      const fix = APP.fixturesData.find(f => String(f.id) === String(card.dataset.id));
      if (fix) loadFixture(fix);
    });
  });
}

function renderFixtureCard(f) {
  const hc = f.home.colors?.primary || '#333';
  const ac = f.away.colors?.primary || '#555';
  return `<div class="fixture-card" data-id="${f.id}" role="button" tabindex="0">
    <span class="fixture-card-comp ${compClass(f.comp)}">${f.compShort}</span>
    <div class="fixture-card-teams">
      <div class="fixture-team home">
        <div class="fixture-badge">${teamBadge(f.home, 40)}</div>
        <div>
          <div class="fixture-team-name">${esc(f.home.name)}</div>
          <div class="fixture-team-pos">${f.home.position ? ordinal(f.home.position) : ''}</div>
        </div>
      </div>
      <div class="fixture-vs">
        <div class="fixture-kickoff">${f.kickoff}</div>
        <div class="fixture-vs-label">KO</div>
      </div>
      <div class="fixture-team away">
        <div class="fixture-badge">${teamBadge(f.away, 40)}</div>
        <div style="text-align:right">
          <div class="fixture-team-name">${esc(f.away.name)}</div>
          <div class="fixture-team-pos">${f.away.position ? ordinal(f.away.position) : ''}</div>
        </div>
      </div>
    </div>
    <div class="fixture-card-venue">${esc(f.venueCity)}<br>${esc(f.venue)}</div>
    <span class="fixture-card-arrow">›</span>
  </div>`;
}


// ════════════════════════════════════════════════════════
// VIEW / ROUTING
// ════════════════════════════════════════════════════════

function showView(name) {
  document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
  document.getElementById(`view-${name}`).classList.add('active');
  APP.view = name;
}

async function loadFixture(card) {
  APP.xiSwap   = null;
  APP.editMode = false;
  document.body.classList.remove('edit-mode');

  // 1. Build fixture from static data immediately
  const fixture = buildStaticFixture(card);
  APP.currentFixture = fixture;

  showView('match');
  setTeamCSSVars(fixture);
  renderMatchHeader(fixture);
  switchTab('main');

  if (APP.useStaticData) return;

  // 2. Show loading overlay and fire all API calls in parallel
  showLoading();
  try {
    const seasonId = fixture.seasonId || SEASON_IDS[fixture.leagueId];
    const isCustom = String(fixture.id).startsWith('custom_');
    const [goldenRes, standingsRes, h2hRes, homeFormRes, awayFormRes, homeSquadRes, awaySquadRes, homeTransfersRes, awayTransfersRes] = await Promise.allSettled([
      isCustom ? Promise.resolve(null) : fetchGolden(fixture.id),
      seasonId ? fetchStandings(seasonId) : Promise.resolve(null),
      fetchH2H(fixture.home.id, fixture.away.id),
      fetchForm(fixture.home.id, fixture.date),
      fetchForm(fixture.away.id, fixture.date),
      fetchSquadStats(fixture.home.id, seasonId),
      fetchSquadStats(fixture.away.id, seasonId),
      isTransferWindow() ? fetchTransfers(fixture.home.id) : Promise.resolve(null),
      isTransferWindow() ? fetchTransfers(fixture.away.id) : Promise.resolve(null),
    ]);

    if (goldenRes.status === 'fulfilled') {
      mergeGolden(fixture, goldenRes.value);
    } else {
      console.warn('Golden call failed:', goldenRes.reason);
    }

    // Fetch referee stats after golden (referee ID comes from golden)
    if (fixture.refereeId) {
      const refRes = await fetchRefereeStats(fixture.refereeId).catch(() => null);
      if (refRes) fixture.referee = parseRefereeStats(refRes, fixture.seasonId || SEASON_IDS[fixture.leagueId]);
    }

    if (standingsRes.status === 'fulfilled' && standingsRes.value) {
      fixture.standings = parseStandings(standingsRes.value, APP.teamsData);
    }
    fixture.standingsLoaded = true;

    if (h2hRes.status === 'fulfilled') {
      fixture.h2h = parseH2H(h2hRes.value.data || [], fixture.home.id, fixture.away.id, APP.teamsData);
    }

    if (homeFormRes.status === 'fulfilled') {
      fixture.home.form      = parseFormFixtures(homeFormRes.value.data || [], fixture.home.id, APP.teamsData);
      fixture.home.lastMatch = fixture.home.form[0] || null;
    }

    if (awayFormRes.status === 'fulfilled') {
      fixture.away.form      = parseFormFixtures(awayFormRes.value.data || [], fixture.away.id, APP.teamsData);
      fixture.away.lastMatch = fixture.away.form[0] || null;
    }

    // Squad stats — full map for player modal + top scorer/creator for key players
    for (const [res, side] of [[homeSquadRes, 'home'], [awaySquadRes, 'away']]) {
      if (res.status !== 'fulfilled') continue;
      fixture[side].squadStats = parseFullSquadStats(res.value);
      const { topScorer, topCreator } = parseSquadStats(res.value);
      const kp = fixture[side].keyPlayers;
      const squad = fixture[side].squad || [];
      if (topScorer) {
        const sp = squad.find(p => p.name === topScorer.name);
        kp[1].name = topScorer.name; kp[1].stat = `${topScorer.goals} goal${topScorer.goals !== 1 ? 's' : ''}`;
        kp[1].image = sp?.image || null; kp[1].shirtNumber = sp?.shirtNumber || null;
      }
      if (topCreator) {
        const cp = squad.find(p => p.name === topCreator.name);
        kp[2].name = topCreator.name; kp[2].stat = `${topCreator.assists} assist${topCreator.assists !== 1 ? 's' : ''}`;
        kp[2].image = cp?.image || null; kp[2].shirtNumber = cp?.shirtNumber || null;
      }
    }

    // Transfers — parse and flag new signings on squad players
    if (homeTransfersRes.status === 'fulfilled' && homeTransfersRes.value) {
      fixture.home.transfers = parseTransfers(homeTransfersRes.value, fixture.home.id);
      applyNewSigningFlags(fixture.home);
    }
    if (awayTransfersRes.status === 'fulfilled' && awayTransfersRes.value) {
      fixture.away.transfers = parseTransfers(awayTransfersRes.value, fixture.away.id);
      applyNewSigningFlags(fixture.away);
    }

    // For custom fixtures, fetch coaches separately from the team endpoint
    if (isCustom) {
      const [homeCoachRes, awayCoachRes] = await Promise.allSettled([
        fetchTeamCoach(fixture.home.id),
        fetchTeamCoach(fixture.away.id),
      ]);
      const extractActiveCoachId = res => {
        if (res.status !== 'fulfilled' || !res.value?.data) return null;
        const coaches = res.value.data.coaches || [];
        const active = coaches.find(c => c.active);
        return active ? active.coach_id : null;
      };
      const homeCoachId = extractActiveCoachId(homeCoachRes);
      const awayCoachId = extractActiveCoachId(awayCoachRes);
      const [homeCoachDetailRes, awayCoachDetailRes] = await Promise.allSettled([
        homeCoachId ? fetchCoachDetails(homeCoachId) : Promise.resolve(null),
        awayCoachId ? fetchCoachDetails(awayCoachId) : Promise.resolve(null),
      ]);
      const extractCoach = res => {
        if (!res || res.status !== 'fulfilled' || !res.value?.data) return null;
        const c = res.value.data;
        return { id: c.id, name: c.display_name || c.name, image: c.image_path || null, dob: c.date_of_birth || null };
      };
      const hc = extractCoach(homeCoachDetailRes), ac = extractCoach(awayCoachDetailRes);
      if (hc) fixture.home.manager = hc;
      if (ac) fixture.away.manager = ac;
    }

  } catch(e) {
    console.error('loadFixture error:', e);
  } finally {
    hideLoading();
  }

  // 3. Apply any KV overrides (manager images, kit colours, captains) — silently, don't block render
  await Promise.allSettled([
    applyManagerImageOverride(fixture.home.id).then(url => { if (url && fixture.home.manager) fixture.home.manager.image = url; }),
    applyManagerImageOverride(fixture.away.id).then(url => { if (url && fixture.away.manager) fixture.away.manager.image = url; }),
    applyManagerNameOverride(fixture.home.id).then(name => { if (name && fixture.home.manager) fixture.home.manager.name = name; }),
    applyManagerNameOverride(fixture.away.id).then(name => { if (name && fixture.away.manager) fixture.away.manager.name = name; }),
    applyKitColorOverrides(fixture.home),
    applyKitColorOverrides(fixture.away),
    applyKitImageOverrides(fixture.home),
    applyKitImageOverrides(fixture.away),
    applyCaptainOverride(fixture.home.id).then(name => { if (name) { const cp=(fixture.home.squad||[]).find(p=>p.name===name); fixture.home.keyPlayers[0].name=name; fixture.home.keyPlayers[0].image=cp?.image||null; fixture.home.keyPlayers[0].shirtNumber=cp?.shirtNumber||null; } }),
    applyCaptainOverride(fixture.away.id).then(name => { if (name) { const cp=(fixture.away.squad||[]).find(p=>p.name===name); fixture.away.keyPlayers[0].name=name; fixture.away.keyPlayers[0].image=cp?.image||null; fixture.away.keyPlayers[0].shirtNumber=cp?.shirtNumber||null; } }),
  ]);

  // 4. Re-render with fresh data
  setTeamCSSVars(fixture);
  renderMatchHeader(fixture);
  switchTab(APP.activeTab);
}

async function refreshFixture(bust = true) {
  const f = APP.currentFixture;
  if (!f) return;
  showLoading();
  try {
    const seasonId = f.seasonId || SEASON_IDS[f.leagueId];
    const [goldenRes, standingsRes, h2hRes, homeFormRes, awayFormRes] = await Promise.allSettled([
      fetchGolden(f.id, bust),
      seasonId ? fetchStandings(seasonId, bust) : Promise.resolve(null),
      fetchH2H(f.home.id, f.away.id, bust),
      fetchForm(f.home.id, f.date, bust),
      fetchForm(f.away.id, f.date, bust),
    ]);

    if (goldenRes.status === 'fulfilled') {
      mergeGolden(f, goldenRes.value);
      if (f.refereeId) {
        const refRes = await fetchRefereeStats(f.refereeId, bust).catch(() => null);
        if (refRes) f.referee = parseRefereeStats(refRes, f.seasonId || SEASON_IDS[f.leagueId]);
      }
    }
    if (standingsRes.status === 'fulfilled' && standingsRes.value)
      f.standings = parseStandings(standingsRes.value, APP.teamsData);
    f.standingsLoaded = true;
    if (h2hRes.status === 'fulfilled')
      f.h2h = parseH2H(h2hRes.value.data || [], f.home.id, f.away.id, APP.teamsData);
    if (homeFormRes.status === 'fulfilled') {
      f.home.form      = parseFormFixtures(homeFormRes.value.data || [], f.home.id, APP.teamsData);
      f.home.lastMatch = f.home.form[0] || null;
    }
    if (awayFormRes.status === 'fulfilled') {
      f.away.form      = parseFormFixtures(awayFormRes.value.data || [], f.away.id, APP.teamsData);
      f.away.lastMatch = f.away.form[0] || null;
    }
  } catch(e) {
    console.error('refreshFixture error:', e);
  } finally {
    hideLoading();
  }
  setTeamCSSVars(f);
  renderMatchHeader(f);
  switchTab(APP.activeTab);
}

// Returns the active kit's primary/secondary colours for a team.
// Falls back to team.colors (home kit baseline) if no kit data.
function activeKitColors(team) {
  const activeKit = team.kits?.active;
  const kitData   = activeKit ? (team.kits?.[activeKit] || null) : null;
  const fallbackPc = team.colors?.primary   || '#333333';
  const fallbackSc = team.colors?.secondary || '#FFFFFF';
  if (kitData) {
    // Mirror the same priority as swatch dot rendering
    const primary   = kitData.colors?.primary   || kitData.primary   || fallbackPc;
    const secondary = kitData.colors?.secondary || kitData.secondary || fallbackSc;
    // Only use kit colour if it's a non-trivial value (not empty string)
    if (primary && primary !== '#') return { primary, secondary };
  }
  return { primary: fallbackPc, secondary: fallbackSc };
}

function setTeamCSSVars(f) {
  const r    = document.documentElement;
  const home = activeKitColors(f.home);
  const away = activeKitColors(f.away);
  r.style.setProperty('--home-primary',   home.primary);
  r.style.setProperty('--home-secondary', home.secondary);
  r.style.setProperty('--away-primary',   away.primary);
  r.style.setProperty('--away-secondary', away.secondary);
  r.style.setProperty('--home-text',    visibleOnWhite(home.primary));  // team colour on white bg
  r.style.setProperty('--away-text',    visibleOnWhite(away.primary));
  r.style.setProperty('--home-text-on', textForBg(home.primary));       // white or black ON the primary bg
  r.style.setProperty('--away-text-on', textForBg(away.primary));
}


// ════════════════════════════════════════════════════════
// MATCH HEADER
// ════════════════════════════════════════════════════════

function renderMatchHeader(f) {
  document.getElementById('hdr-comp').textContent      = f.comp;
  document.getElementById('hdr-datetime').textContent  = `${fmtShortDate(f.date)} · ${f.kickoff}`;
  document.getElementById('hdr-venue').textContent     = f.venue;
  document.getElementById('hdr-home-name').textContent = f.home.name;
  document.getElementById('hdr-away-name').textContent = f.away.name;
  document.getElementById('hdr-home-pos').textContent  = f.home.position ? ordinal(f.home.position) : '';
  document.getElementById('hdr-away-pos').textContent  = f.away.position ? ordinal(f.away.position) : '';
  document.getElementById('hdr-home-badge').innerHTML  = teamBadge(f.home, 50);
  document.getElementById('hdr-away-badge').innerHTML  = teamBadge(f.away, 50);
}


// ════════════════════════════════════════════════════════
// TAB SWITCHING
// ════════════════════════════════════════════════════════

function switchTab(name) {
  APP.activeTab = name;
  APP.xiSwap    = null;
  document.querySelectorAll('.tab-btn').forEach(b => b.classList.toggle('active', b.dataset.tab === name));
  document.querySelectorAll('.tab-panel').forEach(p => p.classList.remove('active'));
  document.getElementById(`tab-${name}`).classList.add('active');
  const f = APP.currentFixture;
  if (name === 'main')       renderMainTab(f);
  if (name === 'stats')      renderStatsTab(f);
  if (name === 'table')      renderTableTab(f);
  if (name === 'squads')     renderSquadsTab(f);
  if (name === 'production') renderProductionTab(f);
  if (name === 'xi')         renderXITab(f);
  if (name === 'warmups')    renderWarmupsTab(f);
  if (name === 'ingame')     renderInGameTab(f);

  // Start/stop live polling
  if (name === 'ingame') startInGamePolling();
  else stopInGamePolling();
}


// ════════════════════════════════════════════════════════
// MAIN TAB
// ════════════════════════════════════════════════════════

function renderMainTab(f) {
  const el = document.getElementById('tab-main');
  const transfersHtml = isTransferWindow()
    ? `${renderTransfersSection(f.home)}${renderTransfersSection(f.away)}`
    : '';
  el.innerHTML = `
    <div class="main-grid">
      ${renderManagerCard(f.home, 'home')}
      ${renderManagerCard(f.away, 'away')}
      ${transfersHtml}
      ${renderFormSection(f.home)}
      ${renderFormSection(f.away)}
      ${renderLastMatchSection(f.home)}
      ${renderLastMatchSection(f.away)}
      ${renderKeyPlayersSection(f.home, 'home')}
      ${renderKeyPlayersSection(f.away, 'away')}
      ${renderNotesSection(f.home, 'home')}
      ${renderNotesSection(f.away, 'away')}
      ${renderInjuriesSection(f.home)}
      ${renderInjuriesSection(f.away)}
    </div>
    <div id="section-formation"></div>
    <div id="section-h2h"></div>
  `;
  renderFormation(f);
  renderH2H(f);
  initMainTabEvents(f);
}

function renderTransferRow(t, teamColor) {
  const initials = t.playerName.split(' ').map(w=>w[0]||'').join('').slice(0,2).toUpperCase();
  const avatarColor = t.direction === 'in' ? (teamColor || '#333') : '#9B9794';
  const avatarInner = t.playerImage
    ? `<img src="${esc(t.playerImage)}" alt="" onerror="this.style.display='none'">`
    : `<div class="transfer-avatar-fallback" style="background:${avatarColor}">${esc(initials)}</div>`;
  const pill = t.direction === 'in'
    ? `<span class="transfer-pill transfer-pill-in">In</span>`
    : `<span class="transfer-pill transfer-pill-out">Out</span>`;
  const otherTeam = t.direction === 'in' ? t.fromTeam : t.toTeam;
  const feeLabel = t.type === 'loan'
    ? `<span class="transfer-pill transfer-pill-loan">Loan</span>`
    : t.fee || `<span class="transfer-pill transfer-pill-free">Free</span>`;
  const dateShort = t.date ? t.date.slice(5).replace('-', ' ').replace(/^0/, '') : '';
  return `<div class="transfer-row">
    <div class="transfer-avatar">${avatarInner}</div>
    <div class="transfer-info">
      <div class="transfer-name">${esc(t.playerName)}</div>
      <div class="transfer-meta">${pill} ${esc(otherTeam)} · ${esc(dateShort)}</div>
    </div>
    <div class="transfer-fee">${feeLabel}</div>
  </div>`;
}

function renderTransfersSection(team) {
  const transfers = team.transfers || [];
  const preview   = transfers.slice(0, 5);
  const hasMore   = transfers.length > 5;
  const body = preview.length
    ? preview.map(t => renderTransferRow(t, team.colors?.primary)).join('')
    : `<div class="transfers-empty">No transfers recorded this window.</div>`;
  return `<div class="section-card">
    <div class="section-card-header">
      <span class="section-title">Transfers</span>
      <span class="transfer-window-pill">● Window open</span>
    </div>
    <div class="transfer-list">${body}</div>
    ${hasMore ? `<button class="transfers-view-all-btn" data-team-id="${team.id}">View all ${transfers.length} transfers ›</button>` : ''}
  </div>`;
}

function openTransfersModal(teamId) {
  const f = APP.currentFixture;
  if (!f) return;
  const side = String(f.home.id) === String(teamId) ? 'home' : 'away';
  const team = f[side];
  const transfers = team.transfers || [];

  const ins  = transfers.filter(t => t.direction === 'in');
  const outs = transfers.filter(t => t.direction === 'out');

  const col = (label, list) => `
    <div class="transfers-modal-col">
      <div class="transfers-modal-col-header">${label} <span class="transfers-modal-count">${list.length}</span></div>
      ${list.length
        ? list.map(t => renderTransferRow(t, team.colors?.primary)).join('')
        : `<div class="transfers-empty">None.</div>`}
    </div>`;

  const overlay = document.getElementById('transfers-modal');
  document.getElementById('transfers-modal-title').textContent = `${team.name} — Transfers (Summer 2026)`;
  document.getElementById('transfers-modal-body').innerHTML = `
    <div class="transfers-modal-grid">
      ${col('In', ins)}
      ${col('Out', outs)}
    </div>`;
  overlay.hidden = false;
}

function closeTransfersModal() {
  document.getElementById('transfers-modal').hidden = true;
}

// Returns perceived brightness 0–255 for a hex colour
function hexBrightness(hex) {
  const c = hex.replace('#', '');
  const r = parseInt(c.slice(0,2),16), g = parseInt(c.slice(2,4),16), b = parseInt(c.slice(4,6),16);
  return 0.299*r + 0.587*g + 0.114*b;
}

// ── Manager card ──────────────────────────────────────────
function renderManagerCard(team, side) {
  const mgr        = team.manager || {};
  const primary    = team.colors?.primary   || '#333333';
  const secondary  = team.colors?.secondary || '#FFFFFF';
  const color      = hexBrightness(primary) > 200 ? secondary : primary;
  const mgrImg     = mgr.image
    ? `<img src="${esc(mgr.image)}" alt="${esc(mgr.name)}" onerror="this.src='${avatarSVG(mgr.name||'?', color, 80)}'">`
    : `<img src="${avatarSVG(mgr.name||'Manager', color, 80)}" alt="${esc(mgr.name||'')}">`;

  const availableKits = ['home','away','third'].filter(k => team.kits?.[k]);
  // Default active: prefer stored active, else 'home', else first available
  const defaultKit = (team.kits?.active && availableKits.includes(team.kits.active))
    ? team.kits.active
    : (availableKits.includes('home') ? 'home' : availableKits[0]);

  const swatchesHtml = availableKits.map(k => {
    const kit = team.kits[k];
    // A kit has "own" colours only if explicitly stored — not just falling back to team primary
    const hasOwnColors = !!(kit.colors?.primary || kit.primary);
    // For home kit, fall back to team.colors (always populated from teams.json) so dots aren't grey by default
    const pc  = hasOwnColors ? (kit.colors?.primary   || kit.primary)   : (k === 'home' ? (team.colors?.primary   || null) : null);
    const sc  = hasOwnColors ? (kit.colors?.secondary || kit.secondary) : (k === 'home' ? (team.colors?.secondary || null) : null);
    const swatchImg = `<img class="kit-img" src="${team.kits[k]?.imageUrl || `./data/kits/${team.id}-${k}.png`}" alt="${k}" onerror="this.style.display='none';this.nextElementSibling.style.display='flex'">`;
    const dotStyle  = pc
      ? `<div class="kit-dot" style="background:${pc}"></div><div class="kit-dot" style="background:${sc || '#ffffff'}"></div>`
      : `<div class="kit-dot kit-dot-unset"></div><div class="kit-dot kit-dot-unset"></div>`;
    const dots = `<div class="kit-color-pair" data-kit-dots="${side}-${k}">${dotStyle}</div>`;
    const unsetLabel = !hasOwnColors && k !== 'home' ? ` <span class="kit-label-unset">not set</span>` : '';
    return `<div class="kit-swatch${k === defaultKit ? ' active' : ''}" data-side="${side}" data-kit="${k}">
      ${swatchImg}${dots}
      <span class="kit-label">${kit.label || k}</span>${unsetLabel}
    </div>`;
  }).join('');

  // Kit image — prefer R2 override URL if stored, else local file
  const kitImgSrc = (k) => team.kits?.[k]?.imageUrl || `./data/kits/${team.id}-${k}.png`;

  const largeKitHtml = defaultKit
    ? (APP.editMode
        ? `<div class="kit-large-wrap" id="kit-large-wrap-${side}" data-side="${side}" data-team="${team.id}" data-kit="${defaultKit}" title="Click to upload kit image">
            <img class="kit-large" id="kit-large-${side}" src="${kitImgSrc(defaultKit)}" alt="${defaultKit} kit" onerror="this.style.display='none'">
            <div class="kit-upload-overlay">📁 Upload kit</div>
            <input type="file" class="kit-upload-input" id="kit-upload-${side}" accept="image/*" style="display:none">
          </div>`
        : `<img class="kit-large" id="kit-large-${side}" src="${kitImgSrc(defaultKit)}" alt="${defaultKit} kit" onerror="this.style.display='none'">`)
    : '';

  // Colour editor — edit mode only, shown for whichever kit is active
  const initEditKit = availableKits.includes(defaultKit) ? defaultKit : (availableKits[0] || null);
  const initEditData = initEditKit ? team.kits[initEditKit] : null;
  const initEditHasOwn = !!(initEditData?.colors?.primary || initEditData?.primary);
  // Use own stored colour if set; for home kit fall back to team.colors; for away/third default to black/white so it's clear colours need setting
  const initPc = initEditHasOwn ? (initEditData.colors?.primary   || initEditData.primary)
                : (initEditKit === 'home' ? color    : '#1a1a1a');
  const initSc = initEditHasOwn ? (initEditData.colors?.secondary || initEditData.secondary)
                : (initEditKit === 'home' ? secondary : '#ffffff');
  const colorEditorHtml = APP.editMode && initEditKit ? `
    <div class="kit-color-editor" id="kit-color-editor-${side}" data-side="${side}" data-team="${team.id}" data-kit="${initEditKit}">
      <label class="kit-color-label">Primary
        <input type="color" class="kit-color-input" data-role="primary" value="${initPc}">
      </label>
      <label class="kit-color-label">Secondary
        <input type="color" class="kit-color-input" data-role="secondary" value="${initSc}">
      </label>
      <button class="kit-color-save btn-primary" style="padding:4px 10px;font-size:12px">Save</button>
    </div>` : '';

  const mgrNameHtml = APP.editMode
    ? `<div class="manager-name-edit-wrap">
        <input class="manager-name-input" data-side="${side}" data-team="${team.id}" value="${esc(mgr.name || '')}" placeholder="Manager name">
        <button class="manager-name-save btn-primary" data-side="${side}" data-team="${team.id}" style="padding:3px 8px;font-size:11px">Save</button>
      </div>`
    : `<div class="manager-name">${esc(mgr.name || 'TBC')}</div>`;

  return `<div class="manager-card" data-side="${side}">
    <div class="manager-image-wrap" style="border-color:${color}">${mgrImg}</div>
    <div class="manager-text">
      ${mgrNameHtml}
      <div class="manager-title">Head Coach</div>
    </div>
    <div class="manager-kit-display">${largeKitHtml}</div>
    <div class="manager-kits-wrap">
      <div class="manager-kits">${swatchesHtml}</div>
      ${colorEditorHtml}
    </div>
  </div>`;
}

// ── Form ──────────────────────────────────────────────────
function renderFormSection(team) {
  if (!team.form || !team.form.length) {
    return `<div class="section-card">
      <div class="section-card-header"><span class="section-title">Last 5</span></div>
      <div class="section-card-body"><p class="notes-empty">Form loading…</p></div>
    </div>`;
  }
  const teamBadgeSmall = id => `<img src="./data/badges/${id}.png" width="12" height="12" style="vertical-align:middle;margin-right:3px;border-radius:2px" onerror="this.style.display='none'">`;

  const tiles = team.form.map((m, idx) => {
    const scorers = (m.scorers || []).map(s =>
      `<div class="form-detail-row">${teamBadgeSmall(s.teamId)}${esc(lastName(s.playerName) || `#${s.playerId}`)} <span class="form-detail-min">${s.minute}'${s.typeId === EV.OWN_GOAL ? ' ↩️' : ''}</span></div>`
    ).join('');
    const reds = (m.redCards || []).map(r =>
      `<div class="form-detail-row">🟥 ${teamBadgeSmall(r.teamId)}${esc(lastName(r.playerName) || `#${r.playerId}`)} <span class="form-detail-min">${r.minute}'</span></div>`
    ).join('');
    const detail = (scorers || reds)
      ? `<div class="form-tile-detail" id="form-detail-${team.id}-${idx}">${scorers}${reds}</div>`
      : `<div class="form-tile-detail" id="form-detail-${team.id}-${idx}"><span class="notes-empty" style="font-size:11px">No event data.</span></div>`;
    return `
    <div class="form-tile-wrap">
      <div class="form-tile ${m.result}" data-form-idx="${idx}" data-team-id="${team.id}" role="button" tabindex="0" title="${esc(m.opponent)} · ${m.date||''}">
        <span class="form-result">${m.result}</span>
        <span class="form-score">${esc(m.score)}</span>
        <span class="form-opp">${esc(m.opponentShort)}</span>
        <span class="form-ha">${m.home ? 'H' : 'A'}</span>
      </div>
      ${detail}
    </div>`;
  }).join('');

  return `<div class="section-card">
    <div class="section-card-header"><span class="section-title">Last 5</span></div>
    <div class="section-card-body"><div class="form-row">${tiles}</div></div>
  </div>`;
}

// ── Last match ────────────────────────────────────────────
function renderLastMatchSection(team) {
  const lm = team.lastMatch;
  if (!lm) return `<div class="section-card">
    <div class="section-card-header"><span class="section-title">Most recent match</span></div>
    <div class="section-card-body"><p class="notes-empty">No data.</p></div>
  </div>`;

  const teamBadgeSmall = id => `<img src="./data/badges/${id}.png" width="14" height="14" style="vertical-align:middle;margin-right:4px;border-radius:2px" onerror="this.style.display='none'">`;

  const scorerRows = lm.scorers.map(s => `
    <div class="match-player-row">
      <span class="match-player-num">${teamBadgeSmall(s.teamId)}</span>
      <span class="match-player-name">${esc(lastName(s.playerName) || `#${s.playerId}`)}</span>
      <span class="match-player-event"><span>${s.typeId === EV.OWN_GOAL ? '↩️' : '⚽'}</span><span class="minute">${s.minute}'</span></span>
    </div>`).join('');

  const redRows = lm.redCards.map(r => `
    <div class="match-player-row">
      <span class="match-player-num">${teamBadgeSmall(r.teamId)}</span>
      <span class="match-player-name">${esc(lastName(r.playerName) || `#${r.playerId}`)}</span>
      <span class="match-player-event">🟥 <span class="minute">${r.minute}'</span></span>
    </div>`).join('');

  return `<div class="section-card">
    <div class="section-card-header">
      <span class="section-title">Most recent match</span>
      <span class="text-muted text-sm">${fmtShortDate(lm.date)}</span>
    </div>
    <div class="section-card-body">
      <div class="last-match-scoreline">
        <span class="last-match-score">${esc(lm.score)}</span>
        <span class="last-match-opponent">vs ${esc(lm.opponent)}</span>
      </div>
      <div class="last-match-list">
        ${scorerRows || redRows
          ? `<div class="last-match-list-section">${scorerRows}${redRows}</div>`
          : `<p class="notes-empty" style="margin-top:4px">No goal data.</p>`}
      </div>
    </div>
  </div>`;
}

// ── Key players ───────────────────────────────────────────
function renderKeyPlayersSection(team, side) {
  const color = team.colors.primary;
  const cards = team.keyPlayers.map((p, idx) => {
    if (APP.editMode) {
      const squadNames = (team.squad || []).map(s => `<option value="${esc(s.name)}"></option>`).join('');
      return `<div class="key-player-card" data-kp-idx="${idx}" data-side="${side}">
        <div class="key-player-image player-img-bg" style="background:var(--${side}-primary);border-color:var(--${side}-primary)">
          <img src="${playerImg(p, color, 72)}" width="72" height="72" alt="" onerror="this.src='${avatarSVG(p.name||'?', color, 72)}'">
        </div>
        <div class="key-player-edit">
          <div style="font-size:9px;font-family:Inter;font-weight:700;letter-spacing:.07em;text-transform:uppercase;color:var(--text-3)">${esc(p.role)}</div>
          <div class="kp-edit-wrap">
            <input class="kp-edit-input kp-name-input" list="kp-squad-${side}" value="${esc(p.name)}" placeholder="Player name…" data-side="${side}" data-idx="${idx}">
            <datalist id="kp-squad-${side}">${squadNames}</datalist>
          </div>
          <input class="kp-edit-input" placeholder="Stat (e.g. 12 goals)" value="${esc(p.stat||'')}" data-side="${side}" data-idx="${idx}" data-field="stat">
        </div>
      </div>`;
    }
    const squadP = (team.squad || []).find(s => s.name === p.name);
    const kpIsNew = squadP?.isNewSigning && isNewSigningPeriod();
    const kpNsClass = kpIsNew ? ' new-signing' : '';
    const kpNsBadge = kpIsNew ? `<span class="new-signing-badge">New</span><div class="new-signing-bar"></div>` : '';
    return `<div class="key-player-card${kpNsClass}">
      <div class="key-player-image player-img-bg" style="background:var(--${side}-primary);border-color:var(--${side}-primary)">
        <img src="${playerImg(p, color, 72)}" width="72" height="72" alt="${esc(p.name)}" onerror="this.src='${avatarSVG(p.name||'?', color, 72)}'">
        ${kpNsBadge}
      </div>
      <div class="key-player-info">
        <div class="key-player-role">${esc(p.role)}</div>
        <div class="key-player-name">${p.name ? esc(p.name) : '<span style="color:var(--text-3)">TBC</span>'}</div>
        ${p.shirtNumber ? `<div class="key-player-number">${p.shirtNumber}</div>` : ''}
        ${p.stat ? `<div class="key-player-stat">${esc(p.stat)}</div>` : ''}
      </div>
    </div>`;
  }).join('');

  return `<div class="section-card">
    <div class="section-card-header"><span class="section-title">Key players</span></div>
    <div class="section-card-body"><div class="key-players-grid">${cards}</div></div>
  </div>`;
}

// ── Notes ─────────────────────────────────────────────────
function renderNotesSection(team, side) {
  let content;
  if (APP.editMode) {
    content = `<textarea class="notes-textarea" data-side="${side}" placeholder="One note per line…">${esc(team.notes||'')}</textarea>
      <div class="notes-hint">Each line becomes a bullet point</div>`;
  } else if (team.notes && team.notes.trim()) {
    const bullets = team.notes.trim().split('\n').filter(l=>l.trim()).map(l=>`<li>${esc(l.trim())}</li>`).join('');
    content = `<ul class="notes-list">${bullets}</ul>`;
  } else {
    content = `<p class="notes-empty">No notes yet.</p>`;
  }
  return `<div class="section-card">
    <div class="section-card-header"><span class="section-title">Notes</span></div>
    <div class="section-card-body">${content}</div>
  </div>`;
}

// ── Injuries ──────────────────────────────────────────────
function renderInjuriesSection(team) {
  if (!team.injuries || !team.injuries.length) {
    return `<div class="section-card">
      <div class="section-card-header"><span class="section-title">Injuries &amp; absences</span></div>
      <div class="section-card-body"><p class="notes-empty">No known injuries.</p></div>
    </div>`;
  }
  const rows = team.injuries.map(inj => {
    const sk = (inj.status || 'out').toLowerCase();
    return `<div class="injury-row">
      <div class="injury-status-dot ${sk}"></div>
      <div class="injury-name">${esc(inj.playerName)}</div>
      <div class="injury-type">${esc(inj.type)}</div>
      <div class="injury-badge ${sk}">${esc(inj.status)}</div>
      <div class="injury-return">${inj.expectedReturn ? esc(fmtInjuryReturn(inj.expectedReturn)) : ''}</div>
    </div>`;
  }).join('');
  return `<div class="section-card">
    <div class="section-card-header"><span class="section-title">Injuries &amp; absences</span></div>
    <div class="section-card-body"><div class="injury-list">${rows}</div></div>
  </div>`;
}


// ════════════════════════════════════════════════════════
// EXPECTED LINEUP (formation — horizontal SVG)
// ════════════════════════════════════════════════════════

function calcPositions(players, pitchW, pitchH, mirrorX) {
  const PAD_X=55, PAD_Y=40, usableW=pitchW-2*PAD_X, usableH=pitchH-2*PAD_Y;
  const cols = {};
  players.filter(p => p.formationField).forEach(p => {
    const [r,c] = p.formationField.split(':').map(Number);
    if (!cols[c]) cols[c] = [];
    cols[c].push({ ...p, _row:r, _col:c });
  });
  const maxCol = Math.max(...Object.keys(cols).map(Number));
  const positions = [];
  Object.entries(cols).forEach(([cs, ps]) => {
    const col = Number(cs);
    const xRatio = maxCol===1 ? 0.5 : (col-1)/(maxCol-1);
    const x = PAD_X + xRatio*usableW, fx = mirrorX ? pitchW-x : x;
    const sorted = [...ps].sort((a,b) => a._row-b._row);
    sorted.forEach((p,i) => {
      let y;
      if (sorted.length === 1) {
        y = pitchH / 2;
      } else {
        // Cap spread: max gap between players scales with count so small rows stay compact
        const maxSpread = Math.min(usableH, sorted.length * 55);
        const topY = pitchH/2 - maxSpread/2;
        y = topY + (i / (sorted.length - 1)) * maxSpread;
      }
      positions.push({ ...p, x:fx, y });
    });
  });
  return positions;
}

function renderFormation(f) {
  const el         = document.getElementById('section-formation');
  const homeStart  = f.home.squad.filter(p => p.formationField);
  const awayStart  = f.away.squad.filter(p => p.formationField);
  if (!homeStart.length && !awayStart.length) {
    el.innerHTML = `<div class="formation-section">
      <div class="formation-header">
        <div class="formation-labels">
          <div class="formation-team-label">${esc(f.home.shortName)}</div>
          <div style="text-align:center"><span style="font-family:Inter;font-size:11px;font-weight:700;color:var(--text-3);letter-spacing:.05em">EXPECTED LINEUP</span></div>
          <div class="formation-team-label">${esc(f.away.shortName)}</div>
        </div>
      </div>
      <div style="padding:32px;text-align:center;color:rgba(255,255,255,.7);font-size:13px;background:#2D5A27;border-radius:8px;margin:0 0 16px">
        Lineups not yet available — check back closer to kick-off.
      </div>
    </div>`;
    return;
  }

  const W=900, H=300, halfW=W/2;
  const homePos = calcPositions(homeStart, halfW, H, false);
  const awayPos = calcPositions(awayStart, halfW, H, true).map(p => ({ ...p, x:p.x+halfW }));
  const hc=f.home.colors.primary, ac=f.away.colors.primary;
  const hfg=textForBg(hc), afg=textForBg(ac);

  const pitchLines = `
    <rect width="${W}" height="${H}" rx="8" fill="#2D5A27"/>
    <rect x="10" y="10" width="${W-20}" height="${H-20}" rx="3" fill="none" stroke="rgba(255,255,255,.3)" stroke-width="1.5"/>
    <line x1="${halfW}" y1="10" x2="${halfW}" y2="${H-10}" stroke="rgba(255,255,255,.3)" stroke-width="1.5"/>
    <circle cx="${halfW}" cy="${H/2}" r="${H*0.18}" fill="none" stroke="rgba(255,255,255,.3)" stroke-width="1.5"/>
    <circle cx="${halfW}" cy="${H/2}" r="3" fill="rgba(255,255,255,.5)"/>
    <rect x="10" y="${H*.22}" width="${W*.1}" height="${H*.56}" fill="none" stroke="rgba(255,255,255,.22)" stroke-width="1.2"/>
    <rect x="10" y="${H*.35}" width="${W*.05}" height="${H*.3}"  fill="none" stroke="rgba(255,255,255,.18)" stroke-width="1"/>
    <rect x="${W-10-W*.1}" y="${H*.22}" width="${W*.1}" height="${H*.56}" fill="none" stroke="rgba(255,255,255,.22)" stroke-width="1.2"/>
    <rect x="${W-10-W*.05}" y="${H*.35}" width="${W*.05}" height="${H*.3}"  fill="none" stroke="rgba(255,255,255,.18)" stroke-width="1"/>`;

  const node = (p, color, fg) => {
    const surname = (p.name||'').split(' ').pop();
    const short   = surname.length>10 ? surname.slice(0,9)+'…' : surname;
    const nsRing  = (p.isNewSigning && isNewSigningPeriod())
      ? `<circle r="21" fill="none" stroke="#FBBF24" stroke-width="2.5"/><circle r="23.5" fill="none" stroke="#F59E0B" stroke-width="1"/>`
      : '';
    return `<g transform="translate(${p.x.toFixed(1)},${p.y.toFixed(1)})">
      ${nsRing}
      <circle r="18" fill="${color}" stroke="rgba(255,255,255,.85)" stroke-width="1.5"/>
      <text y="6" font-family="DM Mono,monospace" font-size="11" font-weight="600" text-anchor="middle" fill="${fg}">${p.shirtNumber||''}</text>
      <text y="30" font-family="Inter,sans-serif" font-size="9" font-weight="700" text-anchor="middle"
        fill="rgba(255,255,255,.95)" paint-order="stroke" stroke="rgba(0,0,0,.6)" stroke-width="2">${esc(short)}</text>
    </g>`;
  };

  const homeFormStr = APP.editMode
    ? `<input class="formation-string-input" value="${esc(f.home.formation)}" data-side="home" list="formation-list">`
    : `<span class="formation-string">${esc(f.home.formation)}</span>`;
  const awayFormStr = APP.editMode
    ? `<input class="formation-string-input" value="${esc(f.away.formation)}" data-side="away" list="formation-list">`
    : `<span class="formation-string">${esc(f.away.formation)}</span>`;

  const confirmedBadge = f.lineupConfirmed
    ? `<span class="xi-confirmed-badge confirmed">Confirmed XI</span>`
    : `<span class="xi-confirmed-badge predicted">Predicted</span>`;

  el.innerHTML = `
    <datalist id="formation-list">
      ${['4-4-2','4-3-3','4-2-3-1','4-5-1','3-5-2','3-4-3','5-4-1','5-3-2','4-1-4-1','4-3-2-1']
        .map(s=>`<option value="${s}"></option>`).join('')}
    </datalist>
    <div class="formation-section">
      <div class="formation-header">
        <div class="formation-labels">
          <div class="formation-team-label" style="color:${visibleOnWhite(hc)}">${esc(f.home.shortName)} ${homeFormStr}</div>
          <div style="text-align:center">
            <span style="font-family:Inter;font-size:11px;font-weight:700;color:var(--text-3);letter-spacing:.05em">EXPECTED LINEUP</span><br>
            ${confirmedBadge}
          </div>
          <div class="formation-team-label" style="color:${visibleOnWhite(ac)}">${awayFormStr} ${esc(f.away.shortName)}</div>
        </div>
      </div>
      <div class="formation-pitch-wrap">
        <svg class="formation-svg" viewBox="0 0 ${W} ${H}" xmlns="http://www.w3.org/2000/svg">
          ${pitchLines}
          ${homePos.map(p => node(p,hc,hfg)).join('')}
          ${awayPos.map(p => node(p,ac,afg)).join('')}
        </svg>
      </div>
    </div>`;

  el.querySelectorAll('.formation-string-input').forEach(inp => {
    inp.addEventListener('change', e => {
      APP.currentFixture[e.target.dataset.side].formation = e.target.value;
    });
  });
}


// ════════════════════════════════════════════════════════
// H2H
// ════════════════════════════════════════════════════════

function renderH2H(f) {
  const el = document.getElementById('section-h2h');
  if (!f.h2h || !f.h2h.length) {
    el.innerHTML = `<div class="h2h-section">
      <div class="section-card-header" style="padding:11px 16px;border-bottom:1px solid var(--border-light)">
        <span class="section-title">Head to head</span>
      </div>
      <div style="padding:24px;text-align:center;color:var(--text-3);font-size:13px">
        No recent H2H data available for these teams.
      </div>
    </div>`;
    return;
  }

  // W/D/L summary from home team's perspective
  let homeW = 0, draws = 0, awayW = 0;
  f.h2h.forEach(m => {
    const fhWon  = m.homeId === f.home.id ? m.homeGoals > m.awayGoals : m.awayGoals > m.homeGoals;
    const fhDrew = m.homeGoals === m.awayGoals;
    if (fhDrew) draws++; else if (fhWon) homeW++; else awayW++;
  });
  const h2hSummary = `
    <div class="h2h-summary">
      <span class="h2h-summary-team">${esc(f.home.shortName)}</span>
      <span class="h2h-summary-num h2h-summary-w">${homeW}W</span>
      <span class="h2h-summary-num h2h-summary-d">${draws}D</span>
      <span class="h2h-summary-num h2h-summary-l">${awayW}W</span>
      <span class="h2h-summary-team">${esc(f.away.shortName)}</span>
    </div>`;

  const rows = f.h2h.map(m => {
    const fhWon  = m.homeId === f.home.id ? m.homeGoals > m.awayGoals : m.awayGoals > m.homeGoals;
    const fhDrew = m.homeGoals === m.awayGoals;
    const dot    = fhWon ? 'var(--win)' : fhDrew ? 'var(--draw)' : 'var(--loss)';
    return `<div class="h2h-row">
      <span class="h2h-date">${(m.date||'').slice(0,4)}</span>
      <div class="h2h-result-dot" style="background:${dot}"></div>
      <span class="h2h-home">${esc(m.home)}</span>
      <span class="h2h-score">${esc(m.score)}</span>
      <span class="h2h-away">${esc(m.away)}</span>
    </div>`;
  }).join('');

  const mr = f.h2h[0];
  const teamBadgeSmall = id => `<img src="./data/badges/${id}.png" width="14" height="14" style="vertical-align:middle;margin-right:4px;border-radius:2px" onerror="this.style.display='none'">`;
  const pName = (id, pre) => pre || `#${id}`;

  const mrScorers = mr.scorers.length
    ? mr.scorers.map(s => `<div class="h2h-event-row">
        <span class="h2h-event-icon">⚽</span>
        <span>${teamBadgeSmall(s.teamId)}${esc(lastName(s.playerName) || pName(s.playerId, s.playerName))}</span>
        <span class="h2h-event-minute">${s.minute}'</span>
      </div>`).join('')
    : `<p class="notes-empty" style="font-size:12px">No scorer data.</p>`;

  const mrReds = mr.redCards.map(r =>
    `<div class="h2h-event-row"><span class="h2h-event-icon">🟥</span><span>${teamBadgeSmall(r.teamId)}${esc(lastName(r.playerName) || pName(r.playerId, r.playerName))}</span><span class="h2h-event-minute">${r.minute}'</span></div>`
  ).join('');

  el.innerHTML = `<div class="h2h-section">
    <div class="section-card-header" style="padding:11px 16px;border-bottom:1px solid var(--border-light)">
      <span class="section-title">Head to head</span>
      ${h2hSummary}
    </div>
    <div class="h2h-inner">
      <div class="h2h-left"><div class="h2h-col-header">Results</div>${rows}</div>
      <div class="h2h-right">
        <div class="h2h-col-header">Most recent — ${fmtH2HDate(mr.date)}</div>
        <div class="h2h-recent-body">
          <div class="h2h-recent-scoreline">
            <span class="h2h-recent-score">${esc(mr.score)}</span>
            <span class="h2h-recent-teams">${esc(mr.home)} vs ${esc(mr.away)}</span>
          </div>
          <div class="h2h-recent-events">${mrScorers}${mrReds}</div>
        </div>
      </div>
    </div>
  </div>`;
}


// ════════════════════════════════════════════════════════
// MAIN TAB EVENTS
// ════════════════════════════════════════════════════════

function initMainTabEvents(f) {
  // Form tile click — toggle detail panel
  document.querySelectorAll('.form-tile[data-form-idx]').forEach(tile => {
    tile.addEventListener('click', () => {
      const detail = document.getElementById(`form-detail-${tile.dataset.teamId}-${tile.dataset.formIdx}`);
      if (!detail) return;
      const isOpen = detail.classList.contains('open');
      // Close any other open detail panels for this team
      document.querySelectorAll(`.form-tile-detail`).forEach(d => d.classList.remove('open'));
      document.querySelectorAll('.form-tile').forEach(t => t.classList.remove('expanded'));
      if (!isOpen) { detail.classList.add('open'); tile.classList.add('expanded'); }
    });
  });

  document.querySelectorAll('.notes-textarea[data-side]').forEach(ta => {
    ta.addEventListener('input', e => { APP.currentFixture[e.target.dataset.side].notes = e.target.value; });
  });
  document.querySelectorAll('.kp-name-input').forEach(inp => {
    inp.addEventListener('change', e => {
      const side=e.target.dataset.side, idx=parseInt(e.target.dataset.idx);
      const name = e.target.value.trim();
      APP.currentFixture[side].keyPlayers[idx].name = name;
      // Sync image and shirt number from squad when name changes
      const matchedPlayer = (APP.currentFixture[side].squad||[]).find(p => p.name === name);
      APP.currentFixture[side].keyPlayers[idx].image = matchedPlayer?.image || null;
      APP.currentFixture[side].keyPlayers[idx].shirtNumber = matchedPlayer?.shirtNumber || null;
      // Persist captain changes to KV so they survive page reload
      if (idx === 0) {
        const teamId = APP.currentFixture[side].id;
        fetch(`${WORKER}/overrides/captain:${teamId}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(name),
        }).catch(() => {});
      }
      renderMainTab(APP.currentFixture);
    });
  });
  document.querySelectorAll('.kp-edit-input[data-field="stat"]').forEach(inp => {
    inp.addEventListener('change', e => {
      const side=e.target.dataset.side, idx=parseInt(e.target.dataset.idx);
      APP.currentFixture[side].keyPlayers[idx].stat = e.target.value.trim();
    });
  });
}


// ════════════════════════════════════════════════════════
// PRODUCTION TAB
// ════════════════════════════════════════════════════════

let groundMarkers     = {};
let groundCurrentType = 'cam3';

const MARKER_CONFIG = {
  'cam3':      { label:'Cam 3',     color:'#16A34A', shape:'circle' },
  'cam4':      { label:'Cam 4',     color:'#9333EA', shape:'circle' },
  'dugouts':   { label:'Dugouts',   color:'#CA8A04', shape:'rect',   w:64, h:20 },
  'away-fans': { label:'Away Fans', color:'#B45309', shape:'rect',   w:72, h:28 },
  'tunnel':    { label:'Tunnel',    color:'#374151', shape:'square', w:24, h:24 },
};
const CAM_COLORS = ['#F97316','#2563EB','#16A34A','#9333EA'];

function groundKey(f)             { return `groundLayout_${f.venueSlug}`; }
function groundNotesKey(f)        { return `groundNotes_${f.venueSlug}`; }
function loadGroundState(f)       { try { groundMarkers=JSON.parse(localStorage.getItem(groundKey(f))||'{}'); } catch { groundMarkers={}; } }
function saveGroundMarkers(f)     { localStorage.setItem(groundKey(f), JSON.stringify(groundMarkers)); }
function saveGroundNotes(f, n)    { localStorage.setItem(groundNotesKey(f), n); }
function loadGroundNotes(f)       { return localStorage.getItem(groundNotesKey(f)) || ''; }

function renderProductionTab(f) {
  loadGroundState(f);
  const notes = loadGroundNotes(f);
  const el    = document.getElementById('tab-production');

  el.innerHTML = `
    <div class="production-top-strip">
      <div style="display:flex;align-items:center;gap:10px;flex:1">
        ${teamBadge(f.home,40)}
        <div>
          <div style="font-family:Inter;font-weight:800;font-size:16px">${esc(f.home.name)}</div>
          <div style="font-size:12px;color:var(--text-3)">${f.home.position?ordinal(f.home.position):''} · ${esc(f.comp)}</div>
        </div>
      </div>
      <div style="font-family:Inter;font-weight:700;color:var(--text-3)">vs</div>
      <div style="display:flex;align-items:center;gap:10px;flex:1;flex-direction:row-reverse">
        ${teamBadge(f.away,40)}
        <div style="text-align:right">
          <div style="font-family:Inter;font-weight:800;font-size:16px">${esc(f.away.name)}</div>
          <div style="font-size:12px;color:var(--text-3)">${f.away.position?ordinal(f.away.position):''} · ${esc(f.comp)}</div>
        </div>
      </div>
    </div>
    <div class="production-layout">
      <div class="section-card ground-layout-card">
        <div class="section-card-header"><span class="section-title">Ground layout — ${esc(f.venue)}</span></div>
        <div class="ground-layout-inner">
          <div class="ground-toolbar">
            ${Object.entries(MARKER_CONFIG).map(([key,cfg]) =>
              `<button class="place-type-btn${groundCurrentType===key?' active':''}" data-type="${key}">
                <span class="btn-dot" style="background:${cfg.color}"></span>${cfg.label}
              </button>`).join('')}
            <button class="place-clear-btn">✕ Clear all</button>
          </div>
          <div class="ground-svg-wrap">
            <svg id="ground-svg" viewBox="0 0 700 420" xmlns="http://www.w3.org/2000/svg">
              <rect x="0"   y="0"   width="700" height="420" fill="#E8E5DF"/>
              <rect x="0"   y="0"   width="700" height="38"  fill="#CCCAC4"/>
              <rect x="0"   y="382" width="700" height="38"  fill="#CCCAC4"/>
              <rect x="0"   y="0"   width="38"  height="420" fill="#D8D5CF"/>
              <rect x="662" y="0"   width="38"  height="420" fill="#D8D5CF"/>
              <rect x="48" y="48" width="604" height="324" fill="#4A8A2A" rx="2"/>
              <rect x="48" y="48" width="604" height="324" fill="none" stroke="rgba(255,255,255,.5)" stroke-width="2"/>
              <line x1="350" y1="48"  x2="350" y2="372" stroke="rgba(255,255,255,.4)" stroke-width="1.5"/>
              <circle cx="350" cy="210" r="46"  fill="none" stroke="rgba(255,255,255,.4)" stroke-width="1.5"/>
              <circle cx="350" cy="210" r="3"   fill="rgba(255,255,255,.5)"/>
              <rect x="48"  y="128" width="122" height="164" fill="none" stroke="rgba(255,255,255,.4)" stroke-width="1.5"/>
              <rect x="530" y="128" width="122" height="164" fill="none" stroke="rgba(255,255,255,.4)" stroke-width="1.5"/>
              <rect x="48"  y="170" width="42"  height="80"  fill="none" stroke="rgba(255,255,255,.3)" stroke-width="1"/>
              <rect x="610" y="170" width="42"  height="80"  fill="none" stroke="rgba(255,255,255,.3)" stroke-width="1"/>
              <rect x="30"  y="192" width="18" height="36" fill="none" stroke="rgba(255,255,255,.5)" stroke-width="1.5"/>
              <rect x="652" y="192" width="18" height="36" fill="none" stroke="rgba(255,255,255,.5)" stroke-width="1.5"/>
              <circle cx="322" cy="401" r="16" fill="#F97316" stroke="white" stroke-width="2"/>
              <text x="322" y="401" text-anchor="middle" dy="4" font-family="Inter,sans-serif" font-size="9" font-weight="700" fill="white">CAM 1</text>
              <circle cx="378" cy="401" r="16" fill="#2563EB" stroke="white" stroke-width="2"/>
              <text x="378" y="401" text-anchor="middle" dy="4" font-family="Inter,sans-serif" font-size="9" font-weight="700" fill="white">CAM 2</text>
              <g id="marker-layer"></g>
            </svg>
          </div>
          <div class="marker-legend" id="marker-legend"></div>
        </div>
      </div>
      <div class="section-card ground-notes-card">
        <div class="section-card-header"><span class="section-title">Ground notes</span></div>
        <div class="section-card-body">
          <p class="ground-hint">Saved per venue — reloads automatically for future matches here.</p>
          <textarea class="notes-textarea" id="ground-notes" style="min-height:160px" placeholder="e.g. Tunnel entrance east side. OB truck Gate B…">${esc(notes)}</textarea>
          <div class="save-row">
            <button class="save-btn" id="ground-notes-save">Save notes</button>
            <span class="saved-msg" id="ground-notes-saved">✓ Saved</span>
          </div>
        </div>
      </div>
    </div>
    <div class="section-title cam-op-section-title">Camera operators</div>
    <div class="cam-op-grid" id="cam-op-grid"></div>
  `;

  renderMarkers(f); initGroundEvents(f); renderCamOps();
}

function svgCoordsFromEvent(e) {
  const svg=document.getElementById('ground-svg'), rect=svg.getBoundingClientRect(), vb=svg.viewBox.baseVal;
  return { x:Math.round((e.clientX-rect.left)/rect.width*vb.width), y:Math.round((e.clientY-rect.top)/rect.height*vb.height) };
}

function renderMarkers(f) {
  const layer=document.getElementById('marker-layer'), legend=document.getElementById('marker-legend');
  if (!layer) return;
  layer.innerHTML='';
  const fixed=[
    `<div class="marker-legend-item"><div style="width:12px;height:12px;border-radius:50%;background:#F97316"></div><span style="font-size:12px;font-weight:600">Cam 1</span><span style="color:var(--text-3);font-size:10px"> · fixed</span></div>`,
    `<div class="marker-legend-item"><div style="width:12px;height:12px;border-radius:50%;background:#2563EB"></div><span style="font-size:12px;font-weight:600">Cam 2</span><span style="color:var(--text-3);font-size:10px"> · fixed</span></div>`,
  ];
  const placed=[];
  Object.entries(groundMarkers).forEach(([type,pos]) => {
    const cfg=MARKER_CONFIG[type]; if (!cfg) return;
    const g=document.createElementNS('http://www.w3.org/2000/svg','g');
    g.setAttribute('transform',`translate(${pos.x},${pos.y})`); g.style.cursor='grab';
    if (cfg.shape==='circle') {
      const c=document.createElementNS('http://www.w3.org/2000/svg','circle');
      c.setAttribute('r','16'); c.setAttribute('fill',cfg.color);
      c.setAttribute('stroke','white'); c.setAttribute('stroke-width','2'); g.appendChild(c);
    } else {
      const hw=Math.round((cfg.w||24)/2), hh=Math.round((cfg.h||24)/2);
      const r=document.createElementNS('http://www.w3.org/2000/svg','rect');
      r.setAttribute('x',-hw); r.setAttribute('y',-hh); r.setAttribute('width',cfg.w||24); r.setAttribute('height',cfg.h||24);
      r.setAttribute('rx','3'); r.setAttribute('fill',cfg.color); r.setAttribute('stroke','white'); r.setAttribute('stroke-width','1.5'); g.appendChild(r);
    }
    const txt=document.createElementNS('http://www.w3.org/2000/svg','text');
    txt.setAttribute('text-anchor','middle'); txt.setAttribute('dy','4');
    txt.setAttribute('font-family','Inter,sans-serif'); txt.setAttribute('font-weight','700');
    txt.setAttribute('font-size',cfg.shape==='circle'?'9':'8');
    txt.setAttribute('fill','white'); txt.textContent=cfg.label; g.appendChild(txt);
    let dragging=false,sx,sy,ox,oy;
    g.addEventListener('mousedown',e=>{ e.stopPropagation(); dragging=true; sx=e.clientX; sy=e.clientY; ox=groundMarkers[type].x; oy=groundMarkers[type].y; g.style.cursor='grabbing'; });
    document.addEventListener('mousemove',e=>{ if(!dragging) return; const sv=document.getElementById('ground-svg'),rc=sv.getBoundingClientRect(),vb=sv.viewBox.baseVal; groundMarkers[type].x=Math.round(ox+(e.clientX-sx)/rc.width*vb.width); groundMarkers[type].y=Math.round(oy+(e.clientY-sy)/rc.height*vb.height); renderMarkers(f); });
    document.addEventListener('mouseup',()=>{ if(dragging){saveGroundMarkers(f);dragging=false;} });
    g.addEventListener('dblclick',e=>{ e.stopPropagation(); delete groundMarkers[type]; saveGroundMarkers(f); renderMarkers(f); });
    layer.appendChild(g);
    placed.push(`<div class="marker-legend-item"><div style="width:12px;height:12px;border-radius:${cfg.shape==='circle'?'50%':'3px'};background:${cfg.color}"></div><span style="font-size:12px;font-weight:600">${cfg.label}</span><span style="color:var(--text-3);font-size:10px"> — dbl-click to remove</span></div>`);
  });
  if (legend) legend.innerHTML=[...fixed,...placed].join('');
}

function initGroundEvents(f) {
  const svg=document.getElementById('ground-svg'); if (!svg) return;
  svg.addEventListener('click',e=>{ if(e.target!==svg&&e.target.closest('g')!==null) return; groundMarkers[groundCurrentType]=svgCoordsFromEvent(e); saveGroundMarkers(f); renderMarkers(f); });
  document.querySelector('.ground-toolbar').addEventListener('click',e=>{
    const btn=e.target.closest('.place-type-btn');
    if(btn){ groundCurrentType=btn.dataset.type; document.querySelectorAll('.place-type-btn').forEach(b=>b.classList.remove('active')); btn.classList.add('active'); return; }
    if(e.target.closest('.place-clear-btn')){ groundMarkers={}; saveGroundMarkers(f); renderMarkers(f); }
  });
  document.getElementById('ground-notes-save').addEventListener('click',()=>{
    const n=document.getElementById('ground-notes').value; saveGroundNotes(f,n);
    const msg=document.getElementById('ground-notes-saved'); msg.classList.add('show'); setTimeout(()=>msg.classList.remove('show'),2000);
  });
}

// ── Camera operator persistence ───────────────────────────
// Operator profiles (name, camera type, power) persist globally — keyed by cam number.
// Match ratings + notes persist per-fixture — keyed by fixture ID + cam number.
// History: last 5 match ratings + notes per operator are stored and displayed.

function camOpProfileKey(camNum)           { return `camOp_profile_${camNum}`; }
function camOpMatchKey(fixtureId, camNum)  { return `camOp_match_${fixtureId}_${camNum}`; }
function camOpHistoryKey(camNum)           { return `camOp_history_${camNum}`; }

function loadCamOpProfile(camNum) {
  try { return JSON.parse(localStorage.getItem(camOpProfileKey(camNum)) || 'null') || {}; } catch { return {}; }
}
function saveCamOpProfile(camNum, data) {
  localStorage.setItem(camOpProfileKey(camNum), JSON.stringify(data));
}
function loadCamOpMatch(fixtureId, camNum) {
  try { return JSON.parse(localStorage.getItem(camOpMatchKey(fixtureId, camNum)) || 'null') || {}; } catch { return {}; }
}
function saveCamOpMatch(fixtureId, camNum, data) {
  localStorage.setItem(camOpMatchKey(fixtureId, camNum), JSON.stringify(data));
  // Update history: load, prepend current entry, cap at 5
  const profile = loadCamOpProfile(camNum);
  const hist = loadCamOpHistory(camNum).filter(h => h.fixtureId !== String(fixtureId));
  hist.unshift({
    fixtureId: String(fixtureId),
    date:  data.date  || '',
    match: data.match || '',
    rating: data.rating || 0,
    notes: data.notes || '',
  });
  localStorage.setItem(camOpHistoryKey(camNum), JSON.stringify(hist.slice(0, 5)));
}
function loadCamOpHistory(camNum) {
  try { return JSON.parse(localStorage.getItem(camOpHistoryKey(camNum)) || '[]'); } catch { return []; }
}

function renderCamOps() {
  const container = document.getElementById('cam-op-grid'); if (!container) return;
  const f = APP.currentFixture;
  const fixtureId = f?.id || 'unknown';
  const matchLabel = f ? `${f.home.shortName} v ${f.away.shortName}` : '';
  const matchDate  = f?.date || '';

  container.innerHTML = [1,2,3,4].map(i => {
    const cc      = CAM_COLORS[i-1];
    const profile = loadCamOpProfile(i);
    const match   = loadCamOpMatch(fixtureId, i);
    const history = loadCamOpHistory(i).filter(h => h.fixtureId !== String(fixtureId));

    const camTypes = ['Sony','Panasonic','JVC','Other'];
    const camOpts  = camTypes.map(t => `<option${profile.camera===t?' selected':''}>${t}</option>`).join('');
    const pwrOpts  = ['Mains','Battery'].map(t => `<option${profile.power===t?' selected':''}>${t}</option>`).join('');

    const starsHtml = [1,2,3,4,5].map(s =>
      `<span class="star${(match.rating||0)>=s?' filled':''}" data-op="${i}" data-val="${s}">★</span>`
    ).join('');

    const avgRating = (() => {
      const allRatings = history.map(h => h.rating).filter(r => r > 0);
      if (!allRatings.length) return null;
      return (allRatings.reduce((a,b) => a+b, 0) / allRatings.length).toFixed(1);
    })();

    const histHtml = history.length ? `
      <div class="cam-op-history">
        <div class="cam-op-history-label">Previous matches</div>
        ${history.map(h => `
          <div class="cam-op-history-row">
            <span class="cam-op-history-match">${esc(h.match || h.fixtureId)}</span>
            <span class="cam-op-history-date">${h.date ? fmtShortDate(h.date) : ''}</span>
            <span class="cam-op-history-stars">${h.rating ? '★'.repeat(h.rating) : '—'}</span>
            ${h.notes ? `<span class="cam-op-history-notes">${esc(h.notes)}</span>` : ''}
          </div>`).join('')}
      </div>` : '';

    return `<div class="cam-op-card" data-cam="${i}">
      <div class="cam-op-header">
        <div class="cam-op-num" style="background:${cc}">CAM<br>${i}</div>
        <input class="cam-op-name-input" type="text" value="${esc(profile.name||'')}" placeholder="Operator name…" data-cam="${i}" data-field="name">
        ${avgRating ? `<span class="cam-op-avg-rating" title="Average rating across ${history.length} match${history.length!==1?'es':''}">avg ${avgRating}★</span>` : ''}
      </div>
      <div class="cam-op-fields">
        <div><div class="cam-op-field-label">Camera</div><select class="cam-op-select" data-cam="${i}" data-field="camera">${camOpts}</select></div>
        <div><div class="cam-op-field-label">Power</div><select class="cam-op-select" data-cam="${i}" data-field="power">${pwrOpts}</select></div>
      </div>
      <div class="cam-op-rating-row">
        <span class="cam-op-rating-label">Today's rating</span>
        <div class="stars-input" data-cam="${i}">${starsHtml}</div>
      </div>
      <textarea class="cam-op-notes notes-textarea" data-cam="${i}" placeholder="Notes for this match…" style="min-height:56px;font-size:13px">${esc(match.notes||'')}</textarea>
      <button class="cam-op-save-btn" data-cam="${i}" style="margin-top:8px">Save</button>
      ${histHtml}
    </div>`;
  }).join('');

  // Stars — hover + click
  container.querySelectorAll('.star').forEach(star => {
    star.addEventListener('click', () => {
      const v = parseInt(star.dataset.val), op = star.dataset.op;
      container.querySelectorAll(`.star[data-op="${op}"]`).forEach(s => s.classList.toggle('filled', parseInt(s.dataset.val) <= v));
      // Store rating on the card element for save
      const card = container.querySelector(`.cam-op-card[data-cam="${op}"]`);
      if (card) card.dataset.rating = v;
    });
    star.addEventListener('mouseover', () => {
      const v = parseInt(star.dataset.val), op = star.dataset.op;
      container.querySelectorAll(`.star[data-op="${op}"]`).forEach(s => {
        if (!s.classList.contains('filled')) s.style.color = parseInt(s.dataset.val) <= v ? '#F59E0B' : '';
      });
    });
    star.addEventListener('mouseleave', () => {
      const op = star.dataset.op;
      container.querySelectorAll(`.star[data-op="${op}"]`).forEach(s => { if (!s.classList.contains('filled')) s.style.color = ''; });
    });
  });

  // Initialise rating dataset from loaded match data
  container.querySelectorAll('.cam-op-card').forEach(card => {
    const i = card.dataset.cam;
    const match = loadCamOpMatch(fixtureId, i);
    if (match.rating) card.dataset.rating = match.rating;
  });

  // Profile fields — save on change
  container.querySelectorAll('.cam-op-name-input, .cam-op-select').forEach(el => {
    el.addEventListener('change', () => {
      const i = el.dataset.cam;
      const profile = loadCamOpProfile(i);
      profile[el.dataset.field] = el.value;
      saveCamOpProfile(i, profile);
    });
  });

  // Save button — persists match rating + notes, re-renders to show in history
  container.querySelectorAll('.cam-op-save-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const i    = btn.dataset.cam;
      const card = container.querySelector(`.cam-op-card[data-cam="${i}"]`);
      const notes  = card.querySelector('.cam-op-notes')?.value || '';
      const rating = parseInt(card.dataset.rating || 0);
      saveCamOpMatch(fixtureId, i, { rating, notes, match: matchLabel, date: matchDate });
      btn.textContent = 'Saved ✓';
      setTimeout(() => { btn.textContent = 'Save'; renderCamOps(); }, 1000);
    });
  });
}


// ════════════════════════════════════════════════════════
// CONFIRMED XI TAB
// ════════════════════════════════════════════════════════

const COMMON_FORMATIONS = ['4-4-2','4-3-3','4-2-3-1','4-5-1','3-5-2','3-4-3','5-4-1','5-3-2','4-1-4-1','4-3-2-1','3-4-1-2','4-4-1-1'];

function applyFormation(side, formationStr) {
  const f=APP.currentFixture, team=f[side];
  const starters=team.squad.filter(p=>p.formationField);
  if (!starters.length) { team.formation=formationStr; renderXITab(f); return; }
  const parts=formationStr.split('-').map(Number);
  if (parts.some(isNaN)||parts.length<2) { team.formation=formationStr; renderXITab(f); return; }
  const cols=[1,...parts];
  const sorted=[...starters].sort((a,b)=>{ const ag=(a.position==='GK')?0:1,bg=(b.position==='GK')?0:1; return ag!==bg?ag-bg:(a.shirtNumber||99)-(b.shirtNumber||99); });
  let pi=0;
  cols.forEach((count,colIdx)=>{ const col=colIdx+1; for(let row=1;row<=count;row++){ if(pi<sorted.length){ const p=team.squad.find(s=>s.id===sorted[pi].id); if(p) p.formationField=`${row}:${col}`; pi++; } } });
  while(pi<sorted.length){ const p=team.squad.find(s=>s.id===sorted[pi].id); if(p) p.formationField=null; pi++; }
  team.formation=formationStr; renderXITab(f);
}

function renderXITab(f) {
  const el=document.getElementById('tab-xi');
  el.innerHTML=`<div class="xi-layout"><div class="xi-col">${buildXICol(f,'home')}</div><div class="xi-col">${buildXICol(f,'away')}</div></div>`;
  initXIEvents(f);
}

function buildXICol(f, side) {
  const team=f[side], color=team.colors.primary, fg=textForBg(color);
  const inSquad  = team.squad.filter(p=>p.formationField!==undefined);
  const starters = inSquad.filter(p=>p.formationField);
  const bench    = inSquad.filter(p=>p.formationField===null);

  const W=380,H=520,PAD_X=32,PAD_Y=40,usableW=W-2*PAD_X,usableH=H-2*PAD_Y;
  const cols={};
  starters.forEach(p=>{ const[r,c]=p.formationField.split(':').map(Number); if(!cols[c]) cols[c]=[]; cols[c].push({...p,_row:r,_col:c}); });
  const maxCol=starters.length?Math.max(...Object.keys(cols).map(Number)):1;
  const positions=[];
  Object.entries(cols).forEach(([cs,ps])=>{
    const col=Number(cs), yRatio=maxCol===1?0.85:1-((col-1)/(maxCol-1))*0.85, y=PAD_Y+yRatio*usableH;
    const sorted=[...ps].sort((a,b)=>a._row-b._row);
    sorted.forEach((p,i)=>{ const x=sorted.length===1?W/2:PAD_X+(i/(sorted.length-1))*usableW; positions.push({...p,x,y}); });
  });

  const selectedId=APP.xiSwap?.side===side?APP.xiSwap.playerId:null, NR=24;
  const nodes=positions.map(p=>{
    const surname=(p.name||'').split(' ').pop(), short=surname.length>9?surname.slice(0,8)+'…':surname;
    const isSel=p.id===selectedId, ring=isSel?`stroke="#3B82F6" stroke-width="3"`:`stroke="rgba(255,255,255,.85)" stroke-width="1.5"`;
    const nsRing = (p.isNewSigning && isNewSigningPeriod())
      ? `<circle cx="${p.x.toFixed(1)}" cy="${p.y.toFixed(1)}" r="${NR+4}" fill="none" stroke="#FBBF24" stroke-width="2.5"/>
         <circle cx="${p.x.toFixed(1)}" cy="${p.y.toFixed(1)}" r="${NR+7}" fill="none" stroke="#F59E0B" stroke-width="1"/>`
      : '';
    return `<g class="xi-node${isSel?' xi-node-selected':''}" data-player-id="${p.id}" data-side="${side}" style="cursor:${APP.editMode?'pointer':'default'}">
      ${nsRing}
      <circle cx="${p.x.toFixed(1)}" cy="${p.y.toFixed(1)}" r="${NR}" fill="${color}" ${ring}/>
      <text x="${p.x.toFixed(1)}" y="${(p.y+8).toFixed(1)}" font-family="DM Mono,monospace" font-size="14" font-weight="600" text-anchor="middle" fill="${fg}">${p.shirtNumber||''}</text>
      <text x="${p.x.toFixed(1)}" y="${(p.y+NR+14).toFixed(1)}" font-family="Inter,sans-serif" font-size="10" font-weight="700" text-anchor="middle"
        fill="rgba(255,255,255,.95)" paint-order="stroke" stroke="rgba(0,0,0,.6)" stroke-width="2.5">${esc(short)}</text>
    </g>`;
  }).join('');

  const pitchSVG=`<svg id="xi-svg-${side}" viewBox="0 0 ${W} ${H}" xmlns="http://www.w3.org/2000/svg" style="width:100%;display:block">
    <rect width="${W}" height="${H}" rx="6" fill="#2D5A27"/>
    <rect x="8" y="8" width="${W-16}" height="${H-16}" rx="3" fill="none" stroke="rgba(255,255,255,.3)" stroke-width="1.2"/>
    <line x1="8" y1="${H/2}" x2="${W-8}" y2="${H/2}" stroke="rgba(255,255,255,.3)" stroke-width="1.2"/>
    <circle cx="${W/2}" cy="${H/2}" r="${Math.round(W*0.13)}" fill="none" stroke="rgba(255,255,255,.3)" stroke-width="1.2"/>
    <circle cx="${W/2}" cy="${H/2}" r="3" fill="rgba(255,255,255,.4)"/>
    <rect x="${W*0.2}" y="${H-8-H*0.16}" width="${W*0.6}" height="${H*0.16}" fill="none" stroke="rgba(255,255,255,.2)" stroke-width="1"/>
    <rect x="${W*0.3}" y="${H-8-H*0.08}" width="${W*0.4}" height="${H*0.08}" fill="none" stroke="rgba(255,255,255,.15)" stroke-width="1"/>
    <rect x="${W*0.2}" y="8" width="${W*0.6}" height="${H*0.16}" fill="none" stroke="rgba(255,255,255,.2)" stroke-width="1"/>
    <rect x="${W*0.3}" y="8" width="${W*0.4}" height="${H*0.08}" fill="none" stroke="rgba(255,255,255,.15)" stroke-width="1"/>
    ${nodes}
  </svg>`;

  const makeRow=(p,isBench)=>APP.editMode
    ? `<div class="xi-player-row"${isBench?' style="opacity:.8"':''}>
        <span class="xi-player-num">${p.shirtNumber||''}</span>
        <input class="xi-player-input" list="xi-squad-${side}" value="${esc(p.name)}" ${isBench?'style="font-weight:400"':''} data-side="${side}" data-player-id="${p.id}">
        <datalist id="xi-squad-${side}">${(team.squad||[]).map(s=>`<option value="${esc(s.name)}">`).join('')}</datalist>
        <span class="xi-player-pos">${esc(p.position||'')}</span>
      </div>`
    : `<div class="xi-player-row"${isBench?' style="opacity:.8"':''}>
        <span class="xi-player-num">${p.shirtNumber||''}</span>
        <span class="xi-player-name"${isBench?' style="font-weight:400"':''}>${esc(p.name)}</span>
        <span class="xi-player-pos">${esc(p.position||'')}</span>
      </div>`;

  const formInput=APP.editMode
    ?`<select class="xi-formation-select" data-side="${side}">${COMMON_FORMATIONS.map(s=>`<option value="${s}"${team.formation===s?' selected':''}>${s}</option>`).join('')}</select>`
    :`<span class="formation-string">${esc(team.formation)}</span>`;

  const confirmedBadge=f.lineupConfirmed?`<span class="xi-confirmed-badge confirmed">Confirmed</span>`:`<span class="xi-confirmed-badge predicted">Predicted</span>`;
  const noLineup=!starters.length?`<div style="padding:24px;text-align:center;color:var(--text-3);font-size:13px">No lineup yet — pull from API when available.</div>`:'';

  return `<div class="xi-pitch-wrap">
    <div class="xi-pitch-header">
      <div style="display:flex;align-items:center;gap:10px">${teamBadge(team,28)}<span class="xi-pitch-title">${esc(team.name)}</span></div>
      <div style="display:flex;align-items:center;gap:8px">
        <div class="xi-formation-row" style="padding:0;border:none;background:none;display:flex;align-items:center;gap:6px">
          <span class="xi-formation-label">Formation</span>${formInput}
        </div>
        ${confirmedBadge}
      </div>
    </div>
    <div class="xi-pitch-svg-wrap">${noLineup||pitchSVG}</div>
    ${APP.editMode?`<div style="padding:6px 12px;background:var(--surface-alt);border-top:1px solid var(--border-light);font-size:11px;color:var(--text-3);font-family:Inter;font-weight:600">${selectedId?'🔵 Tap another player to swap':'Tap two players to swap positions'}</div>`:''}
    <button class="xi-pull-btn" data-side="${side}">
      <svg width="14" height="14" viewBox="0 0 14 14" fill="none"><path d="M7 1v12M1 7l6 6 6-6" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>
      Pull from API
    </button>
  </div>
  <div class="xi-list-section">
    <div class="xi-list-header"><span class="section-title">Starting XI</span><span style="font-size:11px;color:var(--text-3)">${starters.length} players</span></div>
    ${positions.map(p=>makeRow(p,false)).join('')||'<p class="notes-empty">No starters.</p>'}
  </div>
  ${bench.length?`<div class="xi-list-section">
    <div class="xi-list-header"><span class="section-title">Substitutes</span><span style="font-size:11px;color:var(--text-3)">${bench.length} players</span></div>
    ${bench.map(p=>makeRow(p,true)).join('')}
  </div>`:''}`;
}

function initXIEvents(f) {
  document.querySelectorAll('.xi-node').forEach(node=>{
    node.addEventListener('click',()=>{
      if (!APP.editMode) return;
      const side=node.dataset.side, id=parseInt(node.dataset.playerId);
      if (!APP.xiSwap) { APP.xiSwap={side,playerId:id}; renderXITab(f); }
      else if (APP.xiSwap.side===side&&APP.xiSwap.playerId!==id) {
        const squad=f[side].squad, p1=squad.find(p=>p.id===APP.xiSwap.playerId), p2=squad.find(p=>p.id===id);
        if(p1&&p2)[p1.formationField,p2.formationField]=[p2.formationField,p1.formationField];
        APP.xiSwap=null; renderXITab(f);
      } else { APP.xiSwap=null; renderXITab(f); }
    });
  });
  document.querySelectorAll('.xi-formation-select[data-side]').forEach(sel=>{
    sel.addEventListener('change',e=>applyFormation(e.target.dataset.side,e.target.value));
  });
  document.querySelectorAll('.xi-player-input[data-player-id]').forEach(inp=>{
    inp.addEventListener('change',e=>{ const side=e.target.dataset.side,pid=parseInt(e.target.dataset.playerId); const p=f[side].squad.find(s=>s.id===pid); if(p) p.name=e.target.value.trim(); });
  });
  document.querySelectorAll('.xi-pull-btn').forEach(btn=>{
    btn.addEventListener('click',()=>refreshFixture());
  });
}


// ════════════════════════════════════════════════════════
// WARMUPS TAB
// ════════════════════════════════════════════════════════

const warmupsChecked = new Set();

function renderWarmupsTab(f) {
  const el=document.getElementById('tab-warmups');
  el.innerHTML=`<div class="warmups-grid">${renderWarmupsTeam(f.home,'home')}${renderWarmupsTeam(f.away,'away')}</div>`;
  el.querySelectorAll('.warmups-player-card[data-player-id]').forEach(card=>{
    if(warmupsChecked.has(Number(card.dataset.playerId))) card.classList.add('checked-off');
    card.addEventListener('click',()=>{ const id=Number(card.dataset.playerId); warmupsChecked.has(id)?warmupsChecked.delete(id):warmupsChecked.add(id); card.classList.toggle('checked-off'); });
  });
}

function renderWarmupsTeam(team, side) {
  const primary=team.colors.primary, secondary=team.colors.secondary||'#ffffff';
  const color=primary;
  const inSquad=team.squad.filter(p=>p.formationField!==undefined);
  const showSquad=inSquad.length?inSquad:team.squad;
  const starters=showSquad.filter(p=>p.formationField), bench=showSquad.filter(p=>!p.formationField);
  const mgr=team.manager||{};
  const mgrImg=mgr.image
    ?`<img src="${esc(mgr.image)}" style="border-radius:50%;border:3px solid var(--${side}-primary);flex-shrink:0;width:56px;height:56px;object-fit:cover" alt="${esc(mgr.name)}">`
    :`<img src="${avatarSVG(mgr.name||'Manager',color,56)}" style="border-radius:50%;border:3px solid var(--${side}-primary);flex-shrink:0" width="56" height="56" alt="">`;

  const playerCard=(p,isSub=false)=>{
    const surname=(p.name||'').split(' ').pop(), imgSrc=playerImg(p,color,80);
    const numEl=p.shirtNumber
      ? (isSub
          ? `<div class="warmups-player-number-big">${p.shirtNumber}</div>`
          : `<div class="warmups-player-num-pill" style="background:var(--${side}-primary);color:var(--${side}-text-on)">${p.shirtNumber}</div>`)
      : '';
    const nsClass = (p.isNewSigning && isNewSigningPeriod()) ? ' new-signing' : '';
    const nsBadge = (p.isNewSigning && isNewSigningPeriod()) ? `<span class="new-signing-badge">New</span><div class="new-signing-bar"></div>` : '';
    return `<div class="warmups-player-card${isSub?' sub':''}${nsClass}" data-player-id="${p.id}">
      <div class="warmups-player-img player-img-bg" style="background:var(--${side}-primary)">
        <img src="${imgSrc}" style="width:100%;height:100%;display:block;object-fit:cover" alt="" onerror="this.style.display='none'">
        ${nsBadge}
      </div>
      <div class="warmups-player-name-wrap">
        <div class="warmups-player-name">${esc(surname)}</div>
        ${numEl}
      </div>
    </div>`;
  };

  return `<div class="warmups-team-section">
    <div class="warmups-team-header">
      ${teamBadge(team,44)}
      <div><div class="warmups-team-name">${esc(team.name)}</div><div style="font-size:13px;color:var(--text-3)">${esc(mgr.name||'TBC')}</div></div>
      ${mgrImg}
    </div>
    <div class="warmups-section-label">Starting XI</div>
    <div class="warmups-xi-grid">${starters.map(p=>playerCard(p,false)).join('')||'<p class="notes-empty">No lineup yet.</p>'}</div>
    ${bench.length?`<div class="warmups-section-label" style="margin-top:16px">Substitutes</div><div class="warmups-subs-grid">${bench.map(p=>playerCard(p,true)).join('')}</div>`:''}
  </div>`;
}


// ════════════════════════════════════════════════════════
// LEAGUE TABLE TAB
// ════════════════════════════════════════════════════════

function renderTableTab(f) {
  const el=document.getElementById('tab-table');
  if (!f.standings||!f.standings.length) {
    el.innerHTML=`<div style="padding:32px;text-align:center;color:var(--text-3)"><p>${f.standingsLoaded ? 'No standings data available yet.' : 'Standings loading…'}</p></div>`;
    return;
  }
  const rows=f.standings.map(row=>{
    const isHome=row.teamId===f.home.id, isAway=row.teamId===f.away.id;
    const hl=isHome?'table-row-home':isAway?'table-row-away':'';
    return `<tr class="table-row ${hl}">
      <td class="table-pos">${row.position}</td>
      <td class="table-club">
        <span style="display:inline-flex;align-items:center;width:20px;height:20px;margin-right:6px;vertical-align:middle;flex-shrink:0">${teamBadge({id:row.teamId,name:row.teamName,badge:row.badge,colors:row.colors},20)}</span>
        <span>${esc(row.shortName||row.teamName)}</span>
      </td>
      <td>${row.played}</td><td>${row.won}</td><td>${row.drawn}</td><td>${row.lost}</td>
      <td>${row.gf}</td><td>${row.ga}</td>
      <td>${row.gd>=0?'+'+row.gd:row.gd}</td>
      <td class="table-pts">${row.points}</td>
    </tr>`;
  }).join('');
  el.innerHTML=`<div class="table-wrap">
    <div class="table-comp-label">${esc(f.comp)} — ${SEASON_LABEL}</div>
    <table class="standings-table">
      <thead><tr>
        <th class="table-pos">#</th><th class="table-club" style="text-align:left">Club</th>
        <th title="Played">P</th><th title="Won">W</th><th title="Drawn">D</th><th title="Lost">L</th>
        <th title="Goals for">GF</th><th title="Goals against">GA</th><th title="Goal difference">GD</th>
        <th class="table-pts" title="Points">Pts</th>
      </tr></thead>
      <tbody>${rows}</tbody>
    </table>
  </div>`;
}


// ════════════════════════════════════════════════════════
// FULL SQUADS TAB
// ════════════════════════════════════════════════════════

const squadSort = { home:'number', away:'number' };

// ════════════════════════════════════════════════════════
// PLAYER MODAL
// ════════════════════════════════════════════════════════

function openPlayerModal(squadPlayer, statPlayer, team) {
  const overlay = document.getElementById('player-modal');
  const hero    = document.getElementById('player-modal-hero');
  const photo   = document.getElementById('player-modal-photo');
  const badge   = document.getElementById('player-modal-badge');
  const nameEl  = document.getElementById('player-modal-name');
  const metaEl  = document.getElementById('player-modal-meta');
  const statsEl = document.getElementById('player-modal-stats');

  const primary   = team.colors?.primary   || '#333333';
  const secondary = team.colors?.secondary || '#FFFFFF';
  const textColor = textForBg(primary);

  hero.style.background = primary;
  hero.style.color       = textColor;

  // Photo — prefer API image_path, else playerImg fallback
  const imgSrc = statPlayer?.image || playerImg(squadPlayer, primary, 90);
  photo.src    = imgSrc;
  photo.alt    = squadPlayer.name || '';
  photo.onerror = () => { photo.src = avatarSVG(squadPlayer.name || '?', primary, 90); };

  badge.innerHTML = teamBadge(team, 32);

  nameEl.textContent = squadPlayer.name || statPlayer?.name || '';

  const num = statPlayer?.number ?? squadPlayer.shirtNumber ?? null;
  const pos = statPlayer?.position ?? POS[squadPlayer.position] ?? (isNaN(squadPlayer.position) ? squadPlayer.position : '') ?? '';
  const dob = statPlayer?.dob || squadPlayer.dob || null;
  const age = dob ? Math.floor((Date.now() - new Date(dob)) / (365.25 * 24 * 3600 * 1000)) : null;
  metaEl.innerHTML = [
    num != null ? `<span class="player-modal-num" style="background:${secondary};color:${textForBg(secondary)}">${num}</span>` : '',
    pos         ? `<span class="player-modal-pos">${esc(pos)}</span>` : '',
    age         ? `<span class="player-modal-age">${age} yrs</span>` : '',
  ].filter(Boolean).join('');

  if (statPlayer) {
    const rows = [
      { label:'Apps',         val: statPlayer.apps },
      { label:'Starts',       val: statPlayer.starts },
      { label:'Mins',         val: statPlayer.minutes },
      { label:'Goals',        val: statPlayer.goals },
      { label:'Assists',      val: statPlayer.assists },
      { label:'Yellows',      val: statPlayer.yellows },
      { label:'Key Passes',   val: statPlayer.keyPasses },
      { label:'Tackles',      val: statPlayer.tackles },
      { label:'Interceptions',val: statPlayer.interceptions },
      { label:'Pass Acc %',   val: statPlayer.passAcc    != null ? `${statPlayer.passAcc}%` : null },
      { label:'Big Chances',  val: statPlayer.bigChances },
      { label:'Rating',       val: statPlayer.rating     != null ? Number(statPlayer.rating).toFixed(1) : null },
    ].filter(r => r.val !== null && r.val !== undefined);

    statsEl.innerHTML = rows.length
      ? `<div class="player-stat-grid">${rows.map(r =>
          `<div class="player-stat-item">
            <div class="player-stat-val">${esc(String(r.val))}</div>
            <div class="player-stat-label">${esc(r.label)}</div>
          </div>`).join('')}</div>`
      : `<p class="notes-empty" style="padding:20px 24px">No season stats available.</p>`;
  } else {
    statsEl.innerHTML = `<p class="notes-empty" style="padding:20px 24px">No season stats available.</p>`;
  }

  overlay.hidden = false;
}

function closePlayerModal() {
  document.getElementById('player-modal').hidden = true;
}

// ════════════════════════════════════════════════════════
// STATS TAB
// ════════════════════════════════════════════════════════

function renderStatsTab(f) {
  const el = document.getElementById('tab-stats');
  if (!f) { el.innerHTML = '<p class="notes-empty" style="padding:24px">No fixture loaded.</p>'; return; }

  const standings = f.standings || [];
  const homeRow   = standings.find(s => s.teamId === f.home.id);
  const awayRow   = standings.find(s => s.teamId === f.away.id);

  el.innerHTML = `
    <div class="stats-layout">
      ${renderStatsPositionBar(f, homeRow, awayRow)}
      <div class="stats-two-col">
        ${renderStatsTeamColumn(f, 'home', homeRow)}
        ${renderStatsTeamColumn(f, 'away', awayRow)}
      </div>
      ${renderStatsRefereeCard(f)}
      ${renderStatsMatchFacts(f)}
    </div>
  `;
}

// ── League position header bar ────────────────────────────
function renderStatsPositionBar(f, homeRow, awayRow) {
  const posBlock = (team, row) => {
    if (!row) return `<div class="stats-pos-block"><span class="stats-pos-num">—</span><span class="stats-pos-name">${esc(team.name)}</span></div>`;
    const gdStr = row.gd >= 0 ? `+${row.gd}` : `${row.gd}`;
    return `
      <div class="stats-pos-block">
        <span class="stats-pos-num" style="color:${row.colors?.primary||'inherit'}">${ordinal(row.position)}</span>
        <span class="stats-pos-name">${esc(team.name)}</span>
        <span class="stats-pos-meta">${row.points} pts · GD ${gdStr} · P${row.played}</span>
      </div>`;
  };
  return `
    <div class="stats-pos-bar section-card">
      <div class="section-card-header"><span class="section-title">League Standing</span></div>
      <div class="section-card-body stats-pos-row">
        ${posBlock(f.home, homeRow)}
        <span class="stats-pos-vs">vs</span>
        ${posBlock(f.away, awayRow)}
      </div>
    </div>`;
}

// ── Per-team stats column ────────────────────────────────
function renderStatsTeamColumn(f, side, row) {
  const team    = f[side];
  const primary = team.colors?.primary || '#333';

  // Season squares — form array, oldest first for chronological order
  const formChron = [...(team.form || [])].reverse();
  const squares = formChron.length
    ? formChron.map(m => {
        const bg = m.result === 'W' ? '#22c55e' : m.result === 'D' ? '#EAB308' : '#ef4444';
        const tooltip = `${m.result} ${m.score} vs ${esc(m.opponent)} (${m.home ? 'H' : 'A'}) · ${m.date ? fmtShortDate(m.date) : ''}`;
        return `<span class="stats-sq" style="background:${bg}" title="${tooltip}"></span>`;
      }).join('')
    : '<span class="notes-empty" style="font-size:12px">No form data</span>';

  // Goals & conceded per game with league rank
  const leagueRanks = computeLeagueRanks(f.standings || []);
  const played   = row?.played || 0;
  const gf       = row?.gf ?? null;
  const ga       = row?.ga ?? null;
  const gfPer90  = played && gf !== null ? (gf / played).toFixed(2) : null;
  const gaPer90  = played && ga !== null ? (ga / played).toFixed(2) : null;
  const gfRank   = leagueRanks.gfRank?.[team.id];
  const gaRank   = leagueRanks.gaRank?.[team.id];
  const teamSize = f.standings?.length || null;

  const rankBadge = (rank, total, lowerIsBetter = false) => {
    if (!rank || !total) return '';
    const cls = rank <= Math.ceil(total / 3) ? (lowerIsBetter ? 'rank-bad' : 'rank-good')
              : rank >= Math.floor(2 * total / 3) ? (lowerIsBetter ? 'rank-good' : 'rank-bad')
              : 'rank-mid';
    return `<span class="stats-rank ${cls}">${ordinal(rank)} of ${total}</span>`;
  };

  // Home/away split from standings details
  const homeWon  = row ? (f.standings.find(s => s.teamId === team.id)?.won  || 0) : null;
  // Build home/away split from form array
  const homeForm = (team.form || []).filter(m => m.home);
  const awayForm = (team.form || []).filter(m => !m.home);
  const splitBar = renderHomeAwaySplit(homeForm, awayForm, primary);

  // Clean sheets from form
  const cleanSheets = (team.form || []).filter(m => {
    if (m.home) return m.score && m.score.split(/[–\-]/)[1] === '0';
    return m.score && m.score.split(/[–\-]/)[0] === '0';
  }).length;

  // Current form streak
  const streak = computeStreak(team.form || []);

  // Top players by stat from squadStats map
  const topGoals    = topPlayersBy(team.squadStats, 'goals',    3);
  const topAssists  = topPlayersBy(team.squadStats, 'assists',  3);
  const topRating   = topPlayersBy(team.squadStats, 'rating',   3);
  const topYellows  = topPlayersBy(team.squadStats, 'yellows',  3);
  const topKeyPasses= topPlayersBy(team.squadStats, 'keyPasses',3);

  const hasPlayerStats = topGoals.length || topAssists.length;

  return `
    <div class="stats-team-col">
      <div class="stats-team-header" style="background:var(--${side}-primary);color:var(--${side}-text-on)">
        <img src="${teamBadgeSrc(team, 28)}" width="28" height="28" style="border-radius:2px" onerror="this.style.display='none'">
        <span>${esc(team.name)}</span>
      </div>

      <div class="stats-section">
        <div class="stats-section-label">Form (oldest → newest)</div>
        <div class="stats-squares">${squares}</div>
      </div>

      ${played ? `
      <div class="stats-section">
        <div class="stats-section-label">Goals &amp; Conceded per game</div>
        <div class="stats-pill-row">
          <div class="stats-pill">
            <span class="stats-pill-val" style="color:${primary}">${gfPer90 ?? '—'}</span>
            <span class="stats-pill-label">Scored/game</span>
            ${rankBadge(gfRank, teamSize)}
          </div>
          <div class="stats-pill">
            <span class="stats-pill-val" style="color:${primary}">${gaPer90 ?? '—'}</span>
            <span class="stats-pill-label">Conceded/game</span>
            ${rankBadge(gaRank, teamSize, true)}
          </div>
        </div>
      </div>` : ''}

      <div class="stats-section">
        <div class="stats-section-label">Home / Away split (last 5)</div>
        ${splitBar}
      </div>

      <div class="stats-section">
        <div class="stats-pill-row">
          <div class="stats-pill">
            <span class="stats-pill-val" style="color:${visibleOnWhite(primary)}">${cleanSheets}</span>
            <span class="stats-pill-label">Clean sheets</span>
          </div>
          <div class="stats-pill">
            <span class="stats-pill-val" style="color:${visibleOnWhite(primary)}">${streak.label}</span>
            <span class="stats-pill-label">Current run</span>
          </div>
        </div>
      </div>

      ${hasPlayerStats ? `
      <div class="stats-section">
        <div class="stats-section-label">Season player stats</div>
        ${renderPlayerStatTable('Goals', topGoals, 'goals', primary)}
        ${renderPlayerStatTable('Assists', topAssists, 'assists', primary)}
        ${renderPlayerStatTable('Rating', topRating, 'rating', primary)}
        ${renderPlayerStatTable('Yellows', topYellows, 'yellows', primary)}
        ${renderPlayerStatTable('Key passes', topKeyPasses, 'keyPasses', primary)}
      </div>` : `
      <div class="stats-section">
        <p class="notes-empty" style="font-size:12px">Season player stats unavailable — pre-season or new season.</p>
      </div>`}
    </div>`;
}

// ── Home/away split stacked bars ─────────────────────────
function renderHomeAwaySplit(homeForm, awayForm, color) {
  const makeBar = (matches, label) => {
    const total = matches.length;
    if (!total) return `<div class="ha-row"><span class="ha-label">${label}</span><span class="notes-empty" style="font-size:11px">No data</span></div>`;
    const w = matches.filter(m => m.result === 'W').length;
    const d = matches.filter(m => m.result === 'D').length;
    const l = matches.filter(m => m.result === 'L').length;
    const pct = n => Math.round((n / total) * 100);
    const segments = [
      w ? `<span class="ha-seg ha-w" style="width:${pct(w)}%" title="${w}W">${w}</span>` : '',
      d ? `<span class="ha-seg ha-d" style="width:${pct(d)}%" title="${d}D">${d}</span>` : '',
      l ? `<span class="ha-seg ha-l" style="width:${pct(l)}%" title="${l}L">${l}</span>` : '',
    ].join('');
    return `
      <div class="ha-row">
        <span class="ha-label">${label}</span>
        <div class="ha-bar">${segments}</div>
        <span class="ha-counts">${w}W ${d}D ${l}L</span>
      </div>`;
  };
  return `<div class="ha-split">${makeBar(homeForm, 'Home')}${makeBar(awayForm, 'Away')}</div>`;
}

// ── Referee card ─────────────────────────────────────────
function renderStatsRefereeCard(f) {
  const ref = f.referee;
  if (!ref) return '';
  const fmt1 = v => v !== null && v !== undefined ? v.toFixed(2) : '—';
  const photoHtml = ref.image
    ? `<img src="${esc(ref.image)}" class="ref-photo" alt="${esc(ref.name)}" onerror="this.style.display='none'">`
    : `<div class="ref-photo ref-photo-placeholder">${esc((ref.name||'R').split(' ').map(w=>w[0]).join('').slice(0,2).toUpperCase())}</div>`;
  return `
    <div class="section-card stats-ref-card">
      <div class="section-card-header">
        <div class="ref-header">
          ${photoHtml}
          <div>
            <span class="section-title">Referee — ${esc(ref.name)}</span>
            ${ref.matches ? `<div class="text-muted text-sm" style="margin-top:2px">${ref.matches} matches this season</div>` : ''}
          </div>
        </div>
      </div>
      <div class="section-card-body">
        <div class="stats-pill-row stats-pill-row--wide">
          <div class="stats-pill"><span class="stats-pill-val">${fmt1(ref.yellows)}</span><span class="stats-pill-label">Yellows/game</span></div>
          <div class="stats-pill"><span class="stats-pill-val">${fmt1(ref.reds)}</span><span class="stats-pill-label">Reds/game</span></div>
          <div class="stats-pill"><span class="stats-pill-val">${fmt1(ref.yellowReds)}</span><span class="stats-pill-label">Y-Reds/game</span></div>
          <div class="stats-pill"><span class="stats-pill-val">${fmt1(ref.fouls)}</span><span class="stats-pill-label">Fouls/game</span></div>
          <div class="stats-pill"><span class="stats-pill-val">${fmt1(ref.penalties)}</span><span class="stats-pill-label">Pens/game</span></div>
        </div>
      </div>
    </div>`;
}

// ── Match Facts insights ──────────────────────────────────
function renderStatsMatchFacts(f) {
  const facts = f.matchFacts;
  if (!facts || !facts.length) return '';

  // Score and pick top 6 from a group, preferring streaks over statistics,
  // and alternating home/away to keep balance.
  const pickBest = (arr, n = 6) => {
    const scored = arr.map(mf => ({
      ...mf,
      _score: (mf.category === 'streaks' ? 2 : 0) + (mf.participant !== 'both' ? 1 : 0),
    })).sort((a, b) => b._score - a._score);

    // Home top 3, then away top 3, then 'both' to fill
    const home = scored.filter(m => m.participant === 'home').slice(0, 3);
    const away = scored.filter(m => m.participant === 'away').slice(0, 3);
    const both = scored.filter(m => m.participant === 'both');
    return [...home, ...away, ...both].slice(0, n);
  };

  // Group by basis: h2h first, then overall/form
  const h2hFacts  = pickBest(facts.filter(mf => mf.basis === 'h2h'));
  const formFacts = pickBest(facts.filter(mf => mf.basis !== 'h2h'));

  const factsList = arr => arr.map(mf => {
    const tag = mf.participant === 'home' ? `<span class="mf-tag mf-tag--home">${esc(f.home.tla||'H')}</span>`
              : mf.participant === 'away' ? `<span class="mf-tag mf-tag--away">${esc(f.away.tla||'A')}</span>`
              : '';
    return `<li class="mf-item">${tag}${esc(mf.text)}</li>`;
  }).join('');

  return `
    <div class="section-card stats-facts-card">
      <div class="section-card-header"><span class="section-title">Match Insights</span></div>
      <div class="section-card-body">
        ${h2hFacts.length ? `<div class="mf-group-label">Head to Head</div><ul class="mf-list">${factsList(h2hFacts)}</ul>` : ''}
        ${formFacts.length ? `<div class="mf-group-label">Recent Form</div><ul class="mf-list">${factsList(formFacts)}</ul>` : ''}
      </div>
    </div>`;
}

// ── Helper: compute league rank for gf and ga ────────────
function computeLeagueRanks(standings) {
  if (!standings.length) return { gfRank: {}, gaRank: {} };
  const gfRank = {}, gaRank = {};
  const sorted_gf = [...standings].sort((a, b) => (b.gf / Math.max(b.played,1)) - (a.gf / Math.max(a.played,1)));
  const sorted_ga = [...standings].sort((a, b) => (a.ga / Math.max(a.played,1)) - (b.ga / Math.max(b.played,1)));
  sorted_gf.forEach((s, i) => { gfRank[s.teamId] = i + 1; });
  sorted_ga.forEach((s, i) => { gaRank[s.teamId] = i + 1; });
  return { gfRank, gaRank };
}

// ── Helper: compute current result streak from form ──────
function computeStreak(form) {
  if (!form.length) return { label: '—' };
  const latest = form[0].result;
  let count = 0;
  for (const m of form) {
    if (m.result === latest) count++;
    else break;
  }
  const word = latest === 'W' ? 'win' : latest === 'D' ? 'draw' : 'loss';
  return { label: `${count} ${word}${count !== 1 ? 's' : ''}` };
}

// ── Helper: top N players by a stat from squadStats Map ──
function topPlayersBy(statsMap, statKey, n) {
  if (!statsMap) return [];
  return [...statsMap.values()]
    .filter(p => p[statKey] !== null && p[statKey] > 0)
    .sort((a, b) => b[statKey] - a[statKey])
    .slice(0, n);
}

// ── Helper: render a small player stat table ─────────────
function renderPlayerStatTable(label, players, statKey, color) {
  if (!players.length) return '';
  const rows = players.map(p => `
    <tr>
      <td class="pst-name">${esc(p.name)}</td>
      <td class="pst-val" style="color:${color}">${statKey === 'rating' ? Number(p[statKey]).toFixed(1) : p[statKey]}</td>
    </tr>`).join('');
  return `
    <div class="pst-block">
      <div class="pst-label">${label}</div>
      <table class="pst-table"><tbody>${rows}</tbody></table>
    </div>`;
}

// ── Helper: team badge src ────────────────────────────────
function teamBadgeSrc(team) {
  if (team.id) return `./data/badges/${team.id}.png`;
  if (team.badge?.cdn) return team.badge.cdn;
  return '';
}

function renderSquadsTab(f) {
  const el=document.getElementById('tab-squads');
  el.innerHTML=`<div class="squads-layout">${renderSquadTeam(f.home,'home')}${renderSquadTeam(f.away,'away')}</div>`;
  el.querySelectorAll('.squad-sort-btn').forEach(btn=>{
    btn.addEventListener('click',()=>{ squadSort[btn.dataset.side]=btn.dataset.sort; renderSquadsTab(f); });
  });
  // Player card click → open stats modal
  el.addEventListener('click', e => {
    const card = e.target.closest('.squad-player-card[data-player-id]');
    if (!card) return;
    const side       = card.dataset.side;
    const playerIdStr = card.dataset.playerId;
    const playerIdNum = Number(playerIdStr);
    const squadPlayer = f[side].squad.find(p => String(p.id) === playerIdStr);
    if (!squadPlayer) return;
    const statPlayer  = f[side].squadStats?.get(playerIdNum) ?? f[side].squadStats?.get(playerIdStr) ?? null;
    openPlayerModal(squadPlayer, statPlayer, f[side]);
  });
  el.querySelectorAll('.squad-add-confirm').forEach(btn=>{
    btn.addEventListener('click',()=>{
      const side=btn.dataset.side;
      const num=parseInt(document.getElementById(`add-${side}-num`).value)||0;
      const name=document.getElementById(`add-${side}-name`).value.trim();
      const pos=document.getElementById(`add-${side}-pos`).value;
      if (!name) return;
      f[side].squad.push({id:Date.now(),name,shirtNumber:num,position:pos,formationField:undefined,_edited:true});
      renderSquadsTab(f);
    });
  });
}

function renderSquadTeam(team, side) {
  const primary=team.colors.primary, secondary=team.colors.secondary||'#ffffff';
  const color=primary;
  const sk=squadSort[side]||'number';
  const sorted=[...team.squad].sort((a,b)=>{
    if(sk==='number') return (a.shirtNumber||99)-(b.shirtNumber||99);
    const sA=(a.name||'').split(' ').pop().toLowerCase(), sB=(b.name||'').split(' ').pop().toLowerCase();
    return sA<sB?-1:sA>sB?1:0;
  });
  const cards=sorted.map(p=>{
    const imgSrc=playerImg(p,color,80);
    const pos = POS[p.position] || (isNaN(p.position) ? p.position : '') || '';
    const nsClass = (p.isNewSigning && isNewSigningPeriod()) ? ' new-signing' : '';
    const nsBadge = (p.isNewSigning && isNewSigningPeriod()) ? `<span class="new-signing-badge">New</span><div class="new-signing-bar"></div>` : '';
    return `<div class="squad-player-card${nsClass}" data-player-id="${p.id}" data-side="${side}">
      <div class="squad-player-img player-img-bg" style="background:var(--${side}-primary)">
        <img src="${imgSrc}" style="width:100%;display:block;aspect-ratio:1;object-fit:cover" alt="" onerror="this.style.display='none'">
        ${nsBadge}
      </div>
      <div class="squad-player-info">
        <div class="squad-player-name">${esc((p.name||'').split(' ').pop())}</div>
        ${p.shirtNumber?`<div class="squad-player-num-pill" style="background:var(--${side}-primary);color:var(--${side}-text-on)">${p.shirtNumber}</div>`:''}
        ${pos?`<div class="squad-player-pos">${esc(pos)}</div>`:''}
      </div>
    </div>`;
  }).join('');
  const addForm=APP.editMode?`<div class="squad-add-form">
    <div class="section-title" style="margin-bottom:10px">Add player</div>
    <div class="squad-add-form-row">
      <div><div class="field-label">#</div><input class="field-input" id="add-${side}-num" type="number" min="1" max="99" placeholder="No."></div>
      <div><div class="field-label">Name</div><input class="field-input" id="add-${side}-name" placeholder="Full name"></div>
      <div><div class="field-label">Pos</div><select class="field-input" id="add-${side}-pos">
        <option>GK</option><option>RB</option><option>CB</option><option>LB</option>
        <option>CM</option><option>DM</option><option>AM</option><option>RW</option><option>LW</option><option>ST</option>
      </select></div>
    </div>
    <div class="squad-add-form-actions"><button class="btn-primary squad-add-confirm" data-side="${side}" style="padding:8px 16px;font-size:13px">Add player</button></div>
  </div>`:'';
  return `<div>
    <div class="squads-team-header">${teamBadge(team,44)}<div><div class="squads-team-name">${esc(team.name)}</div><div style="font-size:13px;color:var(--text-3)">${team.squad.length} players</div></div></div>
    <div class="squad-sort-row">
      <span class="squad-sort-label">Sort</span>
      <button class="squad-sort-btn${sk==='number'?' active':''}" data-side="${side}" data-sort="number">Number</button>
      <button class="squad-sort-btn${sk==='surname'?' active':''}" data-side="${side}" data-sort="surname">Surname</button>
    </div>
    ${addForm}
    <div class="squad-grid">${cards||`<p class="notes-empty">No squad data.</p>`}</div>
  </div>`;
}


// ════════════════════════════════════════════════════════
// EDIT MODE
// ════════════════════════════════════════════════════════

function toggleEditMode() {
  APP.editMode=!APP.editMode;
  document.body.classList.toggle('edit-mode',APP.editMode);
  const btn=document.getElementById('edit-btn');
  btn.classList.toggle('active',APP.editMode);
  btn.innerHTML=`<svg width="15" height="15" viewBox="0 0 15 15" fill="none"><path d="M10.5 1.5L13.5 4.5L5 13H2V10L10.5 1.5Z" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg> ${APP.editMode?'Editing':'Edit'}`;
  switchTab(APP.activeTab);
}


// ════════════════════════════════════════════════════════
// INIT
// ════════════════════════════════════════════════════════

const AUTH_PASSWORD = 'chairboys';
const AUTH_KEY      = 'efl_authed';

async function init() {
  // Auth gate — require password once per session
  if (sessionStorage.getItem(AUTH_KEY) !== '1') {
    showView('auth');
    await new Promise(resolve => {
      const submit = () => {
        const pw = document.getElementById('auth-password').value;
        if (pw === AUTH_PASSWORD) {
          sessionStorage.setItem(AUTH_KEY, '1');
          resolve();
        } else {
          document.getElementById('auth-error').style.display = '';
          document.getElementById('auth-password').value = '';
          document.getElementById('auth-password').focus();
        }
      };
      document.getElementById('auth-submit').addEventListener('click', submit);
      document.getElementById('auth-password').addEventListener('keydown', e => { if (e.key === 'Enter') submit(); });
    });
  }

  await loadAppData();

  const dateInput=document.getElementById('fixture-date');
  dateInput.value=APP.selectedDate;
  dateInput.addEventListener('change',e=>{ APP.selectedDate=e.target.value; renderFixtureList(); });

  document.getElementById('date-prev').addEventListener('click',()=>{
    const d=new Date(APP.selectedDate+'T12:00:00'); d.setDate(d.getDate()-1);
    APP.selectedDate=d.toISOString().slice(0,10); dateInput.value=APP.selectedDate; renderFixtureList();
  });
  document.getElementById('date-next').addEventListener('click',()=>{
    const d=new Date(APP.selectedDate+'T12:00:00'); d.setDate(d.getDate()+1);
    APP.selectedDate=d.toISOString().slice(0,10); dateInput.value=APP.selectedDate; renderFixtureList();
  });
  document.getElementById('date-today').addEventListener('click',()=>{
    APP.selectedDate=todayISO(); dateInput.value=APP.selectedDate; renderFixtureList();
  });

  document.getElementById('comp-filter').addEventListener('click',e=>{
    const btn=e.target.closest('.comp-btn'); if(!btn) return;
    document.querySelectorAll('.comp-btn').forEach(b=>b.classList.remove('active'));
    btn.classList.add('active'); APP.compFilter=btn.dataset.comp; renderFixtureList();
  });

  document.getElementById('use-static-data').addEventListener('change',e=>{ APP.useStaticData=e.target.checked; });

  // Refresh fixtures list (re-fetches fixtures.json)
  const refreshFixturesBtn=document.getElementById('refresh-fixtures-btn');
  if (refreshFixturesBtn) {
    refreshFixturesBtn.addEventListener('click',async()=>{
      refreshFixturesBtn.disabled=true; refreshFixturesBtn.textContent='Refreshing…';
      await loadAppData(true);
      renderFixtureList();
      refreshFixturesBtn.disabled=false; refreshFixturesBtn.textContent='Refresh fixtures';
    });
  }

  // Create fixture modal — with team autocomplete
  const COMP_CODE_MAP = { 'Championship':'ELC', 'League One':'EL1', 'League Two':'EL2' }; // cup comps allow any team

  // Build team side object from teams.json entry (or fallback from raw text)
  function teamCardSide(t, fallbackName, fallbackId) {
    if (t) return {
      id: Number(t.id),
      name: t.name,
      shortName: t.shortName || t.name.split(' ')[0],
      tla: t.tla || t.name.slice(0,3).toUpperCase(),
      colors: t.colors || { primary:'#333', secondary:'#FFF' },
      badge: t.badge || {},
      position: 0,
    };
    return {
      id: fallbackId,
      name: fallbackName,
      shortName: fallbackName.split(' ')[0],
      tla: fallbackName.slice(0,3).toUpperCase(),
      colors: { primary:'#333', secondary:'#FFF' },
      badge: {},
      position: 0,
    };
  }

  // Autocomplete widget — wires input + dropdown, calls onSelect(teamObj) when chosen
  function initTeamAutocomplete(inputId, dropdownId) {
    const input = document.getElementById(inputId);
    const drop  = document.getElementById(dropdownId);
    let selected = null; // teams.json object or null

    function getCompCode() {
      const comp = document.getElementById('custom-comp').value;
      return COMP_CODE_MAP[comp] || null; // null = all teams (cup)
    }

    function getCandidates(query) {
      const compCode = getCompCode();
      const q = query.toLowerCase();
      return Object.values(APP.teamsData || {}).filter(t => {
        if (compCode && t.comp !== compCode) return false;
        return t.name.toLowerCase().includes(q) || (t.shortName||'').toLowerCase().includes(q) || (t.tla||'').toLowerCase().includes(q);
      }).sort((a,b) => a.name.localeCompare(b.name)).slice(0, 8);
    }

    function renderDrop(teams) {
      drop.innerHTML = '';
      if (!teams.length) { drop.setAttribute('hidden',''); return; }
      teams.forEach(t => {
        const item = document.createElement('div');
        item.className = 'autocomplete-item';
        item.innerHTML = `
          <img class="ac-badge" src="./data/badges/${t.id}.png" onerror="this.style.display='none'">
          <span class="ac-name">${t.name}</span>
          <span class="ac-tla">${t.tla||''}</span>`;
        item.addEventListener('mousedown', e => {
          e.preventDefault(); // don't blur input before click fires
          selected = t;
          input.value = t.name;
          drop.setAttribute('hidden','');
        });
        drop.appendChild(item);
      });
      drop.removeAttribute('hidden');
    }

    input.addEventListener('input', () => {
      selected = null;
      const q = input.value.trim();
      if (q.length < 1) { drop.setAttribute('hidden',''); return; }
      renderDrop(getCandidates(q));
    });

    input.addEventListener('blur', () => {
      setTimeout(() => drop.setAttribute('hidden',''), 150);
    });

    // Reset selection when competition changes
    document.getElementById('custom-comp').addEventListener('change', () => {
      selected = null; input.value = ''; drop.setAttribute('hidden','');
    });

    return { getSelected: () => selected, getValue: () => input.value.trim() };
  }

  const homeAC = initTeamAutocomplete('custom-home', 'custom-home-dropdown');
  const awayAC = initTeamAutocomplete('custom-away', 'custom-away-dropdown');

  document.getElementById('create-fixture-btn').addEventListener('click',()=>{
    document.getElementById('custom-date').value=APP.selectedDate;
    document.getElementById('custom-home').value='';
    document.getElementById('custom-away').value='';
    document.getElementById('create-fixture-modal').removeAttribute('hidden');
    document.getElementById('custom-home').focus();
  });
  ['create-fixture-close','create-fixture-cancel'].forEach(id=>{
    document.getElementById(id).addEventListener('click',()=>document.getElementById('create-fixture-modal').setAttribute('hidden',''));
  });
  document.getElementById('create-fixture-modal').addEventListener('click',e=>{ if(e.target===e.currentTarget) e.currentTarget.setAttribute('hidden',''); });
  document.getElementById('create-fixture-confirm').addEventListener('click',()=>{
    const homeTeam = homeAC.getSelected();
    const awayTeam = awayAC.getSelected();
    const homeName = homeAC.getValue();
    const awayName = awayAC.getValue();
    const comp = document.getElementById('custom-comp').value;
    const date = document.getElementById('custom-date').value;
    if (!homeName || !awayName) return;

    const leagueId = Number(Object.entries(COMP_NAME).find(([,v])=>v===comp)?.[0] || 9);

    // Use real venue from home team's teams.json data if available
    const venue     = homeTeam?.venue || 'TBC';
    const venueCity = homeTeam?.location || '';

    const card = {
      id: 'custom_'+Date.now(), date, kickoff:'15:00',
      comp, compShort: COMP_SHORT[leagueId] || comp.slice(0,5).toUpperCase(),
      leagueId, seasonId: SEASON_IDS[leagueId] || null, stateId: 1,
      venue, venueCity, venueSlug: venue.toLowerCase().replace(/\s+/g,'-'),
      home: teamCardSide(homeTeam, homeName, 9001),
      away: teamCardSide(awayTeam, awayName, 9002),
    };
    document.getElementById('create-fixture-modal').setAttribute('hidden','');
    loadFixture(card);
  });

  document.getElementById('back-btn').addEventListener('click',()=>showView('landing'));

  document.getElementById('tab-nav').addEventListener('click',e=>{
    const btn=e.target.closest('.tab-btn'); if(btn) switchTab(btn.dataset.tab);
  });

  document.getElementById('edit-btn').addEventListener('click',toggleEditMode);

  // Refresh match data button (in match header, if present)
  const refreshMatchBtn=document.getElementById('refresh-match-btn');
  if (refreshMatchBtn) refreshMatchBtn.addEventListener('click',()=>refreshFixture());

  // Player modal — close button + backdrop + Escape
  document.getElementById('player-modal-close').addEventListener('click', closePlayerModal);
  document.getElementById('player-modal').addEventListener('click', e => {
    if (e.target === e.currentTarget) closePlayerModal();
  });
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape') {
      if (!document.getElementById('player-modal').hidden) closePlayerModal();
      if (!document.getElementById('transfers-modal').hidden) closeTransfersModal();
    }
  });

  // Transfers modal — open via "View all" button, close via button/backdrop/Escape
  document.addEventListener('click', e => {
    const btn = e.target.closest('.transfers-view-all-btn');
    if (btn) openTransfersModal(btn.dataset.teamId);
  });
  document.getElementById('transfers-modal-close').addEventListener('click', closeTransfersModal);
  document.getElementById('transfers-modal').addEventListener('click', e => {
    if (e.target === e.currentTarget) closeTransfersModal();
  });

  // Manager crop modal
  MgrCrop.init();

  // Click on manager image wrap → open crop modal (edit mode only)
  document.addEventListener('click', e => {
    if (!APP.editMode) return;
    const wrap = e.target.closest('.manager-image-wrap');
    if (!wrap) return;
    const card = wrap.closest('[data-side]');
    if (!card) return;
    const side = card.dataset.side;
    const f = APP.currentFixture;
    if (!f || !f[side]) return;
    MgrCrop.open(f[side].id, side);
  });

  // Kit large wrap click (edit mode) → trigger file input for kit image upload
  document.addEventListener('click', e => {
    if (!APP.editMode) return;
    const wrap = e.target.closest('.kit-large-wrap');
    if (!wrap) return;
    // Don't fire if they clicked the file input itself
    if (e.target.tagName === 'INPUT') return;
    const input = wrap.querySelector('.kit-upload-input');
    if (input) input.click();
  });

  // Kit image file selected → upload
  document.addEventListener('change', async e => {
    const input = e.target.closest('.kit-upload-input');
    if (!input) return;
    const file = input.files?.[0];
    if (!file) return;
    const wrap   = input.closest('.kit-large-wrap');
    if (!wrap) return;
    const side   = wrap.dataset.side;
    const teamId = wrap.dataset.team;
    // Use whichever kit is currently active
    const kit    = APP.currentFixture?.[side]?.kits?.active || wrap.dataset.kit;
    const overlay = wrap.querySelector('.kit-upload-overlay');
    if (overlay) overlay.textContent = 'Uploading…';
    const ok = await uploadKitImage(teamId, kit, side, file);
    if (overlay) overlay.textContent = ok ? '✓ Uploaded' : '📁 Upload kit';
    setTimeout(() => { if (overlay) overlay.textContent = '📁 Upload kit'; }, 2000);
    // Reset input so the same file can be re-selected if needed
    input.value = '';
  });

  // Kit swatch click → switch large kit display + update colour editor
  document.addEventListener('click', e => {
    const swatch = e.target.closest('.kit-swatch');
    if (!swatch) return;
    const side = swatch.dataset.side;
    const kit  = swatch.dataset.kit;
    const f    = APP.currentFixture;
    if (!f || !f[side]) return;

    // Update active swatch
    document.querySelectorAll(`.kit-swatch[data-side="${side}"]`).forEach(s => s.classList.remove('active'));
    swatch.classList.add('active');

    // Update large kit image (prefer R2 override URL if available)
    const largeImg = document.getElementById(`kit-large-${side}`);
    if (largeImg) {
      largeImg.src = f[side].kits?.[kit]?.imageUrl || `./data/kits/${f[side].id}-${kit}.png`;
      largeImg.style.display = '';
    }
    // Keep the upload wrap's data-kit in sync so uploads target the right kit
    const kitWrap = document.getElementById(`kit-large-wrap-${side}`);
    if (kitWrap) kitWrap.dataset.kit = kit;

    // Persist selection in fixture
    if (f[side].kits) f[side].kits.active = kit;

    // Update CSS vars immediately using the same colour logic as the swatch dots,
    // so whatever colour the dots show is exactly what gets applied site-wide.
    {
      const kitData   = f[side].kits?.[kit] || {};
      const fallbackPc = f[side].colors?.primary   || '#333333';
      const fallbackSc = f[side].colors?.secondary || '#FFFFFF';
      const kitPrimary   = kitData.colors?.primary   || kitData.primary   || fallbackPc;
      const kitSecondary = kitData.colors?.secondary || kitData.secondary || fallbackSc;
      const r = document.documentElement;
      r.style.setProperty(`--${side}-primary`,   kitPrimary);
      r.style.setProperty(`--${side}-secondary`, kitSecondary);
      r.style.setProperty(`--${side}-text`,      visibleOnWhite(kitPrimary));
      r.style.setProperty(`--${side}-text-on`,   textForBg(kitPrimary));
    }

    // Update colour editor if in edit mode — now works for all kits including home
    const editor = document.getElementById(`kit-color-editor-${side}`);
    if (editor) {
      editor.style.display = 'flex';
      editor.dataset.kit = kit;
      const kitData    = f[side].kits?.[kit] || {};
      const hasOwn     = !!(kitData.colors?.primary || kitData.primary);
      const fallbackPc = kit === 'home' ? (f[side].colors?.primary   || '#000000') : '#1a1a1a';
      const fallbackSc = kit === 'home' ? (f[side].colors?.secondary || '#ffffff')  : '#ffffff';
      const pc = hasOwn ? (kitData.colors?.primary   || kitData.primary)   : fallbackPc;
      const sc = hasOwn ? (kitData.colors?.secondary || kitData.secondary) : fallbackSc;
      editor.querySelector('[data-role="primary"]').value   = pc;
      editor.querySelector('[data-role="secondary"]').value = sc;
    }
  });

  // Kit colour editor — live dot preview + save to KV
  document.addEventListener('input', e => {
    const input = e.target.closest('.kit-color-input');
    if (!input) return;
    const editor  = input.closest('.kit-color-editor');
    if (!editor) return;
    const side    = editor.dataset.side;
    const kit     = editor.dataset.kit || document.querySelector(`.kit-swatch.active[data-side="${side}"]`)?.dataset.kit;
    if (!kit) return;
    const pc = editor.querySelector('[data-role="primary"]').value;
    const sc = editor.querySelector('[data-role="secondary"]').value;
    // Update dots live
    const dotsEl = document.querySelector(`[data-kit-dots="${side}-${kit}"]`);
    if (dotsEl) {
      const d = dotsEl.querySelectorAll('.kit-dot');
      if (d[0]) d[0].style.background = pc;
      if (d[1]) d[1].style.background = sc;
    }
    // If this is the active kit, update CSS vars live so pills change in real time
    const f = APP.currentFixture;
    if (f?.[side]?.kits?.active === kit) {
      const prop = side === 'home' ? '--home-primary' : '--away-primary';
      const propS = side === 'home' ? '--home-secondary' : '--away-secondary';
      const propT = side === 'home' ? '--home-text' : '--away-text';
      document.documentElement.style.setProperty(prop, pc);
      document.documentElement.style.setProperty(propS, sc);
      document.documentElement.style.setProperty(propT, visibleOnWhite(pc));
    }
  });

  document.addEventListener('click', async e => {
    const btn = e.target.closest('.kit-color-save');
    if (!btn) return;
    const editor  = btn.closest('.kit-color-editor');
    if (!editor) return;
    const side    = editor.dataset.side;
    const teamId  = editor.dataset.team;
    const kit     = document.querySelector(`.kit-swatch.active[data-side="${side}"]`)?.dataset.kit;
    if (!kit) return;
    const pc = editor.querySelector('[data-role="primary"]').value;
    const sc = editor.querySelector('[data-role="secondary"]').value;

    btn.textContent = 'Saving…'; btn.disabled = true;
    try {
      await fetch(`${WORKER}/overrides/kit-colors:${teamId}:${kit}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ primary: pc, secondary: sc }),
      });
      // Update in-memory fixture
      const f = APP.currentFixture;
      if (f?.[side]?.kits?.[kit]) {
        f[side].kits[kit].colors = { primary: pc, secondary: sc };
      }
      // For home kit, also update team.colors (the base used everywhere as fallback)
      if (kit === 'home' && f?.[side]) {
        f[side].colors = { ...f[side].colors, primary: pc, secondary: sc };
        // Update manager ring colour live
        const managerWrap = document.querySelector(`.manager-card[data-side="${side}"] .manager-image-wrap`);
        const newAccent = hexBrightness(pc) > 200 ? sc : pc;
        if (managerWrap) managerWrap.style.borderColor = newAccent;
      }
      // Re-apply CSS vars so pill colours update immediately
      setTeamCSSVars(f);
      // Remove "not set" label and fix dots on the swatch now that colours are saved
      const swatch = document.querySelector(`.kit-swatch[data-side="${side}"][data-kit="${kit}"]`);
      if (swatch) {
        const unsetLabel = swatch.querySelector('.kit-label-unset');
        if (unsetLabel) unsetLabel.remove();
        const dotsEl = swatch.querySelector(`[data-kit-dots="${side}-${kit}"]`);
        if (dotsEl) {
          dotsEl.querySelectorAll('.kit-dot').forEach(d => d.classList.remove('kit-dot-unset'));
        }
      }
      btn.textContent = 'Saved ✓';
      setTimeout(() => { btn.textContent = 'Save'; btn.disabled = false; }, 1500);
    } catch(err) {
      alert('Save failed: ' + err.message);
      btn.textContent = 'Save'; btn.disabled = false;
    }
  });

  // Manager name save
  document.addEventListener('click', async e => {
    const btn = e.target.closest('.manager-name-save');
    if (!btn) return;
    const side   = btn.dataset.side;
    const teamId = btn.dataset.team;
    const input  = document.querySelector(`.manager-name-input[data-side="${side}"]`);
    if (!input) return;
    const name = input.value.trim();
    btn.textContent = 'Saving…'; btn.disabled = true;
    try {
      await fetch(`${WORKER}/overrides/manager-name:${teamId}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(name),
      });
      const f = APP.currentFixture;
      if (f?.[side]?.manager) f[side].manager.name = name;
      // Update teamsData so it persists within session
      if (APP.teamsData[String(teamId)]?.manager) APP.teamsData[String(teamId)].manager.name = name;
      btn.textContent = 'Saved ✓';
      setTimeout(() => { btn.textContent = 'Save'; btn.disabled = false; }, 1500);
    } catch(err) {
      alert('Save failed: ' + err.message);
      btn.textContent = 'Save'; btn.disabled = false;
    }
  });

  showView('landing');
  renderLanding();
}

// ════════════════════════════════════════════════════════
// MANAGER IMAGE CROP MODAL
// ════════════════════════════════════════════════════════

const MgrCrop = (() => {
  let _teamId = null, _side = null;
  let _scale = 1, _ox = 0, _oy = 0;
  let _dragging = false, _lastX = 0, _lastY = 0;
  let _imgW = 0, _imgH = 0, _vpSize = 0;

  const modal    = () => document.getElementById('mgr-crop-modal');
  const viewport = () => document.getElementById('mgr-crop-viewport');
  const img      = () => document.getElementById('mgr-crop-img');
  const zoom     = () => document.getElementById('mgr-crop-zoom');
  const saveBtn  = () => document.getElementById('mgr-crop-save');
  const urlInput = () => document.getElementById('mgr-crop-url');

  function open(teamId, side) {
    _teamId = teamId; _side = side;
    _scale = 1; _ox = 0; _oy = 0;
    const el = img(); el.onload = null; el.onerror = null; el.src = '';
    urlInput().value = '';
    saveBtn().disabled = true;
    zoom().value = 1;
    modal().classList.add('open');
  }

  function close() {
    modal().classList.remove('open');
    img().src = '';
  }

  function loadBlob(blobUrl) {
    const el = img();
    el.onerror = null; // clear any previous error handler before setting src
    el.onload = () => {
      _imgW = el.naturalWidth;
      _imgH = el.naturalHeight;
      _vpSize = viewport().offsetWidth;
      const fit = Math.max(_vpSize / _imgW, _vpSize / _imgH);
      _scale = fit;
      zoom().min = fit * 0.5;
      zoom().max = fit * 4;
      zoom().value = _scale;
      _ox = (_vpSize - _imgW * _scale) / 2;
      _oy = (_vpSize - _imgH * _scale) / 2;
      applyTransform();
      saveBtn().disabled = false;
    };
    el.onerror = () => alert('Could not load image.');
    el.src = blobUrl;
  }

  async function loadUrl(url) {
    try {
      // Fetch via Worker to avoid CORS issues — Worker proxies the request
      const res = await fetch(`${WORKER}/images/proxy?url=${encodeURIComponent(url)}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const blob = await res.blob();
      loadBlob(URL.createObjectURL(blob));
    } catch(e) {
      alert('Could not load image from URL: ' + e.message);
    }
  }

  function applyTransform() {
    const el = img();
    el.style.left   = _ox + 'px';
    el.style.top    = _oy + 'px';
    el.style.width  = (_imgW * _scale) + 'px';
    el.style.height = (_imgH * _scale) + 'px';
  }

  function clampOffset() {
    const vp = _vpSize;
    const iw = _imgW * _scale, ih = _imgH * _scale;
    // Don't allow viewport to show empty space if image is larger than viewport
    if (iw >= vp) { _ox = Math.min(0, Math.max(vp - iw, _ox)); }
    if (ih >= vp) { _oy = Math.min(0, Math.max(vp - ih, _oy)); }
  }

  async function save() {
    const vp = viewport();
    _vpSize = vp.offsetWidth;
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = 300;
    const ctx = canvas.getContext('2d');
    // Clip to circle
    ctx.beginPath();
    ctx.arc(150, 150, 150, 0, Math.PI * 2);
    ctx.clip();
    // Scale factor from viewport px → canvas px
    const ratio = 300 / _vpSize;
    ctx.drawImage(img(), _ox * ratio, _oy * ratio, _imgW * _scale * ratio, _imgH * _scale * ratio);

    saveBtn().disabled = true;
    saveBtn().textContent = 'Saving…';

    let blob;
    try {
      blob = await new Promise((resolve, reject) => {
        try {
          canvas.toBlob(b => b ? resolve(b) : reject(new Error('Canvas toBlob returned null — image may be cross-origin. Try uploading a file instead of a URL.')), 'image/png');
        } catch(e) {
          reject(new Error('Canvas is tainted by a cross-origin image. Please use file upload instead of a URL.'));
        }
      });
    } catch(e) {
      alert(e.message);
      saveBtn().disabled = false;
      saveBtn().textContent = 'Save';
      return;
    }

    try {
      // Upload to R2 via Worker
      const path = `coaches/${_teamId}-custom.png`;
      const res = await fetch(`${WORKER}/images/${path}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'image/png' },
        body: blob,
      });
      if (!res.ok) throw new Error(`Worker returned ${res.status}`);

      const imageUrl = `${WORKER}/images/${path}`;

      // Store in KV so it survives re-seeds
      await fetch(`${WORKER}/overrides/manager-image:${_teamId}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(imageUrl),
      });

      // Update in-memory fixture and re-render the manager card
      const f = APP.currentFixture;
      if (f && f[_side]) {
        f[_side].manager = f[_side].manager || {};
        f[_side].manager.image = imageUrl;
        const cardEl = document.querySelector(`.manager-card[data-side="${_side}"] .manager-image-wrap img`);
        if (cardEl) cardEl.src = imageUrl + '?t=' + Date.now();
      }

      close();
    } catch(e) {
      alert('Save failed: ' + e.message);
    } finally {
      saveBtn().disabled = false;
      saveBtn().textContent = 'Save';
    }
  }

  function init() {
    // URL load
    document.getElementById('mgr-crop-url-btn').addEventListener('click', () => {
      const u = urlInput().value.trim();
      if (u) loadUrl(u);
    });
    urlInput().addEventListener('keydown', e => { if (e.key === 'Enter') { const u = urlInput().value.trim(); if (u) loadUrl(u); }});

    // File upload
    document.getElementById('mgr-crop-file-btn').addEventListener('click', () =>
      document.getElementById('mgr-crop-file').click());
    document.getElementById('mgr-crop-file').addEventListener('change', e => {
      const file = e.target.files[0];
      if (file) loadBlob(URL.createObjectURL(file));
    });

    // Zoom slider
    zoom().addEventListener('input', () => {
      const vp = _vpSize = viewport().offsetWidth;
      const cx = vp / 2, cy = vp / 2;
      // Zoom around centre of viewport
      const prevScale = _scale;
      _scale = parseFloat(zoom().value);
      _ox = cx - (_scale / prevScale) * (cx - _ox);
      _oy = cy - (_scale / prevScale) * (cy - _oy);
      clampOffset();
      applyTransform();
    });

    // Scroll to zoom
    viewport().addEventListener('wheel', e => {
      e.preventDefault();
      const vp = _vpSize = viewport().offsetWidth;
      const rect = viewport().getBoundingClientRect();
      const cx = e.clientX - rect.left, cy = e.clientY - rect.top;
      const delta = e.deltaY < 0 ? 1.1 : 0.9;
      const prevScale = _scale;
      _scale = Math.max(parseFloat(zoom().min), Math.min(parseFloat(zoom().max), _scale * delta));
      _ox = cx - (_scale / prevScale) * (cx - _ox);
      _oy = cy - (_scale / prevScale) * (cy - _oy);
      clampOffset();
      zoom().value = _scale;
      applyTransform();
    }, { passive: false });

    // Drag
    viewport().addEventListener('pointerdown', e => {
      _dragging = true; _lastX = e.clientX; _lastY = e.clientY;
      viewport().setPointerCapture(e.pointerId);
    });
    viewport().addEventListener('pointermove', e => {
      if (!_dragging) return;
      _ox += e.clientX - _lastX;
      _oy += e.clientY - _lastY;
      _lastX = e.clientX; _lastY = e.clientY;
      clampOffset();
      applyTransform();
    });
    viewport().addEventListener('pointerup', () => { _dragging = false; });

    // Buttons
    document.getElementById('mgr-crop-cancel').addEventListener('click', close);
    document.getElementById('mgr-crop-save').addEventListener('click', save);
    modal().addEventListener('click', e => { if (e.target === modal()) close(); });
  }

  return { open, init };
})();

// Load KV manager image overrides and apply to teamsData

async function applyCaptainOverride(teamId) {
  try {
    const res = await fetch(`${WORKER}/overrides/captain:${teamId}`);
    if (!res.ok) return null;
    const data = await res.json();
    return typeof data === 'string' && data ? data : null;
  } catch { return null; }
}

async function applyManagerImageOverride(teamId) {
  try {
    const res = await fetch(`${WORKER}/overrides/manager-image:${teamId}`);
    if (!res.ok) return null;
    const data = await res.json();
    return typeof data === 'string' && data ? data : null;
  } catch { return null; }
}

async function applyManagerNameOverride(teamId) {
  try {
    const res = await fetch(`${WORKER}/overrides/manager-name:${teamId}`);
    if (!res.ok) return null;
    const data = await res.json();
    return typeof data === 'string' && data ? data : null;
  } catch { return null; }
}

async function applyKitColorOverrides(team) {
  if (!team?.kits) return;
  for (const kit of ['home', 'away', 'third']) {
    if (!team.kits[kit]) continue;
    try {
      const res = await fetch(`${WORKER}/overrides/kit-colors:${team.id}:${kit}`);
      if (!res.ok) continue;
      const colors = await res.json();
      if (colors?.primary && typeof colors.primary === 'string') {
        team.kits[kit].colors = colors;
        // Home kit overrides also update the base team colours
        if (kit === 'home') team.colors = { ...team.colors, ...colors };
      }
    } catch { /* ignore */ }
  }
}

async function applyKitImageOverrides(team) {
  if (!team?.kits) return;
  for (const kit of ['home', 'away', 'third']) {
    if (!team.kits[kit]) continue;
    try {
      const res = await fetch(`${WORKER}/overrides/kit-image:${team.id}:${kit}`);
      if (!res.ok) continue;
      const url = await res.json();
      if (typeof url === 'string' && url) team.kits[kit].imageUrl = url;
    } catch { /* ignore */ }
  }
}

// Upload a kit image file to R2 and persist the URL in KV.
// Updates the in-memory fixture and refreshes the relevant img elements.
async function uploadKitImage(teamId, kit, side, file) {
  const path = `kits/${teamId}-${kit}.png`;
  try {
    // Upload to R2
    const res = await fetch(`${WORKER}/images/${path}`, {
      method: 'PUT',
      headers: { 'Content-Type': file.type || 'image/png' },
      body: file,
    });
    if (!res.ok) throw new Error(`Upload failed: ${res.status}`);

    const imageUrl = `${WORKER}/images/${path}?t=${Date.now()}`;

    // Persist URL in KV
    await fetch(`${WORKER}/overrides/kit-image:${teamId}:${kit}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(`${WORKER}/images/${path}`),
    });

    // Update in-memory fixture
    const f = APP.currentFixture;
    if (f?.[side]?.kits?.[kit]) f[side].kits[kit].imageUrl = imageUrl;

    // Update visible images immediately — large display and swatch thumbnail
    const largeImg = document.getElementById(`kit-large-${side}`);
    if (largeImg) largeImg.src = imageUrl;

    const swatchImg = document.querySelector(`.kit-swatch[data-side="${side}"][data-kit="${kit}"] .kit-img`);
    if (swatchImg) { swatchImg.src = imageUrl; swatchImg.style.display = ''; }

    // Update the wrap's data-kit in case kit switched
    const wrap = document.getElementById(`kit-large-wrap-${side}`);
    if (wrap) wrap.dataset.kit = kit;

    return true;
  } catch(e) {
    alert('Kit image upload failed: ' + e.message);
    return false;
  }
}

// ════════════════════════════════════════════════════════
// IN-GAME TAB
// ════════════════════════════════════════════════════════

let _inGamePollTimer = null;

function startInGamePolling() {
  stopInGamePolling();
  _inGamePollTimer = setInterval(async () => {
    const f = APP.currentFixture;
    if (!f || APP.activeTab !== 'ingame') { stopInGamePolling(); return; }
    try {
      const raw = await fetchGolden(f.id, true);
      if (raw) { mergeGolden(f, raw); renderInGameTab(f); }
    } catch(e) { console.warn('In-game poll failed:', e); }
  }, 60000);
}

function stopInGamePolling() {
  if (_inGamePollTimer) { clearInterval(_inGamePollTimer); _inGamePollTimer = null; }
}

function renderInGameTab(f) {
  const el = document.getElementById('tab-ingame');
  if (!el) return;

  // ── Scores ──
  const cur = f.scores?.current;
  const hg  = cur?.home ?? '–';
  const ag  = cur?.away ?? '–';

  // Determine match minute from state (best effort — not in golden but useful placeholder)
  const stateLabel = f.lineupConfirmed ? 'Live' : 'Pre-match';

  // ── Build sub map from events ──
  // subMap[playerId] = { minute, side } for players subbed OFF
  // subOnMap[playerId] = { minute, side } for players subbed ON
  const subOffMap = {};
  const subOnMap  = {};
  (f.events || []).filter(e => e.typeId === EV.SUB).forEach(e => {
    const side = e.participantId === f.home.id ? 'home' : 'away';
    subOffMap[String(e.playerId)]        = { minute: e.minute, side };
    subOnMap[String(e.relatedPlayerId)]  = { minute: e.minute, side };
  });

  // ── Build current XI and bench for each side ──
  function buildLineup(team) {
    const squad = team.squad || [];

    // Original starters (formationField is a string like '3:2')
    const originalStarters = squad.filter(p => p.formationField && p.formationField !== 'null');
    // Bench (formationField === null)
    const benchPlayers     = squad.filter(p => p.formationField === null);

    // Current XI: replace any subbed-off starter with their sub-on player
    const currentXI = originalStarters.map(p => {
      const off = subOffMap[String(p.id)];
      if (off) {
        // Find who came on to replace them
        const subOn = squad.find(sq => subOnMap[String(sq.id)]);
        // More precisely: find the sub-on whose entry matches this player's off event
        const subOnEntry = Object.entries(subOnMap).find(([onId, meta]) => {
          // The sub event has playerId=off, relatedPlayerId=on
          const ev = (f.events || []).find(e =>
            e.typeId === EV.SUB && String(e.playerId) === String(p.id) && String(e.relatedPlayerId) === String(onId)
          );
          return !!ev;
        });
        if (subOnEntry) {
          const [onId, meta] = subOnEntry;
          const onPlayer = squad.find(sq => String(sq.id) === onId);
          if (onPlayer) return { ...onPlayer, subMinute: meta.minute };
        }
      }
      return p;
    });

    // Bench: unused bench players + players who were subbed off (with minute)
    const subOnIds = new Set(Object.keys(subOnMap));
    const unusedBench = benchPlayers.filter(p => !subOnIds.has(String(p.id)));
    const subbedOff   = originalStarters
      .filter(p => subOffMap[String(p.id)])
      .map(p => ({ ...p, subOffMinute: subOffMap[String(p.id)].minute }));

    return { xi: currentXI, bench: [...subbedOff, ...unusedBench] };
  }

  const home = buildLineup(f.home);
  const away = buildLineup(f.away);

  // ── Stats rows ──
  const S = (side, id) => {
    const v = f[side]?.stats?.[id];
    return (v != null && v !== '') ? v : '–';
  };
  const statRows = [
    { label: 'Possession',    hv: S('home',45),  av: S('away',45),  hPct: () => { const h=parseFloat(S('home',45)); return isNaN(h)?50:h; } },
    { label: 'Shots',         hv: S('home',42),  av: S('away',42),  hPct: () => { const h=parseFloat(S('home',42)),a=parseFloat(S('away',42)); return (!isNaN(h)&&!isNaN(a)&&(h+a)>0)?Math.round(h/(h+a)*100):50; } },
    { label: 'On target',     hv: S('home',86),  av: S('away',86),  hPct: () => { const h=parseFloat(S('home',86)),a=parseFloat(S('away',86)); return (!isNaN(h)&&!isNaN(a)&&(h+a)>0)?Math.round(h/(h+a)*100):50; } },
    { label: 'Big chances',   hv: S('home',580), av: S('away',580), hPct: () => { const h=parseFloat(S('home',580)),a=parseFloat(S('away',580)); return (!isNaN(h)&&!isNaN(a)&&(h+a)>0)?Math.round(h/(h+a)*100):50; } },
    { label: 'Corners',       hv: S('home',34),  av: S('away',34),  hPct: () => { const h=parseFloat(S('home',34)),a=parseFloat(S('away',34)); return (!isNaN(h)&&!isNaN(a)&&(h+a)>0)?Math.round(h/(h+a)*100):50; } },
    { label: 'Fouls',         hv: S('home',56),  av: S('away',56),  hPct: () => { const h=parseFloat(S('home',56)),a=parseFloat(S('away',56)); return (!isNaN(h)&&!isNaN(a)&&(h+a)>0)?Math.round(h/(h+a)*100):50; } },
    { label: 'Passes',        hv: S('home',80),  av: S('away',80),  hPct: () => { const h=parseFloat(S('home',80)),a=parseFloat(S('away',80)); return (!isNaN(h)&&!isNaN(a)&&(h+a)>0)?Math.round(h/(h+a)*100):50; } },
    { label: 'Yellow cards',  hv: S('home',84),  av: S('away',84),  hPct: () => { const h=parseFloat(S('home',84)),a=parseFloat(S('away',84)); return (!isNaN(h)&&!isNaN(a)&&(h+a)>0)?Math.round(h/(h+a)*100):50; } },
  ];

  function ratingClass(r) {
    if (r == null) return '';
    if (r >= 7.5)  return 'ig-rat-h';
    if (r >= 6.5)  return 'ig-rat-m';
    return 'ig-rat-l';
  }

  function playerRow(p, opts = {}) {
    const num    = p.shirtNumber ?? '';
    const name   = lastName(p.name) || p.name || '–';
    const rat    = p.matchRating != null ? p.matchRating.toFixed(1) : null;
    const ratHtml = rat ? `<span class="ig-rating ${ratingClass(p.matchRating)}">${rat}</span>` : `<span class="ig-rating"></span>`;

    if (opts.subOn) {
      // Subbed on — show sub minute in the time col, name in green
      return `<div class="ig-player-row ig-subbed-on">
        <span class="ig-shirt">${num}</span>
        <span class="ig-name">${esc(name)}</span>
        <span class="ig-subtime ig-subtime-on">↑${opts.subMinute}'</span>
        ${ratHtml}
      </div>`;
    }
    if (opts.subOff) {
      // Subbed off — in bench section, show minute off
      return `<div class="ig-player-row ig-subbed-off">
        <span class="ig-shirt">${num}</span>
        <span class="ig-name">${esc(name)}</span>
        <span class="ig-subtime ig-subtime-off">↓${opts.subOffMinute}'</span>
        ${ratHtml}
      </div>`;
    }
    // Normal player
    return `<div class="ig-player-row">
      <span class="ig-shirt">${num}</span>
      <span class="ig-name">${esc(name)}</span>
      <span class="ig-subtime"></span>
      ${ratHtml}
    </div>`;
  }

  function renderLineupCol(team, lineupData, side) {
    const formation = team.formation ? ` ${team.formation}` : '';
    const xiRows    = lineupData.xi.map(p =>
      p.subMinute != null
        ? playerRow(p, { subOn: true, subMinute: p.subMinute })
        : playerRow(p)
    ).join('');

    const benchRows = lineupData.bench.map(p =>
      p.subOffMinute != null
        ? playerRow(p, { subOff: true, subOffMinute: p.subOffMinute })
        : `<div class="ig-player-row ig-bench">
            <span class="ig-shirt">${p.shirtNumber ?? ''}</span>
            <span class="ig-name">${esc(lastName(p.name) || p.name || '–')}</span>
            <span class="ig-subtime"></span>
            <span class="ig-rating"></span>
           </div>`
    ).join('');

    return `<div class="ig-lineup-col ig-lineup-${side}">
      <div class="ig-lineup-head">${esc(team.name)}${esc(formation)}</div>
      ${xiRows}
      <div class="ig-bench-divider"></div>
      <div class="ig-bench-label">Bench</div>
      ${benchRows || '<div class="ig-player-row ig-bench"><span class="ig-name" style="color:var(--text-3)">–</span></div>'}
    </div>`;
  }

  // ── Events ──
  const evIcons = {
    [EV.GOAL]:       '⚽',
    [EV.OWN_GOAL]:   '⚽',
    [EV.PENALTY]:    '⚽',
    [EV.MISSED_PEN]: '✕',
    [EV.SUB]:        '⇄',
    [EV.YELLOW]:     '🟨',
    [EV.RED]:        '🟥',
    [EV.YELLOW_RED]: '🟥',
  };

  function resolveNum(playerId, side) {
    if (!playerId) return '';
    const p = (f[side]?.squad || []).find(sq => String(sq.id) === String(playerId));
    return p?.shirtNumber ?? '';
  }

  function evSide(participantId) {
    return participantId === f.home.id ? 'home' : 'away';
  }

  const sortedEvents = [...(f.events || [])].sort((a,b) => (a.minute||0) - (b.minute||0));

  const evRows = sortedEvents
    .filter(e => [EV.GOAL, EV.OWN_GOAL, EV.PENALTY, EV.MISSED_PEN, EV.SUB, EV.YELLOW, EV.RED, EV.YELLOW_RED].includes(e.typeId))
    .map(e => {
      const side  = evSide(e.participantId);
      const icon  = evIcons[e.typeId] || '';
      const min   = e.minute ? `${e.minute}${e.extraMinute ? '+'+e.extraMinute : ''}'` : '';

      const mainId  = e.playerId;
      const relId   = e.relatedPlayerId;
      const mainNum = resolveNum(mainId, side);
      const relNum  = resolveNum(relId, side);

      // Shirt col — stacked for subs
      let shirtCol;
      if (e.typeId === EV.SUB) {
        const onNum  = resolveNum(relId, side);
        const offNum = resolveNum(mainId, side);
        shirtCol = `<div class="ig-evt-shirt-stack"><span class="ig-evt-shirt-on">${onNum}</span><span class="ig-evt-shirt-off">${offNum}</span></div>`;
      } else {
        shirtCol = `<span class="ig-evt-shirt">${mainNum}</span>`;
      }

      // Primary / secondary text
      let primary, secondary = '';
      const pName = pid => {
        if (!pid) return '';
        const p = (f[side]?.squad || []).find(sq => String(sq.id) === String(pid))
               || (f[side === 'home' ? 'away' : 'home']?.squad || []).find(sq => String(sq.id) === String(pid));
        return p ? lastName(p.name) : `#${pid}`;
      };

      if (e.typeId === EV.SUB) {
        primary   = `${esc(pName(relId))} on`;
        secondary = `${esc(pName(mainId))} off${e.info ? ' ('+esc(e.info)+')' : ''}`;
      } else if (e.typeId === EV.OWN_GOAL) {
        primary   = `${esc(pName(mainId))} (og)`;
        secondary = e.info || '';
      } else if ([EV.GOAL, EV.PENALTY].includes(e.typeId)) {
        primary   = esc(pName(mainId));
        secondary = relId ? `Assist: ${esc(pName(relId))}` : (e.info || '');
      } else if (e.typeId === EV.MISSED_PEN) {
        primary   = `${esc(pName(mainId))} (pen missed)`;
      } else {
        primary   = esc(pName(mainId));
        secondary = e.info || '';
      }

      return `<div class="ig-evt-row">
        <div class="ig-evt-sidebar ig-evt-sidebar-${side}"></div>
        <span class="ig-evt-min">${min}</span>
        <span class="ig-evt-ico">${icon}</span>
        ${shirtCol}
        <div class="ig-evt-text">
          <div class="ig-evt-primary">${primary}</div>
          ${secondary ? `<div class="ig-evt-secondary">${esc(secondary)}</div>` : ''}
        </div>
      </div>`;
    }).join('');

  // ── Stats grid ──
  const statsGrid = statRows.map((r, i) => {
    const pct   = r.hPct();
    const isLast = i >= statRows.length - 4; // last two rows
    return `<div class="ig-stat-cell${isLast ? ' ig-stat-last-row' : ''}">
      <div class="ig-stat-vals"><span class="ig-stat-h">${r.hv}</span><span class="ig-stat-a">${r.av}</span></div>
      <div class="ig-stat-bar"><div class="ig-stat-bar-fill" style="--pct:${pct}%"></div></div>
      <div class="ig-stat-label">${r.label}</div>
    </div>`;
  }).join('');

  // ── Render ──
  el.innerHTML = `
    <div class="ig-wrap">

      <div class="ig-card">
        <div class="ig-score-header">
          <div class="ig-score-team ig-score-team-home">
            <img src="./data/badges/${f.home.id}.png" class="ig-badge" alt="${esc(f.home.name)}" onerror="this.style.opacity=0">
            <span class="ig-score-team-name">${esc(f.home.shortName || f.home.name)}</span>
          </div>
          <div class="ig-score-center">
            <div class="ig-score-digits">${hg} – ${ag}</div>
            <div class="ig-score-state"><span class="ig-live-dot"></span>${stateLabel}</div>
          </div>
          <div class="ig-score-team ig-score-team-away">
            <img src="./data/badges/${f.away.id}.png" class="ig-badge" alt="${esc(f.away.name)}" onerror="this.style.opacity=0">
            <span class="ig-score-team-name">${esc(f.away.shortName || f.away.name)}</span>
          </div>
        </div>
      </div>

      <div class="ig-card">
        <div class="ig-section-head">Stats</div>
        <div class="ig-stats-grid">${statsGrid}</div>
      </div>

      <div class="ig-lower">
        <div class="ig-card">
          <div class="ig-section-head">Lineups</div>
          <div class="ig-lineups">
            ${renderLineupCol(f.home, home, 'home')}
            ${renderLineupCol(f.away, away, 'away')}
          </div>
        </div>
        <div class="ig-card">
          <div class="ig-section-head">Events</div>
          <div class="ig-events">
            ${evRows || '<div class="ig-events-empty">No events yet</div>'}
          </div>
        </div>
      </div>

    </div>
  `;
}

document.addEventListener('DOMContentLoaded', init);
