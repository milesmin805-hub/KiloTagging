/**
 * GameChanger Box Score PDF Parser — Node.js
 * Handles pdf-parse output from GameChanger box score PDFs.
 */

const pdfParse = require('pdf-parse');

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
  // They appear before the score line "9 - 6" as fragments:
  // "Royal Varsity ", "Highlanders", "Oxnard Varsity Yellow ", "Jackets"
  const scoreLineIdx = trimmed.findIndex(l => /^\d+\s*-\s*\d+$/.test(l));
  if (scoreLineIdx > 0) {
    const nameFragments = trimmed.slice(0, scoreLineIdx).filter(l =>
      l.length > 0 &&
      !/^\d/.test(l) &&
      !l.includes('Date:') &&
      !['BATTING','PITCHING','Home','Away'].includes(l)
    );
    // Should be 4 fragments: team1part1, team1part2, team2part1, team2part2
    // Or 2 fragments if single-word team names
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

  // ---- Parse batting ----
  // Header line: "Royal Varsity Hi...ABRHRBIBBSO"
  // Player line: "E Hall #2 (RF)400101"  (6 digits jammed at end = AB R H RBI BB SO)
  // Totals: "To t a l s2797738"
  // Second team header: "Oxnard Varsity Y...ABRHRBIBBSO"
  // Notes: "2B: I Tillman, R Talley..."

  game.teams.forEach(t => { game.batting[t] = {}; game.pitching[t] = {}; });

  let currentTeamIdx = -1; // -1 = not in batting yet
  let inNotes = false;

  // Player line: name (with optional jersey and position) followed by exactly 6 digits
  // Examples:
  //   "E Hall #2 (RF)400101"
  //   "  Tabora #7 (3B)000000"
  //   "R Talley (CF)301311"
  //   "  N Guzman #35000000"
  const playerRe = /^\s*(.+?)\s*(\d)(\d)(\d)(\d)(\d)(\d)$/;

  for (const line of battingLines) {
    // Notes section
    if (/^(2B:|TB:|SAC:|SF:|HBP:|SB:|LOB:|WP:|E:)/.test(line)) {
      inNotes = true;
    }

    if (inNotes) {
      // Parse notes for current and next team
      parseNoteLine(line, game.batting, game.teams);
      continue;
    }

    // Team header line e.g. "Royal Varsity Hi...ABRHRBIBBSO"
    if (/ABRHRBIBBSO$/.test(line)) {
      currentTeamIdx++;
      continue;
    }

    // Totals line
    if (/^To\s*t\s*a\s*l\s*s/.test(line)) continue;

    if (currentTeamIdx < 0 || currentTeamIdx >= game.teams.length) continue;

    // Player line
    const m = line.match(playerRe);
    if (!m) continue;

    const nameStr = m[1].trim();
    const ab  = parseInt(m[2]);
    const r   = parseInt(m[3]);
    const h   = parseInt(m[4]);
    const rbi = parseInt(m[5]);
    const bb  = parseInt(m[6]);
    const so  = parseInt(m[7]);

    // Skip if name looks like a header or totals
    if (!nameStr || /^(Royal|Oxnard|BATTING|PITCHING)/.test(nameStr)) continue;

    const player = buildPlayer(nameStr, ab, r, h, rbi, bb, so);
    const team = game.teams[currentTeamIdx];
    game.batting[team][player.name] = player;
  }

  // ---- Parse pitching ----
  // Header: "Royal Varsi… IP H R ER BB SO HR"  (spaces preserved here)
  // Player: "D Bark… #10 4.1 6 5 5 3 9 0"
  // Notes: "P-S: D Barkman 92-58..."

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

    // Team header
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

  // Apply pitch notes
  parsePitchNotes(pitchNotes.join(' '), game.pitching, game.teams);

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
  // Notes lines appear after all player rows
  // They alternate: team1 notes line, team2 notes line
  // But pdf-parse may split them differently — apply to all teams
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
  // P-S: D Barkman 92-58, D Dunwoody 17-14
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

  // BF: D Barkman 22, D Dunwoody 5
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

  // WP
  const wpRe = /WP:\s*(.+?)(?=\s*HBP:|E:|$)/;
  const wpM = notesText.match(wpRe);
  if (wpM) {
    wpM[1].split(',').forEach(entry => {
      const p = findPitcher(pitching, teams, entry.trim());
      if (p) p.wp++;
    });
  }

  // HBP
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

module.exports = { parseGCScorebook, computeBattingLine, computePitchingLine };
