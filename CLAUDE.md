# CLAUDE.md — EFL Match Prep Tool

## Session Usage Warning

**Monitor context usage throughout every conversation.** When the conversation is getting long and the context window is likely approaching ~75% full, warn the user with a brief message like:

> ⚠️ **Heads up:** This session is getting long — context window is probably around 75% full. Consider starting a fresh conversation soon to avoid truncation.

Repeat the warning if the conversation continues to grow significantly after the first alert.

---

## Project Overview

Single-file web app for preparing broadcast coverage of EFL football matches. Built in HTML/CSS/JS, runs from GitHub Pages with no backend.

**Current files:** `index.html` (markup/structure) + `app.js` (all JS logic) + `style.css` (styles) — always edit these directly, never create new files  
**Demo fixture:** Wycombe Wanderers vs Rotherham United · 2 May 2026 · Sky Bet League One  
**Data:** Hardcoded JSON for demo match — live data pipeline not yet built

---

## Key Rules When Editing

1. Always edit `match-prep.html` directly — do not create a new file
2. Do not change localStorage key names without a migration plan (they hold live user data)
3. The snap zone coordinates in the ground layout map to a 700×420 SVG viewBox — pitch occupies x48–x652, y48–y372
4. Formation rendering is column-based left-to-right: each column in the `formations` object is `[[playerCount]]`, columns ordered GK→FWD
5. Demo data (Wycombe vs Rotherham) is hardcoded — treat as fixture data to be replaced by a future data pipeline

---

## localStorage Keys

| Key | Contents |
|---|---|
| `groundLayout_adams_park` | Camera/dugout/fans marker positions for Adams Park |
| `groundNotes_adams_park` | Ground-specific notes for Adams Park |
| `camop_0_wycrot` … `camop_3_wycrot` | Camera operator name, rating, notes for this match |
| `camOperatorsDB` | Global list of all operator names ever entered |
| `camopHist_{name}` | Running total + count of ratings for each named operator |
| `xi_home_wycrot` | Confirmed XI data (formation + players) for home team |
| `xi_away_wycrot` | Confirmed XI data (formation + players) for away team |

---

## What's Not Built Yet

- Team/match selector (currently locked to demo fixture)
- Live data pipeline — see **Data Pipeline** section below
- Real kit/player/manager images (placeholders in place, slots are image-ready)
- Referee data and card tendency stats
- Suspension tracker (yellow card accumulations)
- Home/away form splits, goals by time period, set piece stats
- Multi-device data sync (localStorage only)
- GitHub Pages deployment config

---

## Data Pipeline (Real Build)

All live data via **football-data.org** API (free tier covers EFL). API key injected at build time — never hardcoded in source.

**Match selection flow:**
1. User selects competition (Championship / League One / League Two) and date
2. `GET /competitions/{id}/matches?dateFrom=X&dateTo=X` → show fixtures on that date
3. User picks the relevant fixture
4. `GET /teams/{id}` for both teams → squad, crest, colours
5. `GET /matches/{id}` → lineups and referee once published (~1hr pre-kick-off)

**football-data.org competition IDs:**
- Championship: `ELC` (id 26)
- League One: `EL1` (id 27 — confirm at build time)
- League Two: `EL2` (id 28 — confirm at build time)

**Confirmed XI:** the `fillXiFromSquad()` function is the current placeholder — replace its logic with a `GET /matches/{id}` call that reads `homeTeam.lineup` / `awayTeam.lineup` once available. The function signature and downstream rendering don't need to change.

---

## Player Images — Club Website Scraper (Real Build)

Player images are scraped from official club websites at build time and stored in own CDN/storage. Two scrapers cover all ~72 EFL clubs.

### Platform 1: Clubcast (Other Media / Drupal 11) — ~40–50% of clubs
Server-side rendered. Plain HTTP fetch works — no headless browser needed.

**Known Clubcast clubs (confirmed or listed as Other Media clients):**
Championship: Swansea City, West Brom, Cardiff City, Oxford United, Charlton Athletic  
League One: Plymouth Argyle, Peterborough United, Bolton Wanderers, Lincoln City, Exeter City, Port Vale  
League Two: Gillingham, Cambridge United, Newport County, Carlisle United, Bristol Rovers

**Squad page URL pattern:**
```
https://{club-domain}/players/{team-id}
https://{club-domain}/squad/{team-id}   ← some clubs use this form
```
e.g. `theposh.com/players/226`, `bwfc.co.uk/squad/68`, `swanseacity.com/players/149`

**Image CDN pattern (identical across all Clubcast clubs):**
```
https://cdn.{club-domain}/sites/default/files/styles/cc_960x960/public/{YYYY-MM}/{player-slug}.png
```
Squad page HTML contains `<img src="...">` tags with these URLs inline — parse with BeautifulSoup or similar. Also includes player name, squad number, and position.

### Platform 2: Gamechanger (EFL's own platform) — ~50–60% of clubs
Client-rendered JavaScript app. Requires Playwright/Puppeteer.

**Known Gamechanger clubs (confirmed):**
Championship: Millwall, Preston North End  
League One: Huddersfield Town, Burton Albion  
League Two: Notts County, Oldham Athletic, Swindon Town

EFL.com itself also runs on Gamechanger (`meta-generator: Gamechanger 1.27.2`).

**Image CDN:** All Gamechanger club images served from `images.gc.eflservices.co.uk` (EFL's central CDN). Since it's EFL's own platform, DOM structure is consistent across all Gamechanger clubs — one Playwright scraper covers all of them.

### Build strategy
1. Identify platform for each club (check `meta-generator` tag or footer credit)
2. Clubcast clubs → plain HTTP fetch + HTML parse
3. Gamechanger clubs → Playwright, wait for squad list to render, then parse DOM
4. Fall back to player initials placeholder if image fetch fails

---

## Design Decisions

- **Fonts:** Bebas Neue (headings), Barlow Condensed (labels/UI), DM Sans (body), DM Mono (stats)
- **Colours:** Clean/light, data-forward — white surfaces, warm off-white background, team colours as accents only
- **Formation layout:** Landscape, GK left→FWD right for home; reversed for away so teams face each other
- **Print layout:** A4 landscape, single page — squad lists suppressed, all key match data retained
