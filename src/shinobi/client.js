// -----------------------------------------------------------------------------
// HTTP client of one Shinobi server (Shinobi Systems' NVR), its web server on
// port 8080 by default. Every route carries the API key and the group key in
// its path (checked on the Shinobi of 20/10/2026, ca152d3, see CLAUDE.md):
//   GET <key>/monitor/<group>                      every monitor: name, mode, status code, details
//   GET <key>/userInfo/<group>                     the user behind the key (its uid, for the socket)
//   GET <key>/jpeg/<group>/<monitor>/s.jpg         the last frame of the JPEG API
//   GET <key>/monitor/<group>/<monitor>/<mode>     mode: start (watch only), record, idle, stop
// The live events go through Socket.IO (src/shinobi/socket.js).
//
// Shinobi answers a refused key with HTTP 200 and `{ ok: false, msg: "Not
// Authorized" }`: the body says it, not the status.
//
// Errors carry a `kind`: `network` (no answer), `auth` (key or group key
// refused), `notFound` (no such monitor), `refused` (Shinobi said no), `http`
// (else). The API key is part of every URL: neither is ever logged.
// -----------------------------------------------------------------------------

import { createLogger } from '@gladysassistant/integration-sdk';

const logger = createLogger({ name: 'shinobi-api' });

export const REQUEST_TIMEOUT_MS = 15000;
export const DEFAULT_PORT = 8080;
export const MODES = ['start', 'record', 'idle', 'stop'];
const MAX_JSON_BYTES = 4 * 1024 * 1024;
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;

export class ShinobiError extends Error {
  constructor(message, { kind = 'http', status } = {}) {
    super(message);
    this.name = 'ShinobiError';
    this.kind = kind;
    this.status = status;
  }
}

/**
 * The address typed by the user: `192.0.2.10`, `nvr.lan:8080`,
 * `https://shinobi.example/`… Resolves to `{ origin, basePath }`, or null.
 * Without a scheme nor a port, Shinobi's own port (8080) is used.
 * Credentials in the address are refused: the key goes in its own field.
 */
export function parseServerUrl(text) {
  const raw = String(text ?? '').trim();
  if (!raw) {
    return null;
  }
  const hasScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(raw);
  let url;
  try {
    url = new URL(hasScheme ? raw : `http://${raw}`);
  } catch {
    return null;
  }
  if (
    !['http:', 'https:'].includes(url.protocol) ||
    url.username ||
    url.password ||
    !url.hostname
  ) {
    return null;
  }
  if (!hasScheme && !url.port) {
    url.port = String(DEFAULT_PORT);
  }
  return { origin: url.origin, basePath: url.pathname.replace(/\/+$/, '') };
}

// The monitor list gives the details as strings ("1") or numbers (1).
const flag = (value) => String(value ?? '') === '1';

/** One monitor of the monitor list. */
export function normalizeMonitor(monitor) {
  const details =
    monitor?.details && typeof monitor.details === 'object'
      ? monitor.details
      : (() => {
          try {
            return JSON.parse(monitor?.details ?? '{}') ?? {};
          } catch {
            return {};
          }
        })();
  const code = Number.parseInt(monitor?.code, 10);
  const detector = flag(details.detector);
  return {
    id: String(monitor?.mid ?? ''),
    name: String(monitor?.name ?? '').trim(),
    mode: String(monitor?.mode ?? ''),
    code: Number.isFinite(code) ? code : null,
    // The JPEG API ("snap"): without it, s.jpg is Shinobi's placeholder.
    snap: flag(details.snap),
    detector,
    objects: detector && flag(details.detector_use_detect_object),
  };
}

async function readLimited(response, limit) {
  const length = Number(response.headers.get('content-length'));
  if (Number.isFinite(length) && length > limit) {
    await response.body?.cancel().catch(() => {});
    throw new ShinobiError(`Answer too large (${length} bytes)`);
  }
  const buffer = Buffer.from(await response.arrayBuffer());
  if (buffer.length > limit) {
    throw new ShinobiError(`Answer too large (${buffer.length} bytes)`);
  }
  return buffer;
}

const isJpeg = (buffer) => buffer.length > 3 && buffer[0] === 0xff && buffer[1] === 0xd8;

/** A `{ ok: false, msg }` answer as an error. */
function refusal(body, what) {
  const msg = String(body?.msg ?? '')
    .replace(/\s+/g, ' ')
    .slice(0, 160);
  if (/not authori[sz]ed|not permitted/i.test(msg)) {
    return new ShinobiError(`Shinobi refuses the API key or group key (${what})`, {
      kind: 'auth',
    });
  }
  if (/does not exist/i.test(msg)) {
    return new ShinobiError(`Shinobi: ${msg}`, { kind: 'notFound' });
  }
  return new ShinobiError(`Shinobi refuses ${what}${msg ? `: ${msg}` : ''}`, { kind: 'refused' });
}

export class ShinobiClient {
  /**
   * @param {object} options
   * @param {string} options.url the server address (parseServerUrl)
   * @param {string} options.apiKey an API key of the Shinobi account
   * @param {string} options.groupKey the group key of the account
   * @param {Function} [options.fetch] fetch (tests replace it)
   */
  constructor({ url, apiKey, groupKey, fetch = globalThis.fetch }) {
    const server = parseServerUrl(url);
    if (!server) {
      throw new ShinobiError('Invalid Shinobi address', { kind: 'config' });
    }
    this.origin = server.origin;
    this.basePath = server.basePath;
    this.apiKey = String(apiKey ?? '');
    this.groupKey = String(groupKey ?? '');
    this.fetch = fetch;
  }

  /** The address, for messages and logs (never with the key). */
  get label() {
    return `${this.origin}${this.basePath}`;
  }

  /** The Socket.IO address of the server (Engine.IO `eio`, WebSocket only). */
  socketUrl(eio = 4) {
    return `${this.label.replace(/^http/, 'ws')}/socket.io/?EIO=${eio}&transport=websocket`;
  }

  // --- Requests --------------------------------------------------------------

  /**
   * GET `<key>/<route>/<group>/<rest…>`. `what` names the route in messages
   * and logs: the URL holds the key.
   */
  async send(route, rest = [], what = route) {
    const parts = [this.apiKey, route, this.groupKey, ...rest].map(encodeURIComponent);
    const url = `${this.label}/${parts.join('/')}`;
    logger.debug(`GET ${what}`);
    let response;
    try {
      response = await this.fetch(url, {
        headers: { accept: 'application/json, image/jpeg' },
        redirect: 'manual',
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch (err) {
      const reason = err?.name === 'TimeoutError' ? 'timeout' : (err?.cause?.code ?? err?.message);
      throw new ShinobiError(`${this.label} does not answer (${reason})`, { kind: 'network' });
    }
    if (response.ok) {
      return response;
    }
    await response.body?.cancel().catch(() => {});
    if (response.status === 401 || response.status === 403) {
      throw new ShinobiError(`Shinobi refuses the access (HTTP ${response.status})`, {
        kind: 'auth',
        status: response.status,
      });
    }
    throw new ShinobiError(`Shinobi answered HTTP ${response.status} to ${what}`, {
      kind: response.status === 404 ? 'notFound' : 'http',
      status: response.status,
    });
  }

  async parse(response, what) {
    const buffer = await readLimited(response, MAX_JSON_BYTES);
    try {
      return JSON.parse(buffer.toString('utf8'));
    } catch {
      throw new ShinobiError(`Shinobi answered something else than JSON to ${what}`);
    }
  }

  /** The monitors of the group, as normalizeMonitor. */
  async listMonitors() {
    const body = await this.parse(await this.send('monitor', [], 'monitor list'), 'monitor list');
    if (!Array.isArray(body)) {
      if (body && typeof body === 'object' && body.ok === false) {
        throw refusal(body, 'the monitor list');
      }
      throw new ShinobiError('This server does not answer like Shinobi (monitor list)');
    }
    return body.map(normalizeMonitor).filter((monitor) => /^[A-Za-z0-9_-]+$/.test(monitor.id));
  }

  /** The user id behind the API key: the socket login asks for it. */
  async userId() {
    const body = await this.parse(await this.send('userInfo', [], 'user info'), 'user info');
    if (body?.ok !== true || typeof body.user?.uid !== 'string') {
      throw refusal(body, 'the user info');
    }
    return body.user.uid;
  }

  /** The last frame of the monitor's JPEG API. */
  async snapshot(monitorId) {
    const response = await this.send('jpeg', [monitorId, 's.jpg'], 'snapshot');
    const buffer = await readLimited(response, MAX_IMAGE_BYTES);
    if (!isJpeg(buffer)) {
      let body = null;
      try {
        body = JSON.parse(buffer.toString('utf8'));
      } catch {
        // Not JSON either.
      }
      throw body?.ok === false
        ? refusal(body, 'the snapshot')
        : new ShinobiError(`Monitor ${monitorId} sent no JPEG image`);
    }
    return buffer;
  }

  /** Switch a monitor to `start` (watch only), `record`, `idle` or `stop`. */
  async setMode(monitorId, mode) {
    if (!MODES.includes(mode)) {
      throw new ShinobiError(`Unknown mode "${mode}": ${MODES.join(', ')}`, { kind: 'refused' });
    }
    const body = await this.parse(await this.send('monitor', [monitorId, mode], 'mode'), 'mode');
    // "Monitor mode is already : record" is not a failure.
    if (body?.ok !== true && !/already/i.test(String(body?.msg ?? ''))) {
      throw refusal(body, 'the mode change');
    }
  }
}
