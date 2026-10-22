// -----------------------------------------------------------------------------
// Integration configuration: defaults (they mirror the `default` values of the
// manifest `config_schema`, see test/manifest.test.js) and normalization, so
// the rest of the code never deals with strings, blanks or `undefined`.
// -----------------------------------------------------------------------------

import { parseServerUrl } from './shinobi/client.js';

export const LANGUAGES = ['en', 'fr', 'de', 'es'];

// Seconds between two images sent to Gladys (`snapshot_interval`). The core
// accepts 12 images a minute per camera; a detection also sends one at once.
export const SNAPSHOT_INTERVALS = [10, 30, 60, 300, 900];

// Seconds a detection stays on without a new one (`motion_reset`): Shinobi
// sends each detection, never its end.
export const MOTION_RESETS = [10, 30, 60, 120, 300];

export const DEFAULT_CONFIG = {
  url: '',
  group_key: '',
  snapshot_interval: '60',
  motion_reset: '30',
  language: 'fr',
};

function pick(value, allowed, fallback) {
  const number = Number(value);
  return allowed.includes(number) ? number : Number(fallback);
}

/**
 * @param {Record<string, unknown>} raw the configuration returned by the SDK
 */
export function normalizeConfig(raw = {}) {
  const source = raw && typeof raw === 'object' ? raw : {};
  const url = String(source.url ?? DEFAULT_CONFIG.url).trim();
  const apiKey = typeof source.api_key === 'string' ? source.api_key.trim() : '';
  const groupKey = String(source.group_key ?? DEFAULT_CONFIG.group_key).trim();
  return {
    url,
    validUrl: Boolean(parseServerUrl(url)),
    apiKey,
    groupKey,
    complete: Boolean(parseServerUrl(url)) && apiKey !== '' && groupKey !== '',
    snapshotSeconds: pick(
      source.snapshot_interval,
      SNAPSHOT_INTERVALS,
      DEFAULT_CONFIG.snapshot_interval,
    ),
    motionResetSeconds: pick(source.motion_reset, MOTION_RESETS, DEFAULT_CONFIG.motion_reset),
    language: LANGUAGES.includes(source.language) ? source.language : DEFAULT_CONFIG.language,
  };
}

/** What identifies a connection: a change of one of them means a new client. */
export const connectionKey = (config) =>
  JSON.stringify([config.url, config.apiKey, config.groupKey]);
