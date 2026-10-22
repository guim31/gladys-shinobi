// -----------------------------------------------------------------------------
// The Socket.IO link of one Shinobi server: the live events.
//
// Socket.IO spoken by hand over a plain WebSocket (no client library): Shinobi
// of 2026 runs Socket.IO 4 (Engine.IO 4). The exchange, checked on the
// Shinobi of 20/10/2026:
//   server  0{"sid","pingInterval",…}              Engine.IO open
//   client  40                                     join the default namespace
//   server  40{"sid"}
//   client  42["f",{"f":"init","auth":<API key>,"ke":<group>,"uid":<user id>}]
//   server  42["f",{"f":"init_success",…}]         or {"ok":false,"msg"} then a close
//   client  42["f",{"f":"monitor","ff":"detector_on","id":<monitor>,…}]  per monitor
// then `detector_trigger` (motion, objects) for the monitors followed, and
// `monitor_status` (status codes) for all. The server pings (`2`, answered
// `3`), and Shinobi itself sends ["ping",{beat}] every few seconds, answered
// ["pong",{beat}]. An API key needs the "Can Authenticate Websocket"
// permission (`auth_socket`) for `init`.
//
// An older Shinobi (Socket.IO 2) speaks Engine.IO 3 whatever is asked: its
// open packet has no `maxPayload`, the server joins the namespace itself and
// the client pings. Such a Shinobi has no `detector_on` either (checked on the
// 2021 Docker Hub image): the socket opens, but no detection comes.
// -----------------------------------------------------------------------------

import { createLogger } from '@gladysassistant/integration-sdk';
import { ShinobiError } from './client.js';

const logger = createLogger({ name: 'shinobi-socket' });

export const SOCKET_TIMINGS = {
  handshakeMs: 15000,
  // Nothing received this long after the ping interval: the link is dead.
  silenceMarginMs: 20000,
  retryMinMs: 2000,
  retryMaxMs: 60000,
};

export class ShinobiSocket {
  /**
   * @param {object} options
   * @param {import('./client.js').ShinobiClient} options.client the REST client (address, keys)
   * @param {Function} [options.WebSocket] the WebSocket class (tests replace it)
   * @param {Function} options.monitors the monitor ids to follow, read at each (re)connection
   * @param {Function} options.onOpen called once logged in, after each (re)connection
   * @param {Function} options.onEvent called with each `f` event of the server
   * @param {Function} options.onClose called with the error when a link fails or is lost
   * @param {object} [options.timings] overrides of SOCKET_TIMINGS
   */
  constructor({
    client,
    WebSocket = globalThis.WebSocket,
    monitors,
    onOpen,
    onEvent,
    onClose,
    timings,
  }) {
    this.client = client;
    this.WebSocket = WebSocket;
    this.monitors = monitors;
    this.onOpen = onOpen;
    this.onEvent = onEvent;
    this.onClose = onClose;
    this.timings = { ...SOCKET_TIMINGS, ...timings };
    this.ws = null;
    this.uid = null;
    this.eio = 4;
    this.followed = new Set();
    this.ready = false;
    this.closed = false;
    this.failures = 0;
    this.retryTimer = null;
    this.pingTimer = null;
    this.silenceTimer = null;
    this.pingInterval = 25000;
  }

  // --- Connection ------------------------------------------------------------

  /** Open the link; resolves once logged in, rejects on failure. */
  async open() {
    if (this.closed) {
      return;
    }
    // The user behind the key, once per client: `init` wants it.
    this.uid ??= await this.client.userId();
    if (this.closed) {
      return;
    }
    await new Promise((resolve, reject) => {
      let settled = false;
      const settle = (err) => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timer);
        if (err) {
          reject(err);
        } else {
          resolve();
        }
      };
      const timer = setTimeout(
        () => settle(new ShinobiError('The Shinobi socket does not answer', { kind: 'network' })),
        this.timings.handshakeMs,
      );
      let ws;
      try {
        ws = new this.WebSocket(this.client.socketUrl(4));
      } catch (err) {
        settle(new ShinobiError(`Cannot open the Shinobi socket: ${err.message}`));
        return;
      }
      this.ws = ws;
      const send = (text) => {
        try {
          ws.send(text);
        } catch {
          // Closing: the close event follows.
        }
      };
      const emit = (data) => send(`42${JSON.stringify(['f', data])}`);
      const login = () =>
        emit({ f: 'init', auth: this.client.apiKey, ke: this.client.groupKey, uid: this.uid });
      ws.addEventListener('message', (event) => {
        if (ws !== this.ws) {
          return;
        }
        const text = String(event.data);
        this.heard();
        if (text.startsWith('0')) {
          let open = {};
          try {
            open = JSON.parse(text.slice(1)) ?? {};
          } catch {
            // The defaults.
          }
          this.pingInterval = Number(open.pingInterval) || 25000;
          // Engine.IO 4 announces `maxPayload`; an Engine.IO 3 server (an
          // older Shinobi, Socket.IO 2) does not check the EIO asked, answers
          // without it, joins the namespace itself and waits for client pings.
          this.eio = open.maxPayload === undefined ? 3 : 4;
          if (this.eio === 4) {
            send('40');
          } else {
            this.startClientPing(ws);
          }
          this.heard();
        } else if (text === '2') {
          send('3');
        } else if (text.startsWith('40')) {
          login();
        } else if (text.startsWith('41')) {
          ws.close();
        } else if (text.startsWith('42')) {
          let event;
          try {
            event = JSON.parse(text.slice(2));
          } catch {
            return;
          }
          const [name, data] = Array.isArray(event) ? event : [];
          if (name === 'ping') {
            send(`42${JSON.stringify(['pong', data])}`);
          } else if (name === 'f' && data && typeof data === 'object') {
            if (this.ready) {
              this.onEvent?.(data);
            } else if (data.f === 'init_success') {
              this.ready = true;
              this.followed.clear();
              this.follow(this.monitors?.() ?? []);
              settle();
            } else if (data.ok === false) {
              // A refused login: the key, the group key, or the socket permission.
              const msg = String(data.msg ?? '').slice(0, 160);
              settle(
                new ShinobiError(`Shinobi refuses the socket login${msg ? `: ${msg}` : ''}`, {
                  kind: 'auth',
                }),
              );
              ws.close();
            }
          }
        }
      });
      ws.addEventListener('error', (event) => {
        settle(
          new ShinobiError(
            `The Shinobi socket failed (${event?.message ?? event?.error?.message ?? 'error'})`,
            { kind: 'network' },
          ),
        );
      });
      ws.addEventListener('close', () => {
        settle(new ShinobiError('The Shinobi socket closed', { kind: 'network' }));
        this.lost(ws);
      });
    });
    this.failures = 0;
    await this.onOpen?.();
  }

  /** Open, and keep it open: every failure plans another try. */
  connect() {
    if (this.closed) {
      return Promise.resolve();
    }
    return this.open().catch((err) => {
      if (this.closed) {
        return;
      }
      this.failures += 1;
      this.drop();
      if (err.kind === 'auth') {
        // The key may have been refused for the user lookup: look again next time.
        this.uid = null;
      }
      this.onClose?.(err, { connected: false });
      this.scheduleRetry();
    });
  }

  scheduleRetry() {
    if (this.closed || this.retryTimer) {
      return;
    }
    const delay = Math.min(
      this.timings.retryMinMs * 2 ** Math.max(this.failures - 1, 0),
      this.timings.retryMaxMs,
    );
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      this.connect();
    }, delay);
    this.retryTimer.unref?.();
  }

  /** The open link was lost: tell the hub, try again. */
  lost(ws) {
    if (ws !== this.ws) {
      return;
    }
    const wasReady = this.ready;
    this.drop();
    if (wasReady && !this.closed) {
      this.failures = 1;
      this.onClose?.(new ShinobiError('The Shinobi socket closed', { kind: 'network' }), {
        connected: true,
      });
      this.scheduleRetry();
    }
  }

  drop() {
    this.ready = false;
    clearInterval(this.pingTimer);
    this.pingTimer = null;
    clearTimeout(this.silenceTimer);
    this.silenceTimer = null;
    const ws = this.ws;
    this.ws = null;
    try {
      ws?.close();
    } catch {
      // Already closed.
    }
  }

  close() {
    this.closed = true;
    clearTimeout(this.retryTimer);
    this.retryTimer = null;
    this.drop();
  }

  /** A packet came in: the link lives; a silence too long means it does not. */
  heard() {
    clearTimeout(this.silenceTimer);
    const ws = this.ws;
    this.silenceTimer = setTimeout(() => {
      logger.debug('The Shinobi socket went silent');
      this.lost(ws);
    }, this.pingInterval + this.timings.silenceMarginMs);
    this.silenceTimer.unref?.();
  }

  /** Engine.IO 3: the client pings. */
  startClientPing(ws) {
    clearInterval(this.pingTimer);
    this.pingTimer = setInterval(() => {
      try {
        ws.send('2');
      } catch {
        // Closing.
      }
    }, this.pingInterval);
    this.pingTimer.unref?.();
  }

  // --- Commands --------------------------------------------------------------

  /** Receive the detections of these monitors (the ones not followed yet). */
  follow(ids) {
    if (!this.ready || !this.ws) {
      return;
    }
    for (const id of ids) {
      if (this.followed.has(id)) {
        continue;
      }
      this.followed.add(id);
      this.ws.send(
        `42${JSON.stringify([
          'f',
          {
            f: 'monitor',
            ff: 'detector_on',
            id,
            ke: this.client.groupKey,
            auth: this.client.apiKey,
            uid: this.uid,
          },
        ])}`,
      );
    }
  }
}
