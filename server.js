// Ultra Rabble Bowl live bridge
// Polls ESPN's public (unofficial) NFL endpoints and serves the visualizer at http://localhost:3000
// Run:  node server.js   (Node 18 or newer)

const http = require('http');
const fs = require('fs');
const path = require('path');
const { exec, execFile } = require('child_process');

if (typeof fetch !== 'function') {
  console.error('Ultra Rabble Bowl needs Node.js 18 or newer. Install the LTS version from https://nodejs.org and try again.');
  process.exit(1);
}

const PORT = Number(process.env.PORT) || 3000;
const BASE = 'https://site.api.espn.com/apis/site/v2/sports/football/nfl';
const cache = new Map();
const CACHE_DIR = path.join(__dirname, 'cache');
fs.mkdirSync(path.join(CACHE_DIR, 'headshots'), { recursive: true });
fs.mkdirSync(path.join(CACHE_DIR, 'uniforms'), { recursive: true });
fs.mkdirSync(path.join(CACHE_DIR, 'voice'), { recursive: true });
const WIKI_UA = 'UltraRabbleBowl/1.0 (personal NFL play-by-play viewer)';

async function getJSON(url, ttlMs) {
  const hit = cache.get(url);
  if (hit && Date.now() - hit.t < ttlMs) return hit.v;
  const r = await fetch(url, { headers: { 'Accept': 'application/json', 'User-Agent': 'Mozilla/5.0 (UltraRabbleBowl personal viewer)' } });
  if (!r.ok) throw new Error(`ESPN responded with ${r.status}`);
  const v = await r.json();
  cache.set(url, { t: Date.now(), v });
  return v;
}

function statusOf(obj) {
  const t = ((obj || {}).type) || {};
  return { state: t.state || '', detail: t.shortDetail || t.detail || t.description || '' };
}

function toGames(sb) {
  return (sb.events || []).map(e => {
    const comp = (e.competitions || [])[0] || {};
    const cs = comp.competitors || [];
    const h = cs.find(c => c.homeAway === 'home') || {};
    const a = cs.find(c => c.homeAway === 'away') || {};
    const s = statusOf(e.status || comp.status);
    return {
      id: e.id,
      home: h.team && h.team.abbreviation, away: a.team && a.team.abbreviation,
      homeScore: h.score ?? '', awayScore: a.score ?? '',
      state: s.state, detail: s.detail
    };
  });
}

function toPlays(sum) {
  const comp = ((sum.header || {}).competitions || [])[0] || {};
  const idToAbbr = {};
  let home = null, away = null;
  const cols = {};
  for (const c of comp.competitors || []) {
    const ab = c.team && c.team.abbreviation;
    if (c.team) idToAbbr[c.team.id] = ab;
    if (c.homeAway === 'home') home = ab; else if (c.homeAway === 'away') away = ab;
    if (c.team && c.homeAway) cols[c.homeAway] = [c.team.color || null, c.team.alternateColor || null];
  }
  const s = statusOf(comp.status);
  const drives = sum.drives || {};
  const list = [...(drives.previous || [])];
  if (drives.current) list.push(drives.current);

  const seen = new Set(), out = [];
  const add = (pl, drive) => {
    if (!pl || pl.id == null || seen.has(String(pl.id))) return;
    seen.add(String(pl.id));
    const st = pl.start || {};
    const tid = (st.team && st.team.id) || (drive && drive.team && drive.team.id);
    const team = idToAbbr[tid] || (drive && drive.team && drive.team.abbreviation) || null;
    out.push({
      id: String(pl.id),
      posteam: team,
      home_team: home, away_team: away,
      home_color: (cols.home || [])[0], home_alt: (cols.home || [])[1], away_color: (cols.away || [])[0], away_alt: (cols.away || [])[1],
      desc: pl.text || '',
      espnType: (pl.type && pl.type.text) || '',
      qtr: pl.period && pl.period.number,
      time: pl.clock && pl.clock.displayValue,
      down: st.down, ydstogo: st.distance, yardline_100: st.yardsToEndzone,
      yards: pl.statYardage,
      total_home_score: pl.homeScore, total_away_score: pl.awayScore
    });
  };
  for (const d of list) for (const pl of d.plays || []) add(pl, d);
  if (!out.length && Array.isArray(sum.plays)) for (const pl of sum.plays) add(pl, null);
  return { home, away, state: s.state, detail: s.detail, plays: out };
}

function toTeams(j) {
  const list = ((((j.sports || [])[0] || {}).leagues || [])[0] || {}).teams || [];
  return list.map(x => x.team || x).filter(t => t && t.abbreviation).map(t => ({
    id: String(t.id), abbr: t.abbreviation, name: t.displayName || t.name || t.abbreviation,
    color: t.color || null, alt: t.alternateColor || null
  }));
}
function toRoster(j) {
  const groups = Array.isArray(j.athletes) ? j.athletes : [];
  const items = groups.flatMap(g => Array.isArray(g.items) ? g.items : [g]);
  return items.filter(a => a && a.id).map(a => ({
    id: String(a.id), name: a.displayName || a.fullName || '', first: a.firstName || '', last: a.lastName || '',
    jersey: a.jersey || '', pos: (a.position && a.position.abbreviation) || '',
    headshot: !!(a.headshot && a.headshot.href)
  }));
}

// ---------- Wikipedia uniform illustrations ----------
async function wiki(params) {
  const url = 'https://en.wikipedia.org/w/api.php?' + new URLSearchParams({ ...params, format: 'json', formatversion: '2' });
  const hit = cache.get(url); if (hit && Date.now() - hit.t < 86400000) return hit.v;
  const r = await fetch(url, { headers: { 'User-Agent': WIKI_UA, 'Accept': 'application/json' } });
  if (!r.ok) throw new Error('Wikipedia responded with ' + r.status);
  const v = await r.json(); cache.set(url, { t: Date.now(), v }); return v;
}
const cleanFile = f => String(f || '').replace(/^\s*\[\[/, '').replace(/^(File|Image):/i, '').split('|')[0].replace(/\]\]\s*$/, '').trim();
async function findUniformFile(title) {
  for (const page of [title, 'Logos and uniforms of the ' + title]) {
    try {
      const j = await wiki({ action: 'parse', page, prop: 'wikitext', section: '0', redirects: '1' });
      const wt = (j.parse && j.parse.wikitext) || '';
      const m = wt.match(/\|\s*uniform\s*=\s*([^\n|}]+)/i);
      if (m && cleanFile(m[1])) return { file: cleanFile(m[1]), page };
    } catch (e) { /* try the next source */ }
    try {
      const j = await wiki({ action: 'query', prop: 'images', titles: page, imlimit: '200', redirects: '1' });
      const imgs = ((j.query && j.query.pages && j.query.pages[0] && j.query.pages[0].images) || []).map(x => x.title);
      const pick = imgs.find(t => /uniform/i.test(t) && /\.(png|svg)$/i.test(t));
      if (pick) return { file: cleanFile(pick), page };
    } catch (e) { /* try the next source */ }
  }
  return null;
}
async function uniformFor(title) {
  const key = title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  const meta = path.join(CACHE_DIR, 'uniforms', key + '.json'), img = path.join(CACHE_DIR, 'uniforms', key + '.png');
  if (fs.existsSync(meta) && fs.existsSync(img)) return { ...JSON.parse(fs.readFileSync(meta, 'utf8')), key };
  const found = await findUniformFile(title);
  if (!found) throw new Error('no uniform illustration found on Wikipedia');
  const j = await wiki({ action: 'query', titles: 'File:' + found.file, prop: 'imageinfo', iiprop: 'url|extmetadata', iiurlwidth: '900' });
  const ii = j.query && j.query.pages && j.query.pages[0] && j.query.pages[0].imageinfo && j.query.pages[0].imageinfo[0];
  if (!ii) throw new Error('could not read the image details');
  const src = ii.thumburl || ii.url;
  const r = await fetch(src, { headers: { 'User-Agent': WIKI_UA } });
  if (!r.ok) throw new Error('image download failed (' + r.status + ')');
  fs.writeFileSync(img, Buffer.from(await r.arrayBuffer()));
  const lic = ii.extmetadata && ii.extmetadata.LicenseShortName && ii.extmetadata.LicenseShortName.value;
  const info = { file: found.file, page: found.page, license: lic || '', link: 'https://en.wikipedia.org/wiki/File:' + encodeURIComponent(found.file.replace(/ /g, '_')) };
  fs.writeFileSync(meta, JSON.stringify(info));
  return { ...info, key };
}

// ---------- voices: the QB's cadence and the stadium PA announcer, rendered once with the computer's own voices ----------
const QB_LINES = { down: 'Down!', set: 'Set!', go: 'Go!' };
const PA_LINES = {
  title: 'Ultra Rabble Bowl!', touchdown: 'Touchdown!', first: 'First down!', good: "It's good!", nogood: 'No good!',
  sack1: 'Oh, what a hit!', sack2: "He's sacked!", sack3: 'Brought down hard!',
  fumble1: 'Fumble!', fumble2: 'The ball is loose!', int1: 'Picked off!', int2: 'Interception!',
  run1: 'A little razzle dazzle!', run2: 'Look at him go!', run3: 'He breaks free!',
  catch1: 'Oh, what a catch!', catch2: 'What a grab!', catch3: 'Hauls it in!',
  return1: 'What a return!', return2: "He's off to the races!",
  stuff1: 'Stuffed at the line!', stuff2: 'Nowhere to go!', breakup1: 'Broken up!', breakup2: 'Knocked away!',
  downs: 'Turnover on downs!', safety: 'Safety!', flag: 'Flag on the play!',
  review: 'This play is under review.', reversed: 'The ruling is reversed!', stands: 'The ruling on the field stands!', confirmed: 'The call is confirmed!',
  quarter: "That's the end of the quarter!", final: "That's the ballgame!", official: 'Official timeout.', twomin: 'Two-minute warning.', timeout: 'Timeout on the field.'
};
const VOICE_VER = 'v5-broadcast';
const voiceFile = key => path.join(CACHE_DIR, 'voice', `${key}-${VOICE_VER}.wav`);
const xml = t => t.replace(/&/g, '&amp;').replace(/</g, '&lt;');
// QB: clipped cadence. PA: warm baritone, measured broadcast delivery with more emphasis on scoring plays.
const ssmlFor = (key, text) => QB_LINES[key]
  ? `<speak version="1.0" xmlns="http://www.w3.org/2001/10/synthesis" xml:lang="en-US"><prosody pitch="low" rate="x-fast" volume="x-loud"><emphasis level="strong">${xml(text)}</emphasis></prosody></speak>`
  : `<speak version="1.0" xmlns="http://www.w3.org/2001/10/synthesis" xml:lang="en-US"><prosody pitch="low" rate="medium" volume="x-loud"><emphasis level="strong">${xml(text)}</emphasis></prosody></speak>`;
let voiceJob = null;
function makeVoices() {
  if (voiceJob) return voiceJob;
  const all = { ...QB_LINES, ...PA_LINES };
  const todo = Object.keys(all).filter(k => !fs.existsSync(voiceFile(k)) || fs.statSync(voiceFile(k)).size < 1000);
  if (!todo.length) return Promise.resolve();
  voiceJob = new Promise((resolve, reject) => {
    if (process.platform === 'win32') {
      const q = t => t.replace(/'/g, "''");
      const lines = [
        'Add-Type -AssemblyName System.Speech',
        '$s = New-Object System.Speech.Synthesis.SpeechSynthesizer',
        "$males = @($s.GetInstalledVoices() | Where-Object { $_.Enabled -and $_.VoiceInfo.Gender -eq 'Male' } | ForEach-Object { $_.VoiceInfo.Name })",
        '$qb = $null; $pa = $null; if ($males.Count -gt 0) { $qb = $males[0]; $pa = $males[0] }; if ($males.Count -gt 1) { $pa = $males[1] }',
        '$s.Volume = 100'
      ];
      for (const k of todo) {
        lines.push(`if (${QB_LINES[k] ? '$qb' : '$pa'}) { $s.SelectVoice(${QB_LINES[k] ? '$qb' : '$pa'}) }`);
        lines.push(`$s.SetOutputToWaveFile('${q(voiceFile(k))}'); $s.SpeakSsml('${q(ssmlFor(k, all[k]))}'); $s.SetOutputToNull()`);
      }
      lines.push('$s.Dispose()');
      const script = path.join(CACHE_DIR, 'voice', 'make-voices.ps1');
      fs.writeFileSync(script, '\ufeff' + lines.join('\r\n'), 'utf8');
      execFile('powershell', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script], { timeout: 180000 }, err => err ? reject(err) : resolve());
    } else if (process.platform === 'darwin') {
      const run = i => {
        if (i >= todo.length) return resolve();
        const k = todo[i], qb = !!QB_LINES[k];
        execFile('say', ['-v', qb ? 'Alex' : 'Daniel', '-r', qb ? '270' : '205', '--data-format=LEI16@22050', '-o', voiceFile(k), all[k]], { timeout: 20000 }, () => run(i + 1));
      };
      run(0);
    } else {
      // Linux / Docker: create WAV speech assets with espeak-ng.
      const run = i => {
        if (i >= todo.length) return resolve();
        const k = todo[i], qb = !!QB_LINES[k];
        // Avoid falsetto PA: synthesize a steady male baritone and vary delivery by play significance.
        const highlight = /^(touchdown|int|fumble|run|catch|return|sack|safety|good|nogood)/.test(k);
        const tempo = qb ? '185' : highlight ? '163' : '149';
        const pitch = qb ? '34' : highlight ? '42' : '34';
        const amplitude = qb ? '180' : highlight ? '200' : '175';
        const voice = qb ? 'en-us+m3' : 'en-us+m7';
        execFile('espeak-ng', ['-v', voice, '-s', tempo, '-p', pitch, '-a', amplitude, '-g', qb ? '0' : '5', '-w', voiceFile(k), all[k]],
          { timeout: 20000 }, err => err ? reject(err) : run(i + 1));
      };
      run(0);
    }
  }).finally(() => { voiceJob = null; });
  return voiceJob;
}

function send(res, obj, code = 200) {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(obj));
}

const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://localhost');
  try {
    if (u.pathname === '/' || u.pathname === '/index.html') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      fs.createReadStream(path.join(__dirname, 'index.html')).pipe(res);
      return;
    }
    if (u.pathname === '/api/games') {
      const d = u.searchParams.get('date');
      const url = BASE + '/scoreboard' + (d && /^\d{8}$/.test(d) ? '?dates=' + d : '');
      return send(res, { games: toGames(await getJSON(url, 15000)) });
    }
    if (u.pathname === '/api/plays') {
      const ev = u.searchParams.get('event') || '';
      if (!/^\d+$/.test(ev)) return send(res, { error: 'Missing or invalid game id' }, 400);
      const raw = await getJSON(BASE + '/summary?event=' + ev, 4000);
      // Saved for troubleshooting: the last raw response from ESPN
      fs.writeFile(path.join(CACHE_DIR, 'espn-last.json'), JSON.stringify(raw, null, 1), () => {});
      return send(res, toPlays(raw));
    }
    if (u.pathname === '/api/teams') {
      const j = await getJSON(BASE + '/teams', 3600000);
      return send(res, { teams: toTeams(j) });
    }
    if (u.pathname === '/api/roster') {
      const id = u.searchParams.get('team') || '';
      if (!/^\d+$/.test(id)) return send(res, { error: 'Missing or invalid team id' }, 400);
      const j = await getJSON(BASE + '/teams/' + id + '/roster', 6 * 3600000);
      fs.writeFile(path.join(CACHE_DIR, 'roster-' + id + '.json'), JSON.stringify(j, null, 1), () => {});
      return send(res, { players: toRoster(j) });
    }
    if (u.pathname === '/api/uniform') {
      const title = (u.searchParams.get('title') || '').trim();
      if (!/^[A-Za-z0-9 .'&-]{3,60}$/.test(title)) return send(res, { error: 'Missing or invalid team name' }, 400);
      const info = await uniformFor(title);
      return send(res, { ...info, img: '/api/uniform-img?key=' + info.key });
    }
    if (u.pathname === '/api/uniform-img') {
      const key = u.searchParams.get('key') || '';
      const file = path.join(CACHE_DIR, 'uniforms', key + '.png');
      if (!/^[a-z0-9-]{3,80}$/.test(key) || !fs.existsSync(file)) { res.writeHead(404); res.end(); return; }
      res.writeHead(200, { 'Content-Type': 'image/png', 'Cache-Control': 'max-age=86400' });
      fs.createReadStream(file).pipe(res);
      return;
    }
    if (u.pathname === '/api/voice-pack') {
      await makeVoices();
      return send(res, { qb: QB_LINES, pa: PA_LINES });
    }
    if (u.pathname === '/api/voice') {
      const key = (u.searchParams.get('key') || '').toLowerCase();
      if (!QB_LINES[key] && !PA_LINES[key]) { res.writeHead(400); res.end(); return; }
      if (!fs.existsSync(voiceFile(key))) await makeVoices();
      if (!fs.existsSync(voiceFile(key))) { res.writeHead(404); res.end(); return; }
      res.writeHead(200, { 'Content-Type': 'audio/wav', 'Cache-Control': 'max-age=86400' });
      fs.createReadStream(voiceFile(key)).pipe(res);
      return;
    }
    if (u.pathname === '/api/headshot') {
      const id = u.searchParams.get('id') || '';
      if (!/^\d+$/.test(id)) { res.writeHead(400); res.end(); return; }
      const file = path.join(CACHE_DIR, 'headshots', id + '.png');
      if (!fs.existsSync(file)) {
        const r = await fetch('https://a.espncdn.com/i/headshots/nfl/players/full/' + id + '.png', { headers: { 'User-Agent': 'Mozilla/5.0 (UltraRabbleBowl personal viewer)' } });
        if (!r.ok) { res.writeHead(404); res.end(); return; }
        fs.writeFileSync(file, Buffer.from(await r.arrayBuffer()));
      }
      res.writeHead(200, { 'Content-Type': 'image/png', 'Cache-Control': 'max-age=86400' });
      fs.createReadStream(file).pipe(res);
      return;
    }
    res.writeHead(404, { 'Content-Type': 'text/plain' }); res.end('Not found');
  } catch (e) {
    console.error('Error:', e.message);
    send(res, { error: e.message }, 502);
  }
});

if (require.main === module) server.listen(PORT, process.env.HOST || '127.0.0.1', () => {
  const url = `http://localhost:${PORT}`;
  console.log(`Ultra Rabble Bowl is running at ${url}`);
  console.log('Keep this window open while you watch. Close it (or press Ctrl+C) to stop.');
  if (process.env.NO_BROWSER === '1') return;
  const cmd = process.platform === 'win32' ? `start "" ${url}` : process.platform === 'darwin' ? `open ${url}` : `xdg-open ${url}`;
  exec(cmd, () => {});
});
server.on('error', e => {
  if (e.code === 'EADDRINUSE') console.error(`Port ${PORT} is already in use. Close the other Gridiron window, or run:  set PORT=3001 && node server.js`);
  else console.error(e.message);
});

module.exports = { toPlays, toGames };