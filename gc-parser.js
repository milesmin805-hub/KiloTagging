/**
 * GameChanger Scorebook PDF Parser — Node.js
 * 
 * Dependencies (add to package.json):
 *   "pdf-parse": "^1.1.1"
 * 
 * Usage:
 *   const { parseGCScorebook } = require('./gc-parser');
 *   const game = await parseGCScorebook(pdfBuffer);
 */

const pdfParse = require('pdf-parse');

// ============================================================
// RESULT PATTERN MATCHING 
// ============================================================

const AT_BAT_RE = /^(K|BB|HBP|IBB|FC|1B(\+E)?|2B(\+E)?|3B|HR|SB|CS|WP|PB|PO|OA|BK|CI|INT|G\d*(-\d+)?|F\d+|L\d+|DP\d*(-\d+)?|E\d*|SAC|SF)$/;

function isResult(text) {
  return AT_BAT_RE.test((text || '').trim());
}

function sprayDirection(result) {
  const m = (result || '').match(/^[GFL](\d)/);
  if (!m) return null;
  const f = parseInt(m[1]);
  if ([5,6,7].includes(f)) return 'L';
  if ([1,2,8].includes(f)) return 'C';
  if ([3,4,9].includes(f)) return 'R';
  return null;
}

function hitType(result) {
  if (!result) return null;
  if (result.startsWith('G') || result.startsWith('DP')) return 'GB';
  if (result.startsWith('F')) return 'FB';
  if (result.startsWith('L')) return 'LD';
  return null;
}

// ============================================================
// PDF TEXT EXTRACTION + SPATIAL PARSING
// ============================================================

/**
 * pdf-parse gives us raw text. We need to reconstruct spatial layout.
 * Strategy: use the text extraction with layout preservation, then
 * parse line by line with positional awareness.
 * 
 * GameChanger scorebook structure per page:
 * - Line 1: Team name
 * - Line 2: "Away/Home  Date: YYYY/MM/DD  Time: HH:MM"
 * - Line 3: column header "1 2 3 3 4 5 6 7 8" (inning numbers)
 * - Then player rows, each ~5-6 lines tall:
 *   - Line A: #JERSEY Name  [POS]  [#J1 RES1] [#J2 RES2] ... per inning
 *   - Line B: pitch sequence balls row
 *   - Line C: pitch sequence strikes row
 *   - Line D: supplemental events (SB, WP, etc.)
 */

async function parseGCScorebook(pdfBuffer) {
  // Extract with layout-preserving options
  const data = await pdfParse(pdfBuffer, {
    pagerender: null,
    max: 0,
  });

const rawText = data.text;
  let pages = rawText.split('\f').filter(p => p && p.trim().length > 10);

  if (pages.length < 2) {
    const headerRe = /([A-Z][A-Za-z ]{3,50}?)(Away|Home)\s*Date:/g;
    const headers = [];
    let hm;
    while ((hm = headerRe.exec(rawText)) !== null) {
      headers.push({ idx: hm.index, team: hm[1].trim(), homeAway: hm[2] });
    }
    if (headers.length >= 2) {
      pages = [
        rawText.slice(0, headers[1].idx),
        rawText.slice(headers[1].idx),
      ];
    }
  }

  const game = {
    teams: [], date: null, homeAway: [],
    batting: {}, pitching: {},
  };

  for (let pageIdx = 0; pageIdx < Math.min(pages.length, 2); pageIdx++) {
    const pageText = pages[pageIdx];
    if (!pageText || !pageText.trim()) continue;

    const lines = pageText.split('\n').map(l => l.trimEnd());
    const result = parsePage(lines, pageIdx);

    if (result.teamName && !game.teams.includes(result.teamName)) {
      game.teams.push(result.teamName);
    }
    if (result.date && !game.date) game.date = result.date;
    if (result.homeAway) game.homeAway.push(result.homeAway);
    if (result.teamName) {
      game.batting[result.teamName]  = result.batting;
      game.pitching[result.teamName] = result.pitching;
    }
  }

  return game;
}

function parsePage(lines, pageIdx) {
  let teamName = null;
  let date = null;
  let homeAway = null;
  let inningLabels = []; // e.g. ['1','2','3','3','4','5','6','7','8']
  const players = {}; // jersey -> player data
  const pitchers = {}; // name -> Set of inning labels

  // ---- Parse header ----
  for (let i = 0; i < Math.min(lines.length, 8); i++) {
    const line = lines[i].trim();
    if (!line) continue;

// Team name — may be jammed together with Away/Home/Date in pdf-parse output
    if (!teamName) {
      // Try to extract team name from lines like "Royal Varsity HighlandersAwayDate: 2026/02/21"
// Team name — may be jammed together with Away/Home/Date in pdf-parse output
      const jammedMatch = line.match(/^(.+?)(Away|Home)\s*Date:/);
      if (jammedMatch) {
        teamName = jammedMatch[1].trim();
        const dm = line.match(/Date:\s*(\d{4}\/\d{2}\/\d{2})/);
        if (dm) date = dm[1];
        homeAway = line.includes('Away') ? 'away' : 'home';
        continue;
      }
      // Also handle case where team name ends with Away/Home jammed at end
      const endJamMatch = line.match(/^(.+?)(Away|Home)$/);
      if (endJamMatch && endJamMatch[1].length > 3) {
        teamName = endJamMatch[1].trim();
        homeAway = endJamMatch[2] === 'Away' ? 'away' : 'home';
        continue;
      }
      
      // Normal case — standalone team name line
      if (line.length > 3 && !line.includes('Date:') && !line.includes('Away') && !line.includes('Home') && line !== '#Name') {
        teamName = line;
        continue;
      }
    }

    // Date and home/away
    if (line.includes('Date:')) {
      const dm = line.match(/Date:\s*(\d{4}\/\d{2}\/\d{2})/);
      if (dm) date = dm[1];
      homeAway = line.includes('Away') ? 'away' : 'home';
      continue;
    }

    // Inning header row — line of single digits separated by spaces
    const innMatch = line.match(/^[\s\d]+$/) && line.trim().match(/^(\d\s+)+\d$/);
    if (innMatch || /^\s*1\s+2\s+3/.test(line)) {
      inningLabels = line.trim().split(/\s+/).filter(t => /^\d$/.test(t));
      break;
    }
  }

  if (inningLabels.length === 0) {
    // Fallback: standard 9 columns
    inningLabels = ['1','2','3','4','5','6','7','8','9'];
  }

  const numCols = inningLabels.length;

  // ---- Parse player rows ----
  // Each player block starts with a line containing:
  // jersey_number  Name  [Position]  at-bat-results...
  // 
  // We identify player lines by: starts with 1-2 digits at the beginning

  const playerLineRe = /^(\d{1,2})\s+([A-Z][a-zA-Z.]+(?:\s+[A-Z][a-zA-Z.]+)*)\s*((?:[A-Z0-9]{1,4}\s*)*)\s*(.*)/;

  // Collect all lines that look like player rows
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (!line) { i++; continue; }

    const m = line.match(/^(\d{1,2})\s+([A-Z][a-zA-Z.]\S*(?:\s+[A-Z][a-zA-Z.]\S*)*)/);
    if (!m) { i++; continue; }

    const jersey = m[1];
    const restOfLine = line.slice(m[0].length).trim();

    // Parse position (1-4 char uppercase tokens before at-bat data)
    const tokens = restOfLine.split(/\s+/);
    let posTokens = [];
    let atBatStart = 0;
    for (let t = 0; t < tokens.length; t++) {
      if (/^[A-Z0-9]{1,4}$/.test(tokens[t]) && !isResult(tokens[t]) && !/^#\d/.test(tokens[t])) {
        posTokens.push(tokens[t]);
        atBatStart = t + 1;
      } else {
        atBatStart = t;
        break;
      }
    }

    // Parse name from the start of the line
    const nameMatch = line.match(/^\d{1,2}\s+([A-Z][a-zA-Z.]+(?:\s+[A-Z][a-zA-Z.]+)*)/);
    const name = nameMatch ? nameMatch[1].trim() : `Player${jersey}`;
    const position = posTokens.join(' ');
    const isPitcher = /\bP\b/.test(position);

    // Now parse the inning columns from subsequent lines
    // Collect the next 4-6 lines as this player's block
    const blockLines = [line];
    let j = i + 1;
    while (j < lines.length && j < i + 7) {
      const nextLine = lines[j];
      // Stop if next line starts a new player (number at start)
      if (/^\d{1,2}\s+[A-Z]/.test(nextLine)) break;
      blockLines.push(nextLine);
      j++;
    }

    // Parse at-bat results from the block
    const atBats = parseAtBats(blockLines, inningLabels, jersey, name);

    const playerKey = `#${jersey} ${name}`;
    if (!players[playerKey]) {
      players[playerKey] = {
        jersey, name, position, isPitcher,
        atBats: atBats,
      };
    } else {
      // Merge sub-row at-bats
      atBats.forEach((ab, idx) => {
        if (ab && !players[playerKey].atBats[idx]) {
          players[playerKey].atBats[idx] = ab;
        }
      });
      if (isPitcher) players[playerKey].isPitcher = true;
    }

    // Track pitcher innings
    if (isPitcher) {
      if (!pitchers[name]) pitchers[name] = new Set();
      atBats.forEach((ab, idx) => {
        if (ab) pitchers[name].add(inningLabels[idx]);
      });
    }

    i = j;
  }

  return { teamName, date, homeAway, batting: players, pitching: pitchers };
}

function parseAtBats(blockLines, inningLabels, jersey, name) {
  /**
   * Parse at-bat results from a player's block of text lines.
   * 
   * The at-bat results appear in the first line of the block after the
   * player name/position. Each inning column has a cell containing:
   * - Optional: #JERSEY (sub marker)
   * - Result code: G6-3, F8, K, BB, 1B, etc.
   * - Pitch sequence on subsequent lines
   * 
   * We use character position to align columns.
   */
  const numCols = inningLabels.length;
  const atBats = new Array(numCols).fill(null);

  if (!blockLines.length) return atBats;

  // The first line has the player info + first row of at-bat data
  // Subsequent lines have pitch sequences and supplemental events
  
  // Join all block lines and scan for result patterns
  // Each result is preceded by an optional #JERSEY marker

  const fullBlock = blockLines.join(' ');
  
  // Find all #JERSEY RESULT pairs or standalone results
  // Pattern: (#\d{1,2}\s+)?RESULT
  const resultPattern = /#?(\d{1,2})\s+([A-Z]\S*)/g;
  
  // Simpler approach: scan each line for result tokens
  // Results appear after position codes in the first line
  // and in subsequent lines if player batted around

  // Find the column width: total line width / numCols
  const firstLine = blockLines[0] || '';
  
  // Find where at-bat data starts (after name + position)
  // Name is typically 20-25 chars, position 5-10 chars
  // Then at-bat cells follow
  
  // Scan all lines for result tokens with their column positions
  const colResults = new Array(numCols).fill(null);
  const colPitches = new Array(numCols).fill(null).map(() => ({ balls: 0, strikes: 0, fps: false }));
  const colEvents  = new Array(numCols).fill(null).map(() => ({ sb: false, wp: false }));

  // Estimate column width from line length
  // GameChanger uses fixed-width columns
  // Player info takes first ~25 chars, then numCols * colWidth
  
  for (const line of blockLines) {
    if (!line.trim()) continue;

    // Scan for at-bat result codes
    // Results are standalone uppercase tokens matching our pattern
    const tokens = line.trim().split(/\s+/);
    
    // Look for #JERSEY RESULT patterns (sub entries)
    for (let t = 0; t < tokens.length - 1; t++) {
      const jerseyMatch = tokens[t].match(/^#(\d{1,2})$/);
      if (jerseyMatch && isResult(tokens[t+1])) {
        // Find which column this is in by character position
        const charPos = line.indexOf(tokens[t]);
        const colIdx = estimateColumn(charPos, line.length, numCols);
        if (colIdx >= 0 && colIdx < numCols) {
          let result = tokens[t+1];
          colResults[colIdx] = result === 'K' ? 'KS' : result; // K → KS (no visual detector in Node yet)
        }
      }
    }

    // Look for standalone result codes
    for (let t = 0; t < tokens.length; t++) {
      if (isResult(tokens[t]) && tokens[t] !== 'B' && tokens[t] !== 'S') {
        const charPos = line.indexOf(tokens[t]);
        const colIdx = estimateColumn(charPos, line.length, numCols);
        if (colIdx >= 0 && colIdx < numCols && !colResults[colIdx]) {
          let result = tokens[t];
          colResults[colIdx] = result === 'K' ? 'KS' : result;
        }
      }

      // Pitch sequence: B/S with numbers
      if (tokens[t] === 'B' || tokens[t] === 'S') {
        const charPos = line.indexOf(tokens[t]);
        const colIdx = estimateColumn(charPos, line.length, numCols);
        if (colIdx >= 0 && colIdx < numCols) {
          // Count consecutive digits after B or S as pitch count
          if (tokens[t] === 'B') colPitches[colIdx].balls++;
          if (tokens[t] === 'S') {
            colPitches[colIdx].strikes++;
            // First pitch strike if first digit after S is 1
            if (t+1 < tokens.length && tokens[t+1] === '1') {
              colPitches[colIdx].fps = true;
            }
          }
        }
      }

      // Supplemental events
      if (tokens[t] === 'SB') {
        const charPos = line.indexOf(tokens[t]);
        const colIdx = estimateColumn(charPos, line.length, numCols);
        if (colIdx >= 0 && colIdx < numCols) colEvents[colIdx].sb = true;
      }
      if (tokens[t] === 'WP') {
        const charPos = line.indexOf(tokens[t]);
        const colIdx = estimateColumn(charPos, line.length, numCols);
        if (colIdx >= 0 && colIdx < numCols) colEvents[colIdx].wp = true;
      }
    }
  }

  // Build at-bat objects
  for (let c = 0; c < numCols; c++) {
    if (!colResults[c]) continue;
    atBats[c] = {
      inning: inningLabels[c],
      colIdx: c,
      result: colResults[c],
      balls: colPitches[c].balls,
      strikes: colPitches[c].strikes,
      totalPitches: colPitches[c].balls + colPitches[c].strikes,
      fps: colPitches[c].fps,
      sb: colEvents[c].sb,
      wp: colEvents[c].wp,
      spray: sprayDirection(colResults[c]),
      hitType: hitType(colResults[c]),
    };
  }

  return atBats;
}

function estimateColumn(charPos, lineLength, numCols) {
  // Player info area takes first ~25% of line
  // Rest is split into numCols equal columns
  const PLAYER_AREA = Math.floor(lineLength * 0.25);
  if (charPos < PLAYER_AREA) return -1;
  const gridWidth = lineLength - PLAYER_AREA;
  const colWidth = gridWidth / numCols;
  const col = Math.floor((charPos - PLAYER_AREA) / colWidth);
  return Math.max(0, Math.min(numCols - 1, col));
}

// ============================================================
// STAT CALCULATORS
// ============================================================

function computeBattingLine(atBats) {
  const abs = atBats.filter(ab => ab !== null);
  if (!abs.length) return null;

  const results = abs.map(ab => ab.result);

  const singles  = results.filter(r => r === '1B' || r?.startsWith('1B+')).length;
  const doubles  = results.filter(r => r === '2B' || r?.startsWith('2B+')).length;
  const triples  = results.filter(r => r === '3B').length;
  const homers   = results.filter(r => r === 'HR').length;
  const hits     = singles + doubles + triples + homers;
  const xbh      = doubles + triples + homers;

  const walks    = results.filter(r => r === 'BB' || r === 'IBB').length;
  const ksSwing  = results.filter(r => r === 'KS').length;
  const ksLook   = results.filter(r => r === 'KL').length;
  const ks       = ksSwing + ksLook;
  const hbp      = results.filter(r => r === 'HBP').length;
  const sac      = results.filter(r => r === 'SAC' || r === 'SF').length;
  const fc       = results.filter(r => r === 'FC').length;
  const roe      = results.filter(r => r && /^E\d*$/.test(r)).length;
  const sb       = abs.filter(ab => ab.sb).length;
  const cs       = results.filter(r => r === 'CS').length;

  const outResults = new Set(['KS','KL','FC']);
  const outPrefixes = ['G','F','L','DP','E'];
  const ab = results.filter(r => r && (outResults.has(r) || outPrefixes.some(p => r.startsWith(p)))).length + hits;
  const pa = ab + walks + hbp + sac;

  const avg  = ab > 0 ? +(hits/ab).toFixed(3) : 0;
  const obp  = (ab+walks+hbp+sac) > 0 ? +((hits+walks+hbp)/(ab+walks+hbp+sac)).toFixed(3) : 0;
  const slg  = ab > 0 ? +((singles+2*doubles+3*triples+4*homers)/ab).toFixed(3) : 0;
  const ops  = +(obp+slg).toFixed(3);
  const iso  = +(slg-avg).toFixed(3);
  const woba = (ab+walks+hbp+sac) > 0
    ? +((0.69*walks+0.72*hbp+0.888*singles+1.271*doubles+1.616*triples+2.101*homers)/(ab+walks+hbp+sac)).toFixed(3)
    : 0;

  const bip    = abs.filter(ab => ab.hitType);
  const bipN   = bip.length;
  const gbCount = bip.filter(ab => ab.hitType==='GB').length;
  const ldCount = bip.filter(ab => ab.hitType==='LD').length;
  const fbCount = bip.filter(ab => ab.hitType==='FB').length;
  const gbPct  = bipN > 0 ? +((gbCount/bipN)*100).toFixed(1) : 0;
  const ldPct  = bipN > 0 ? +((ldCount/bipN)*100).toFixed(1) : 0;
  const fbPct  = bipN > 0 ? +((fbCount/bipN)*100).toFixed(1) : 0;
  const gbFb   = fbCount > 0 ? +(gbCount/fbCount).toFixed(2) : null;

  const spray   = abs.filter(ab => ab.spray).map(ab => ab.spray);
  const sprayN  = spray.length;
  const sprayL  = sprayN > 0 ? +((spray.filter(s=>s==='L').length/sprayN)*100).toFixed(1) : 0;
  const sprayC  = sprayN > 0 ? +((spray.filter(s=>s==='C').length/sprayN)*100).toFixed(1) : 0;
  const sprayR  = sprayN > 0 ? +((spray.filter(s=>s==='R').length/sprayN)*100).toFixed(1) : 0;

  const totalPitches = abs.reduce((s,ab) => s + (ab.totalPitches||0), 0);
  const fpsPct = pa > 0 ? +((abs.filter(ab=>ab.fps).length/pa)*100).toFixed(1) : 0;

  return {
    g:1, pa, ab, h:hits, singles, doubles, triples, hr:homers, xbh,
    bb:walks, ks, ksSwing, ksLook, hbp, sac, fc, roe, sb, cs,
    avg, obp, slg, ops, iso, woba,
    gbPct, ldPct, fbPct, gbFb,
    sprayL, sprayC, sprayR,
    totalPitchesSeen: totalPitches, fpsPct,
  };
}

function computePitchingLine(oppBatting, pitcherInnings) {
  if (!pitcherInnings || pitcherInnings.size === 0) return null;

  const allPAs = [];
  for (const pdata of Object.values(oppBatting)) {
    for (const ab of pdata.atBats) {
      if (ab && pitcherInnings.has(ab.inning)) {
        allPAs.push(ab);
      }
    }
  }
  if (!allPAs.length) return null;

  const results = allPAs.map(ab => ab.result);
  const bf   = allPAs.length;
  const h    = results.filter(r => r && ['1B','2B','3B','HR'].includes(r) || (r?.startsWith('1B+')) || (r?.startsWith('2B+'))).length;
  const bb   = results.filter(r => r === 'BB' || r === 'IBB').length;
  const ks   = results.filter(r => r === 'KS' || r === 'KL').length;
  const ksSwing = results.filter(r => r === 'KS').length;
  const ksLook  = results.filter(r => r === 'KL').length;
  const hbp  = results.filter(r => r === 'HBP').length;
  const hr   = results.filter(r => r === 'HR').length;
  const wp   = allPAs.filter(ab => ab.wp).length;
  const ip   = pitcherInnings.size;

  const k9   = ip > 0 ? +(ks/ip*9).toFixed(2) : null;
  const bb9  = ip > 0 ? +(bb/ip*9).toFixed(2) : null;
  const h9   = ip > 0 ? +(h/ip*9).toFixed(2) : null;
  const whip = ip > 0 ? +((h+bb)/ip).toFixed(3) : null;
  const kbb  = bb > 0 ? +(ks/bb).toFixed(2) : null;
  const kPct  = bf > 0 ? +(ks/bf*100).toFixed(1) : 0;
  const bbPct = bf > 0 ? +(bb/bf*100).toFixed(1) : 0;

  const bip    = allPAs.filter(ab => ab.hitType);
  const bipN   = bip.length;
  const gbPct  = bipN > 0 ? +((bip.filter(ab=>ab.hitType==='GB').length/bipN)*100).toFixed(1) : 0;
  const ldPct  = bipN > 0 ? +((bip.filter(ab=>ab.hitType==='LD').length/bipN)*100).toFixed(1) : 0;
  const fbPct  = bipN > 0 ? +((bip.filter(ab=>ab.hitType==='FB').length/bipN)*100).toFixed(1) : 0;

  const totalPitches = allPAs.reduce((s,ab) => s+(ab.totalPitches||0), 0);
  const fpsPct = bf > 0 ? +((allPAs.filter(ab=>ab.fps).length/bf)*100).toFixed(1) : 0;
  const totalStrikes = allPAs.reduce((s,ab) => s+(ab.strikes||0), 0);
  const strikePct = totalPitches > 0 ? +((totalStrikes/totalPitches)*100).toFixed(1) : 0;

  return {
    g:1, gs:1, ip, bf, h, bb, ks, ksSwing, ksLook, hbp, hr, wp,
    k9, bb9, h9, whip, kbb, kPct, bbPct,
    gbPct, ldPct, fbPct,
    fpsPct, strikePct,
    totalPitches,
    avgPPerBF:  bf > 0 ? +(totalPitches/bf).toFixed(1) : null,
    avgPPerInn: ip > 0 ? +(totalPitches/ip).toFixed(1) : null,
    innings: [...pitcherInnings].sort(),
  };
}

async function debugParsePDF(pdfBuffer) {
  const data = await pdfParse(pdfBuffer, { pagerender: null, max: 0 });
  const pages = data.text.split('\f');
  console.log('=== GC PARSER DEBUG ===');
  console.log('Total pages detected:', pages.length);
  pages.forEach((p, i) => {
    const lines = p.split('\n').filter(l => l.trim());
    console.log(`Page ${i}: ${lines.length} lines, first 5:`, lines.slice(0, 5));
  });
  return data.text;
}

module.exports = { parseGCScorebook, computeBattingLine, computePitchingLine, debugParsePDF };
