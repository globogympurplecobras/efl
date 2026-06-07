# EFL Match Prep Tool

A broadcast match preparation tool for EFL football coverage. Pick a fixture, get live data, plan your production.

**Live site:** _add GitHub Pages URL here once deployed_

---

## What it does

Select any EFL Championship, League One, or League Two fixture by date and the tool pulls live data from football-data.org to populate:

- **Manager cards** — name, appointment date
- **Form** — last 5 results with scorers, most recent match detail
- **Key players** — 5 editable slots per team, autocomplete from squad list, persisted per match
- **Scout notes** — freetext tactical notes per team, persisted per match
- **Injuries / availability** — freetext, persisted per match
- **Expected formations** — landscape pitch view, populated from the Confirmed XI tab
- **Head to head** — win/draw/loss record + most recent meeting with scorers
- **League table** — full standings with both teams highlighted, promotion/playoff/relegation zones marked
- **Squad lists** — sortable by number or surname

**Production tab**
- Ground layout diagram — place Cam 3, Cam 4, dugouts, away fans section, tunnel by clicking; drag to reposition; saved per venue
- Ground notes — freetext, saved per venue, reloads automatically for future matches at the same ground
- Camera operators — name (with autocomplete from history), star rating, match notes; rating history tracked across matches

**Confirmed XI tab**
- Enter formation and players for each team
- Autocomplete from live squad data
- "Fill from Squad" — auto-distributes squad by position to match the selected formation
- "Import API Lineup" — pulls the confirmed starting XI from the API once published (~1hr pre-kick-off)
- Formation view updates live in the Match Data tab

**Print / PDF**
- Browser print → A4 landscape, single page — managers, form, scout notes, formations, squad lists

---

## Data

All live data via [football-data.org](https://www.football-data.org/) free tier API, which covers all three EFL divisions.

| Competition | Code |
|---|---|
| Sky Bet Championship | `ELC` |
| Sky Bet League One | `EL1` |
| Sky Bet League Two | `EL2` |

Data is cached in `localStorage` for 1 hour (15 minutes for lineups) to stay within the free tier rate limit of 10 requests/minute.

### localStorage keys

| Key | Contents |
|---|---|
| `fdApiKey` | football-data.org API key |
| `currentMatch` | Last selected match (restored on reload) |
| `cache_{key}` | API response cache with timestamp |
| `groundLayout_{venueSlug}` | Camera/marker positions per venue |
| `groundNotes_{venueSlug}` | Ground notes per venue |
| `xi_home_{matchId}` / `xi_away_{matchId}` | Confirmed XI data per match |
| `kp_home_{matchId}` / `kp_away_{matchId}` | Key player entries per match |
| `scout_home_{matchId}` / `scout_away_{matchId}` | Scout notes per match |
| `inj_home_{matchId}` / `inj_away_{matchId}` | Injury notes per match |
| `camop_{0-3}_{matchId}` | Camera operator name, rating, notes per match |
| `camOperatorsDB` | Global list of all operator names (for autocomplete) |
| `camopHist_{name}` | Running rating average per operator |

---

## Files

| File | Contents |
|---|---|
| `index.html` | Markup — header, tabs, match selector overlay, ground layout SVG |
| `style.css` | All styles including print layout |
| `app.js` | All JavaScript — API layer, caching, rendering, localStorage |

---

## API key

Get a free key at [football-data.org](https://www.football-data.org/client/register). Enter it in the match selector overlay on first load — it's stored in `localStorage` and never leaves the browser.

---

## Planned

- Real kit and player images (slots are image-ready — replace initials avatars with `<img>`)
- Referee data and card tendency stats
- Suspension tracker (yellow card accumulations)
- Home/away form splits, goals by time period, set piece stats
- Multi-device sync (currently localStorage only)

---

## Design

- **Fonts:** Barlow Condensed (labels/UI), DM Sans (body), DM Mono (stats)
- **Colours:** Clean, data-forward — white surfaces, warm off-white background, team colours as CSS variable accents (`--home`, `--away`)
- **Formation layout:** Landscape, GK left→FWD right for home; mirrored for away so both teams face each other
