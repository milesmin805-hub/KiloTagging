/**
 * GameChanger Box Score PDF Parser — Node.js
 * 
 * Parses the GameChanger box score PDF (not the scorebook).
 * Extracts batting and pitching stats for both teams.
 * 
 * Dependencies: "pdf-parse": "^1.1.1"
 */

const pdfParse = require('pdf-parse');

// ============================================================
// MAIN PARSER
// ============================================================

async function parseGCScorebook(pdfBuffer) {
  const data = await pdfParse(pdfBuffer, { pagerender: null, max: 0 });
  const rawText = data.text;
  const lines = rawText.split('\n').map(l => l.trim()).filter(l => l.length > 0);

  const game = {
    teams: [],
    date: null,
    homeAway: [],
    score: {},
    batting: {},
    pitching: {},
  };

  // ---- Parse header ----
  // Line 0: "Royal Varsity Oxnard Varsity Yellow"  (team names split across)
  // Line 1: "9 - 6"  (score)
  // Line 2: "Highlanders Jackets"  (continuation of team names)
  // Line 3: "Home Saturday February 21, 2026"

  // Find score line (format: "N - N")
  let scoreLineIdx = -1;
  for (let i = 0; i < Math.min(lines.length, 8); i++) {
    if (/^\d+\s*-\s*\d+$/.test(lines[i])) {
      scoreLineIdx = i;
      break;
    }
  }

  if (scoreLineIdx > 0) {
    // Team names are on lines before and around the score
    // They appear split because of the score in the middle
    // e.g. "Royal Varsity Oxnard Varsity Yellow" then score then "Highlanders Jackets"
    const beforeScore = lines[scoreLineIdx - 1] || '';
    const afterScore  = lines[scoreLineIdx + 1] || '';

    // Split before score roughly in half — left is team1, right is team2 start
    // Actually GameChanger puts team1 words then team2 words on same line
    // We'll extract from the batting table headers which are more reliable
  }

  // Find date line
  for (const line of lines) {
    const dm = line.match(/(?:Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday)\s+(\w+\s+\d+,\s+\d{4})/);
    if (dm) {
      game.date = dm[1]; // e.g. "February 21, 2026"
      break;
    }
    // Also try YYYY/MM/DD format
    const dm2 = line.match(/(\d{4}\/\d{2}\/\d{2})/);
    if (dm2) { game.date = dm2[1]; break; }
  }

  // Home/away
  for (const line of lines) {
    if (/\bHome\b/.test(line) && !game.homeAway.includes('home')) {
      game.homeAway = ['away', 'home'];
      break;
    }
    if (/\bAway\b/.test(line) && !game.homeAway.includes('away')) {
      game.homeAway = ['away', 'home'];
      break;
    }
  }

  // ---- Parse batting section ----
  // Find "BATTING" line
  const battingIdx = lines.findIndex(l => l === 'BATTING');
  const pitchingIdx = lines.findIndex(l => l === 'PITCHING');

  if (battingIdx === -1) {
    return game;
  }

  const battingLines = lines.slice(battingIdx + 1, pitchingIdx > -1 ? pitchingIdx : lines.length);
  const pitchingLines = pitchingIdx > -1 ? lines.slice(pitchingIdx + 1) : [];

  // Parse batting
  const battingResult = parseBattingSection(battingLines);
  game.teams = battingResult.teams;
  game.batting = battingResult.batting;

  // Parse pitching
  if (pitchingLines.length > 0) {
    const pitchingResult = parsePitchingSection(pitchingLines, game.teams);
    game.pitching = pitchingResult;
  }

  return game;
}

// ============================================================
// BATTING PARSER
// ============================================================

function parseBattingSection(lines) {
  // Header line looks like:
  // "Royal Varsity Hi… AB R H RBI BB SO Oxnard Varsity Y… AB R H RBI BB SO"
  // Player lines look like:
  // "E Hall #2 (RF) 4 0 0 1 0 1 G Ramos #31 (CF) 3 2 1 2 1 0"
  // or single team if only one side:
  // "E Hall #2 (RF) 4 0 0 1 0 1"

  const teams = [];
  const batting = {};

  // Find the header line with AB R H RBI BB SO
  let headerIdx = -1;
  for (let i = 0; i < lines.length; i++) {
    if (/AB\s+R\s+H\s+RBI\s+BB\s+SO/.test(lines[i])) {
      headerIdx = i;
      break;
    }
  }

  if (headerIdx === -1) return { teams, batting };

  // Extract team names from header
  const headerLine = lines[headerIdx];
  // Format: "Team1Name… AB R H RBI BB SO Team2Name… AB R H RBI BB SO"
  const headerMatch = headerLine.match(/^(.+?)\s+AB\s+R\s+H\s+RBI\s+BB\s+SO\s+(.+?)\s+AB\s+R\s+H\s+RBI\s+BB\s+SO$/);
  if (headerMatch) {
    teams.push(headerMatch[1].trim().replace(/…$/, '').trim());
    teams.push(headerMatch[2].trim().replace(/…$/, '').trim());
  } else {
    // Single team
    const singleMatch = headerLine.match(/^(.+?)\s+AB\s+R\s+H\s+RBI\s+BB\s+SO$/);
    if (singleMatch) teams.push(singleMatch[1].trim().replace(/…$/, '').trim());
  }

  // Initialize batting objects
  teams.forEach(t => { batting[t] = {}; });

  // Parse player rows
  // Player line: "Name #Jersey (Pos) AB R H RBI BB SO [Name2 #Jersey2 (Pos2) AB2 R2 H2 RBI2 BB2 SO2]"
  const playerRe = /^(.+?#\d+(?:\s+\(\w+\))?)\s+(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s+(\d+)/;

  let team1Players = [];
  let team2Players = [];
  let inNotes = false;

  for (let i = headerIdx + 1; i < lines.length; i++) {
    const line = lines[i];

    // Stop at notes section (lines starting with "2B:", "TB:", "SAC:", etc.)
    if (/^(2B:|TB:|SAC:|SF:|HBP:|SB:|LOB:|WP:|E:)/.test(line)) {
      inNotes = true;
    }
    if (inNotes) continue;

    // Totals line
    if (/^Totals\s+\d+/.test(line)) continue;

    // Try to match player line(s)
    // The line may contain two players (one per team) side by side
    const m = line.match(playerRe);
    if (!m) continue;

    // Parse first player
    const p1 = parsePlayerEntry(m[1], m[2], m[3], m[4], m[5], m[6], m[7]);

    // Check for second player on same line
    const rest = line.slice(m[0].length).trim();
    const m2 = rest.match(playerRe);
    let p2 = null;
    if (m2) {
      p2 = parsePlayerEntry(m2[1], m2[2], m2[3], m2[4], m2[5], m2[6], m2[7]);
    }

    team1Players.push(p1);
    if (p2) team2Players.push(p2);
  }

  // Assign to teams
  if (teams[0]) {
    team1Players.forEach(p => { batting[teams[0]][p.name] = p; });
  }
  if (teams[1]) {
    team2Players.forEach(p => { batting[teams[1]][p.name] = p; });
  }

  // Parse notes for 2B, SB, HBP, SAC, SF
  parseNotesIntoBatting(lines.slice(headerIdx + 1), batting, teams);

  return { teams, batting };
}

function parsePlayerEntry(nameStr, ab, r, h, rbi, bb, so) {
  // nameStr: "E Hall #2 (RF)" or "A Koby #14 (3B)"
  const jerseyMatch = nameStr.match(/#(\d+)/);
  const posMatch    = nameStr.match(/\(([^)]+)\)/);
  const name        = nameStr.replace(/#\d+/, '').replace(/\([^)]*\)/, '').trim();
  const jersey      = jerseyMatch ? jerseyMatch[1] : null;
  const position    = posMatch ? posMatch[1] : '';

  const abN  = parseInt(ab)  || 0;
  const rN   = parseInt(r)   || 0;
  const hN   = parseInt(h)   || 0;
  const rbiN = parseInt(rbi) || 0;
  const bbN  = parseInt(bb)  || 0;
  const soN  = parseInt(so)  || 0;

  // Calculate basic rate stats
  const avg  = abN > 0 ? +(hN / abN).toFixed(3) : 0;
  const slg  = abN > 0 ? +(hN / abN).toFixed(3) : 0; // placeholder until we know XBH
  const obp  = (abN + bbN) > 0 ? +((hN + bbN) / (abN + bbN)).toFixed(3) : 0;
  const ops  = +(obp + slg).toFixed(3);

  return {
    name, jersey, position,
    ab: abN, r: rN, h: hN, rbi: rbiN, bb: bbN, so: soN,
    doubles: 0, triples: 0, hr: 0, hbp: 0, sac: 0, sf: 0, sb: 0,
    avg, obp, slg, ops, woba: 0,
    // Will be enriched by notes parsing
  };
}

function parseNotesIntoBatting(lines, batting, teams) {
  // Notes lines like:
  // "2B: I Tillman, R Talley, C Rainer, P Visage 2, TB: I..."
  // These are for the left (team1) side

  const fullNotes = lines.filter(l =>
    /^(2B:|TB:|SAC:|SF:|HBP:|SB:|LOB:|WP:|E:)/.test(l) ||
    /^Scorekeeping/.test(l)
  );

  // Split notes into two halves — one per team
  // They appear on the same line separated by the second team's stats
  // Actually pdf-parse puts them on separate lines per team context

  // Parse each notes block
  const noteBlocks = [];
  let currentBlock = '';
  for (const line of fullNotes) {
    if (/^Scorekeeping/.test(line)) break;
    currentBlock += ' ' + line;
  }

  // Try to split into two team note blocks
  // They typically appear as two separate lines in pdf-parse output
  const noteLines = lines.filter(l => /^(2B:|TB:|SAC:|SF:|HBP:|SB:|LOB:)/.test(l));

  noteLines.forEach((noteLine, idx) => {
    const team = teams[idx] || teams[0];
    if (!team || !batting[team]) return;

    // Parse 2B
    const doubles = parseNoteList(noteLine, '2B');
    doubles.forEach(({ name, count }) => {
      const player = findPlayer(batting[team], name);
      if (player) player.doubles += count;
    });

    // Parse HR (rare in these notes but possible)
    const homers = parseNoteList(noteLine, 'HR');
    homers.forEach(({ name, count }) => {
      const player = findPlayer(batting[team], name);
      if (player) player.hr += count;
    });

    // Parse SAC
    const sacs = parseNoteList(noteLine, 'SAC');
    sacs.forEach(({ name, count }) => {
      const player = findPlayer(batting[team], name);
      if (player) player.sac += count;
    });

    // Parse SF
    const sfs = parseNoteList(noteLine, 'SF');
    sfs.forEach(({ name, count }) => {
      const player = findPlayer(batting[team], name);
      if (player) player.sf += count;
    });

    // Parse HBP
    const hbps = parseNoteList(noteLine, 'HBP');
    hbps.forEach(({ name, count }) => {
      const player = findPlayer(batting[team], name);
      if (player) player.hbp += count;
    });

    // Parse SB
    const sbs = parseNoteList(noteLine, 'SB');
    sbs.forEach(({ name, count }) => {
      const player = findPlayer(batting[team], name);
      if (player) player.sb += count;
    });
  });

  // Recalculate stats with enriched data
  for (const team of teams) {
    if (!batting[team]) continue;
    for (const player of Object.values(batting[team])) {
      const { ab, h, bb, hbp, sac, sf, doubles, triples, hr } = player;
      const singles = h - doubles - triples - hr;
      const tb = singles + 2*doubles + 3*triples + 4*hr;

      player.singles  = Math.max(0, singles);
      player.xbh      = doubles + triples + hr;
      player.tb       = tb;

      const pa = ab + bb + hbp + sac + sf;
      player.pa = pa;

      player.avg  = ab > 0 ? +(h/ab).toFixed(3) : 0;
      player.slg  = ab > 0 ? +(tb/ab).toFixed(3) : 0;
      player.obp  = (ab+bb+hbp+sf) > 0 ? +((h+bb+hbp)/(ab+bb+hbp+sf)).toFixed(3) : 0;
      player.ops  = +(player.obp + player.slg).toFixed(3);
      player.iso  = +(player.slg - player.avg).toFixed(3);
      player.woba = pa > 0
        ? +((0.69*bb + 0.72*hbp + 0.888*player.singles + 1.271*doubles + 1.616*triples + 2.101*hr) / pa).toFixed(3)
        : 0;
    }
  }
}

function parseNoteList(noteLine, key) {
  // e.g. "2B: I Tillman, R Talley, C Rainer, P Visage 2, TB: ..."
  // Returns [{name, count}]
  const results = [];
  const keyRe = new RegExp(`${key}:\\s*([^,]+(?:,\\s*[^,]+)*?)(?:\\s*(?:TB:|SAC:|SF:|HBP:|SB:|LOB:|WP:|E:|$))`);
  const m = noteLine.match(keyRe);
  if (!m) return results;

  const entries = m[1].split(',').map(s => s.trim()).filter(Boolean);
  for (const entry of entries) {
    // Entry: "P Visage 2" or "I Tillman" or "C Rainer"
    const countMatch = entry.match(/^(.+?)\s+(\d+)$/);
    if (countMatch) {
      results.push({ name: countMatch[1].trim(), count: parseInt(countMatch[2]) });
    } else if (entry.trim()) {
      results.push({ name: entry.trim(), count: 1 });
    }
  }
  return results;
}

function findPlayer(teamBatting, noteName) {
  // noteName might be "I Tillman" — match against "I Tillman #11 (DH)" style name
  // Player keys in batting are full names like "I Tillman"
  const lowerNote = noteName.toLowerCase().trim();
  for (const player of Object.values(teamBatting)) {
    const lowerPlayer = player.name.toLowerCase();
    if (lowerPlayer === lowerNote || lowerPlayer.startsWith(lowerNote) || lowerNote.startsWith(lowerPlayer.split(' ')[0])) {
      return player;
    }
  }
  return null;
}

// ============================================================
// PITCHING PARSER
// ============================================================

function parsePitchingSection(lines, teams) {
  const pitching = {};
  teams.forEach(t => { pitching[t] = {}; });

  // Header: "Royal Varsi… IP H R ER BB SO HR Oxnard Var… IP H R ER BB SO HR"
  let headerIdx = -1;
  for (let i = 0; i < lines.length; i++) {
    if (/IP\s+H\s+R\s+ER\s+BB\s+SO\s+HR/.test(lines[i])) {
      headerIdx = i;
      break;
    }
  }
  if (headerIdx === -1) return pitching;

  const pitcherRe = /^(.+?#\d+)\s+([\d.]+)\s+(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s+(\d+)/;

  for (let i = headerIdx + 1; i < lines.length; i++) {
    const line = lines[i];
    if (/^Totals/.test(line)) continue;
    if (/^P-S:|^BF:|^WP:|^HBP:|^E:|^Scorekeeping/.test(line)) break;

    const m = line.match(pitcherRe);
    if (!m) continue;

    const p1 = parsePitcherEntry(m[1], m[2], m[3], m[4], m[5], m[6], m[7], m[8]);

    const rest = line.slice(m[0].length).trim();
    const m2 = rest.match(pitcherRe);
    let p2 = null;
    if (m2) {
      p2 = parsePitcherEntry(m2[1], m2[2], m2[3], m2[4], m2[5], m2[6], m2[7], m2[8]);
    }

    if (teams[0] && p1) pitching[teams[0]][p1.name] = p1;
    if (teams[1] && p2) pitching[teams[1]][p2.name] = p2;
  }

  // Parse P-S notes for pitch counts
  parsePitchingNotes(lines, pitching, teams);

  return pitching;
}

function parsePitcherEntry(nameStr, ip, h, r, er, bb, so, hr) {
  const jerseyMatch = nameStr.match(/#(\d+)/);
  const name        = nameStr.replace(/#\d+/, '').trim().replace(/…$/, '').trim();
  const jersey      = jerseyMatch ? jerseyMatch[1] : null;

  const ipN  = parseFloat(ip) || 0;
  const hN   = parseInt(h)   || 0;
  const rN   = parseInt(r)   || 0;
  const erN  = parseInt(er)  || 0;
  const bbN  = parseInt(bb)  || 0;
  const soN  = parseInt(so)  || 0;
  const hrN  = parseInt(hr)  || 0;

  // IP in baseball is recorded as 4.1 = 4 innings + 1 out = 4.333 actual innings
  const ipDecimal = Math.floor(ipN) + (ipN % 1) * 10 / 3;

  const era  = ipDecimal > 0 ? +((erN / ipDecimal) * 9).toFixed(2) : null;
  const whip = ipDecimal > 0 ? +((hN + bbN) / ipDecimal).toFixed(3) : null;
  const k9   = ipDecimal > 0 ? +((soN / ipDecimal) * 9).toFixed(2) : null;
  const bb9  = ipDecimal > 0 ? +((bbN / ipDecimal) * 9).toFixed(2) : null;
  const h9   = ipDecimal > 0 ? +((hN / ipDecimal) * 9).toFixed(2) : null;

  return {
    name, jersey,
    ip: ipN, ipDecimal,
    h: hN, r: rN, er: erN, bb: bbN, ks: soN, hr: hrN,
    era, whip, k9, bb9, h9,
    // Enriched from notes:
    totalPitches: 0, strikes: 0, balls: 0, bf: 0,
    wp: 0, hbp: 0,
    fpsPct: null, strikePct: null, kPct: null, bbPct: null,
  };
}

function parsePitchingNotes(lines, pitching, teams) {
  // P-S: D Barkman 92-58, D Dunwoody 17-14, Obrien 21-13
  // BF: D Barkman 22, D Dunwoody 5, Obrien 5
  const notesText = lines.join(' ');

  // Parse P-S (pitches-strikes)
  const psMatch = notesText.match(/P-S:\s*([^,B][^B]+?)(?:\s+BF:|$)/);
  if (psMatch) {
    const entries = psMatch[1].split(',').map(s => s.trim()).filter(Boolean);
    entries.forEach(entry => {
      const m = entry.match(/^(.+?)\s+(\d+)-(\d+)$/);
      if (!m) return;
      const name    = m[1].trim();
      const pitches = parseInt(m[2]);
      const strikes = parseInt(m[3]);
      const pitcher = findPitcherAcrossTeams(pitching, teams, name);
      if (pitcher) {
        pitcher.totalPitches = pitches;
        pitcher.strikes      = strikes;
        pitcher.balls        = pitches - strikes;
        pitcher.strikePct    = pitches > 0 ? +((strikes/pitches)*100).toFixed(1) : null;
      }
    });
  }

  // Parse BF (batters faced)
  const bfMatch = notesText.match(/BF:\s*([^,W][^W]+?)(?:\s+WP:|$|\s+HBP:|$)/);
  if (bfMatch) {
    const entries = bfMatch[1].split(',').map(s => s.trim()).filter(Boolean);
    entries.forEach(entry => {
      const m = entry.match(/^(.+?)\s+(\d+)$/);
      if (!m) return;
      const pitcher = findPitcherAcrossTeams(pitching, teams, m[1].trim());
      if (pitcher) {
        pitcher.bf = parseInt(m[2]);
        if (pitcher.bf > 0) {
          pitcher.kPct  = +((pitcher.ks / pitcher.bf) * 100).toFixed(1);
          pitcher.bbPct = +((pitcher.bb / pitcher.bf) * 100).toFixed(1);
          pitcher.fpsPct = pitcher.strikePct; // approximation
        }
      }
    });
  }

  // Parse WP
  const wpMatch = notesText.match(/WP:\s*([^,H][^H]+?)(?:\s+HBP:|$)/);
  if (wpMatch) {
    const names = wpMatch[1].split(',').map(s => s.trim()).filter(Boolean);
    names.forEach(name => {
      const pitcher = findPitcherAcrossTeams(pitching, teams, name);
      if (pitcher) pitcher.wp++;
    });
  }

  // Parse HBP
  const hbpMatch = notesText.match(/HBP:\s*([^,B][^B]+?)(?:\s+BF:|$)/);
  if (hbpMatch) {
    const entries = hbpMatch[1].split(',').map(s => s.trim()).filter(Boolean);
    entries.forEach(entry => {
      const m = entry.match(/^(.+?)\s+(\d+)$/);
      const pitcher = findPitcherAcrossTeams(pitching, teams, m ? m[1] : entry);
      if (pitcher) pitcher.hbp += m ? parseInt(m[2]) : 1;
    });
  }
}

function findPitcherAcrossTeams(pitching, teams, noteName) {
  const lower = noteName.toLowerCase().trim();
  for (const team of teams) {
    if (!pitching[team]) continue;
    for (const pitcher of Object.values(pitching[team])) {
      const pLower = pitcher.name.toLowerCase();
      // Match last name or partial name
      const lastName = pLower.split(' ').pop();
      const noteLast = lower.split(' ').pop();
      if (pLower.includes(lower) || lower.includes(pLower) ||
          lastName === noteLast || pLower.startsWith(lower)) {
        return pitcher;
      }
    }
  }
  return null;
}

// ============================================================
// STAT CALCULATORS (for DB insertion)
// ============================================================

function computeBattingLine(player) {
  if (!player) return null;
  return {
    g: 1,
    pa: player.pa || player.ab + player.bb + (player.hbp||0) + (player.sac||0) + (player.sf||0),
    ab: player.ab, h: player.h, singles: player.singles || 0,
    doubles: player.doubles || 0, triples: player.triples || 0,
    hr: player.hr || 0, xbh: player.xbh || 0,
    r: player.r || 0, rbi: player.rbi || 0,
    bb: player.bb, ks: player.so, ksSwing: player.so, ksLook: 0,
    hbp: player.hbp || 0, sac: player.sac || 0, sf: player.sf || 0,
    roe: 0, sb: player.sb || 0, cs: 0,
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
    h9: pitcher.h9, whip: pitcher.whip, kbb: pitcher.bb > 0 ? +(pitcher.ks/pitcher.bb).toFixed(2) : null,
    kPct: pitcher.kPct || 0, bbPct: pitcher.bbPct || 0,
    gbPct: 0, ldPct: 0, fbPct: 0,
    fpsPct: pitcher.fpsPct || 0, strikePct: pitcher.strikePct || 0,
    totalPitches: pitcher.totalPitches || 0,
    avgPPerBF: pitcher.bf > 0 ? +((pitcher.totalPitches||0)/pitcher.bf).toFixed(1) : null,
    avgPPerInn: pitcher.ipDecimal > 0 ? +((pitcher.totalPitches||0)/pitcher.ipDecimal).toFixed(1) : null,
    innings: [],
  };
}

module.exports = { parseGCScorebook, computeBattingLine, computePitchingLine };
