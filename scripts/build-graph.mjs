// Builds dist/graph.svg: the contribution graph, animated with the preset from
// the `gh-anim` comment in README.md (the same line the browser extension reads).
//
//   GITHUB_TOKEN=... GH_USER=sujithgnth node scripts/build-graph.mjs
//   node scripts/build-graph.mjs --fixture weeks.json      (offline, for testing)
//
// Colours are animated on `fill` directly (not CSS filters) because SVG
// filters on <rect> behave differently across browsers.

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { parseConfig, isValidUser } from './gh-anim-presets.mjs';

const CELL = 10;
const GAP = 3;
const STEP = CELL + GAP;
const LEVEL = { NONE: 0, FIRST_QUARTILE: 1, SECOND_QUARTILE: 2, THIRD_QUARTILE: 3, FOURTH_QUARTILE: 4 };

// GitHub's own palettes
const THEMES = {
  light: ['#ebedf0', '#9be9a8', '#40c463', '#30a14e', '#216e39'],
  dark: ['#161b22', '#0e4429', '#006d32', '#26a641', '#39d353'],
};
const TEXT = { light: '#57606a', dark: '#8b949e' };

// ---------- colour helpers ----------
function hexToHsl(hex) {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255);
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  if (max === min) return [0, 0, l];
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  const h =
    max === r ? (g - b) / d + (g < b ? 6 : 0) : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return [h * 60, s, l];
}

function hslToHex(h, s, l) {
  h = ((h % 360) + 360) % 360;
  s = Math.min(1, Math.max(0, s));
  l = Math.min(1, Math.max(0, l));
  const k = (n) => (n + h / 30) % 12;
  const a = s * Math.min(l, 1 - l);
  const f = (n) => l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
  return '#' + [f(0), f(8), f(4)].map((x) => Math.round(x * 255).toString(16).padStart(2, '0')).join('');
}

function shift(hex, { hue = 0, light = 0, sat = 0 }) {
  const [h, s, l] = hexToHsl(hex);
  return hslToHex(h + hue, s + sat, l + light);
}

// ---------- presets, SVG flavour ----------
// frames: keyframe body for one colour. delay: per-column delay in seconds.
const SVG_PRESETS = {
  aurora: {
    frames: (c, { hue }) => `0%,100%{fill:${c}}50%{fill:${shift(c, { hue, light: 0.04 })}}`,
    delay: ({ duration, spread }, col) => (col * spread) / 1000 - duration,
  },
  shimmer: {
    frames: (c) => `0%,14%,100%{fill:${c}}7%{fill:${shift(c, { light: 0.12, sat: 0.1 })}}`,
    delay: ({ spread }, col) => (col * spread) / 1000,
  },
  breathe: {
    frames: () => `0%,100%{opacity:1}50%{opacity:.7}`,
    delay: ({ spread }, col) => (-col * spread) / 1000,
  },
};

function round(n) {
  return Math.round(n * 1000) / 1000;
}

export function buildSvg(weeks, total, config) {
  const width = weeks.length * STEP - GAP;
  const gridHeight = 7 * STEP - GAP;
  const height = gridHeight + 22;
  const preset = config && SVG_PRESETS[config.preset];

  let cells = '';
  weeks.forEach((week, col) => {
    for (const day of week.contributionDays) {
      const level = LEVEL[day.contributionLevel] ?? 0;
      const delay = preset && level > 0 ? ` style="animation-delay:${round(preset.delay(config, col))}s"` : '';
      cells += `<rect class="l${level}" x="${col * STEP}" y="${day.weekday * STEP}" width="${CELL}" height="${CELL}" rx="2"${delay}/>`;
    }
  });

  let css = '';
  for (const [theme, colors] of Object.entries(THEMES)) {
    let rules = colors.map((c, i) => `.l${i}{fill:${c}}`).join('') + `text{fill:${TEXT[theme]}}`;
    if (preset) {
      for (let i = 1; i <= 4; i++) {
        rules += `@keyframes ${theme}${i}{${preset.frames(colors[i], config)}}`;
        rules += `.l${i}{animation:${theme}${i} ${config.duration}s ease-in-out infinite}`;
      }
    }
    css += theme === 'dark' ? `@media (prefers-color-scheme:dark){${rules}}` : rules;
  }
  css += `@media (prefers-reduced-motion:reduce){rect{animation:none!important}}`;
  css += `text{font:12px -apple-system,BlinkMacSystemFont,"Segoe UI",Helvetica,Arial,sans-serif}`;

  const label = `${Number(total).toLocaleString('en-US')} contributions in the last year`;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-label="${label}">
<title>${label}</title>
<style>${css}</style>
${cells}
<text x="0" y="${gridHeight + 17}">${label}</text>
</svg>
`;
}

async function fetchCalendar(user, token) {
  const query = `query($login:String!){user(login:$login){contributionsCollection{contributionCalendar{
    totalContributions weeks{contributionDays{weekday contributionLevel}}}}}}`;
  const res = await fetch('https://api.github.com/graphql', {
    method: 'POST',
    headers: { Authorization: `bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query, variables: { login: user } }),
  });
  const body = await res.json();
  if (!res.ok || body.errors) throw new Error(`GraphQL failed: ${JSON.stringify(body.errors ?? body)}`);
  return body.data.user.contributionsCollection.contributionCalendar;
}

async function main() {
  const fixtureArg = process.argv.indexOf('--fixture');
  const config = parseConfig(await readFile('README.md', 'utf8'));

  let calendar;
  if (fixtureArg !== -1) {
    calendar = JSON.parse(await readFile(process.argv[fixtureArg + 1], 'utf8'));
  } else {
    const user = process.env.GH_USER;
    if (!isValidUser(user)) throw new Error('GH_USER is missing or invalid');
    if (!process.env.GITHUB_TOKEN) throw new Error('GITHUB_TOKEN is missing');
    calendar = await fetchCalendar(user, process.env.GITHUB_TOKEN);
  }

  await mkdir('dist', { recursive: true });
  await writeFile('dist/graph.svg', buildSvg(calendar.weeks, calendar.totalContributions, config));
  console.log(`dist/graph.svg written (${config ? config.preset : 'no animation'})`);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
