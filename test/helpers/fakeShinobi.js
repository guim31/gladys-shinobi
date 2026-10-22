// -----------------------------------------------------------------------------
// A simulated Shinobi behind the `fetch` and `WebSocket` seams, built on
// answers recorded from a real Shinobi (20/10/2026, ca152d3, see
// test/fixtures/shinobi): the monitor list, the user info, a snapshot, the
// socket events.
//
// It behaves like that Shinobi: a wrong API key or group key is an HTTP 200
// `{ ok: false, msg: "Not Authorized" }`; a mode already set is `ok: false`
// "Monitor mode is already"; the socket speaks Engine.IO 4 / Socket.IO, wants
// `init` with the key, group key and user id, and an API key with the
// `auth_socket` permission; `detector_trigger` only goes to the sockets that
// asked `detector_on` for the monitor.
// -----------------------------------------------------------------------------

import { readFileSync } from 'node:fs';

const fixture = (name) => new URL(`../fixtures/shinobi/${name}`, import.meta.url);
const read = (name) => JSON.parse(readFileSync(fixture(name), 'utf8'));

export const FRAME = readFileSync(fixture('frame.jpg'));
export const EVENTS = read('events.json');
export const API_KEY = 'Kx7mQ2vR9tLw4ZpN8sYc3HbJ6fGdAe';
export const GROUP_KEY = 'TestGroup';
export const UID = read('userinfo.json').user.uid;

const json = (body) =>
  new Response(JSON.stringify(body, null, 3), {
    headers: { 'content-type': 'application/json' },
  });

const STATUS = { start: [2, 'Watching'], record: [3, 'Recording'], stop: [5, 'Stopped'] };

export class FakeShinobi {
  constructor() {
    this.monitors = read('monitors.json');
    this.userInfo = read('userinfo.json');
    this.apiKey = API_KEY;
    this.groupKey = GROUP_KEY;
    // The permissions of the key: control monitors, open the socket.
    this.canControl = true;
    this.canSocket = true;
    this.down = false;
    this.socketDown = false;
    // Engine.IO versions the socket server speaks.
    this.eio = [4];
    this.requests = [];
    this.sockets = new Set();
    this.frame = FRAME;
    this.fetch = this.fetch.bind(this);
    const server = this;
    this.WebSocket = class extends FakeSocket {
      constructor(url) {
        super(server, url);
      }
    };
  }

  monitor(id) {
    return this.monitors.find((monitor) => monitor.mid === id);
  }

  async fetch(input) {
    const url = new URL(String(input));
    this.requests.push(url.pathname);
    if (this.down) {
      const err = new TypeError('fetch failed');
      err.cause = { code: 'ECONNREFUSED' };
      throw err;
    }
    const [key, route, group, id, mode] = url.pathname.split('/').slice(1).map(decodeURIComponent);
    if (key !== this.apiKey || group !== this.groupKey) {
      return json({ ok: false, msg: 'Not Authorized' });
    }
    if (route === 'userInfo') {
      return json(this.userInfo);
    }
    if (route === 'jpeg') {
      // An unknown monitor gets Shinobi's placeholder image: a JPEG too.
      return new Response(this.frame, { headers: { 'content-type': 'image/jpeg' } });
    }
    if (route === 'monitor' && !id) {
      return json(this.monitors);
    }
    if (route === 'monitor' && mode) {
      if (!this.canControl) {
        return json({ ok: false, msg: 'Not Authorized' });
      }
      if (!['start', 'record', 'stop', 'idle'].includes(mode)) {
        return json({ ok: false, msg: 'Mode not recognized.' });
      }
      const monitor = this.monitor(id);
      if (!monitor) {
        return json({ ok: false, msg: 'Monitor or Key does not exist.' });
      }
      if (monitor.mode === mode) {
        return json({ ok: false, msg: `Monitor mode is already : ${mode}` });
      }
      this.setMode(id, mode);
      return json({
        ok: true,
        msg: `Monitor mode changed : ${mode}`,
        cmd_at: '2026-10-22 11:07:49',
      });
    }
    return json({ ok: false, msg: 'Not Authorized' });
  }

  /** A mode change, as Shinobi does it: stopped, then started in the new mode. */
  setMode(id, mode) {
    const monitor = this.monitor(id);
    monitor.mode = mode;
    const [code, status] = STATUS[mode] ?? [6, 'Idle'];
    monitor.code = String(code);
    monitor.status = status;
    this.emit({ id, ke: this.groupKey, status: 'Stopped', code: 5, f: 'monitor_status' });
    if (mode !== 'stop') {
      this.emit({ f: 'monitor_starting', mode, mid: id, time: '2026-10-22T11-07-50' });
      this.emit({ id, ke: this.groupKey, status, code, f: 'monitor_status' });
    }
  }

  /** The status code of a monitor changes (its stream lost, back…). */
  setStatus(id, code, status) {
    const monitor = this.monitor(id);
    monitor.code = String(code);
    monitor.status = status;
    this.emit({ id, ke: this.groupKey, status, code, f: 'monitor_status' });
  }

  /** Send an event to the logged-in sockets (detections: to their followers). */
  emit(event) {
    for (const socket of this.sockets) {
      socket.event(event);
    }
  }

  /** A detection recorded from Shinobi, for a monitor. */
  detect(id, details) {
    this.emit({
      f: 'detector_trigger',
      id,
      ke: this.groupKey,
      time: new Date().toISOString(),
      details,
      doObjectDetection: false,
    });
  }

  /** Close every open socket, as a restart of Shinobi does. */
  dropSockets() {
    for (const socket of [...this.sockets]) {
      socket.close();
    }
  }
}

/** The WebSocket of the fake: the EventTarget surface undici offers. */
class FakeSocket extends EventTarget {
  constructor(server, url) {
    super();
    this.server = server;
    this.url = url;
    this.eio = Number(new URL(url).searchParams.get('EIO'));
    this.logged = false;
    this.followed = new Set();
    this.open = true;
    this.sent = [];
    queueMicrotask(() => this.start());
  }

  dispatch(type, props = {}) {
    const event = new Event(type);
    Object.assign(event, props);
    this.dispatchEvent(event);
  }

  reply(text) {
    if (this.open) {
      queueMicrotask(() => this.open && this.dispatch('message', { data: text }));
    }
  }

  start() {
    if (this.server.down || this.server.socketDown || !this.server.eio.includes(this.eio)) {
      this.open = false;
      this.dispatch('error', { message: 'Unexpected server response: 400' });
      this.dispatch('close');
      return;
    }
    this.server.sockets.add(this);
    this.dispatch('open');
    this.reply(
      `0${JSON.stringify({ sid: 'fake', upgrades: [], pingInterval: 60000, pingTimeout: 130000 })}`,
    );
    if (this.eio === 3) {
      // Engine.IO 3: the server joins the default namespace itself.
      this.reply('40');
    }
  }

  send(text) {
    this.sent.push(text);
    if (text === '40') {
      this.reply('40{"sid":"fake-ns"}');
      return;
    }
    if (!text.startsWith('42')) {
      return;
    }
    const [name, data] = JSON.parse(text.slice(2));
    if (name !== 'f') {
      return;
    }
    const { apiKey, groupKey } = this.server;
    if (data.f === 'init') {
      const valid = data.auth === apiKey && data.ke === groupKey && data.uid === UID;
      if (!valid || !this.server.canSocket) {
        this.reply(
          `42${JSON.stringify([
            'f',
            {
              ok: false,
              msg: valid
                ? 'Permissions for this key do not allow authentication with Websocket'
                : 'Not an API key',
              token_used: data.auth,
              ke: data.ke,
            },
          ])}`,
        );
        queueMicrotask(() => this.close());
        return;
      }
      this.logged = true;
      this.reply(`42${JSON.stringify(['f', { f: 'init_success', ke: groupKey }])}`);
      return;
    }
    if (this.logged && data.f === 'monitor' && data.ff === 'detector_on') {
      this.followed.add(data.id);
    }
  }

  event(event) {
    if (!this.logged) {
      return;
    }
    if (event.f === 'detector_trigger' && !this.followed.has(event.id)) {
      return;
    }
    this.reply(`42${JSON.stringify(['f', event])}`);
  }

  close() {
    if (!this.open) {
      return;
    }
    this.open = false;
    this.server.sockets.delete(this);
    queueMicrotask(() => this.dispatch('close'));
  }
}
