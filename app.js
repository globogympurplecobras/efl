/* ══════════════════════════════════════════
   CONSTANTS & STATE
══════════════════════════════════════════ */
// dawn-rain-2785.hollandtideserver.workers.dev:
const PROXY_BASE = 'https://dawn-rain-2785.hollandtideserver.workers.dev/v4';
const LS_MATCH   = 'currentMatch';
const CACHE_TTL  = 60 * 60 * 1000; // 1 hour
const LINEUP_TTL = 15 * 60 * 1000; // 15 min

const COMP_NAMES = {
  ELC: 'Sky Bet Championship',
  EL1: 'Sky Bet League One',
  EL2: 'Sky Bet League Two',
  WC:  'FIFA World Cup 2026'
};

// API-Football (api-sports) league IDs for EFL
// Championship also available (id 40) but covered by football-data.org free tier
const AF_COMP_IDS = { ELC: 40, EL1: 41, EL2: 42 };
// Use API-Football for League One + Two; Championship stays on football-data.org
function useAfApi(comp){ return comp==='EL1'||comp==='EL2'; }
function afSeason(){
  const now=new Date();
  return now.getMonth()>=7?now.getFullYear():now.getFullYear()-1;
}

const TEAM_COLORS = {
  'Wycombe Wanderers':'#003087','Rotherham United':'#CC0000','Lincoln City':'#EE3524',
  'Bolton Wanderers':'#1B2E66','Stockport County':'#002F6C','Bradford City':'#C8102E',
  'Plymouth Argyle':'#007A33','Huddersfield Town':'#0E63AD','Peterborough United':'#0066B2',
  'Barnsley':'#C8102E','Luton Town':'#F78F1E','Leyton Orient':'#EE3524',
  'Mansfield Town':'#F5A623','Reading':'#004494','Wigan Athletic':'#1E3A5F',
  'Stevenage':'#EE3524','AFC Wimbledon':'#1A3055','Burton Albion':'#FFD700',
  'Doncaster Rovers':'#EE3524','Blackpool':'#F5821F','Exeter City':'#EE3524',
  'Port Vale':'#000000','Northampton Town':'#A2002A','Cardiff City':'#0070B5',
  'Burnley':'#6C1D45','West Bromwich Albion':'#122F67','Sheffield United':'#EE2737',
  'Sunderland':'#EB172B','Oxford United':'#F5A623','Swansea City':'#000000',
  'Charlton Athletic':'#CC0000','Millwall':'#001B5E','Preston North End':'#001489',
  'Bristol City':'#E03C31','Middlesbrough':'#EE3124','Coventry City':'#69B3E7',
  'Leeds United':'#FFCD00','Norwich City':'#00A650','Derby County':'#1B1917',
  'Hull City':'#F5A623','Sheffield Wednesday':'#1E4D8C','Watford':'#FBEE23',
  'Stoke City':'#E03A3E','Portsmouth':'#1D1C5C','Blackburn Rovers':'#009EE0',
  'Queens Park Rangers':'#005CAB','Ipswich Town':'#0055A5','Birmingham City':'#233875',
  'Wrexham':'#CC0000','Gillingham':'#004B87','Cambridge United':'#F5A623',
  'Newport County':'#F5A623','Carlisle United':'#1B2A5B','Bristol Rovers':'#005FAE',
  'Notts County':'#000000','Oldham Athletic':'#003DA5','Swindon Town':'#CC0000',
  'Cheltenham Town':'#CC0000','Colchester United':'#003DA5','Crawley Town':'#CC0000',
  'Fleetwood Town':'#CC0000','Shrewsbury Town':'#005BAC','Morecambe':'#CC0000',
  'Salford City':'#CC0000','Sutton United':'#AC9B00','Accrington Stanley':'#CC0000',
  'Forest Green Rovers':'#008B00','Crewe Alexandra':'#CC0000','Grimsby Town':'#000000',
  'Harrogate Town':'#F5A623','MK Dons':'#CC0000','Tranmere Rovers':'#003DA5',
  'Walsall':'#CC0000','Peterborough United':'#0066B2','Charlton Athletic':'#CC0000',
};

function teamColor(name){ return TEAM_COLORS[name] || '#444'; }
function initials(name){
  return (name||'?').split(' ').filter(w=>w).map(w=>w[0]).join('').slice(0,2).toUpperCase();
}
function slugify(s){ return (s||'').toLowerCase().replace(/[^a-z0-9]+/g,'_').replace(/^_|_$/g,''); }
function fmtDate(iso){
  return new Date(iso).toLocaleDateString('en-GB',{weekday:'long',day:'numeric',month:'long',year:'numeric'});
}
function fmtShortDate(iso){
  return new Date(iso).toLocaleDateString('en-GB',{day:'numeric',month:'short',year:'numeric'});
}
function fmtTime(iso){
  return new Date(iso).toLocaleTimeString('en-GB',{hour:'2-digit',minute:'2-digit'});
}
function mapPos(p){
  return {Goalkeeper:'GK',Defence:'DEF',Defender:'DEF',Midfield:'MID',Midfielder:'MID',Offence:'FWD',Attacker:'FWD'}[p]||p||'';
}

let APP = {
  match: null, compCode: null,
  homeTeam: null, awayTeam: null,
  table: null, h2h: null,
  homeForm: null, awayForm: null,
  matchDetail: null,
  kits: {},     // populated from data/kits.json at startup
  injuries: {}, // populated from data/injuries.json at startup
};

let selectorFixtures = [];

/* ══════════════════════════════════════════
   API + CACHE
══════════════════════════════════════════ */
async function apiGet(path){
  const r = await fetch(PROXY_BASE+path);
  if(r.status===429) throw Object.assign(new Error('Rate limited'),{code:'RATE_LIMIT'});
  if(r.status===403||r.status===401) throw Object.assign(new Error('Auth error'),{code:'AUTH'});
  if(!r.ok) throw Object.assign(new Error('API error '+r.status),{code:'ERR'});
  return r.json();
}

function cacheGet(k,ttl=CACHE_TTL){
  try{
    const raw=localStorage.getItem('cache_'+k);
    if(!raw) return null;
    const {ts,data}=JSON.parse(raw);
    if(Date.now()-ts>ttl) return null;
    return data;
  }catch{return null;}
}
function cachePut(k,data){
  try{localStorage.setItem('cache_'+k,JSON.stringify({ts:Date.now(),data}));}catch{}
}
async function cachedGet(k,path,ttl=CACHE_TTL){
  const hit=cacheGet(k,ttl);
  if(hit) return hit;
  const data=await apiGet(path);
  cachePut(k,data);
  return data;
}

/* ── API-Football helpers ── */
async function afApiGet(path){
  const r=await fetch(PROXY_BASE.replace('/v4','')+'/af'+path);
  if(r.status===429) throw Object.assign(new Error('Rate limited'),{code:'RATE_LIMIT'});
  if(r.status===403||r.status===401) throw Object.assign(new Error('Auth error'),{code:'AUTH'});
  if(!r.ok) throw Object.assign(new Error('API error '+r.status),{code:'ERR'});
  const json=await r.json();
  // AF returns errors array instead of HTTP error codes sometimes
  if(json.errors&&Object.keys(json.errors).length&&!json.response?.length)
    throw Object.assign(new Error('AF API error: '+JSON.stringify(json.errors)),{code:'ERR'});
  return json;
}
async function afCachedGet(k,path,ttl=CACHE_TTL){
  const hit=cacheGet(k,ttl);
  if(hit) return hit;
  const data=await afApiGet(path);
  cachePut(k,data);
  return data;
}

/* ── API-Football → internal shape adapters ── */
function afStatusMap(s){
  return{FT:'FINISHED',NS:'SCHEDULED',TBD:'SCHEDULED',PST:'POSTPONED',
         HT:'IN_PLAY','1H':'IN_PLAY','2H':'IN_PLAY',ET:'IN_PLAY',P:'IN_PLAY'}[s]||s;
}
function afPosMap(p){
  return{Goalkeeper:'Goalkeeper',Defender:'Defence',Midfielder:'Midfield',Attacker:'Offence'}[p]||p||'';
}
function afFixturesToMatches(response,comp){
  return response.map(f=>({
    id:f.fixture.id,
    utcDate:f.fixture.date,
    status:afStatusMap(f.fixture.status.short),
    venue:f.fixture.venue?.name||'',
    homeTeam:{id:f.teams.home.id,name:f.teams.home.name,
      tla:f.teams.home.name.split(' ').map(w=>w[0]).join('').slice(0,3).toUpperCase()},
    awayTeam:{id:f.teams.away.id,name:f.teams.away.name,
      tla:f.teams.away.name.split(' ').map(w=>w[0]).join('').slice(0,3).toUpperCase()},
    score:{fullTime:{home:f.goals.home,away:f.goals.away}},
    goals:[],
    compCode:comp,
  }));
}
function afTeamToInternal(teamResp,squadResp,coachResp){
  if(!teamResp) return null;
  const t=teamResp.team||{};
  const squad=(squadResp?.players||[]).map(p=>({
    id:p.id,name:p.name,position:afPosMap(p.position),shirtNumber:p.number,
  }));
  // Current coach = career entry with no end date at current club
  const currentCoach=coachResp?.find(c=>c.career?.some(e=>e.team?.id===t.id&&!e.end));
  const coach=currentCoach?{
    name:currentCoach.name,
    contract:{start:currentCoach.career?.find(e=>e.team?.id===t.id)?.start||''},
  }:null;
  return{id:t.id,name:t.name,crest:t.logo,venue:teamResp.venue?.name||'',squad,coach};
}
function afStandingsToInternal(response){
  const rows=(response?.[0]?.league?.standings?.[0]||[]).map(r=>({
    position:r.rank,
    team:{id:r.team.id,name:r.team.name},
    playedGames:r.all.played,won:r.all.win,draw:r.all.draw,lost:r.all.lose,
    goalsFor:r.all.goals.for,goalsAgainst:r.all.goals.against,
    goalDifference:r.goalsDiff,points:r.points,
  }));
  return{standings:[{type:'TOTAL',table:rows}]};
}
function afFixturesToFormShape(response){
  return{matches:response.map(f=>({
    id:f.fixture.id,
    utcDate:f.fixture.date,
    status:'FINISHED',
    venue:f.fixture.venue?.name||'',
    homeTeam:{id:f.teams.home.id,name:f.teams.home.name},
    awayTeam:{id:f.teams.away.id,name:f.teams.away.name},
    score:{fullTime:{home:f.goals.home,away:f.goals.away}},
    goals:[], // goalscorer detail not included in bulk fixtures endpoint
  }))};
}
function afH2HToInternal(response,homeId,awayId){
  const finished=response.filter(f=>f.fixture.status.short==='FT');
  let hWins=0,aWins=0;
  finished.forEach(f=>{
    const gh=f.goals.home,ga=f.goals.away;
    if(gh>ga){if(f.teams.home.id===homeId)hWins++;else aWins++;}
    else if(ga>gh){if(f.teams.away.id===homeId)hWins++;else aWins++;}
  });
  const matches=response.map(f=>({
    id:f.fixture.id,utcDate:f.fixture.date,
    status:afStatusMap(f.fixture.status.short),
    venue:f.fixture.venue?.name||'',
    homeTeam:{id:f.teams.home.id,name:f.teams.home.name},
    awayTeam:{id:f.teams.away.id,name:f.teams.away.name},
    score:{fullTime:{home:f.goals.home,away:f.goals.away}},
    goals:[],
  }));
  return{matches,aggregates:{numberOfMatches:finished.length,
    homeTeam:{wins:hWins},awayTeam:{wins:aWins}}};
}

/* ══════════════════════════════════════════
   MATCH SELECTOR
══════════════════════════════════════════ */
function showSelector(){
  document.getElementById('sel-overlay').classList.remove('hidden');
  const d=document.getElementById('sel-date');
  if(!d.value) d.value=new Date().toISOString().split('T')[0];
  document.getElementById('sel-fixtures').innerHTML='';
  // Populate manual team datalist
  const dl=document.getElementById('man-teams-dl');
  if(dl&&!dl.children.length){
    dl.innerHTML=Object.keys(TEAM_COLORS).sort().map(t=>`<option value="${t}">`).join('');
  }
  const md=document.getElementById('man-date');
  if(md&&!md.value) md.value=new Date().toISOString().split('T')[0];
}

function toggleManualEntry(){
  const el=document.getElementById('sel-manual');
  const btn=document.querySelector('.sel-manual-link');
  const hidden=el.style.display==='none';
  el.style.display=hidden?'block':'none';
  btn.textContent=hidden?'↑ Hide manual entry':'↓ Or enter teams manually';
}

function doManualSelect(){
  const home=document.getElementById('man-home').value.trim();
  const away=document.getElementById('man-away').value.trim();
  const comp=document.getElementById('man-comp').value;
  const date=document.getElementById('man-date').value;
  if(!home||!away){alert('Please enter both team names.');return;}
  // Build a minimal match object matching the football-data.org shape
  const m={
    id:'manual_'+slugify(home)+'_'+slugify(away),
    utcDate:date?date+'T15:00:00Z':new Date().toISOString(),
    status:'SCHEDULED',
    venue:'',
    homeTeam:{id:slugify(home),name:home,tla:home.split(' ').map(w=>w[0]).join('').slice(0,3).toUpperCase()},
    awayTeam:{id:slugify(away),name:away,tla:away.split(' ').map(w=>w[0]).join('').slice(0,3).toUpperCase()},
    score:{fullTime:{home:null,away:null}},
    compCode:comp,
  };
  selectMatch(m,comp);
}
function hideSelector(){
  document.getElementById('sel-overlay').classList.add('hidden');
}
async function doFetchFixtures(){
  const comp=document.getElementById('sel-comp').value;
  const date=document.getElementById('sel-date').value;
  const el=document.getElementById('sel-fixtures');
  if(!date){el.innerHTML='<div class="sel-msg">Pick a date first.</div>';return;}
  el.innerHTML='<div class="sel-msg"><span class="spin"></span> Loading fixtures…</div>';
  try{
    let matches;
    if(useAfApi(comp)){
      const leagueId=AF_COMP_IDS[comp];
      const data=await afApiGet(`/fixtures?league=${leagueId}&date=${date}`);
      matches=afFixturesToMatches(data.response||[],comp);
    }else{
      const data=await apiGet(`/competitions/${comp}/matches?dateFrom=${date}&dateTo=${date}`);
      matches=data.matches||[];
    }
    selectorFixtures=matches;
    renderFixtureList(matches,comp);
  }catch(e){
    const msg=e.code==='AUTH'?'Proxy auth error — check worker config.':e.code==='RATE_LIMIT'?'Rate limited — wait a moment.':'Could not load fixtures.';
    el.innerHTML=`<div class="sel-error">${msg}</div>`;
  }
}

function renderFixtureList(matches,comp){
  const el=document.getElementById('sel-fixtures');
  if(!matches.length){el.innerHTML='<div class="sel-msg">No fixtures on this date.</div>';return;}
  el.innerHTML=matches.map((m,i)=>{
    const t=m.status==='FINISHED'?`${m.score.fullTime.home}–${m.score.fullTime.away}`:fmtTime(m.utcDate);
    const meta=fmtShortDate(m.utcDate)+(m.venue?` · ${m.venue}`:'');
    return `<div class="sel-fixture" onclick="selectMatchByIndex(${i},'${comp}')">
      <div>
        <div class="sel-fixture-teams">${m.homeTeam.name} <span style="color:var(--muted);font-weight:400">vs</span> ${m.awayTeam.name}</div>
        <div class="sel-fixture-meta">${meta}</div>
      </div>
      <div class="sel-fixture-time">${t}</div>
    </div>`;
  }).join('');
}

async function selectMatchByIndex(i,comp){
  const m=selectorFixtures[i];
  await selectMatch(m,comp);
}

async function selectMatch(m,comp){
  APP.match={...m,compCode:comp};
  APP.compCode=comp;
  localStorage.setItem(LS_MATCH,JSON.stringify(APP.match));
  hideSelector();
  showAppUI();
  renderBanner();
  setHomeAwayColors(m.homeTeam.name,m.awayTeam.name);
  setLoadingState();
  await loadMatchData(m,comp);
}

function showAppUI(){
  document.getElementById('match-banner').style.display='';
  document.getElementById('main-tab-bar').style.display='';
  document.getElementById('tab-match').style.display='';
}

function setLoadingState(){
  const spin='<div class="section-load"><span class="spin"></span> Loading…</div>';
  ['s-managers','s-kits','s-form','s-scout','s-injuries','s-formations','s-h2h','s-table','s-squads'].forEach(id=>{
    const el=document.getElementById(id);
    if(el) el.innerHTML=spin;
  });
}

function setHomeAwayColors(homeName,awayName){
  const hc=teamColor(homeName);
  const ac=teamColor(awayName);
  document.documentElement.style.setProperty('--home',hc);
  document.documentElement.style.setProperty('--away',ac);
  document.documentElement.style.setProperty('--home-light',hexToLight(hc));
  document.documentElement.style.setProperty('--away-light',hexToLight(ac));
}
function hexToLight(hex){
  // Returns a very light tint of the hex color
  const r=parseInt(hex.slice(1,3),16);
  const g=parseInt(hex.slice(3,5),16);
  const b=parseInt(hex.slice(5,7),16);
  return `rgba(${r},${g},${b},0.07)`;
}

/* ══════════════════════════════════════════
   DATA LOADING
══════════════════════════════════════════ */
async function loadMatchData(m,comp){
  if(useAfApi(comp)) return loadMatchDataAF(m,comp);

  const hId=m.homeTeam.id, aId=m.awayTeam.id, mId=m.id;
  const seasonStart=`${new Date().getMonth()>=7?new Date().getFullYear():new Date().getFullYear()-1}-08-01`;
  const today=new Date().toISOString().split('T')[0];

  const results=await Promise.allSettled([
    cachedGet(`team_${hId}`,`/teams/${hId}`),
    cachedGet(`team_${aId}`,`/teams/${aId}`),
    cachedGet(`table_${comp}`,`/competitions/${comp}/standings`),
    cachedGet(`h2h_${mId}`,`/matches/${mId}/head2head?limit=10`),
    cachedGet(`form_${hId}_${today}`,`/teams/${hId}/matches?status=FINISHED&dateFrom=${seasonStart}&dateTo=${today}`),
    cachedGet(`form_${aId}_${today}`,`/teams/${aId}/matches?status=FINISHED&dateFrom=${seasonStart}&dateTo=${today}`),
    cachedGet(`match_${mId}`,`/matches/${mId}`,LINEUP_TTL),
  ]);

  APP.homeTeam    = results[0].status==='fulfilled'?results[0].value:null;
  APP.awayTeam    = results[1].status==='fulfilled'?results[1].value:null;
  APP.table       = results[2].status==='fulfilled'?results[2].value:null;
  APP.h2h         = results[3].status==='fulfilled'?results[3].value:null;
  APP.homeForm    = results[4].status==='fulfilled'?results[4].value:null;
  APP.awayForm    = results[5].status==='fulfilled'?results[5].value:null;
  APP.matchDetail = results[6].status==='fulfilled'?results[6].value:null;

  renderAll();
}

async function loadMatchDataAF(m,comp){
  const hId=m.homeTeam.id, aId=m.awayTeam.id, mId=m.id;
  const season=afSeason();
  const leagueId=AF_COMP_IDS[comp];

  const results=await Promise.allSettled([
    afCachedGet(`af_team_${hId}`,`/teams?id=${hId}`),
    afCachedGet(`af_squad_${hId}`,`/players/squads?team=${hId}`),
    afCachedGet(`af_coach_${hId}`,`/coachs?team=${hId}`),
    afCachedGet(`af_team_${aId}`,`/teams?id=${aId}`),
    afCachedGet(`af_squad_${aId}`,`/players/squads?team=${aId}`),
    afCachedGet(`af_coach_${aId}`,`/coachs?team=${aId}`),
    afCachedGet(`af_table_${leagueId}_${season}`,`/standings?league=${leagueId}&season=${season}`),
    afCachedGet(`af_h2h_${hId}_${aId}`,`/fixtures/headtohead?h2h=${hId}-${aId}&last=10`),
    afCachedGet(`af_form_${hId}_${season}`,`/fixtures?team=${hId}&last=5&status=FT`),
    afCachedGet(`af_form_${aId}_${season}`,`/fixtures?team=${aId}&last=5&status=FT`),
  ]);

  const get=(r,key='response')=>r.status==='fulfilled'?(r.value?.[key]??r.value):null;

  const hTeamR=get(results[0]),  hSquadR=get(results[1]), hCoachR=get(results[2]);
  const aTeamR=get(results[3]),  aSquadR=get(results[4]), aCoachR=get(results[5]);
  const tableR=get(results[6]),  h2hR=get(results[7]);
  const hFormR=get(results[8]),  aFormR=get(results[9]);

  APP.homeTeam    = afTeamToInternal(hTeamR?.[0], hSquadR?.[0], hCoachR);
  APP.awayTeam    = afTeamToInternal(aTeamR?.[0], aSquadR?.[0], aCoachR);
  APP.table       = tableR ? afStandingsToInternal(tableR) : null;
  APP.h2h         = h2hR  ? afH2HToInternal(h2hR, hId, aId) : null;
  APP.homeForm    = hFormR ? afFixturesToFormShape(hFormR) : null;
  APP.awayForm    = aFormR ? afFixturesToFormShape(aFormR) : null;
  APP.matchDetail = null; // lineup import not yet supported for AF matches

  renderAll();
}

/* ══════════════════════════════════════════
   RENDER ALL
══════════════════════════════════════════ */
function renderAll(){
  const m=APP.match;
  renderBanner();
  renderManagers();
  renderKits();
  renderFormSection();
  renderScoutNotes();
  renderInjuries();
  renderFormations();
  renderH2H();
  renderTable();
  renderSquads();
  renderProdTeams();
  updateXiTeamButtons();
  renderPrintView();
  const comp=COMP_NAMES[m.compCode]||m.compCode||'';
  document.getElementById('hdr-comp').textContent=comp.toUpperCase();
  const htla=m.homeTeam.tla||m.homeTeam.name.slice(0,3).toUpperCase();
  const atla=m.awayTeam.tla||m.awayTeam.name.slice(0,3).toUpperCase();
  document.getElementById('s-footer').textContent=
    `MATCH PREP · ${comp.toUpperCase()} · ${htla} VS ${atla} · ${fmtShortDate(m.utcDate).toUpperCase()} · DATA: FOOTBALL-DATA.ORG`;
}

/* ══════════════════════════════════════════
   RENDER: BANNER
══════════════════════════════════════════ */
function renderBanner(){
  const m=APP.match;
  const hName=m.homeTeam.name, aName=m.awayTeam.name;
  const hc=teamColor(hName), ac=teamColor(aName);
  let hPos='', aPos='';
  if(APP.table){
    const rows=(APP.table.standings||[]).find(s=>s.type==='TOTAL')?.table||[];
    const hRow=rows.find(r=>r.team.id===m.homeTeam.id);
    const aRow=rows.find(r=>r.team.id===m.awayTeam.id);
    if(hRow) hPos=ordinal(hRow.position);
    if(aRow) aPos=ordinal(aRow.position);
  }
  const venue=m.venue||(APP.homeTeam?.venue)||'';
  const comp=COMP_NAMES[m.compCode]||'';
  document.getElementById('match-banner').innerHTML=`
    <div class="match-banner">
      <div class="team-header">
        <div class="team-name" style="color:${hc}">${hName}</div>
        <div class="team-meta">${venue}${hPos?' &nbsp;·&nbsp; '+hPos:''}</div>
      </div>
      <div class="match-centre">
        <span class="match-vs">VS</span>
        <div class="match-date">${fmtDate(m.utcDate)}</div>
        <div class="match-venue">${venue}</div>
        <div class="match-badge">${comp}</div>
      </div>
      <div class="team-header away">
        <div class="team-name" style="color:${ac}">${aName}</div>
        <div class="team-meta">${aPos||''}</div>
      </div>
    </div>`;
}
function ordinal(n){return n+(n===1?'st':n===2?'nd':n===3?'rd':'th');}

/* ══════════════════════════════════════════
   RENDER: MANAGERS
══════════════════════════════════════════ */
function renderManagers(){
  const hc=teamColor(APP.match.homeTeam.name);
  const ac=teamColor(APP.match.awayTeam.name);
  const hCoach=APP.homeTeam?.coach;
  const aCoach=APP.awayTeam?.coach;
  function coachCard(coach,color,teamName){
    if(!coach) return `<div class="card"><div class="manager-card">
      <div class="manager-avatar" style="background:${color}">?</div>
      <div><div class="manager-role">${teamName}</div><div class="manager-name">—</div></div>
    </div></div>`;
    const ini=initials(coach.name);
    const since=coach.contract?.start?`Appointed ${fmtShortDate(coach.contract.start)}`:'';
    return `<div class="card"><div class="manager-card">
      <div class="manager-avatar" style="background:${color}">${ini}</div>
      <div>
        <div class="manager-role">Manager · ${teamName}</div>
        <div class="manager-name">${coach.name}</div>
        ${since?`<div class="manager-since">${since}</div>`:''}
      </div>
    </div></div>`;
  }
  document.getElementById('s-managers').innerHTML=
    coachCard(hCoach,hc,APP.match.homeTeam.name)+
    coachCard(aCoach,ac,APP.match.awayTeam.name);
}

/* ══════════════════════════════════════════
   RENDER: KITS (color swatches)
══════════════════════════════════════════ */
function renderKits(){
  const hName=APP.match.homeTeam.name, aName=APP.match.awayTeam.name;
  const hc=teamColor(hName), ac=teamColor(aName);

  function kitSlot(imgUrl, fallbackStyle, label){
    if(imgUrl){
      return `<div class="kit-item">
        <div class="kit-shape kit-shape--img"><img src="${imgUrl}" alt="${label} kit" style="width:100%;height:100%;object-fit:contain;display:block"></div>
        <div class="kit-label">${label}</div>
      </div>`;
    }
    return `<div class="kit-item"><div class="kit-shape" style="${fallbackStyle}">${label}</div><div class="kit-label">${label}</div></div>`;
  }

  function kitCard(color, name){
    const teamKits = APP.kits[name] || {};
    const hasAnyImage = teamKits.home || teamKits.away || teamKits.third;
    return `<div class="card">
      <div class="kit-grid">
        ${kitSlot(teamKits.home, `background:${color}`, 'Home')}
        ${kitSlot(teamKits.away, `background:#FFF;border:2px solid var(--border);color:${color}`, 'Away')}
        ${kitSlot(teamKits.third, `background:#FFD700;color:#333`, 'Third')}
      </div>
      ${hasAnyImage ? '' : '<p class="footnote">Run scraper-kits.js to fetch kit images</p>'}
    </div>`;
  }

  document.getElementById('s-kits').innerHTML=kitCard(hc,hName)+kitCard(ac,aName);
}

/* ══════════════════════════════════════════
   RENDER: FORM SECTION (form + key players)
══════════════════════════════════════════ */
function renderFormSection(){
  const hId=APP.match.homeTeam.id, aId=APP.match.awayTeam.id;
  const hName=APP.match.homeTeam.name, aName=APP.match.awayTeam.name;
  const hc=teamColor(hName), ac=teamColor(aName);
  const hForm=getLastN(APP.homeForm?.matches||[],hId,5);
  const aForm=getLastN(APP.awayForm?.matches||[],aId,5);
  const mId=APP.match.id;
  document.getElementById('s-form').innerHTML=
    `<div style="display:flex;flex-direction:column;gap:14px">
      ${formCard(hForm,hId,hName,hc)}
      ${recentMatchCard(hForm,hId,hName,hc)}
      ${keyPlayersCard('home',mId,hName,hc)}
    </div>
    <div style="display:flex;flex-direction:column;gap:14px">
      ${formCard(aForm,aId,aName,ac)}
      ${recentMatchCard(aForm,aId,aName,ac)}
      ${keyPlayersCard('away',mId,aName,ac)}
    </div>`;
  initKpHandlers('home',mId);
  initKpHandlers('away',mId);
}

function getLastN(matches,teamId,n){
  const finished=matches.filter(m=>m.status==='FINISHED');
  finished.sort((a,b)=>new Date(b.utcDate)-new Date(a.utcDate));
  return finished.slice(0,n);
}

function matchResult(m,teamId){
  const isHome=m.homeTeam.id===teamId;
  const gf=isHome?m.score.fullTime.home:m.score.fullTime.away;
  const ga=isHome?m.score.fullTime.away:m.score.fullTime.home;
  if(gf==null) return {r:'?',gf:'?',ga:'?',opp:'?',ha:'?'};
  const r=gf>ga?'W':gf<ga?'L':'D';
  const opp=isHome?m.awayTeam.name:m.homeTeam.name;
  return {r,gf,ga,opp,ha:isHome?'H':'A'};
}

function formCard(matches,teamId,teamName,color){
  if(!matches.length) return `<div class="card"><div class="section-title">Last 5 Matches</div><div class="section-load">No data available</div></div>`;
  const pills=matches.map(m=>{const {r}=matchResult(m,teamId);return`<div class="form-pill ${r}">${r}</div>`;}).join('');
  const rows=matches.map(m=>{
    const {r,gf,ga,opp,ha}=matchResult(m,teamId);
    const bg=r==='W'?'var(--good)':r==='L'?'var(--bad)':'var(--draw)';
    const shortOpp=opp.length>18?opp.split(' ').pop():opp;
    return `<div class="form-match">
      <div class="result-badge" style="background:${bg}">${r}</div>
      <div class="ha">${ha}</div>
      <div class="opponent">${shortOpp}</div>
      <div class="score">${gf}–${ga}</div>
    </div>`;
  }).join('');
  return `<div class="card">
    <div class="section-title">Last 5 Matches</div>
    <div class="form-row">${pills}<span style="font-size:10px;color:var(--muted);margin-left:6px;align-self:center;font-family:'DM Mono',monospace">${teamName.split(' ').pop().slice(0,3).toUpperCase()}</span></div>
    ${rows}
  </div>`;
}

function recentMatchCard(matches,teamId,teamName,color){
  if(!matches.length) return `<div class="card"><div class="section-title">Most Recent Match</div><div class="section-load">No data</div></div>`;
  const m=matches[0];
  const {r,gf,ga,opp,ha}=matchResult(m,teamId);
  const isHome=m.homeTeam.id===teamId;
  const title=isHome?`${m.homeTeam.name} ${gf}–${ga} ${m.awayTeam.name}`:`${m.homeTeam.name} ${m.score.fullTime.home}–${m.score.fullTime.away} ${m.awayTeam.name}`;
  const venueLine=fmtShortDate(m.utcDate)+(m.venue?` · ${m.venue}`:'')+(isHome?' · Home':' · Away');
  // Goalscorers
  const teamGoals=(m.goals||[]).filter(g=>g.team?.id===teamId);
  const scorerStr=teamGoals.length?teamGoals.map(g=>`<span class="recent-scorer-time">${g.minute}'</span>${g.scorer?.name?.split(' ').pop()||'?'}`).join(' &nbsp;·&nbsp; '):'—';
  return `<div class="card">
    <div class="section-title">Most Recent Match</div>
    <div class="recent-header">${title}<span class="recent-result ${r}">${r}</span></div>
    <div class="recent-meta">${venueLine}</div>
    <div class="recent-sublabel">${teamName.split(' ').pop()} Goalscorers</div>
    <div class="recent-scorers">${scorerStr}</div>
  </div>`;
}

/* ── Key Players (editable, 5 slots per team, stored per matchId) ── */
function kpKey(side,mId){return `kp_${side}_${mId}`;}
function loadKp(side,mId){
  try{return JSON.parse(localStorage.getItem(kpKey(side,mId)))||defaultKp();}catch{return defaultKp();}
}
function defaultKp(){return Array(5).fill(null).map(()=>({name:'',role:'Key Player',desc:'',stat:''}));}
function saveKp(side,mId){
  const rows=document.querySelectorAll(`.kp-row[data-side="${side}"]`);
  const data=Array.from(rows).map(row=>({
    name:row.querySelector('.kp-name-inp').value,
    role:row.querySelector('.kp-role-sel').value,
    desc:row.querySelector('.kp-desc-inp').value,
    stat:row.querySelector('.kp-stat-inp').value,
  }));
  localStorage.setItem(kpKey(side,mId),JSON.stringify(data));
  renderPrintView();
}
const KP_ROLES=['Top Scorer','Key Player','Captain','New Signing','Watch','Striker','Creator','Defender','Goalkeeper','Other'];

function keyPlayersCard(side,mId,teamName,color){
  const data=loadKp(side,mId);
  const squad=side==='home'?(APP.homeTeam?.squad||[]):(APP.awayTeam?.squad||[]);
  const dlId=`kp-squad-${side}`;
  const dl=squad.map(p=>`<option value="${p.name}"></option>`).join('');
  const rows=data.map((p,i)=>{
    const ini=p.name?initials(p.name):'?';
    return `<div class="kp-row" data-side="${side}" data-i="${i}">
      <div class="kp-av" style="background:${color}">${ini}</div>
      <div class="kp-inputs">
        <input class="kp-name-inp" list="${dlId}" placeholder="Player name…" value="${escHtml(p.name)}"
          oninput="updateKpAv(this)" onchange="saveKp('${side}','${mId}')">
        <input class="kp-desc-inp" placeholder="Brief note…" value="${escHtml(p.desc)}"
          onchange="saveKp('${side}','${mId}')">
      </div>
      <div style="display:flex;flex-direction:column;gap:3px;align-items:flex-end">
        <select class="xi-pos-select" style="width:80px" onchange="saveKp('${side}','${mId}')">
          ${KP_ROLES.map(r=>`<option${r===p.role?' selected':''}>${r}</option>`).join('')}
        </select>
        <input class="kp-stat-inp" placeholder="stat" value="${escHtml(p.stat)}"
          onchange="saveKp('${side}','${mId}')">
      </div>
    </div>`;
  }).join('');
  return `<div class="card" id="kp-card-${side}">
    <div class="section-title">Key Players</div>
    <datalist id="${dlId}">${dl}</datalist>
    ${rows}
  </div>`;
}
function initKpHandlers(side,mId){
  document.querySelectorAll(`.kp-row[data-side="${side}"] input, .kp-row[data-side="${side}"] select`).forEach(el=>{
    el.addEventListener('change',()=>saveKp(side,mId));
  });
}
function updateKpAv(inp){
  const row=inp.closest('.kp-row');
  const av=row.querySelector('.kp-av');
  av.textContent=inp.value?initials(inp.value):'?';
}
function escHtml(s){return (s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');}

/* ══════════════════════════════════════════
   RENDER: SCOUT NOTES (editable)
══════════════════════════════════════════ */
function scoutKey(side,mId){return `scout_${side}_${mId}`;}
function renderScoutNotes(){
  const mId=APP.match.id;
  const hName=APP.match.homeTeam.name, aName=APP.match.awayTeam.name;
  const hVal=localStorage.getItem(scoutKey('home',mId))||'';
  const aVal=localStorage.getItem(scoutKey('away',mId))||'';
  document.getElementById('s-scout').innerHTML=
    noteCard(hName,'home',mId,hVal)+noteCard(aName,'away',mId,aVal);
}
function noteCard(teamName,side,mId,val){
  return `<div class="card">
    <div class="section-title">${teamName}</div>
    <textarea class="notes-ta" id="scout-${side}"
      placeholder="Tactical notes, patterns, threats, weaknesses…"
      onchange="localStorage.setItem('scout_${side}_${mId}',this.value);renderPrintView()">${escHtml(val)}</textarea>
  </div>`;
}

/* ══════════════════════════════════════════
   RENDER: INJURIES (editable)
══════════════════════════════════════════ */
function injKey(side,mId){return `inj_${side}_${mId}`;}
function renderInjuries(){
  const mId=APP.match.id;
  const hName=APP.match.homeTeam.name, aName=APP.match.awayTeam.name;
  const hVal=localStorage.getItem(injKey('home',mId))||'';
  const aVal=localStorage.getItem(injKey('away',mId))||'';
  document.getElementById('s-injuries').innerHTML=
    injCard(hName,'home',mId,hVal)+injCard(aName,'away',mId,aVal);
}
function injCard(teamName,side,mId,val){
  const scraped=APP.injuries[teamName];
  const scrapedHtml=scraped&&scraped.players&&scraped.players.length
    ? `<div class="inj-scraped">
        ${scraped.players.map(p=>`
          <div class="inj-row">
            <span class="inj-name">${escHtml(p.name)}</span>
            <span class="inj-status inj-status--${statusClass(p.status)}">${escHtml(p.status)}</span>
          </div>`).join('')}
        <div class="inj-meta">Source: Soccerway · ${fmtScrapedDate(scraped.scraped)}</div>
      </div>`
    : (scraped
        ? `<div class="inj-meta" style="margin-bottom:8px">No injuries reported (Soccerway · ${fmtScrapedDate(scraped.scraped)})</div>`
        : '');
  return `<div class="card">
    <div class="section-title">${teamName}</div>
    ${scrapedHtml}
    <textarea class="notes-ta" id="inj-${side}" style="min-height:50px;margin-top:${scrapedHtml?'10px':'0'}"
      placeholder="Manual notes: e.g. Player — Hamstring — Out"
      onchange="localStorage.setItem('inj_${side}_${mId}',this.value)">${escHtml(val)}</textarea>
  </div>`;
}
function statusClass(s){
  if(/injur/i.test(s)) return 'injury';
  if(/inactive/i.test(s)) return 'inactive';
  if(/suspend/i.test(s)) return 'suspended';
  return 'other';
}
function fmtScrapedDate(iso){
  if(!iso) return 'unknown date';
  try{ return new Date(iso).toLocaleDateString('en-GB',{day:'numeric',month:'short',year:'numeric'}); }
  catch{ return iso; }
}

/* ══════════════════════════════════════════
   RENDER: FORMATIONS (from XI tab data)
══════════════════════════════════════════ */
function renderFormations(){
  const mId=APP.match.id;
  const hXi=loadXiFromStorage('home');
  const aXi=loadXiFromStorage('away');
  const hName=APP.match.homeTeam.name, aName=APP.match.awayTeam.name;
  const hc=teamColor(hName), ac=teamColor(aName);
  const placeholder=`<div class="card">
    <div class="section-title" style="border:none;padding:0;margin-bottom:8px">Formation</div>
    <div class="section-empty">Enter the confirmed XI in the <strong>Confirmed XI</strong> tab to display the formation here.</div>
  </div>`;
  const hPitch=hXi?formationPitch(hXi,hName,hc,'home',false):placeholder;
  const aPitch=aXi?formationPitch(aXi,aName,ac,'away',true):placeholder;
  document.getElementById('s-formations').innerHTML=hPitch+aPitch;
}

function loadXiFromStorage(side){
  const mId=APP.match.id;
  try{return JSON.parse(localStorage.getItem(`xi_${side}_${mId}`))||null;}catch{return null;}
}

function formationPitch(xiData,teamName,color,side,mirrored){
  const fkey=xiData.formation||'4-4-2';
  const layout=formations[fkey]||formations['4-4-2'];
  const players=xiData.players||[];
  const note=mirrored?'← Attacking · ':'Attacking → ';
  let pIdx=0;
  const cols=mirrored?[...layout].reverse():layout;
  const colHtml=cols.map(col=>{
    const cellHtml=Array.from({length:col[0]}).map(()=>{
      const p=players[pIdx]||{name:'',pos:''};
      const ini=p.name?initials(p.name):String(pIdx+1);
      pIdx++;
      return `<div class="pitch-player-h">
        <div class="av" style="background:${color}">${ini}</div>
        <div class="pn">${p.name?p.name.split(' ').pop():''}</div>
      </div>`;
    }).join('');
    return `<div class="pitch-col">${cellHtml}</div>`;
  }).join('');
  return `<div class="card">
    <div class="formation-meta">
      <div>
        <div class="section-title" style="border:none;padding:0;margin:0 0 2px">${teamName}</div>
        <div class="formation-tag" style="color:${color}">${fkey.replace(/-/g,'–')}</div>
      </div>
      <div class="formation-note">${note}</div>
    </div>
    <div class="pitch-landscape ${side==='home'?'home-pitch':'away-pitch'}">${colHtml}</div>
  </div>`;
}

/* ══════════════════════════════════════════
   RENDER: H2H
══════════════════════════════════════════ */
function renderH2H(){
  const d=APP.h2h;
  const hName=APP.match.homeTeam.name, aName=APP.match.awayTeam.name;
  const hc=teamColor(hName), ac=teamColor(aName);
  if(!d){
    document.getElementById('s-h2h').innerHTML=`<div class="card section-empty">H2H data unavailable</div><div class="card section-empty"></div>`;
    return;
  }
  const agg=d.aggregates||{};
  const home=agg.homeTeam||{}, away=agg.awayTeam||{};
  const hWins=home.wins??'—', aWins=away.wins??'—';
  const draws=agg.numberOfMatches!=null?(agg.numberOfMatches-(home.wins||0)-(away.wins||0)):'—';
  const recent=(d.matches||[]).filter(m=>m.status==='FINISHED').sort((a,b)=>new Date(b.utcDate)-new Date(a.utcDate));
  let recentHtml='<div class="section-empty">No recent meetings found</div>';
  if(recent.length){
    const rm=recent[0];
    const hScore=rm.score.fullTime.home, aScore=rm.score.fullTime.away;
    const hTeam=rm.homeTeam.name, aTeam=rm.awayTeam.name;
    const hGoals=(rm.goals||[]).filter(g=>g.team?.id===rm.homeTeam.id).map(g=>`<span class="recent-scorer-time">${g.minute}'</span>${g.scorer?.name?.split(' ').pop()||'?'}`).join(' &nbsp;·&nbsp; ');
    const aGoals=(rm.goals||[]).filter(g=>g.team?.id===rm.awayTeam.id).map(g=>`<span class="recent-scorer-time">${g.minute}'</span>${g.scorer?.name?.split(' ').pop()||'?'}`).join(' &nbsp;·&nbsp; ');
    const title=`${hTeam} ${hScore}–${aScore} ${aTeam}`;
    recentHtml=`
      <div class="section-title">Most Recent Meeting</div>
      <div class="recent-header">${title}</div>
      <div class="recent-meta">${fmtShortDate(rm.utcDate)}${rm.venue?' · '+rm.venue:''}</div>
      ${hGoals?`<div class="recent-sublabel">${hTeam.split(' ').pop()} Goalscorers</div><div class="recent-scorers">${hGoals}</div>`:''}
      ${aGoals?`<div class="recent-sublabel">${aTeam.split(' ').pop()} Goalscorers</div><div class="recent-scorers">${aGoals}</div>`:''}`;
  }
  document.getElementById('s-h2h').innerHTML=`
    <div class="card">
      <div class="section-title">Last ${agg.numberOfMatches||'N'} Meetings</div>
      <div class="h2h-stats">
        <div><div class="h2h-num" style="color:${hc}">${hWins}</div><div class="h2h-label">${hName.split(' ').pop()} Wins</div></div>
        <div class="h2h-divider"></div>
        <div><div class="h2h-num" style="color:${ac}">${aWins}</div><div class="h2h-label">${aName.split(' ').pop()} Wins</div></div>
      </div>
      <div style="text-align:center;margin-bottom:10px"><span style="font-family:'DM Mono',monospace;font-size:12px;color:var(--muted)">${draws} Draws</span></div>
    </div>
    <div class="card">${recentHtml}</div>`;
}

/* ══════════════════════════════════════════
   RENDER: LEAGUE TABLE
══════════════════════════════════════════ */
function renderTable(){
  if(!APP.table){document.getElementById('s-table').innerHTML='<div class="section-empty">Table unavailable</div>';return;}
  const rows=(APP.table.standings||[]).find(s=>s.type==='TOTAL')?.table||[];
  if(!rows.length){document.getElementById('s-table').innerHTML='<div class="section-empty">No standings data</div>';return;}
  const hId=APP.match.homeTeam.id, aId=APP.match.awayTeam.id;
  const n=rows.length;
  const rowHtml=rows.map(r=>{
    const isH=r.team.id===hId, isA=r.team.id===aId;
    const cls=(isH?'hl-home':isA?'hl-away':'')+(r.position<=2?' z-up':r.position<=6?' z-po':r.position>n-4?' z-dn':'');
    const gd=r.goalDifference>0?'+'+r.goalDifference:r.goalDifference;
    return `<tr class="${cls}">
      <td>${r.position}</td><td>${r.team.name}</td>
      <td>${r.playedGames}</td><td>${r.won}</td><td>${r.draw}</td><td>${r.lost}</td>
      <td>${r.goalsFor}</td><td>${r.goalsAgainst}</td><td>${gd}</td><td>${r.points}</td>
    </tr>`;
  }).join('');
  const comp=COMP_NAMES[APP.compCode]||'';
  document.getElementById('s-table').innerHTML=`
    <div class="section-title">${comp}</div>
    <div class="table-wrap"><table>
      <thead><tr><th>#</th><th>Team</th><th>P</th><th>W</th><th>D</th><th>L</th><th>GF</th><th>GA</th><th>GD</th><th>Pts</th></tr></thead>
      <tbody>${rowHtml}</tbody>
    </table></div>
    <div style="display:flex;gap:18px;margin-top:10px;flex-wrap:wrap">
      <div style="display:flex;align-items:center;gap:5px;font-size:11px;color:var(--muted)"><div style="width:3px;height:13px;background:var(--good)"></div>Auto promotion</div>
      <div style="display:flex;align-items:center;gap:5px;font-size:11px;color:var(--muted)"><div style="width:3px;height:13px;background:#2563EB"></div>Play-offs</div>
      <div style="display:flex;align-items:center;gap:5px;font-size:11px;color:var(--muted)"><div style="width:3px;height:13px;background:var(--bad)"></div>Relegation</div>
    </div>`;
}

/* ══════════════════════════════════════════
   RENDER: SQUADS
══════════════════════════════════════════ */
let homeSquadData=[], awaySquadData=[];

function renderSquads(){
  homeSquadData=[...(APP.homeTeam?.squad||[])].sort((a,b)=>(a.shirtNumber||99)-(b.shirtNumber||99));
  awaySquadData=[...(APP.awayTeam?.squad||[])].sort((a,b)=>(a.shirtNumber||99)-(b.shirtNumber||99));
  const hName=APP.match.homeTeam.name, aName=APP.match.awayTeam.name;
  document.getElementById('s-squads').innerHTML=
    squadCard(homeSquadData,'home',hName)+squadCard(awaySquadData,'away',aName);
}
function squadCard(squad,side,teamName){
  if(!squad.length) return `<div class="card"><div class="section-title">${teamName}</div><div class="section-empty">Squad not loaded</div></div>`;
  return `<div class="card">
    <div class="section-title">${teamName}</div>
    <div class="squad-controls">
      <button class="squad-btn active" onclick="sortSquadDyn('${side}','num',this)">By Number</button>
      <button class="squad-btn" onclick="sortSquadDyn('${side}','name',this)">By Surname</button>
    </div>
    <div class="squad-grid" id="sq-${side}">${renderSquadGrid(squad)}</div>
  </div>`;
}
function renderSquadGrid(squad){
  return squad.map(p=>`<div class="squad-player">
    <span class="squad-num">${p.shirtNumber||'—'}</span>
    <span class="squad-name">${p.name}</span>
    <span class="squad-pos">${mapPos(p.position)}</span>
  </div>`).join('');
}
function sortSquadDyn(side,by,btn){
  const data=side==='home'?[...homeSquadData]:[...awaySquadData];
  const sorted=by==='num'?data.sort((a,b)=>(a.shirtNumber||99)-(b.shirtNumber||99)):
    data.sort((a,b)=>a.name.split(' ').pop().localeCompare(b.name.split(' ').pop()));
  document.getElementById('sq-'+side).innerHTML=renderSquadGrid(sorted);
  btn.parentElement.querySelectorAll('.squad-btn').forEach(b=>b.classList.remove('active'));
  btn.classList.add('active');
}

/* ══════════════════════════════════════════
   RENDER: PRODUCTION TAB — TEAM OVERVIEW
══════════════════════════════════════════ */
function renderProdTeams(){
  const m=APP.match;
  const hName=m.homeTeam.name, aName=m.awayTeam.name;
  const hc=teamColor(hName), ac=teamColor(aName);
  const hCoach=APP.homeTeam?.coach, aCoach=APP.awayTeam?.coach;
  const venue=m.venue||(APP.homeTeam?.venue)||'';
  function teamCard(name,color,coach,extra){
    const ini=initials(name);
    const coachName=coach?.name||'—';
    const coachSince=coach?.contract?.start?`Appointed ${fmtShortDate(coach.contract.start)}`:'';
    return `<div class="team-info-card">
      <div class="team-colour-strip" style="background:${color}"></div>
      <div class="team-info-name" style="color:${color}">${name}</div>
      <div class="team-info-manager">
        <div class="mgr-photo" style="background:${color}">${initials(coachName)}</div>
        <div>
          <div style="font-size:10px;font-weight:600;text-transform:uppercase;letter-spacing:1.5px;color:var(--muted);margin-bottom:2px">Head Coach</div>
          <div style="font-size:15px;font-weight:600">${coachName}</div>
          ${coachSince?`<div style="font-size:11px;color:var(--muted)">${coachSince}</div>`:''}
        </div>
      </div>
      <div class="team-colours">
        <div class="colour-swatch" style="background:${color}"></div>
        <div class="colour-swatch" style="background:#FFF;border:1px solid #ccc"></div>
        <span class="colour-label">${name}</span>
      </div>
      ${extra}
    </div>`;
  }
  const hExtra=`<div style="margin-top:9px;font-size:11px;color:var(--muted)">Stadium: <strong>${venue}</strong></div>`;
  document.getElementById('s-prod-teams').innerHTML=
    teamCard(hName,hc,hCoach,hExtra)+teamCard(aName,ac,aCoach,'');

  // Update ground notes title and load ground-specific notes
  const venueSlug=slugify(venue||'ground');
  document.getElementById('ground-notes-title').textContent=`${venue||'Ground'} · Ground Notes`;
  const gKey='groundNotes_'+venueSlug;
  document.getElementById('ground-notes').value=localStorage.getItem(gKey)||'';
  currentGroundKey='groundLayout_'+venueSlug;
  currentGroundNotesKey=gKey;
  loadMarkers();
}

/* ══════════════════════════════════════════
   RENDER: PRINT VIEW
══════════════════════════════════════════ */
function renderPrintView(){
  if(!APP.match) return;
  const m=APP.match;
  const hName=m.homeTeam.name, aName=m.awayTeam.name;
  const hc=teamColor(hName), ac=teamColor(aName);
  const hCoach=APP.homeTeam?.coach, aCoach=APP.awayTeam?.coach;
  const hForm=getLastN(APP.homeForm?.matches||[],m.homeTeam.id,5);
  const aForm=getLastN(APP.awayForm?.matches||[],m.awayTeam.id,5);
  const mId=m.id;
  const hScout=localStorage.getItem(scoutKey('home',mId))||'';
  const aScout=localStorage.getItem(scoutKey('away',mId))||'';
  const hKp=loadKp('home',mId);
  const aKp=loadKp('away',mId);

  function pvFormStrip(matches,teamId){
    return matches.map(mx=>{
      const {r,gf,ga,opp}=matchResult(mx,teamId);
      const abbr=opp.split(' ').pop().slice(0,3).toUpperCase();
      return `<div class="pv-form-item">
        <div class="pv-fp ${r}">${r}</div>
        <div class="pv-fc">${abbr}</div>
        <div class="pv-fs">${gf}–${ga}</div>
      </div>`;
    }).join('');
  }

  function pvPitch(xiData,color,side){
    if(!xiData) return '<div style="border:1.5px dashed #ccc;height:155px;display:flex;align-items:center;justify-content:center;font-size:8px;color:#999">No XI data</div>';
    const fkey=xiData.formation||'4-4-2';
    const layout=formations[fkey]||formations['4-4-2'];
    const players=xiData.players||[];
    const cols=side==='away'?[...layout].reverse():layout;
    let pIdx=0;
    const colHtml=cols.map(col=>{
      const cells=Array.from({length:col[0]}).map(()=>{
        const p=players[pIdx]||{name:''};
        pIdx++;
        return `<div class="pv-pp">
          <div class="pv-pp-av" style="background:${color}">${p.name?initials(p.name):''}</div>
          <div class="pv-pp-name">${p.name?p.name.split(' ').pop():''}</div>
        </div>`;
      }).join('');
      return `<div class="pv-pcol">${cells}</div>`;
    }).join('');
    return `<div class="pv-pitch ${side==='home'?'home-p':'away-p'}">${colHtml}</div>`;
  }

  const hXi=loadXiFromStorage('home'), aXi=loadXiFromStorage('away');
  const hSquad=homeSquadData, aSquad=awaySquadData;

  function pvSquad(squad){
    return squad.map(p=>`<div class="pv-sq"><span class="pv-sq-num">${p.shirtNumber||'—'}</span>${p.name.split(' ').pop()}</div>`).join('');
  }

  function pvNotes(text){
    if(!text) return '<div style="font-size:8px;color:#aaa;font-style:italic">No scout notes entered</div>';
    return text.split('\n').filter(l=>l.trim()).map(l=>`<div class="pv-note">${escHtml(l)}</div>`).join('');
  }

  let hPos='', aPos='';
  if(APP.table){
    const rows=(APP.table.standings||[]).find(s=>s.type==='TOTAL')?.table||[];
    const hRow=rows.find(r=>r.team.id===m.homeTeam.id);
    const aRow=rows.find(r=>r.team.id===m.awayTeam.id);
    if(hRow) hPos=ordinal(hRow.position);
    if(aRow) aPos=ordinal(aRow.position);
  }

  document.getElementById('print-view').innerHTML=`
    <div class="pv-banner">
      <div>
        <div class="pv-team-name" style="color:${hc}">${hName}</div>
        <div class="pv-team-meta">${hPos||''} · ${m.venue||''} · ${COMP_NAMES[m.compCode]||''}</div>
      </div>
      <div class="pv-vs-block">
        <div class="pv-vs">VS</div>
        <div class="pv-match-info">${fmtDate(m.utcDate)}</div>
      </div>
      <div style="text-align:right">
        <div class="pv-team-name" style="color:${ac}">${aName}</div>
        <div class="pv-team-meta">${aPos||''}</div>
      </div>
    </div>

    <div class="pv-two">
      <div class="pv-col">
        <div class="pv-mgr-form-row">
          <div class="pv-mgr">
            <div class="pv-mgr-av" style="background:${hc}">${hCoach?initials(hCoach.name):'?'}</div>
            <div>
              <div class="pv-mgr-name">${hCoach?.name||'—'}</div>
              <div class="pv-mgr-since">Manager${hCoach?.contract?.start?' · '+fmtShortDate(hCoach.contract.start):''}</div>
            </div>
          </div>
          <div class="pv-form-side">
            <div class="pv-section-label">Last 5 Matches</div>
            <div class="pv-form-strip">${pvFormStrip(hForm,m.homeTeam.id)}</div>
          </div>
        </div>
        <div class="pv-section-label">Scout Notes</div>
        <div class="pv-notes">${pvNotes(hScout)}</div>
      </div>
      <div class="pv-col">
        <div class="pv-mgr-form-row">
          <div class="pv-mgr">
            <div class="pv-mgr-av" style="background:${ac}">${aCoach?initials(aCoach.name):'?'}</div>
            <div>
              <div class="pv-mgr-name">${aCoach?.name||'—'}</div>
              <div class="pv-mgr-since">Manager${aCoach?.contract?.start?' · '+fmtShortDate(aCoach.contract.start):''}</div>
            </div>
          </div>
          <div class="pv-form-side">
            <div class="pv-section-label">Last 5 Matches</div>
            <div class="pv-form-strip">${pvFormStrip(aForm,m.awayTeam.id)}</div>
          </div>
        </div>
        <div class="pv-section-label">Scout Notes</div>
        <div class="pv-notes">${pvNotes(aScout)}</div>
      </div>
    </div>

    <div class="pv-section-label" style="margin-bottom:6px">Expected Formations</div>
    <div class="pv-formations">
      <div>
        <div class="pv-pitch-header">
          <span class="pv-pitch-ftag" style="color:${hc}">${(hXi?.formation||'—').replace(/-/g,'–')}</span>
          <span class="pv-pitch-team">${hName}</span>
          <span class="pv-pitch-note">Attacking →</span>
        </div>
        ${pvPitch(hXi,hc,'home')}
      </div>
      <div>
        <div class="pv-pitch-header">
          <span class="pv-pitch-note">← Attacking</span>
          <span class="pv-pitch-team">${aName}</span>
          <span class="pv-pitch-ftag" style="color:${ac}">${(aXi?.formation||'—').replace(/-/g,'–')}</span>
        </div>
        ${pvPitch(aXi,ac,'away')}
      </div>
    </div>

    <div class="pv-two" style="margin-bottom:0">
      <div>
        <div class="pv-section-label">${hName}</div>
        <div class="pv-squad-list">${pvSquad(hSquad)}</div>
      </div>
      <div>
        <div class="pv-section-label">${aName}</div>
        <div class="pv-squad-list">${pvSquad(aSquad)}</div>
      </div>
    </div>

    <div class="pv-footer">
      Match Prep · ${COMP_NAMES[m.compCode]||''} · ${hName} vs ${aName} · ${fmtShortDate(m.utcDate)} · Data: football-data.org
    </div>`;
}

/* ══════════════════════════════════════════
   GROUND LAYOUT
══════════════════════════════════════════ */
let currentGroundKey='groundLayout_default';
let currentGroundNotesKey='groundNotes_default';
const MARKER_CONFIG={
  'cam3':    {label:'Cam 3',    color:'#16A34A',shape:'circle',w:0, h:0},
  'cam4':    {label:'Cam 4',    color:'#9333EA',shape:'circle',w:0, h:0},
  'dugouts': {label:'Dugouts',  color:'#CA8A04',shape:'rect',  w:60,h:22},
  'away-fans':{label:'Away Fans',color:'#B45309',shape:'rect', w:70,h:30},
  'tunnel':  {label:'Tunnel',   color:'#374151',shape:'square',w:26,h:26},
};
let currentPlaceType='cam3';
let markers={};

function svgCoordsFromEvent(e){
  const svg=document.getElementById('ground-svg');
  const rect=svg.getBoundingClientRect();
  const vb=svg.viewBox.baseVal;
  return{x:Math.round((e.clientX-rect.left)/rect.width*vb.width),y:Math.round((e.clientY-rect.top)/rect.height*vb.height)};
}
function loadMarkers(){
  const saved=localStorage.getItem(currentGroundKey);
  if(saved){try{markers=JSON.parse(saved);}catch{markers={};}}else{markers={};}
  renderMarkers();
}
function saveMarkers(){localStorage.setItem(currentGroundKey,JSON.stringify(markers));}
function setPlaceType(type,btn){
  currentPlaceType=type;
  document.querySelectorAll('.place-type-btn').forEach(b=>b.classList.remove('active'));
  btn.classList.add('active');
}
function clearAllMarkers(){markers={};saveMarkers();renderMarkers();}

document.getElementById('ground-svg').addEventListener('click',e=>{
  const pos=svgCoordsFromEvent(e);
  markers[currentPlaceType]=pos;
  saveMarkers();renderMarkers();
});

function renderMarkers(){
  const layer=document.getElementById('marker-layer');
  layer.innerHTML='';
  Object.entries(markers).forEach(([type,pos])=>{
    const cfg=MARKER_CONFIG[type];
    if(!cfg) return;
    const g=document.createElementNS('http://www.w3.org/2000/svg','g');
    g.setAttribute('transform',`translate(${pos.x},${pos.y})`);
    g.style.cursor='grab';
    if(cfg.shape==='circle'){
      const c=document.createElementNS('http://www.w3.org/2000/svg','circle');
      c.setAttribute('r','14');c.setAttribute('fill',cfg.color);c.setAttribute('stroke','white');c.setAttribute('stroke-width','2');
      g.appendChild(c);
    }else{
      const hw=Math.round(cfg.w/2),hh=Math.round(cfg.h/2);
      const r=document.createElementNS('http://www.w3.org/2000/svg','rect');
      r.setAttribute('x',-hw);r.setAttribute('y',-hh);r.setAttribute('width',cfg.w);r.setAttribute('height',cfg.h);
      r.setAttribute('rx','3');r.setAttribute('fill',cfg.color);r.setAttribute('stroke','white');r.setAttribute('stroke-width','1.5');
      g.appendChild(r);
    }
    const txt=document.createElementNS('http://www.w3.org/2000/svg','text');
    txt.setAttribute('text-anchor','middle');txt.setAttribute('dy','4');
    txt.setAttribute('font-family','Barlow Condensed,sans-serif');txt.setAttribute('font-weight','700');
    txt.setAttribute('font-size',cfg.shape==='circle'?'10':'9');txt.setAttribute('fill','white');txt.setAttribute('letter-spacing','0.5');
    txt.textContent=cfg.label;g.appendChild(txt);
    let dragging=false,startX,startY,origX,origY;
    g.addEventListener('mousedown',e=>{e.stopPropagation();dragging=true;startX=e.clientX;startY=e.clientY;origX=markers[type].x;origY=markers[type].y;g.style.cursor='grabbing';});
    document.addEventListener('mousemove',e=>{
      if(!dragging) return;
      const svg=document.getElementById('ground-svg');const rect=svg.getBoundingClientRect();const vb=svg.viewBox.baseVal;
      markers[type].x=Math.round(origX+(e.clientX-startX)/rect.width*vb.width);
      markers[type].y=Math.round(origY+(e.clientY-startY)/rect.height*vb.height);
      renderMarkers();
    });
    document.addEventListener('mouseup',()=>{if(dragging){saveMarkers();dragging=false;}});
    g.addEventListener('dblclick',e=>{e.stopPropagation();delete markers[type];saveMarkers();renderMarkers();});
    layer.appendChild(g);
  });
  updateMarkerLegend();
}
function updateMarkerLegend(){
  const fixed=[
    `<div class="marker-legend-item"><div style="width:12px;height:12px;border-radius:50%;background:#F97316"></div><span style="font-weight:600">Cam 1</span><span style="color:var(--muted);font-size:10px"> · fixed</span></div>`,
    `<div class="marker-legend-item"><div style="width:12px;height:12px;border-radius:50%;background:#2563EB"></div><span style="font-weight:600">Cam 2</span><span style="color:var(--muted);font-size:10px"> · fixed</span></div>`,
  ];
  const placed=Object.keys(markers).filter(t=>MARKER_CONFIG[t]).map(t=>{
    const cfg=MARKER_CONFIG[t];
    return `<div class="marker-legend-item"><div style="width:12px;height:12px;border-radius:${cfg.shape==='circle'?'50%':'3px'};background:${cfg.color}"></div><span style="font-weight:600">${cfg.label}</span><span style="color:var(--muted);font-size:10px"> — dbl-click to remove</span></div>`;
  });
  document.getElementById('marker-legend').innerHTML=[...fixed,...placed].join('');
}
loadMarkers();

/* ── Ground Notes ── */
function saveGroundNotes(){
  localStorage.setItem(currentGroundNotesKey,document.getElementById('ground-notes').value);
  const msg=document.getElementById('ground-notes-saved');
  msg.classList.add('show');setTimeout(()=>msg.classList.remove('show'),2000);
}

/* ══════════════════════════════════════════
   CAMERA OPERATORS
══════════════════════════════════════════ */
const NUM_CAMS=4;
const CAM_COLORS=['#F97316','#2563EB','#16A34A','#9333EA'];
const OPS_DB_KEY='camOperatorsDB';
function getOpsDB(){return JSON.parse(localStorage.getItem(OPS_DB_KEY)||'[]');}
function saveOpToDatabase(name){
  if(!name.trim()) return;
  const db=getOpsDB();
  if(!db.includes(name.trim())) db.push(name.trim());
  db.sort();
  localStorage.setItem(OPS_DB_KEY,JSON.stringify(db));
}

function camKey(i){
  const mId=APP.match?.id||'default';
  return `camop_${i}_${mId}`;
}

function buildCamOps(){
  const grid=document.getElementById('cam-ops-grid');
  grid.innerHTML='';
  for(let i=0;i<NUM_CAMS;i++){
    const saved=JSON.parse(localStorage.getItem(camKey(i))||'{}');
    const histHTML=getOperatorHistory(saved.name);
    grid.innerHTML+=`
    <div class="cam-op-card">
      <div class="cam-op-header">
        <div class="cam-op-label" style="color:${CAM_COLORS[i]}">Camera ${i+1}</div>
        <div style="width:10px;height:10px;border-radius:50%;background:${CAM_COLORS[i]}"></div>
      </div>
      <div class="cam-name-wrap">
        <input class="cam-op-input" id="camop-name-${i}" placeholder="Type or select operator…"
          value="${escHtml(saved.name||'')}" oninput="onCamNameInput(${i})" onfocus="openDropdown(${i})" onblur="closeDropdown(${i})" autocomplete="off">
        <div class="cam-dropdown" id="cam-dd-${i}"></div>
      </div>
      <div class="star-row">
        <div class="stars" id="stars-${i}">
          ${[1,2,3,4,5].map(n=>`<span class="star${(saved.rating||0)>=n?' active':''}" onmousedown="setRating(${i},${n})">★</span>`).join('')}
        </div>
        <span class="saved-inline" id="star-saved-${i}">✓</span>
      </div>
      <textarea class="cam-op-notes" id="camop-notes-${i}"
        placeholder="Notes for this game…" onblur="saveCamOp(${i})">${escHtml(saved.notes||'')}</textarea>
      <div class="cam-op-history" id="camop-hist-${i}">${histHTML}</div>
    </div>`;
  }
}
function getOperatorHistory(name){
  if(!name) return '';
  const h=JSON.parse(localStorage.getItem(`camopHist_${name.trim()}`)||'null');
  if(!h||!h.count) return '';
  const avg=h.total/h.count;
  return `<div>Avg for <strong>${name}</strong>: ${'★'.repeat(Math.round(avg))}${'☆'.repeat(5-Math.round(avg))} (${h.count} match${h.count===1?'':'es'})</div>`;
}
function onCamNameInput(i){
  const val=document.getElementById(`camop-name-${i}`).value.toLowerCase();
  const db=getOpsDB();const matches=db.filter(n=>n.toLowerCase().includes(val));
  const dd=document.getElementById(`cam-dd-${i}`);
  if(matches.length&&val){dd.innerHTML=matches.map(n=>`<div class="cam-dd-item" onmousedown="selectOp(${i},'${n.replace(/'/g,"\\'")}')">${n}</div>`).join('');dd.classList.add('open');}
  else dd.classList.remove('open');
  saveCamOp(i);
}
function openDropdown(i){
  const db=getOpsDB();const dd=document.getElementById(`cam-dd-${i}`);
  if(db.length){dd.innerHTML=db.map(n=>`<div class="cam-dd-item" onmousedown="selectOp(${i},'${n.replace(/'/g,"\\'")}')">${n}</div>`).join('');dd.classList.add('open');}
}
function closeDropdown(i){setTimeout(()=>{const dd=document.getElementById(`cam-dd-${i}`);if(dd)dd.classList.remove('open');},150);}
function selectOp(i,name){
  document.getElementById(`camop-name-${i}`).value=name;
  document.getElementById(`cam-dd-${i}`).classList.remove('open');
  document.getElementById(`camop-hist-${i}`).innerHTML=getOperatorHistory(name);
  saveCamOp(i);
}
function setRating(i,r){
  const saved=JSON.parse(localStorage.getItem(camKey(i))||'{}');
  saved.rating=r;saved.name=document.getElementById(`camop-name-${i}`).value;
  localStorage.setItem(camKey(i),JSON.stringify(saved));
  document.querySelectorAll(`#stars-${i} .star`).forEach((s,j)=>s.classList.toggle('active',j<r));
  const msg=document.getElementById(`star-saved-${i}`);
  msg.classList.add('show');setTimeout(()=>msg.classList.remove('show'),1800);
  updateOperatorHistory(i);
}
function saveCamOp(i){
  const saved=JSON.parse(localStorage.getItem(camKey(i))||'{}');
  saved.name=document.getElementById(`camop-name-${i}`).value;
  saved.notes=document.getElementById(`camop-notes-${i}`).value;
  localStorage.setItem(camKey(i),JSON.stringify(saved));
  if(saved.name) saveOpToDatabase(saved.name);
}
function updateOperatorHistory(i){
  const saved=JSON.parse(localStorage.getItem(camKey(i))||'{}');
  if(!saved.name||!saved.rating) return;
  const hk=`camopHist_${saved.name.trim()}`;
  const h=JSON.parse(localStorage.getItem(hk)||'{"count":0,"total":0}');
  h.total=(h.total||0)+saved.rating;h.count=(h.count||0)+1;
  localStorage.setItem(hk,JSON.stringify(h));
  document.getElementById(`camop-hist-${i}`).innerHTML=getOperatorHistory(saved.name);
}
buildCamOps();

/* ══════════════════════════════════════════
   CONFIRMED XI
══════════════════════════════════════════ */
const formations={
  '4-4-2':  [[1],[4],[4],[2]],
  '4-3-3':  [[1],[4],[3],[3]],
  '4-2-3-1':[[1],[4],[2],[3],[1]],
  '4-3-1-2':[[1],[4],[3],[1],[2]],
  '3-5-2':  [[1],[3],[5],[2]],
  '3-4-3':  [[1],[3],[4],[3]],
  '5-3-2':  [[1],[5],[3],[2]],
  '5-4-1':  [[1],[5],[4],[1]],
};
let currentXiTeam='home';
const xiData={
  home:{formation:'4-4-2',players:Array(11).fill(null).map(()=>({num:'',name:'',pos:''}))},
  away:{formation:'4-4-2',players:Array(11).fill(null).map(()=>({num:'',name:'',pos:''}))}
};

function updateXiTeamButtons(){
  if(!APP.match) return;
  document.getElementById('xi-btn-home').textContent=APP.match.homeTeam.name;
  document.getElementById('xi-btn-away').textContent=APP.match.awayTeam.name;
}

function switchXiTeam(team,btn){
  currentXiTeam=team;
  document.querySelectorAll('.xi-team-btn').forEach(b=>b.classList.remove('active-home','active-away'));
  btn.classList.add('active-'+team);
  const color=team==='home'?'var(--home)':'var(--away)';
  const name=APP.match?(team==='home'?APP.match.homeTeam.name:APP.match.awayTeam.name):(team==='home'?'Home Team':'Away Team');
  document.getElementById('xi-pitch-title').style.color=color;
  document.getElementById('xi-pitch-title').textContent=name;
  loadXiData();
}

function xiStorageKey(side){
  const mId=APP.match?.id||'default';
  return `xi_${side}_${mId}`;
}

const XI_POSITIONS=['GK','RB','CB','LB','CM','DM','AM','LM','RM','LW','RW','ST','CF'];
function buildXiInputs(){
  const d=xiData[currentXiTeam];
  const squad=currentXiTeam==='home'?(APP.homeTeam?.squad||[]):(APP.awayTeam?.squad||[]);
  const dlId=`xi-squad-dl-${currentXiTeam}`;
  document.getElementById('xi-formation').value=d.formation;
  const dl=`<datalist id="${dlId}">${squad.map(p=>`<option value="${p.name}"></option>`).join('')}</datalist>`;
  document.getElementById('xi-inputs').innerHTML=dl+d.players.map((p,i)=>`
    <div class="xi-player-row">
      <div class="xi-num">${i+1}</div>
      <div style="position:relative">
        <input class="xi-input" id="xi-p-name-${i}" value="${escHtml(p.name||'')}" placeholder="Player name…"
          list="${dlId}" oninput="updateXiPlayer(${i})" autocomplete="off">
      </div>
      <select class="xi-pos-select" id="xi-p-pos-${i}" onchange="updateXiPlayer(${i})">
        ${XI_POSITIONS.map(pos=>`<option${p.pos===pos?' selected':''}>${pos}</option>`).join('')}
      </select>
    </div>`).join('');
}

function updateXiPlayer(i){
  xiData[currentXiTeam].players[i].name=document.getElementById(`xi-p-name-${i}`).value;
  xiData[currentXiTeam].players[i].pos=document.getElementById(`xi-p-pos-${i}`).value;
  renderXiPitch();
}

function renderXiPitch(){
  const fkey=document.getElementById('xi-formation').value;
  xiData[currentXiTeam].formation=fkey;
  document.getElementById('xi-formation-badge').textContent=fkey.replace(/-/g,'–');
  const layout=formations[fkey]||formations['4-4-2'];
  const players=xiData[currentXiTeam].players;
  const color=currentXiTeam==='home'?'var(--home)':'var(--away)';
  let pIdx=0;
  const pitch=document.getElementById('xi-pitch');
  pitch.innerHTML='';
  layout.forEach(col=>{
    const colEl=document.createElement('div');
    colEl.className='xi-col';
    for(let i=0;i<col[0];i++){
      const p=players[pIdx]||{name:'',pos:''};
      const ini=p.name?initials(p.name):String(pIdx+1);
      colEl.innerHTML+=`<div class="xi-player-node">
        <div class="xi-avatar" style="background:${color}">${ini}</div>
        <div class="xi-pname">${p.name||'—'}</div>
        <div class="xi-ppos">${p.pos}</div>
      </div>`;
      pIdx++;
    }
    pitch.appendChild(colEl);
  });
}

function saveXiData(){
  localStorage.setItem(xiStorageKey(currentXiTeam),JSON.stringify(xiData[currentXiTeam]));
  const msg=document.getElementById('xi-saved-msg');
  msg.classList.add('show');setTimeout(()=>msg.classList.remove('show'),2000);
  renderFormations(); // update formations section in match tab
  renderPrintView();
}

function loadXiData(){
  const saved=JSON.parse(localStorage.getItem(xiStorageKey(currentXiTeam))||'null');
  if(saved) xiData[currentXiTeam]=saved;
  buildXiInputs();
  renderXiPitch();
}

function fillXiFromSquad(){
  const squad=currentXiTeam==='home'?(APP.homeTeam?.squad||[]):(APP.awayTeam?.squad||[]);
  if(!squad.length){alert('Squad not loaded yet. Please wait for data to load.');return;}
  const fkey=document.getElementById('xi-formation').value;
  const layout=formations[fkey]||formations['4-4-2'];
  const GK=['Goalkeeper'],DEF=['Defence','Defender'],MID=['Midfield','Midfielder'],FWD=['Offence','Attacker'];
  const nCols=layout.length;
  const colPrefs=layout.map((_,i)=>{
    if(i===0) return GK;
    if(i===nCols-1) return FWD;
    if(nCols===3) return MID;
    if(nCols===4) return i===1?DEF:MID;
    if(nCols===5) return i===1?DEF:i===2?[...MID,...DEF]:FWD;
    return MID;
  });
  function pickBest(pool,used,prefs){
    for(const pos of prefs){const m=pool.find(p=>!used.has(p.id)&&p.position===pos);if(m) return m;}
    return pool.find(p=>!used.has(p.id))||null;
  }
  const used=new Set();const players=[];
  layout.forEach((col,ci)=>{
    for(let i=0;i<col[0];i++){
      const p=pickBest(squad,used,colPrefs[ci]);
      if(p){used.add(p.id);players.push({num:String(p.shirtNumber||''),name:p.name,pos:mapPos(p.position)});}
      else players.push({num:'',name:'',pos:''});
    }
  });
  while(players.length<11) players.push({num:'',name:'',pos:''});
  xiData[currentXiTeam].players=players.slice(0,11);
  buildXiInputs();renderXiPitch();
}

/* Import API lineup when available */
async function importApiLineup(){
  if(!APP.match){alert('No match selected.');return;}
  const btn=document.getElementById('xi-api-import');
  btn.textContent='Loading…';btn.disabled=true;
  try{
    const d=await apiGet(`/matches/${APP.match.id}`);
    cachePut(`match_${APP.match.id}`,d);
    APP.matchDetail=d;
    const side=currentXiTeam==='home'?d.homeTeam:d.awayTeam;
    const lineup=side.lineup||[];
    if(!lineup.length){alert('Lineup not published yet. Check back closer to kick-off.');return;}
    xiData[currentXiTeam].players=lineup.slice(0,11).map(p=>({
      num:String(p.shirtNumber||''),
      name:p.name||'',
      pos:mapPos(p.position),
    }));
    while(xiData[currentXiTeam].players.length<11) xiData[currentXiTeam].players.push({num:'',name:'',pos:''});
    buildXiInputs();renderXiPitch();
    alert('Lineup imported! Check positions and save.');
  }catch(e){
    alert(e.code==='AUTH'?'Invalid API key.':e.code==='RATE_LIMIT'?'Rate limited — try again in a moment.':'Could not load lineup.');
  }finally{
    btn.textContent='↓ Import API Lineup';btn.disabled=false;
  }
}

/* ══════════════════════════════════════════
   TAB SWITCH
══════════════════════════════════════════ */
function switchTab(id,btn){
  document.querySelectorAll('.tab-panel').forEach(p=>p.classList.remove('active'));
  document.querySelectorAll('.tab-btn').forEach(b=>b.classList.remove('active'));
  document.getElementById('tab-'+id).classList.add('active');
  btn.classList.add('active');
  if(id==='xi') loadXiData();
  if(id==='production') buildCamOps();
}

/* ══════════════════════════════════════════
   INIT
══════════════════════════════════════════ */
(function init(){
  // Load kit images from data/kits.json (best-effort — fails silently if not present)
  fetch('data/kits.json')
    .then(r=>r.ok?r.json():Promise.reject())
    .then(data=>{ APP.kits=data||{}; })
    .catch(()=>{}); // no kits.json yet — colour fallbacks used

  // Load injury data from data/injuries.json (best-effort)
  fetch('data/injuries.json')
    .then(r=>r.ok?r.json():Promise.reject())
    .then(data=>{ APP.injuries=data||{}; })
    .catch(()=>{});

  // Restore saved match
  const saved=localStorage.getItem(LS_MATCH);
  if(saved){
    try{
      const m=JSON.parse(saved);
      APP.match=m;
      APP.compCode=m.compCode;
      setHomeAwayColors(m.homeTeam.name,m.awayTeam.name);
      showAppUI();
      renderBanner();
      setLoadingState();
      loadMatchData(m,m.compCode);
      return;
    }catch{}
  }
  // No saved match — show selector
  showSelector();
  // Set default date
  document.getElementById('sel-date').value=new Date().toISOString().split('T')[0];
})();
