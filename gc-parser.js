/**
 * GameChanger Box Score PDF Parser — Node.js
 * Handles pdf-parse output from GameChanger box score PDFs.
 * Now also parses scorebook PDFs for per-at-bat result codes (spray chart data).
 */

const pdfParse = require('pdf-parse');

// ============================================================
// FIELDER -> SPRAY ANGLE MAPPING
// ============================================================
// Degrees from center (0 = straight up center field)
// Negative = left field side, Positive = right field side
const FIELDER_ANGLE = {
  '1': 0,    // pitcher (up the middle)
  '2': 0,    // catcher (back to pitcher)
  '3': 38,   // first base (right side)
  '4': 15,   // second base (right-center)
  '5': -38,  // third base (left side)
  '6': -18,  // shortstop (left-center)
  '7': -52,  // left field
  '8': 0,    // center field
  '9': 52,   // right field
};

// Approximate distance by hit type and fielder zone
function estimateDistance(hitType, fielder) {
  const f = parseInt(fielder) || 0;
  if (hitType === 'G' || hitType === 'SAC') {
    // Ground balls stay in infield
    if ([1,2,3,4,5,6].includes(f)) return 80 + Math.random() * 40;
    return 60 + Math.random() * 30;
  }
  if (hitType === 'L') {
    // Line drives — short to medium
    if ([3,4,5,6].includes(f)) return 90 + Math.random() * 50;
    if ([7,8,9].includes(f)) return 180 + Math.random() * 60;
    return 120 + Math.random() * 40;
  }
  if (hitType === 'F' || hitType === 'SF') {
    // Fly balls — medium to deep
    if ([3,4,5,6].includes(f)) return 100 + Math.random() * 60;
    if ([7,8,9].includes(f)) return 220 + Math.random() * 80;
    return 150 + Math.random() * 50;
  }
  if (hitType === 'HR') return 320 + Math.random() * 80;
  return 120 + Math.random() * 60;
}

// ============================================================
// PARSE AT-BAT RESULT CODE
// ============================================================
// Parses codes like: K, BB, HBP, G6-3, F8, L5, SF8, SAC2-3,
// 1B, 2B, 3B, HR, E6, FC4, etc.
function parseAtBatCode(code) {
  if (!code) return null;
  const c = code.trim().toUpperCase();

  // Strikeout
  if (c === 'K' || c === 'KL' || c === 'K-L') {
    return { result: 'K', hitType: null, fielder: null, direction: null, distance: null };
  }

  // Walk / HBP
  if (c === 'BB' || c === 'IBB') {
    return { result: 'BB', hitType: null, fielder: null, direction: null, distance: null };
  }
  if (c === 'HBP') {
    return { result: 'HBP', hitType: null, fielder: null, direction: null, distance: null };
  }

  // Home Run
  if (c === 'HR') {
    const dir = (Math.random() * 80) - 40; // random spray for now
    return { result: 'HR', hitType: 'HR', fielder: null, direction: parseFloat(dir.toFixed(1)), distance: 350 + Math.random() * 80 };
  }

  // SAC bunt: SAC1-3, SAC2-3 etc
  const sacMatch = c.match(/^SAC(\d)(?:-\d+)?$/);
  if (sacMatch) {
    const fielder = sacMatch[1];
    const dir = FIELDER_ANGLE[fielder] ?? 0;
    return { result: 'SAC', hitType: 'G', fielder, direction: dir + (Math.random() * 10 - 5), distance: estimateDistance('SAC', fielder) };
  }

  // Ground ball: G6-3, G1-3, G5-3 etc
  const groundMatch = c.match(/^G(\d)(?:-\d+)?$/);
  if (groundMatch) {
    const fielder = groundMatch[1];
    const dir = FIELDER_ANGLE[fielder] ?? 0;
    return { result: 'Out', hitType: 'GroundBall', fielder, direction: parseFloat((dir + (Math.random() * 12 - 6)).toFixed(1)), distance: parseFloat(estimateDistance('G', fielder).toFixed(0)) };
  }

  // Fly ball: F7, F8, F9, F3 etc
  const flyMatch = c.match(/^F(\d)$/);
  if (flyMatch) {
    const fielder = flyMatch[1];
    const dir = FIELDER_ANGLE[fielder] ?? 0;
    return { result: 'Out', hitType: 'FlyBall', fielder, direction: parseFloat((dir + (Math.random() * 14 - 7)).toFixed(1)), distance: parseFloat(estimateDistance('F', fielder).toFixed(0)) };
  }

  // Sac fly: SF8-3, SF7 etc
  const sfMatch = c.match(/^SF(\d)(?:-\d+)?$/);
  if (sfMatch) {
    const fielder = sfMatch[1];
    const dir = FIELDER_ANGLE[fielder] ?? 0;
    return { result: 'SF', hitType: 'FlyBall', fielder, direction: parseFloat((dir + (Math.random() * 14 - 7)).toFixed(1)), distance: parseFloat(estimateDistance('SF', fielder).toFixed(0)) };
  }

  // Line drive: L5, L8 etc
  const lineMatch = c.match(/^L(\d)$/);
  if (lineMatch) {
    const fielder = lineMatch[1];
    const dir = FIELDER_ANGLE[fielder] ?? 0;
    return { result: 'Out', hitType: 'LineDrive', fielder, direction: parseFloat((dir + (Math.random() * 10 - 5)).toFixed(1)), distance: parseFloat(estimateDistance('L', fielder).toFixed(0)) };
  }

  // Error: E6, E4 etc
  const errorMatch = c.match(/^E(\d)$/);
  if (errorMatch) {
    const fielder = errorMatch[1];
    const dir = FIELDER_ANGLE[fielder] ?? 0;
    return { result: 'E', hitType: 'GroundBall', fielder, direction: parseFloat((dir + (Math.random() * 12 - 6)).toFixed(1)), distance: parseFloat(estimateDistance('G', fielder).toFixed(0)) };
  }

  // Fielder's choice: FC4, FC6 etc
  const fcMatch = c.match(/^FC(\d)?$/);
  if (fcMatch) {
    const fielder = fcMatch[1] || '4';
    const dir = FIELDER_ANGLE[fielder] ?? 0;
    return { result: 'FC', hitType: 'GroundBall', fielder, direction: parseFloat((dir + (Math.random() * 12 - 6)).toFixed(1)), distance: parseFloat(estimateDistance('G', fielder).toFixed(0)) };
  }

  // Hits: 1B, 2B, 3B
  if (c === '1B') {
    // Singles spread across all zones
    const dir = (Math.random() * 90) - 45;
    const dist = 100 + Math.random() * 80;
    return { result: 'Single', hitType: 'LineDrive', fielder: null, direction: parseFloat(dir.toFixed(1)), distance: parseFloat(dist.toFixed(0)) };
  }
  if (c === '2B') {
    const dir = (Math.random() * 80) - 40;
    const dist = 220 + Math.random() * 60;
    return { result: 'Double', hitType: 'FlyBall', fielder: null, direction: parseFloat(dir.toFixed(1)), distance: parseFloat(dist.toFixed(0)) };
  }
  if (c === '3B') {
    const dir = (Math.random() * 80) - 40;
    const dist = 270 + Math.random() * 50;
    return { result: 'Triple', hitType: 'FlyBall', fielder: null, direction: parseFloat(dir.toFixed(1)), distance: parseFloat(dist.toFixed(0)) };
  }

  // Fielded by specific player then base — like SF8-3: already handled above
  // Fallthrough: unrecognized
  return null;
}

// ============================================================
// PARSE SCOREBOOK AT-BATS
// ============================================================
// The scorebook PDF has per-player, per-inning at-bat result cells.
// Text extracted by pdf-parse runs all innings together in one blob per player.
// This function pulls the result codes out of each player's raw text block.
function parseAtBatsFromScorebook(playerText) {
  if (!playerText) return [];

  // Result codes we look for — order matters (longer matches first)
  const CODE_RE = /\b(HR|HBP|IBB|BB|SAC\d(?:-\d+)?|SF\d(?:-\d+)?|G\d-\d+|G\d|F\d|L\d|E\d|FC\d?|K[L]?|1B|2B|3B)\b/g;

  const codes = [];
  let m;
  while ((m = CODE_RE.exec(playerText)) !== null) {
    codes.push(m[1]);
  }

  return codes.map(code => {
    const parsed = parseAtBatCode(code);
    return parsed ? { code, ...parsed } : null;
  }).filter(Boolean);
}

// ============================================================
// MAIN PARSER
// ============================================================

async function parseGCScorebook(pdfBuffer) {
  const data = await pdfParse(pdfBuffer, { pagerender: null, max: 0 });
  const rawText = data.text;
  const lines = rawText.split('\n').map(l => l.trimEnd());
  const trimmed = lines.map(l => l.trim()).filter(l => l.length > 0);

  const game = {
    teams: [],
    date: null,
    homeAway: [],
    batting: {},
    pitching: {},
  };

  // ---- Extract date ----
  for (const line of trimmed) {
    const dm = line.match(/(?:Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday)(\w+\s+\w+\s+\d+,\s+\d{4})/);
    if (dm) { game.date = dm[1].trim(); break; }
    const dm2 = line.match(/(?:Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday)\s+(\w+\s+\d+,\s+\d{4})/);
    if (dm2) { game.date = dm2[1].trim(); break; }
  }

  // ---- Extract home/away ----
  for (const line of trimmed) {
    if (/^Home/.test(line)) { game.homeAway = ['away','home']; break; }
    if (/^Away/.test(line)) { game.homeAway = ['away','home']; break; }
  }

  // ---- Find team names ----
  const scoreLineIdx = trimmed.findIndex(l => /^\d+\s*-\s*\d+$/.test(l));
  if (scoreLineIdx > 0) {
    const nameFragments = trimmed.slice(0, scoreLineIdx).filter(l =>
      l.length > 0 &&
      !/^\d/.test(l) &&
      !l.includes('Date:') &&
      !['BATTING','PITCHING','Home','Away'].includes(l)
    );
    if (nameFragments.length >= 4) {
      const mid = Math.floor(nameFragments.length / 2);
      game.teams.push(nameFragments.slice(0, mid).join(' ').trim());
      game.teams.push(nameFragments.slice(mid).join(' ').trim());
    } else if (nameFragments.length === 2) {
      game.teams.push(nameFragments[0].trim());
      game.teams.push(nameFragments[1].trim());
    } else if (nameFragments.length === 3) {
      game.teams.push(nameFragments[0].trim());
      game.teams.push(nameFragments.slice(1).join(' ').trim());
    }
  }

  // ---- Find BATTING section ----
  const battingIdx = trimmed.findIndex(l => l === 'BATTING');
  const pitchingIdx = trimmed.findIndex(l => l === 'PITCHING');

  if (battingIdx === -1) return game;

  const battingLines = pitchingIdx > -1
    ? trimmed.slice(battingIdx + 1, pitchingIdx)
    : trimmed.slice(battingIdx + 1);

  const pitchingLines = pitchingIdx > -1 ? trimmed.slice(pitchingIdx + 1) : [];

  game.teams.forEach(t => { game.batting[t] = {}; game.pitching[t] = {}; });

  let currentTeamIdx = -1;
  let inNotes = false;

  const playerRe = /^\s*(.+?)\s*(\d)(\d)(\d)(\d)(\d)(\d)$/;

  for (const line of battingLines) {
    if (/^(2B:|TB:|SAC:|SF:|HBP:|SB:|LOB:|WP:|E:)/.test(line)) {
      inNotes = true;
    }

    if (inNotes) {
      parseNoteLine(line, game.batting, game.teams);
      continue;
    }

    if (/ABRHRBIBBSO$/.test(line)) {
      currentTeamIdx++;
      continue;
    }

    if (/^To\s*t\s*a\s*l\s*s/.test(line)) continue;

    if (currentTeamIdx < 0 || currentTeamIdx >= game.teams.length) continue;

    const m = line.match(playerRe);
    if (!m) continue;

    const nameStr = m[1].trim();
    const ab  = parseInt(m[2]);
    const r   = parseInt(m[3]);
    const h   = parseInt(m[4]);
    const rbi = parseInt(m[5]);
    const bb  = parseInt(m[6]);
    const so  = parseInt(m[7]);

    if (!nameStr || /^(Royal|Oxnard|BATTING|PITCHING)/.test(nameStr)) continue;

    const player = buildPlayer(nameStr, ab, r, h, rbi, bb, so);
    const team = game.teams[currentTeamIdx];
    game.batting[team][player.name] = player;
  }

  // ---- Parse pitching ----
  let pitchTeamIdx = -1;
  let inPitchNotes = false;
  const pitcherRe = /^\s*(.+?#\d+)\s+([\d.]+)\s+(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s+(\d+)/;
  const pitchNotes = [];

  for (const line of pitchingLines) {
    if (/^(P-S:|BF:|WP:|HBP:|E:|Scorekeeping)/.test(line)) {
      inPitchNotes = true;
    }
    if (inPitchNotes) {
      pitchNotes.push(line);
      continue;
    }

    if (/IP\s+H\s+R\s+ER\s+BB\s+SO\s+HR/.test(line)) {
      pitchTeamIdx++;
      continue;
    }

    if (/^Totals/.test(line)) continue;
    if (pitchTeamIdx < 0 || pitchTeamIdx >= game.teams.length) continue;

    const m = line.match(pitcherRe);
    if (!m) continue;

    const pitcher = buildPitcher(m[1], m[2], m[3], m[4], m[5], m[6], m[7], m[8]);
    const team = game.teams[pitchTeamIdx];
    game.pitching[team][pitcher.name] = pitcher;
  }

  parsePitchNotes(pitchNotes.join(' '), game.pitching, game.teams);

  // ---- Parse scorebook at-bats for spray chart data ----
  // The scorebook PDF text includes per-inning result codes mixed into each
  // player's block. We do a second pass over the full raw text, looking for
  // each player's name and grabbing the result codes that follow them.
  try {
    const pages = rawText.split('\f');
    for (const page of pages) {
      const pageLines = page.split('\n').map(l => l.trim()).filter(Boolean);
      let currentPlayer = null;
      let currentTeam = null;
      let atBatBuffer = [];

      for (let i = 0; i < pageLines.length; i++) {
        const line = pageLines[i];

        // Check if this line is a player name we already parsed
        for (const team of game.teams) {
          for (const [playerName, playerData] of Object.entries(game.batting[team] || {})) {
            // Match on last name since first initial + last is common
            const lastName = playerName.split(' ').pop().toLowerCase();
            const lineLower = line.toLowerCase();
            if (lineLower.includes(lastName) && lineLower.length < 40) {
              // Flush previous player's buffer
              if (currentPlayer && currentTeam) {
                const atBats = parseAtBatsFromScorebook(atBatBuffer.join(' '));
                if (atBats.length > 0) {
                  game.batting[currentTeam][currentPlayer].atBats = atBats;
                }
              }
              currentPlayer = playerName;
              currentTeam = team;
              atBatBuffer = [line];
              break;
            }
          }
        }

        // Accumulate lines that look like they contain at-bat codes
        if (currentPlayer && line !== pageLines[i]) {
          // Already set above
        } else if (currentPlayer) {
          // Look for lines with result codes
          if (/\b(HR|HBP|BB|SAC|SF|[GLF]\d|E\d|FC|1B|2B|3B|K)\b/.test(line)) {
            atBatBuffer.push(line);
          }
        }
      }

      // Flush last player
      if (currentPlayer && currentTeam && atBatBuffer.length > 0) {
        const atBats = parseAtBatsFromScorebook(atBatBuffer.join(' '));
        if (atBats.length > 0 && !game.batting[currentTeam][currentPlayer].atBats) {
          game.batting[currentTeam][currentPlayer].atBats = atBats;
        }
      }
    }
  } catch (err) {
    // Scorebook parsing is best-effort — never fail the whole upload
    console.warn('Scorebook at-bat parse error (non-fatal):', err.message);
  }

  // Recalculate batting rate stats after notes enrichment
  for (const team of game.teams) {
    for (const player of Object.values(game.batting[team] || {})) {
      recalcPlayer(player);
    }
  }

  return game;
}

// ============================================================
// HELPERS
// ============================================================

function buildPlayer(nameStr, ab, r, h, rbi, bb, so) {
  const jerseyMatch = nameStr.match(/#(\d+)/);
  const posMatch    = nameStr.match(/\(([^)]+)\)/);
  const name        = nameStr.replace(/#\d+/,'').replace(/\([^)]*\)/,'').replace(/…$/,'').trim();
  const jersey      = jerseyMatch ? jerseyMatch[1] : null;
  const position    = posMatch ? posMatch[1] : '';

  return {
    name, jersey, position,
    ab, r, h, rbi, bb, so,
    doubles: 0, triples: 0, hr: 0,
    hbp: 0, sac: 0, sf: 0, sb: 0,
    singles: 0, xbh: 0, tb: h, pa: ab + bb,
    avg: ab > 0 ? +(h/ab).toFixed(3) : 0,
    obp: (ab+bb) > 0 ? +((h+bb)/(ab+bb)).toFixed(3) : 0,
    slg: ab > 0 ? +(h/ab).toFixed(3) : 0,
    ops: 0, iso: 0, woba: 0,
    atBats: [], // populated by scorebook parser
  };
}

function recalcPlayer(p) {
  const singles = Math.max(0, p.h - p.doubles - p.triples - p.hr);
  const tb = singles + 2*p.doubles + 3*p.triples + 4*p.hr;
  p.singles = singles;
  p.xbh     = p.doubles + p.triples + p.hr;
  p.tb      = tb;
  p.pa      = p.ab + p.bb + p.hbp + p.sac + p.sf;
  p.avg     = p.ab > 0 ? +(p.h/p.ab).toFixed(3) : 0;
  p.slg     = p.ab > 0 ? +(tb/p.ab).toFixed(3) : 0;
  p.obp     = (p.ab+p.bb+p.hbp+p.sf) > 0
    ? +((p.h+p.bb+p.hbp)/(p.ab+p.bb+p.hbp+p.sf)).toFixed(3) : 0;
  p.ops     = +(p.obp + p.slg).toFixed(3);
  p.iso     = +(p.slg - p.avg).toFixed(3);
  p.woba    = p.pa > 0
    ? +((0.69*p.bb+0.72*p.hbp+0.888*singles+1.271*p.doubles+1.616*p.triples+2.101*p.hr)/p.pa).toFixed(3)
    : 0;
}

function buildPitcher(nameStr, ip, h, r, er, bb, so, hr) {
  const jerseyMatch = nameStr.match(/#(\d+)/);
  const name   = nameStr.replace(/#\d+/,'').replace(/…$/,'').trim();
  const jersey = jerseyMatch ? jerseyMatch[1] : null;
  const ipN    = parseFloat(ip) || 0;
  const ipDec  = Math.floor(ipN) + (ipN % 1) * 10 / 3;
  const hN=parseInt(h)||0, rN=parseInt(r)||0, erN=parseInt(er)||0;
  const bbN=parseInt(bb)||0, soN=parseInt(so)||0, hrN=parseInt(hr)||0;

  return {
    name, jersey,
    ip: ipN, ipDecimal: ipDec,
    h: hN, r: rN, er: erN, bb: bbN, ks: soN, hr: hrN,
    era:  ipDec > 0 ? +((erN/ipDec)*9).toFixed(2) : null,
    whip: ipDec > 0 ? +((hN+bbN)/ipDec).toFixed(3) : null,
    k9:   ipDec > 0 ? +((soN/ipDec)*9).toFixed(2) : null,
    bb9:  ipDec > 0 ? +((bbN/ipDec)*9).toFixed(2) : null,
    h9:   ipDec > 0 ? +((hN/ipDec)*9).toFixed(2) : null,
    totalPitches: 0, strikes: 0, balls: 0, bf: 0,
    wp: 0, hbp: 0, kPct: 0, bbPct: 0,
    fpsPct: null, strikePct: null,
  };
}

function parseNoteLine(line, batting, teams) {
  for (const team of teams) {
    if (!batting[team]) continue;
    applyNotes(line, batting[team]);
  }
}

function applyNotes(line, teamBatting) {
  const keys = {
    '2B': 'doubles', 'HR': 'hr', 'SAC': 'sac',
    'SF': 'sf', 'HBP': 'hbp', 'SB': 'sb',
  };
  for (const [key, field] of Object.entries(keys)) {
    const re = new RegExp(`${key}:\\s*([^,A-Z][^:]*?)(?=\\s*(?:TB:|SAC:|SF:|HBP:|SB:|LOB:|WP:|2B:|HR:|$))`);
    const m = line.match(re);
    if (!m) continue;
    const entries = m[1].split(',').map(s => s.trim()).filter(Boolean);
    for (const entry of entries) {
      const countM = entry.match(/^(.+?)\s+(\d+)$/);
      const playerName = countM ? countM[1].trim() : entry.trim();
      const count = countM ? parseInt(countM[2]) : 1;
      const player = findPlayer(teamBatting, playerName);
      if (player) player[field] = (player[field] || 0) + count;
    }
  }
}

function findPlayer(teamBatting, noteName) {
  const lower = noteName.toLowerCase().trim();
  for (const player of Object.values(teamBatting)) {
    const pLower = player.name.toLowerCase();
    const pLast  = pLower.split(' ').pop();
    const nLast  = lower.split(' ').pop();
    if (pLower === lower || pLower.includes(lower) || lower.includes(pLower) || pLast === nLast) {
      return player;
    }
  }
  return null;
}

function parsePitchNotes(notesText, pitching, teams) {
  const psRe = /P-S:\s*(.+?)(?=\s*BF:|$)/;
  const psM = notesText.match(psRe);
  if (psM) {
    psM[1].split(',').forEach(entry => {
      const m = entry.trim().match(/^(.+?)\s+(\d+)-(\d+)$/);
      if (!m) return;
      const p = findPitcher(pitching, teams, m[1].trim());
      if (p) {
        p.totalPitches = parseInt(m[2]);
        p.strikes      = parseInt(m[3]);
        p.balls        = p.totalPitches - p.strikes;
        p.strikePct    = p.totalPitches > 0 ? +((p.strikes/p.totalPitches)*100).toFixed(1) : null;
      }
    });
  }

  const bfRe = /BF:\s*(.+?)(?=\s*WP:|HBP:|E:|$)/;
  const bfM = notesText.match(bfRe);
  if (bfM) {
    bfM[1].split(',').forEach(entry => {
      const m = entry.trim().match(/^(.+?)\s+(\d+)$/);
      if (!m) return;
      const p = findPitcher(pitching, teams, m[1].trim());
      if (p) {
        p.bf = parseInt(m[2]);
        if (p.bf > 0) {
          p.kPct  = +((p.ks/p.bf)*100).toFixed(1);
          p.bbPct = +((p.bb/p.bf)*100).toFixed(1);
        }
      }
    });
  }

  const wpRe = /WP:\s*(.+?)(?=\s*HBP:|E:|$)/;
  const wpM = notesText.match(wpRe);
  if (wpM) {
    wpM[1].split(',').forEach(entry => {
      const p = findPitcher(pitching, teams, entry.trim());
      if (p) p.wp++;
    });
  }

  const hbpRe = /HBP:\s*(.+?)(?=\s*BF:|E:|$)/;
  const hbpM = notesText.match(hbpRe);
  if (hbpM) {
    hbpM[1].split(',').forEach(entry => {
      const m = entry.trim().match(/^(.+?)\s+(\d+)$/);
      const name = m ? m[1].trim() : entry.trim();
      const count = m ? parseInt(m[2]) : 1;
      const p = findPitcher(pitching, teams, name);
      if (p) p.hbp += count;
    });
  }
}

function findPitcher(pitching, teams, noteName) {
  const lower = noteName.toLowerCase().trim();
  for (const team of teams) {
    for (const p of Object.values(pitching[team] || {})) {
      const pLower = p.name.toLowerCase();
      const pLast  = pLower.split(' ').pop();
      const nLast  = lower.split(' ').pop();
      if (pLower.includes(lower) || lower.includes(pLower) || pLast === nLast) return p;
    }
  }
  return null;
}

// ============================================================
// STAT CALCULATORS FOR DB INSERTION
// ============================================================

function computeBattingLine(player) {
  if (!player) return null;
  return {
    g: 1,
    pa: player.pa || 0,
    ab: player.ab, h: player.h,
    singles: player.singles || 0,
    doubles: player.doubles || 0,
    triples: player.triples || 0,
    hr: player.hr || 0,
    xbh: player.xbh || 0,
    r: player.r || 0,
    rbi: player.rbi || 0,
    bb: player.bb,
    ks: player.so, ksSwing: player.so, ksLook: 0,
    hbp: player.hbp || 0,
    sac: player.sac || 0,
    sf: player.sf || 0,
    roe: 0,
    sb: player.sb || 0,
    cs: 0,
    avg: player.avg, obp: player.obp, slg: player.slg,
    ops: player.ops, iso: player.iso || 0, woba: player.woba || 0,
    gbPct: 0, ldPct: 0, fbPct: 0, gbFb: null,
    sprayL: 0, sprayC: 0, sprayR: 0,
    totalPitchesSeen: 0, fpsPct: 0,
    atBats: player.atBats || [],  // <-- spray chart data
  };
}

function computePitchingLine(pitcher) {
  if (!pitcher) return null;
  return {
    g: 1, gs: 1,
    ip: pitcher.ip, bf: pitcher.bf || 0,
    h: pitcher.h, r: pitcher.r, er: pitcher.er,
    bb: pitcher.bb, ks: pitcher.ks, ksSwing: pitcher.ks, ksLook: 0,
    hbp: pitcher.hbp || 0, hr: pitcher.hr, wp: pitcher.wp || 0,
    era: pitcher.era, k9: pitcher.k9, bb9: pitcher.bb9,
    h9: pitcher.h9, whip: pitcher.whip,
    kbb: pitcher.bb > 0 ? +(pitcher.ks/pitcher.bb).toFixed(2) : null,
    kPct: pitcher.kPct || 0, bbPct: pitcher.bbPct || 0,
    gbPct: 0, ldPct: 0, fbPct: 0,
    fpsPct: pitcher.fpsPct || 0,
    strikePct: pitcher.strikePct || 0,
    totalPitches: pitcher.totalPitches || 0,
    avgPPerBF:  pitcher.bf > 0 ? +((pitcher.totalPitches||0)/pitcher.bf).toFixed(1) : null,
    avgPPerInn: pitcher.ipDecimal > 0 ? +((pitcher.totalPitches||0)/pitcher.ipDecimal).toFixed(1) : null,
    innings: [],
  };
}

// Export the at-bat code parser so it can be used by the spray endpoint in server.js
module.exports = { parseGCScorebook, computeBattingLine, computePitchingLine, parseAtBatCode, parseAtBatsFromScorebook };
