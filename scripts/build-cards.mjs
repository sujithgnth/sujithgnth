// Builds the profile README cards:
//   dist/header.svg     name and title, fade in once
//   dist/activity.svg   contributions, streaks, top languages (bars grow once)
//   README.md           the "Now building" list between its markers (real links)
//
//   GITHUB_TOKEN=... GH_USER=sujithgnth node scripts/build-cards.mjs
//   node scripts/build-cards.mjs --fixture data.json      (offline, for testing)
//
// Everything animates once per page load, then stays still. Animations are
// skipped for visitors who turned on "reduce motion".

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

const USER_RE = /^[a-z\d](?:[a-z\d]|-(?=[a-z\d])){0,38}$/i;
const W = 800;
const FONT = `-apple-system,BlinkMacSystemFont,"Segoe UI",Helvetica,Arial,sans-serif`;

// GitHub's text and border colours, light then dark
const THEME_CSS = `
  .fg{fill:#1f2328}.muted{fill:#59636e}.border{stroke:#d0d7de}.track{fill:#eff2f5}
  @media (prefers-color-scheme:dark){
    .fg{fill:#f0f6fc}.muted{fill:#9198a1}.border{stroke:#3d444d}.track{fill:#262c36}
  }
  text{font-family:${FONT}}
  @media (prefers-reduced-motion:reduce){*{animation:none!important}}`;

// ---------- small helpers ----------
export function xml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// Text for markdown: no HTML, no link/emphasis syntax, one line
export function md(s) {
  return String(s ?? '')
    .replace(/[\r\n]+/g, ' ')
    .replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c])
    .replace(/([\\`*_{}[\]()#+!|~])/g, '\\$1')
    .trim();
}

function truncate(s, n) {
  return s.length > n ? s.slice(0, n - 1).trimEnd() + '…' : s;
}

function safeColor(c) {
  return /^#[0-9a-f]{6}$/i.test(c ?? '') ? c : '#8b949e';
}

export function relativeTime(iso, now = new Date()) {
  // whole calendar days (UTC), so last night's push reads "yesterday"
  const day = (d) => Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
  const days = Math.round((day(now) - day(new Date(iso))) / 86_400_000);
  if (days <= 0) return 'today';
  if (days === 1) return 'yesterday';
  if (days < 30) return `${days} days ago`;
  const months = Math.floor(days / 30.4);
  if (months < 12) return months === 1 ? '1 month ago' : `${months} months ago`;
  const years = Math.floor(days / 365);
  return years === 1 ? '1 year ago' : `${years} years ago`;
}

// ---------- data shaping ----------
export function streaks(weeks) {
  const days = weeks.flatMap((w) => w.contributionDays).sort((a, b) => a.date.localeCompare(b.date));
  let best = 0;
  let run = 0;
  for (const d of days) {
    run = d.contributionCount > 0 ? run + 1 : 0;
    best = Math.max(best, run);
  }
  // today may not have contributions yet; don't let that break the streak
  let i = days.length - 1;
  if (i >= 0 && days[i].contributionCount === 0) i--;
  let current = 0;
  for (; i >= 0 && days[i].contributionCount > 0; i--) current++;
  return { current, best };
}

export function topLanguages(repos, count) {
  const sizes = new Map();
  for (const repo of repos) {
    for (const { size, node } of repo.languages?.edges ?? []) {
      const prev = sizes.get(node.name) ?? { size: 0, color: node.color };
      sizes.set(node.name, { size: prev.size + size, color: prev.color });
    }
  }
  const total = [...sizes.values()].reduce((sum, l) => sum + l.size, 0) || 1;
  return [...sizes.entries()]
    .map(([name, { size, color }]) => ({ name, color: safeColor(color), pct: (size / total) * 100 }))
    .filter((l) => l.pct >= 1) // a 0% bar is noise
    .sort((a, b) => b.pct - a.pct)
    .slice(0, count);
}

export function nowBuilding(repos, login, cfg) {
  const hidden = new Set([login.toLowerCase(), ...(cfg.hideRepos ?? []).map((r) => r.toLowerCase())]);
  return repos
    .filter((r) => !r.isArchived && !hidden.has(r.name.toLowerCase()))
    .sort((a, b) => b.pushedAt.localeCompare(a.pushedAt))
    .slice(0, cfg.nowBuildingCount);
}

// ---------- SVG cards ----------
export function headerSvg(cfg) {
  const subtitle = [cfg.title, cfg.location].filter(Boolean).join(' · ');
  const label = `${cfg.name}, ${subtitle}`;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="96" viewBox="0 0 ${W} 96" role="img" aria-label="${xml(label)}">
<title>${xml(label)}</title>
<style>${THEME_CSS}
  @keyframes rise{from{opacity:0;transform:translateY(8px)}to{opacity:1;transform:none}}
  @keyframes grow{from{transform:scaleX(0)}to{transform:scaleX(1)}}
  .name{font-size:32px;font-weight:600;animation:rise .7s ease-out both}
  .sub{font-size:17px;animation:rise .7s ease-out .25s both}
  .line{transform-box:fill-box;transform-origin:left;animation:grow .9s ease-out .45s both}
</style>
<text class="fg name" x="2" y="40">${xml(cfg.name)}</text>
<text class="muted sub" x="2" y="70">${xml(subtitle)}</text>
<rect class="line" x="2" y="86" width="64" height="3" rx="1.5" fill="#2f81f7"/>
</svg>
`;
}

export function activitySvg({ total, streak, languages }) {
  const H = 156;
  const days = (n) => `${n} day${n === 1 ? '' : 's'}`;
  const label = `${total} contributions in the last year. Current streak ${days(streak.current)}, best ${days(streak.best)}.`;
  const barX = 520;
  const barW = 200;

  const rows = languages
    .map((l, i) => {
      const y = 52 + i * 26;
      const w = Math.max(2, (l.pct / 100) * barW).toFixed(1);
      const delay = (0.3 + i * 0.12).toFixed(2);
      return `<text class="fg lang" x="400" y="${y + 9}">${xml(truncate(l.name, 16))}</text>
<rect class="track" x="${barX}" y="${y}" width="${barW}" height="10" rx="5"/>
<rect class="bar" x="${barX}" y="${y}" width="${w}" height="10" rx="5" fill="${l.color}" style="animation-delay:${delay}s"/>
<text class="muted pct" x="${barX + barW + 12}" y="${y + 9}">${l.pct.toFixed(0)}%</text>`;
    })
    .join('\n');

  const fmt = (n) => Number(n).toLocaleString('en-US');

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" role="img" aria-label="${xml(label)}">
<title>${xml(label)}</title>
<style>${THEME_CSS}
  @keyframes fade{from{opacity:0}to{opacity:1}}
  @keyframes grow{from{transform:scaleX(0)}to{transform:scaleX(1)}}
  .card{fill:none;stroke-width:1}
  .head{font-size:13px;font-weight:600;letter-spacing:.06em;animation:fade .6s ease-out both}
  .big{font-size:36px;font-weight:600;animation:fade .6s ease-out .1s both}
  .small{font-size:14px;animation:fade .6s ease-out .2s both}
  .lang,.pct{font-size:13px;animation:fade .6s ease-out .2s both}
  .bar{transform-box:fill-box;transform-origin:left;animation:grow .9s cubic-bezier(.2,.7,.2,1) both}
</style>
<rect class="card border" x="0.5" y="0.5" width="${W - 1}" height="${H - 1}" rx="8"/>
<text class="muted head" x="24" y="32">ACTIVITY</text>
<text class="fg big" x="24" y="80">${fmt(total)}</text>
<text class="muted small" x="24" y="104">contributions in the last year</text>
<text class="muted small" x="24" y="132">Current streak ${days(streak.current)} · Best ${days(streak.best)}</text>
<text class="muted head" x="400" y="32">LANGUAGES</text>
${rows}
</svg>
`;
}

// ---------- README section ----------
const START = '<!-- now-building:start -->';
const END = '<!-- now-building:end -->';

export function nowBuildingMarkdown(repos, now = new Date()) {
  const lines = repos.map((r) => {
    const desc = r.description ? ` · ${md(truncate(r.description, 90))}` : '';
    return `- **[${md(r.name)}](${r.url})**${desc} · _updated ${relativeTime(r.pushedAt, now)}_`;
  });
  return `${START}\n### Now building\n\n${lines.join('\n')}\n${END}`;
}

export function replaceSection(readme, section) {
  const start = readme.indexOf(START);
  const end = readme.indexOf(END);
  if (start === -1 || end === -1 || end < start) throw new Error('now-building markers missing from README.md');
  return readme.slice(0, start) + section + readme.slice(end + END.length);
}

// ---------- GitHub data ----------
async function fetchData(login, token) {
  const query = `query($login:String!){user(login:$login){
    contributionsCollection{contributionCalendar{totalContributions weeks{contributionDays{date contributionCount}}}}
    repositories(first:100, ownerAffiliations:OWNER, isFork:false, privacy:PUBLIC, orderBy:{field:PUSHED_AT, direction:DESC}){
      nodes{name description url pushedAt isArchived
        languages(first:10, orderBy:{field:SIZE, direction:DESC}){edges{size node{name color}}}}}}}`;
  const res = await fetch('https://api.github.com/graphql', {
    method: 'POST',
    headers: { Authorization: `bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query, variables: { login } }),
  });
  const body = await res.json();
  if (!res.ok || body.errors) throw new Error(`GraphQL failed: ${JSON.stringify(body.errors ?? body)}`);
  const { contributionsCollection, repositories } = body.data.user;
  return {
    calendar: contributionsCollection.contributionCalendar,
    repos: repositories.nodes,
  };
}

async function main() {
  const login = process.env.GH_USER ?? 'sujithgnth';
  if (!USER_RE.test(login)) throw new Error('GH_USER is invalid');
  const cfg = JSON.parse(await readFile('profile.json', 'utf8'));

  const fixtureArg = process.argv.indexOf('--fixture');
  let data;
  if (fixtureArg !== -1) {
    data = JSON.parse(await readFile(process.argv[fixtureArg + 1], 'utf8'));
  } else {
    if (!process.env.GITHUB_TOKEN) throw new Error('GITHUB_TOKEN is missing');
    data = await fetchData(login, process.env.GITHUB_TOKEN);
  }

  await mkdir('dist', { recursive: true });
  await writeFile('dist/header.svg', headerSvg(cfg));
  await writeFile(
    'dist/activity.svg',
    activitySvg({
      total: data.calendar.totalContributions,
      streak: streaks(data.calendar.weeks),
      languages: topLanguages(data.repos, cfg.languageCount),
    }),
  );

  const readme = await readFile('README.md', 'utf8');
  const repos = nowBuilding(data.repos, login, cfg);
  await writeFile('README.md', replaceSection(readme, nowBuildingMarkdown(repos)));
  console.log(`cards written; now building: ${repos.map((r) => r.name).join(', ')}`);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
