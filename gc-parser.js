/**
 * GameChanger Scorebook PDF Parser — Node.js
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
// MAIN PARSER
// ============================================================

async function parseGCScorebook(pdfBuffer) {
  const data = await pdfParse(pdfBuffer, { pagerender: null, max: 0 });
  const rawText = data.text;

  // Split pages by form feed
  let pages = rawText.split('\f').filter(p => p && p.trim().length > 10);

  // If only one page block, try to split on second team header
  if (pages.length < 2) {
    const headerRe = /([A-Z][A-Za-z ]{3,50}?)(Away|Home)\s*Date:/g;
    const headers = [];
    let hm;
    while ((hm = headerRe.exec(rawText)) !== null) {
      headers.push({ idx: hm.index });
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
    const result = parsePage(lines);

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

// ============================================================
// PAGE PARSER
// ============================================================

function parsePage(lines) {
  let teamName = null;
  let date = null;
  let homeAway = null;
  let inningLabels = [];
  const players = {};
  const pitchers = {};

  // ---- Parse header (first 8 lines) ----
  for (let i = 0; i < Math.min(lines.length, 8); i++) {
    const line = lines[i].trim();
    if (!line) continue;

    if (!teamName) {
      // Team name jammed with Away/Home Date: e.g. "Royal Varsity HighlandersAwayDate: 2026/02/21"
      const jammedMatch = line.match(/^(.+?)(Away|Home)\s*Date:/);
      if (jammedMatch) {
        teamName = jammedMatch[1].trim();
        const dm = line.match(/Date:\s*(\d{4}\/\d{2}\/\d{2})/);
        if (dm) date = dm[1];
        homeAway = line.includes('Away') ? 'away' : 'home';
        continue;
      }
      // Standalone team name
      if (line.length > 3 && !line.includes('Date:') &&
          !line.includes('Away') && !line.includes('Home') &&
          line !== '#Name' && !/^\d+$/.test(line)) {
        teamName = line;
        continue;
      }
    }

    if (line.includes('Date:') && !date) {
      const dm = line.match(/Date:\s*(\d{4}\/\d{2}\/\d{2})/);
      if (dm) date = dm[1];
      homeAway = line.includes('Away') ? 'away' : 'home';
    }

    // Inning header row e.g. "123456789" or "1 2 3 3 4 5 6 7 8"
    if (/^[\d\s]+$/.test(line) && line.trim().length >= 7) {
      if (/^\d{7,}$/.test(line.trim())) {
        inningLabels = line.trim().split('').filter(c => /\d/.test(c));
      } else {
        inningLabels = line.trim().split(/\s+/).filter(t => /^\d$/.test(t));
      }
      if (inningLabels.length >= 7) break;
    }
  }

  if (inningLabels.length === 0) {
    inningLabels = ['1','2','3','4','5','6','7','8','9'];
  }

  // ---- Parse player roster ----
  // Each player line format: {jersey}{initial}. {lastname}{position}
  // e.g. "2E. HallRF" "14A. Koby3B" "19P. VisageC" "27N. Vasqez2B"
  // Jersey (1-2 digits) + Initial (A-Z + period) + space + LastName + Position

  const roster = {};
  const POSITIONS = new Set(['P','C','1B','2B','3B','SS','LF','CF','RF','DH','EH','PH','PR']);

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    // Stop at inning header
    if (/^\d{7,}$/.test(trimmed)) break;

// Format 1: jersey jammed with name: "2E. HallRF" "14A. Koby3B" "23C. Rainer1B"
    const playerMatch = trimmed.match(/^(\d{1,2})([A-Z]\. [A-Za-z]+)([A-Z0-9]{1,2})?\s*$/);
    if (playerMatch) {
      const jersey   = playerMatch[1];
      const name     = playerMatch[2].trim();
      const pos      = playerMatch[3] || '';
      roster[jersey] = { name, position: pos, isPitcher: pos === 'P' };
      continue;
    }

    // Format 2: name only, no jersey prefix: "R. TalleyCF"
    // Jersey comes from the jerseyResults keys that don't have roster entries yet
    const nameOnlyMatch = trimmed.match(/^([A-Z]\. [A-Za-z]+)([A-Z0-9]{1,2})?\s*$/);
    if (nameOnlyMatch) {
      const name = nameOnlyMatch[1].trim();
      const pos  = nameOnlyMatch[2] || '';
      // Store temporarily — match to jersey after parsing results
      if (!roster['_pending']) roster['_pending'] = [];
      roster['_pending'].push({ name, position: pos, isPitcher: pos === 'P' });
      continue;
    }

    // Format 3: last name only with jersey "7Tabora" "52Smith"
    const subMatch = trimmed.match(/^(\d{1,2})([A-Z][a-z]+)([A-Z0-9]{1,2})?$/);
    if (subMatch && !roster[subMatch[1]]) {
      const jersey = subMatch[1];
      const name   = subMatch[2].trim();
      const pos    = subMatch[3] || '';
      roster[jersey] = { name, position: pos, isPitcher: pos === 'P' };
    }
  }

  // ---- Parse at-bat results ----
  // Format per at-bat (each on its own line):
  // #JERSEY (or #JERSEYRESULT jammed)
  // optional: inning number
  // B### (balls pitched as 2,3,5 → "B235")
  // S### (strikes pitched as 1,4,6,7 → "S1467")
  // RESULT (K, BB, G6-3, F8, 1B, etc.)
  // or result jammed with jersey: "#2K" "#2F"

  const jerseyResults = {};

  let i = 0;
  while (i < lines.length) {
    const line = lines[i].trim();

    // At-bat header: #JERSEY or #JERSEY+RESULT jammed e.g. "#2K" "#2SF"
    const abHeader = line.match(/^#(\d{1,2})([A-Z]\S*)?$/);
    if (abHeader) {
      const jersey = abHeader[1];
      let result   = abHeader[2] || null;

      // If result jammed on header line, validate it
      if (result && !isResult(result)) result = null;

      // Scan next few lines for result if not found yet
      let balls = 0, strikes = 0, fps = false, sb = false, wp = false;
      let scanIdx = i + 1;
      while (scanIdx < Math.min(i + 10, lines.length)) {
        const sl = lines[scanIdx].trim();

        // Stop at next at-bat header
        if (/^#\d/.test(sl)) break;

        // Result line
        if (!result && isResult(sl)) {
          result = sl;
        }

        // Result with fielder jammed e.g. "F4" "G6-3" "DP6-3" "L8" "SF8"
        if (!result) {
          const rm = sl.match(/^([A-Z]{1,2}\d[-\d]*)$/);
          if (rm && isResult(rm[1])) result = rm[1];
        }

        // Balls: "B235" means balls on pitches 2,3,5 → count = 3
        if (/^B\d+$/.test(sl)) balls = sl.length - 1;

        // Strikes: "S1467" means strikes on pitches 1,4,6,7 → count = 4
        if (/^S\d+$/.test(sl)) {
          strikes = sl.length - 1;
          fps = sl.charAt(1) === '1'; // first pitch was a strike
        }

        if (sl === 'SB') sb = true;
        if (sl === 'WP') wp = true;

        scanIdx++;
      }

      if (result) {
        if (!jerseyResults[jersey]) jerseyResults[jersey] = [];
        jerseyResults[jersey].push({
          result: result === 'K' ? 'KS' : result,
          balls, strikes,
          totalPitches: balls + strikes,
          fps, sb, wp,
          spray: sprayDirection(result),
          hitType: hitType(result),
        });
      }
    }

    i++;
  }

// Match pending (name-only) players to unmatched jersey result keys
  if (roster['_pending']) {
    const pendingList = roster['_pending'];
    delete roster['_pending'];
    const unmatchedJerseys = Object.keys(jerseyResults).filter(j => !roster[j]);
    pendingList.forEach((p, idx) => {
      if (unmatchedJerseys[idx]) {
        roster[unmatchedJerseys[idx]] = p;
      }
    });
  }

  // Add placeholder for any jersey with results but no roster entry
  for (const jersey of Object.keys(jerseyResults)) {
    if (!roster[jersey]) {
      roster[jersey] = { name: `Player #${jersey}`, position: '', isPitcher: false };
    }
  }

  // ---- Build player records ----
  console.log('ROSTER:', JSON.stringify(Object.keys(roster)));
  console.log('JERSEY RESULTS:', JSON.stringify(Object.keys(jerseyResults)));
  for (const [j, res] of Object.entries(jerseyResults)) {
    console.log(`  Jersey #${j} results:`, res.map(r => r.result));
  }
  for (const [jersey, info] of Object.entries(roster)) {
    const playerKey = `#${jersey} ${info.name}`;
    const abs = (jerseyResults[jersey] || []).map((ab, idx) => ({
      ...ab,
      inning: inningLabels[idx] || String(idx + 1),
      colIdx: idx,
    }));

    players[playerKey] = {
      jersey,
      name: info.name,
      position: info.position,
      isPitcher: info.isPitcher,
      atBats: abs,
    };

    if (info.isPitcher) {
      if (!pitchers[info.name]) pitchers[info.name] = new Set();
      abs.forEach(ab => pitchers[info.name].add(ab.inning));
    }
  }

  return { teamName, date, homeAway, batting: players, pitching: pitchers };
}

// ============================================================
// STAT CALCULATORS
// ============================================================

function computeBattingLine(atBats) {
  const abs = atBats.filter(ab => ab !== null);
  if (!abs.length) return null;

  const results = abs.map(ab => ab.result);

  const singles = results.filter(r => r === '1B' || r?.startsWith('1B+')).length;
  const doubles = results.filter(r => r === '2B' || r?.startsWith('2B+')).length;
  const triples = results.filter(r => r === '3B').length;
  const homers  = results.filter(r => r === 'HR').length;
  const hits    = singles + doubles + triples + homers;
  const xbh     = doubles + triples + homers;

  const walks   = results.filter(r => r === 'BB' || r === 'IBB').length;
  const ksSwing = results.filter(r => r === 'KS').length;
  const ksLook  = results.filter(r => r === 'KL').length;
  const ks      = ksSwing + ksLook;
  const hbp     = results.filter(r => r === 'HBP').length;
  const sac     = results.filter(r => r === 'SAC' || r === 'SF').length;
  const fc      = results.filter(r => r === 'FC').length;
  const roe     = results.filter(r => r && /^E\d*$/.test(r)).length;
  const sb      = abs.filter(ab => ab.sb).length;
  const cs      = results.filter(r => r === 'CS').length;

  const outResults  = new Set(['KS','KL','FC']);
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

  const bip     = abs.filter(ab => ab.hitType);
  const bipN    = bip.length;
  const gbCount = bip.filter(ab => ab.hitType==='GB').length;
  const ldCount = bip.filter(ab => ab.hitType==='LD').length;
  const fbCount = bip.filter(ab => ab.hitType==='FB').length;
  const gbPct   = bipN > 0 ? +((gbCount/bipN)*100).toFixed(1) : 0;
  const ldPct   = bipN > 0 ? +((ldCount/bipN)*100).toFixed(1) : 0;
  const fbPct   = bipN > 0 ? +((fbCount/bipN)*100).toFixed(1) : 0;
  const gbFb    = fbCount > 0 ? +(gbCount/fbCount).toFixed(2) : null;

  const spray  = abs.filter(ab => ab.spray).map(ab => ab.spray);
  const sprayN = spray.length;
  const sprayL = sprayN > 0 ? +((spray.filter(s=>s==='L').length/sprayN)*100).toFixed(1) : 0;
  const sprayC = sprayN > 0 ? +((spray.filter(s=>s==='C').length/sprayN)*100).toFixed(1) : 0;
  const sprayR = sprayN > 0 ? +((spray.filter(s=>s==='R').length/sprayN)*100).toFixed(1) : 0;

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
      if (ab && pitcherInnings.has(ab.inning)) allPAs.push(ab);
    }
  }
  if (!allPAs.length) return null;

  const results  = allPAs.map(ab => ab.result);
  const bf       = allPAs.length;
  const h        = results.filter(r => r && (['1B','2B','3B','HR'].includes(r) || r.startsWith('1B+') || r.startsWith('2B+'))).length;
  const bb       = results.filter(r => r === 'BB' || r === 'IBB').length;
  const ks       = results.filter(r => r === 'KS' || r === 'KL').length;
  const ksSwing  = results.filter(r => r === 'KS').length;
  const ksLook   = results.filter(r => r === 'KL').length;
  const hbp      = results.filter(r => r === 'HBP').length;
  const hr       = results.filter(r => r === 'HR').length;
  const wp       = allPAs.filter(ab => ab.wp).length;
  const ip       = pitcherInnings.size;

  const k9   = ip > 0 ? +(ks/ip*9).toFixed(2) : null;
  const bb9  = ip > 0 ? +(bb/ip*9).toFixed(2) : null;
  const h9   = ip > 0 ? +(h/ip*9).toFixed(2)  : null;
  const whip = ip > 0 ? +((h+bb)/ip).toFixed(3) : null;
  const kbb  = bb > 0 ? +(ks/bb).toFixed(2) : null;
  const kPct  = bf > 0 ? +(ks/bf*100).toFixed(1) : 0;
  const bbPct = bf > 0 ? +(bb/bf*100).toFixed(1) : 0;

  const bip   = allPAs.filter(ab => ab.hitType);
  const bipN  = bip.length;
  const gbPct = bipN > 0 ? +((bip.filter(ab=>ab.hitType==='GB').length/bipN)*100).toFixed(1) : 0;
  const ldPct = bipN > 0 ? +((bip.filter(ab=>ab.hitType==='LD').length/bipN)*100).toFixed(1) : 0;
  const fbPct = bipN > 0 ? +((bip.filter(ab=>ab.hitType==='FB').length/bipN)*100).toFixed(1) : 0;

  const totalPitches = allPAs.reduce((s,ab) => s+(ab.totalPitches||0), 0);
  const fpsPct       = bf > 0 ? +((allPAs.filter(ab=>ab.fps).length/bf)*100).toFixed(1) : 0;
  const totalStrikes = allPAs.reduce((s,ab) => s+(ab.strikes||0), 0);
  const strikePct    = totalPitches > 0 ? +((totalStrikes/totalPitches)*100).toFixed(1) : 0;

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

module.exports = { parseGCScorebook, computeBattingLine, computePitchingLine };
