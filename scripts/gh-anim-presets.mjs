// Presets and config handling. Everything that comes from a README passes
// through parseConfig(): only a preset name and a few clamped numbers survive.
// CSS is built only from our own templates, never from README text.

const USER_RE = /^[a-z\d](?:[a-z\d]|-(?=[a-z\d])){0,38}$/i;
const CONFIG_RE = /<!--\s*gh-anim\s+(\{[\s\S]{0,500}?\})\s*-->/;

export const LIMITS = {
  hue: [-180, 180],      // degrees
  duration: [4, 30],     // seconds; the floor stops fast or flashing animations
  spread: [10, 400],     // milliseconds between columns
};

export const PRESETS = {
  // a band of shifted colour drifts left to right
  aurora: {
    defaults: { hue: 80, duration: 10, spread: 180 },
    keyframes: ({ hue }) => `
      0%, 100% { filter: hue-rotate(0deg) brightness(1); }
      50%      { filter: hue-rotate(${hue}deg) brightness(1.15); }`,
    delay: ({ duration, spread }) => `calc(var(--col, 0) * ${spread}ms - ${duration}s)`,
  },
  // a faint light passes across, then the grid rests
  shimmer: {
    defaults: { hue: 0, duration: 8, spread: 35 },
    keyframes: () => `
      0%, 14%, 100% { filter: brightness(1); }
      7%            { filter: brightness(1.35) saturate(1.2); }`,
    delay: ({ spread }) => `calc(var(--col, 0) * ${spread}ms)`,
  },
  // each column slowly fades in and out, out of step with its neighbours
  breathe: {
    defaults: { hue: 0, duration: 6, spread: 370 },
    keyframes: () => `
      0%, 100% { opacity: 1; }
      50%      { opacity: 0.7; }`,
    delay: ({ spread }) => `calc(var(--col, 0) * -${spread}ms)`,
  },
};

export function isValidUser(user) {
  return typeof user === 'string' && USER_RE.test(user);
}

function clamp(value, [lo, hi], fallback) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  return Math.round(Math.min(hi, Math.max(lo, value)) * 100) / 100;
}

// README text -> { preset, hue, duration, spread } or null
export function parseConfig(readme) {
  if (typeof readme !== 'string') return null;
  const match = readme.match(CONFIG_RE);
  if (!match) return null;

  let raw;
  try {
    raw = JSON.parse(match[1]);
  } catch {
    return null;
  }
  if (!raw || typeof raw !== 'object') return null;
  if (!Object.hasOwn(PRESETS, raw.preset)) return null;

  const { defaults } = PRESETS[raw.preset];
  return {
    preset: raw.preset,
    hue: clamp(raw.hue, LIMITS.hue, defaults.hue),
    duration: clamp(raw.duration, LIMITS.duration, defaults.duration),
    spread: clamp(raw.spread, LIMITS.spread, defaults.spread),
  };
}

// Builds CSS scoped to one profile, so several profiles visited in one tab
// never interfere with each other.
export function buildCss(config, user) {
  if (!isValidUser(user)) throw new Error('invalid user');
  const u = user.toLowerCase();
  const preset = PRESETS[config.preset];
  const name = `gha-${u}`;
  const scope = `html[data-gh-anim-user="${u}"]`;
  const cells = `${scope} td.ContributionCalendar-day:not([data-level="0"])`;

  return `
@keyframes ${name} {${preset.keyframes(config)}
}
${cells} {
  animation: ${name} ${config.duration}s ease-in-out infinite;
  animation-delay: ${preset.delay(config)};
}
@media (prefers-reduced-motion: reduce) {
  ${cells} { animation: none !important; }
}`;
}
