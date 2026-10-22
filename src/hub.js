// -----------------------------------------------------------------------------
// The Shinobi hub: one server (one group key), its monitors, and everything
// Gladys sees of them.
//
// Two sources (the devices are published with should_poll: false, see
// src/devices.js):
//   - Socket.IO, live: `detector_trigger` (motion, objects) and
//     `monitor_status` (the status code of a monitor). A detection fires its
//     scene trigger and sends the image of the moment;
//   - the monitor list (REST), every minute: names, monitors added or
//     removed, mode, status code, and whether the server answers at all. It
//     keeps the states right while the socket is down.
// An image also goes every `snapshot_interval` to each camera added in Gladys.
//
// States go through publishChangedStates (only what changed, a heartbeat
// every 12 h so a quiet value never looks stale).
// -----------------------------------------------------------------------------

import { createLogger } from '@gladysassistant/integration-sdk';
import { connectionKey } from './config.js';
import {
  FEATURE_KEYS,
  MODES,
  buildDevice,
  deviceIds,
  deviceName,
  featureKeyOf,
} from './devices.js';
import { asCameraImage, fitJpeg } from './image.js';
import { ShinobiClient, ShinobiError } from './shinobi/client.js';
import { ShinobiSocket } from './shinobi/socket.js';
import { CONNECTION_TEXT } from './texts.js';

const logger = createLogger({ name: 'shinobi' });

export const WIDGET_KEY = 'camera';
export const TRIGGERS = {
  MOTION: 'motion_detected',
  OBJECT: 'object_detected',
  OFFLINE: 'camera_offline',
};

// Status codes of a monitor whose stream comes in: Watching, Recording.
export const STREAMING_CODES = [2, 3];
// Modes where no stream is expected: no "offline" alarm.
export const QUIET_MODES = ['stop', 'idle'];
// The region of a detection on the whole image (no region drawn).
export const FULL_FRAME = 'FULL_FRAME';

export const DEFAULT_TIMINGS = {
  listMs: 60 * 1000,
  // How often the image timer looks for a camera due for an image.
  imageTickMs: 5000,
  // A monitor not streaming this long is said offline: a restart (a mode
  // change, Shinobi's own watchdog) does not fire the trigger.
  offlineAfterMs: 30 * 1000,
  // 12 images a minute per camera at most (the core's bound).
  minImageSpacingMs: 5000,
  // How long a trigger waits for the image of the moment.
  imageWaitMs: 3000,
  heartbeatMs: 12 * 60 * 60 * 1000,
  // Monitor lists failed in a row before Shinobi is said down (and its
  // cameras offline): one lost answer is not an outage.
  outageAfter: 2,
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// How old the last image may be to stand in for a fresh one.
const STALE_IMAGE_MS = 5 * 60 * 1000;

/** A confidence in percent (0-100), from 0-1 or 0-100, or null. */
export function percentOf(value) {
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0) {
    return null;
  }
  return Math.round(number <= 1 ? number * 100 : Math.min(number, 100));
}

/**
 * What a `detector_trigger` says: `{ kind: 'motion' | 'object', hits: [{
 * region, label, score }] }`. Motion: one hit per region (empty for the whole
 * image). Objects: one hit per label, the best score.
 */
export function parseDetection(details) {
  const kind = String(details?.reason ?? '') === 'object' ? 'object' : 'motion';
  const matrices = Array.isArray(details?.matrices) ? details.matrices : [];
  const hits = new Map();
  for (const matrix of matrices) {
    const tag = String(matrix?.tag ?? '').trim();
    const score = percentOf(matrix?.confidence);
    const hit =
      kind === 'object'
        ? { region: '', label: tag.toLowerCase(), score }
        : { region: tag === FULL_FRAME ? '' : tag, label: '', score };
    if (kind === 'object' && !hit.label) {
      continue;
    }
    const key = kind === 'object' ? hit.label : hit.region;
    const known = hits.get(key);
    if (!known || (hit.score ?? -1) > (known.score ?? -1)) {
      hits.set(key, hit);
    }
  }
  if (hits.size === 0) {
    // No matrices (a detection sent through the API): its name is the region.
    const name = String(details?.name ?? '').trim();
    const region = kind === 'motion' && name && name !== 'multipleRegions' ? name : '';
    hits.set('', { region, label: '', score: percentOf(details?.confidence) });
  }
  return { kind, hits: [...hits.values()] };
}

export class ShinobiHub {
  /**
   * @param {object} options
   * @param {object} options.gladys GladysIntegration (or the SDK's fake)
   * @param {Function} [options.fetch] fetch for the Shinobi client (tests)
   * @param {Function} [options.WebSocket] WebSocket class (tests)
   * @param {boolean} [options.timers] run the periodic timers
   * @param {object} [options.timings] overrides of DEFAULT_TIMINGS
   * @param {object} [options.socketTimings] overrides of SOCKET_TIMINGS
   */
  constructor({ gladys, fetch, WebSocket, timers = true, timings = {}, socketTimings }) {
    this.gladys = gladys;
    this.fetch = fetch;
    this.WebSocket = WebSocket;
    this.useTimers = timers;
    this.timings = { ...DEFAULT_TIMINGS, ...timings };
    this.socketTimings = socketTimings;
    this.config = null;
    this.client = null;
    this.socket = null;
    this.clientKey = null;
    this.cameras = new Map();
    // null (not tried yet), 'ok', 'auth', 'unreachable', 'error', 'noUrl'
    this.server = null;
    // Whether the live events flow (the socket is open and logged in).
    this.live = false;
    // Why they do not: the last socket error.
    this.socketError = null;
    this.publishedDevicesKey = null;
    this.pending = new Set();
    this.timers = [];
    this.stopped = false;
    this.generation = 0;
  }

  // --- Lifecycle ---------------------------------------------------------------

  async start(config) {
    this.applyConfig(config);
    logger.info(
      this.client
        ? `Starting with the Shinobi server ${this.client.label}`
        : 'No complete Shinobi configuration (address, API key, group key)',
    );
    await this.refresh();
    this.startTimers();
  }

  /** Gladys came back: re-send what it may have lost. */
  async resync(config) {
    this.applyConfig(config);
    this.publishedDevicesKey = null;
    await this.refresh();
    for (const device of this.gladys.devices ?? []) {
      this.gladys.forgetPublishedStates(device.external_id);
    }
    await this.publishAllStates();
    await this.publishTransports();
  }

  async reconfigure(config) {
    const language = this.config?.language;
    this.applyConfig(config);
    if (language !== config.language) {
      this.publishedDevicesKey = null;
    }
    await this.refresh();
    this.startTimers();
  }

  applyConfig(config) {
    this.config = config;
    const key = connectionKey(config);
    if (key === this.clientKey) {
      return;
    }
    this.clientKey = key;
    this.generation += 1;
    this.socket?.close();
    this.socket = null;
    this.live = false;
    this.socketError = null;
    this.socketFailing = false;
    this.clearCameraTimers();
    this.cameras.clear();
    // The cameras already added in Gladys, known before Shinobi answers: they
    // can be said unreachable when it never does.
    for (const device of this.gladys.devices ?? []) {
      const param = (device.params ?? []).find((item) => item.name === 'SHINOBI_MONITOR');
      if (param?.value) {
        this.cameras.set(param.value, {
          ...this.newCamera(param.value),
          name: String(device.name ?? ''),
        });
      }
    }
    this.server = null;
    this.listFailures = 0;
    this.publishedDevicesKey = null;
    this.client = config.complete
      ? new ShinobiClient({
          url: config.url,
          apiKey: config.apiKey,
          groupKey: config.groupKey,
          fetch: this.fetch,
        })
      : null;
  }

  startTimers() {
    this.clearTimers();
    if (!this.useTimers || this.stopped) {
      return;
    }
    this.timers.push(
      setInterval(() => this.track(this.refresh()), this.timings.listMs),
      setInterval(() => this.track(this.imageTick()), this.timings.imageTickMs),
    );
    for (const timer of this.timers) {
      timer.unref?.();
    }
  }

  clearTimers() {
    for (const timer of this.timers) {
      clearInterval(timer);
    }
    this.timers = [];
  }

  clearCameraTimers() {
    for (const camera of this.cameras.values()) {
      clearTimeout(camera.offlineTimer);
      camera.offlineTimer = null;
      for (const kind of ['motion', 'object']) {
        clearTimeout(camera.resetTimers[kind]);
        camera.resetTimers[kind] = null;
      }
    }
  }

  /** Keep a background task, so stop() and the tests can wait for it. */
  track(promise) {
    const task = Promise.resolve(promise).catch((err) => logger.debug(err.message));
    this.pending.add(task);
    task.finally(() => this.pending.delete(task));
    return task;
  }

  async idle() {
    while (this.pending.size > 0) {
      await Promise.all([...this.pending]);
    }
  }

  async stop() {
    this.stopped = true;
    this.clearTimers();
    this.clearCameraTimers();
    this.socket?.close();
    await this.idle();
  }

  // --- Socket.IO -------------------------------------------------------------------

  /** Open the socket once the server answers (and again after a change). */
  ensureSocket() {
    if (this.socket || !this.client || this.stopped) {
      return;
    }
    const generation = this.generation;
    this.socket = new ShinobiSocket({
      client: this.client,
      WebSocket: this.WebSocket,
      timings: this.socketTimings,
      monitors: () => [...this.cameras.values()].filter((c) => c.listed).map((c) => c.id),
      onOpen: () => this.socketOpened(generation),
      onEvent: (data) => {
        if (generation === this.generation) {
          this.track(this.onEvent(data));
        }
      },
      onClose: (err, { connected }) => {
        if (generation === this.generation) {
          this.socketLost(err, connected);
        }
      },
    });
    this.track(this.socket.connect());
  }

  socketOpened(generation) {
    if (generation !== this.generation) {
      return;
    }
    if (this.socketFailing) {
      logger.info('The Shinobi live events are back');
    }
    this.socketFailing = false;
    this.socketError = null;
    this.live = true;
    this.requestWidgetRefresh();
  }

  socketLost(err, connected) {
    this.live = false;
    this.socketError = err;
    // Without live events a detection would stay at 1: back to none.
    for (const camera of this.cameras.values()) {
      this.clearDetections(camera);
      this.track(this.publishStates(camera));
    }
    if (!this.socketFailing) {
      this.socketFailing = true;
      // A refused login or a lost link: one line, until it is back.
      const line = `Shinobi live events unavailable: ${err.message}`;
      if (connected || err.kind === 'auth') {
        logger.warn(line);
      } else {
        logger.info(line);
      }
    } else {
      logger.debug(err.message);
    }
  }

  /** One `f` event of the socket. */
  async onEvent(data) {
    const camera = this.cameras.get(String(data?.id ?? data?.mid ?? ''));
    if (!camera) {
      return;
    }
    switch (data.f) {
      case 'detector_trigger':
        await this.onDetection(camera, data.details);
        break;
      case 'monitor_status': {
        const code = Number.parseInt(data.code, 10);
        if (Number.isFinite(code)) {
          camera.code = code;
          if (STREAMING_CODES.includes(code)) {
            await this.checkOnline(camera);
          } else {
            // Stopped, restarting, died: the mode says whether it is meant
            // (disabled in Shinobi) or an outage, and only the list has it.
            await this.refresh();
          }
        }
        break;
      }
      case 'monitor_starting':
        if (MODES.includes(data.mode) && data.mode !== camera.mode) {
          camera.mode = data.mode;
          await this.publishStates(camera);
          this.requestWidgetRefresh();
        }
        break;
      default:
        break;
    }
  }

  /**
   * A detection: the state on (back to 0 after `motion_reset` seconds
   * without another), and, for a region or a label not seen during that
   * time, the image of the moment and the scene trigger.
   */
  async onDetection(camera, details) {
    const { kind, hits } = parseDetection(details);
    if (kind === 'object' && !camera.objects) {
      // A plugin found on the way: the feature comes with the next list.
      camera.objects = true;
      this.publishedDevicesKey = null;
    }
    const now = Date.now();
    const resetMs = this.config.motionResetSeconds * 1000;
    const fresh = [];
    for (const hit of hits) {
      const key = `${kind}|${hit.region}|${hit.label}`;
      const last = camera.seen.get(key);
      camera.seen.set(key, now);
      if (last === undefined || now - last >= resetMs) {
        fresh.push(hit);
      }
    }
    const was = camera[kind];
    camera[kind] = true;
    camera.lastLabels = kind === 'object' ? hits.map((hit) => hit.label) : camera.lastLabels;
    clearTimeout(camera.resetTimers[kind]);
    camera.resetTimers[kind] = null;
    if (this.useTimers) {
      camera.resetTimers[kind] = setTimeout(() => {
        camera.resetTimers[kind] = null;
        this.track(this.endDetection(camera, kind));
      }, resetMs);
      camera.resetTimers[kind].unref?.();
    }
    if (was !== true) {
      await this.publishStates(camera);
      this.requestWidgetRefresh();
    }
    if (fresh.length === 0 || !this.isCreated(camera)) {
      return;
    }
    // The image of the moment first, but the triggers never wait long for it.
    const image = this.track(this.publishImage(camera, { wait: true }));
    await Promise.race([image, sleep(this.timings.imageWaitMs)]);
    for (const hit of fresh) {
      const data =
        kind === 'object'
          ? { label: hit.label, score: hit.score ?? 0 }
          : { region: hit.region, score: hit.score ?? 0 };
      this.track(
        this.gladys.publishSceneEvent(kind === 'object' ? TRIGGERS.OBJECT : TRIGGERS.MOTION, {
          camera: this.ids(camera).device,
          camera_name: deviceName(camera),
          ...data,
        }),
      );
    }
  }

  /** No detection for `motion_reset` seconds: back to none. */
  async endDetection(camera, kind) {
    if (camera[kind] !== true) {
      return;
    }
    camera[kind] = false;
    await this.publishStates(camera);
    this.requestWidgetRefresh();
  }

  // --- Server and monitor list -----------------------------------------------------

  /** Read the monitor list; publish what changed. */
  refresh() {
    // A refresh started before a change of configuration speaks of the old
    // server: chain a new one rather than share its result.
    if (!this.refreshing || this.refreshing.generation !== this.generation) {
      const previous = this.refreshing ?? Promise.resolve();
      const generation = this.generation;
      const run = previous
        .catch(() => {})
        .then(() => this.doRefresh(generation))
        .finally(() => {
          if (this.refreshing === run) {
            this.refreshing = null;
          }
        });
      run.generation = generation;
      this.refreshing = run;
    }
    return this.refreshing;
  }

  async doRefresh(generation = this.generation) {
    if (!this.client) {
      await this.setServer('noUrl');
      return;
    }
    let list;
    try {
      list = await this.client.listMonitors();
    } catch (err) {
      if (generation !== this.generation) {
        return;
      }
      this.listFailures += 1;
      if (
        this.server === 'ok' &&
        err.kind !== 'auth' &&
        this.listFailures < this.timings.outageAfter
      ) {
        logger.debug(`Cannot read the monitor list: ${err.message}`);
        return;
      }
      await this.serverFailed(err);
      return;
    }
    if (generation !== this.generation) {
      return;
    }
    this.listFailures = 0;
    const seen = new Set();
    for (const item of list) {
      seen.add(item.id);
      let camera = this.cameras.get(item.id);
      if (!camera) {
        camera = this.newCamera(item.id);
        this.cameras.set(item.id, camera);
      }
      camera.listed = true;
      this.applyMonitor(camera, item);
    }
    for (const [id, camera] of [...this.cameras]) {
      if (!seen.has(id)) {
        logger.info(`Monitor ${id} is no longer in Shinobi`);
        // Its device stays in Gladys: no "local" badge nor detection left behind.
        this.clearDetections(camera);
        await this.publishStates(camera);
        if (camera.online !== false) {
          camera.online = false;
          await this.publishTransports([camera]);
        }
        clearTimeout(camera.offlineTimer);
        this.cameras.delete(id);
      }
    }
    await this.setServer('ok');
    this.ensureSocket();
    this.socket?.follow([...seen]);
    await this.publishDevices();
    for (const camera of this.cameras.values()) {
      await this.checkOnline(camera);
    }
    await this.publishAllStates();
  }

  newCamera(id) {
    return {
      id,
      name: '',
      listed: false,
      mode: null,
      code: null,
      snap: true,
      detector: false,
      objects: false,
      motion: null,
      object: null,
      lastLabels: [],
      seen: new Map(),
      resetTimers: { motion: null, object: null },
      online: null,
      offlineSince: null,
      offlineTimer: null,
      image: null,
      imageSeq: 0,
      lastPublishAt: 0,
    };
  }

  /** The monitor list: name, mode, status, what the monitor does. */
  applyMonitor(camera, item) {
    camera.name = item.name;
    const modeChanged = camera.mode !== null && camera.mode !== item.mode;
    camera.mode = item.mode;
    camera.code = item.code;
    camera.snap = item.snap;
    camera.detector = item.detector;
    // Never dropped once seen: a plugin may go and come back.
    camera.objects = camera.objects || item.objects;
    if (camera.motion === null) {
      camera.motion = false;
    }
    if (camera.objects && camera.object === null) {
      camera.object = false;
    }
    if (modeChanged) {
      this.requestWidgetRefresh();
    }
  }

  clearDetections(camera) {
    for (const kind of ['motion', 'object']) {
      clearTimeout(camera.resetTimers[kind]);
      camera.resetTimers[kind] = null;
      camera[kind] = camera[kind] === null ? null : false;
    }
    camera.seen.clear();
  }

  async serverFailed(err) {
    const state = err.kind === 'auth' ? 'auth' : err.kind === 'network' ? 'unreachable' : 'error';
    if (state !== this.server) {
      const line = `Shinobi ${this.client.label}: ${err.message}`;
      if (state === 'unreachable' && this.server === 'ok') {
        logger.warn(line);
      } else {
        logger.error(line);
      }
    } else {
      logger.debug(err.message);
    }
    await this.setServer(state);
  }

  async setServer(state) {
    const previous = this.server;
    this.server = state;
    if (state === 'ok' && previous && previous !== 'ok' && previous !== 'noUrl') {
      logger.info(`Shinobi ${this.client.label} answers again`);
    }
    if (state === previous) {
      return;
    }
    if (state !== 'ok') {
      // Nothing can be read any more: no stale detection, no "local" badge.
      const outage = state === 'unreachable' || state === 'error';
      for (const camera of this.cameras.values()) {
        this.clearDetections(camera);
        await this.publishStates(camera);
        // Shinobi down: its cameras are lost too ("Camera offline").
        await this.setOnline(camera, false, { quiet: !outage });
      }
    }
    try {
      if (state === 'ok') {
        await this.gladys.setConnectionStatus(true);
      } else {
        await this.gladys.setConnectionStatus(false, CONNECTION_TEXT[state]);
      }
    } catch (err) {
      logger.debug(`Cannot send the connection status: ${err.message}`);
    }
  }

  // --- Devices -------------------------------------------------------------------

  ids(camera) {
    return deviceIds(this.gladys, camera.id);
  }

  async publishDevices() {
    const devices = [...this.cameras.values()].map((camera) =>
      buildDevice(this.gladys, this.withKnownFeatures(camera), this.config.language),
    );
    // Republished when a monitor appears, goes, is renamed or gains a
    // feature: an upsert on the devices already added, a new entry in the
    // Discovery tab otherwise.
    const key = JSON.stringify(
      devices.map((device) => [
        device.external_id,
        device.name,
        device.features.map((feature) => feature.external_id),
      ]),
    );
    if (key === this.publishedDevicesKey) {
      return;
    }
    try {
      await this.gladys.publishDiscoveredDevices(devices);
      this.publishedDevicesKey = key;
      if (this.devicesFailing) {
        this.devicesFailing = false;
        logger.info('The cameras are published to Gladys again');
      }
    } catch (err) {
      // Tried again at the next reading of the list.
      if (!this.devicesFailing) {
        this.devicesFailing = true;
        logger.warn(`Cannot publish the cameras to Gladys: ${err.message}`);
      }
    }
  }

  /**
   * A camera already added keeps the object feature it has in Gladys, even
   * when the monitor no longer says it uses a plugin: published without it,
   * Discovery would offer an "Update" that deletes it, history and scenes too.
   */
  withKnownFeatures(camera) {
    if (camera.objects) {
      return camera;
    }
    const externalId = this.ids(camera).device;
    const device = (this.gladys.devices ?? []).find((item) => item.external_id === externalId);
    const known = (device?.features ?? []).some(
      (feature) => featureKeyOf(feature.external_id) === FEATURE_KEYS.OBJECT,
    );
    if (known) {
      camera.objects = true;
      camera.object ??= false;
    }
    return camera;
  }

  isCreated(camera) {
    const externalId = this.ids(camera).device;
    return (this.gladys.devices ?? []).some((device) => device.external_id === externalId);
  }

  /** The camera behind a Gladys device external id, or null. */
  resolveDevice(externalId) {
    for (const camera of this.cameras.values()) {
      if (this.ids(camera).device === externalId) {
        return camera;
      }
    }
    return null;
  }

  require(externalId) {
    const camera = this.resolveDevice(externalId);
    if (!camera) {
      throw new Error(`Unknown Shinobi monitor ${externalId}: check the integration`);
    }
    return camera;
  }

  // --- States --------------------------------------------------------------------

  statesOf(camera) {
    const ids = this.ids(camera);
    const states = [];
    const add = (key, value) => {
      if (value !== null && value !== undefined) {
        states.push({ device_feature_external_id: ids.feature(key), state: value ? 1 : 0 });
      }
    };
    add(FEATURE_KEYS.MOTION, camera.motion);
    if (camera.objects) {
      add(FEATURE_KEYS.OBJECT, camera.object);
    }
    if (MODES.includes(camera.mode)) {
      states.push({
        device_feature_external_id: ids.feature(FEATURE_KEYS.MODE),
        text: camera.mode,
      });
    }
    add(FEATURE_KEYS.ONLINE, camera.online);
    return states;
  }

  async publishStates(camera) {
    if (!this.isCreated(camera)) {
      return;
    }
    const states = this.statesOf(camera);
    if (states.length === 0) {
      return;
    }
    try {
      // Only what changed; a value that never changes again every 12 h.
      await this.gladys.publishChangedStates(states, { heartbeat: this.timings.heartbeatMs });
      if (this.statesFailing) {
        this.statesFailing = false;
        logger.info('States are published to Gladys again');
      }
    } catch (err) {
      if (this.statesFailing) {
        logger.debug(`Cannot publish the states of monitor ${camera.id}: ${err.message}`);
      } else {
        this.statesFailing = true;
        logger.warn(`Cannot publish the states of monitor ${camera.id}: ${err.message}`);
      }
    }
  }

  async publishAllStates() {
    for (const camera of this.cameras.values()) {
      await this.publishStates(camera);
    }
  }

  async publishTransports(cameras = [...this.cameras.values()]) {
    const entries = cameras
      .filter((camera) => camera.online !== null && this.isCreated(camera))
      .map((camera) => ({
        external_id: this.ids(camera).device,
        transport: camera.online ? 'local' : 'unreachable',
      }));
    if (entries.length > 0) {
      await this.gladys.publishTransports(entries).catch((err) => logger.debug(err.message));
    }
  }

  /**
   * The user added a device: the states sent before were dropped by Gladys,
   * and so was the transport badge. Send them again, with an image.
   */
  async onDeviceCreated(device) {
    const camera = this.resolveDevice(device?.external_id);
    if (!camera) {
      return;
    }
    this.gladys.forgetPublishedStates(device.external_id);
    camera.lastPublishAt = 0;
    await this.publishStates(camera);
    if (camera.online) {
      await this.publishImage(camera);
    }
    await this.publishTransports([camera]);
    this.requestWidgetRefresh();
  }

  requestWidgetRefresh() {
    try {
      this.gladys.requestWidgetRefresh(WIDGET_KEY);
    } catch (err) {
      logger.debug(`Widget refresh refused: ${err.message}`);
    }
  }

  // --- Online / offline ------------------------------------------------------------

  async checkOnline(camera) {
    if (QUIET_MODES.includes(camera.mode)) {
      // Disabled or idle in Shinobi: no stream expected, no "offline" alarm.
      camera.offlineSince = null;
      await this.setOnline(camera, false, { quiet: true });
      return;
    }
    if (STREAMING_CODES.includes(camera.code)) {
      camera.offlineSince = null;
      await this.setOnline(camera, true);
      return;
    }
    if (camera.code === null || camera.mode === null) {
      return;
    }
    const now = Date.now();
    camera.offlineSince ??= now;
    if (camera.online === null || now - camera.offlineSince >= this.timings.offlineAfterMs) {
      await this.setOnline(camera, false);
    } else if (!camera.offlineTimer && this.useTimers) {
      // Restarting, starting: look again when the delay is over.
      camera.offlineTimer = setTimeout(() => {
        camera.offlineTimer = null;
        this.track(this.checkOnline(camera));
      }, this.timings.offlineAfterMs);
      camera.offlineTimer.unref?.();
    }
  }

  async setOnline(camera, online, { quiet = false } = {}) {
    if (camera.online === online) {
      return;
    }
    const was = camera.online;
    camera.online = online;
    const name = deviceName(camera);
    if (online && was === false) {
      logger.info(`Camera ${name} is online again`);
    } else if (!online && was === true && !quiet) {
      logger.info(`Camera ${name} is offline`);
    }
    await this.publishStates(camera);
    await this.publishTransports([camera]);
    this.requestWidgetRefresh();
    if (!online && was === true && !quiet && this.isCreated(camera)) {
      this.track(
        this.gladys.publishSceneEvent(TRIGGERS.OFFLINE, {
          camera: this.ids(camera).device,
          camera_name: name,
        }),
      );
    }
  }

  // --- Images --------------------------------------------------------------------

  /** Every few seconds: the cameras due for their periodic image. */
  async imageTick() {
    if (!this.client || this.server !== 'ok') {
      return;
    }
    for (const camera of this.cameras.values()) {
      if (
        camera.online &&
        Date.now() - camera.lastPublishAt >= this.config.snapshotSeconds * 1000
      ) {
        await this.publishImage(camera);
      }
    }
  }

  /**
   * A JPEG Gladys keeps (≤ 150 KB as a data URI): the last frame of the
   * monitor's JPEG API, made smaller in the container when it is too heavy
   * (Shinobi cannot be asked for a smaller one).
   */
  async grab(camera) {
    if (!this.client) {
      throw new ShinobiError('No Shinobi configuration');
    }
    if (!camera.snap) {
      // Shinobi would send its placeholder ("no image") instead.
      throw new ShinobiError(`The JPEG API of monitor ${camera.id} is off in Shinobi`, {
        kind: 'refused',
      });
    }
    const jpeg = await fitJpeg(await this.client.snapshot(camera.id));
    camera.image = { jpeg, at: Date.now() };
    camera.imageSeq += 1;
    return jpeg;
  }

  /** Send a fresh frame to Gladys, at most one every 5 s per camera. */
  async publishImage(camera, { wait = false } = {}) {
    if (!this.isCreated(camera) || !this.client) {
      return false;
    }
    const left = camera.lastPublishAt + this.timings.minImageSpacingMs - Date.now();
    if (left > 0) {
      if (!wait) {
        return false;
      }
      await sleep(left);
    }
    camera.lastPublishAt = Date.now();
    try {
      const jpeg = await this.grab(camera);
      // The DEVICE external id: the core answers 404 to a feature's.
      await this.gladys.publishCameraImage(this.ids(camera).device, asCameraImage(jpeg));
      return true;
    } catch (err) {
      // 404: the camera is turned off in Gladys, or not added; 429: too many.
      logger.debug(`Image of monitor ${camera.id} not sent: ${err.message}`);
      return false;
    }
  }

  /** A fresh image for Gladys (dashboard, "show me the camera"): data URI. */
  async imageFor(externalId) {
    const camera = this.require(externalId);
    try {
      return asCameraImage(await this.grab(camera));
    } catch (err) {
      logger.debug(`No fresh image of monitor ${camera.id}: ${err.message}`);
      if (!camera.image || Date.now() - camera.image.at > STALE_IMAGE_MS) {
        throw new Error(`Monitor ${camera.id} has no image right now`, { cause: err });
      }
      return asCameraImage(camera.image.jpeg);
    }
  }

  // --- Commands ------------------------------------------------------------------

  /** The mode list of the dashboard, or a scene's "Control a device". */
  async setValue(device, feature, value) {
    const camera = this.require(device?.external_id);
    if (featureKeyOf(feature?.external_id) !== FEATURE_KEYS.MODE) {
      throw new Error(`The feature ${feature?.external_id} cannot be set`);
    }
    await this.setMode(camera, String(value));
  }

  /** Change the mode of a monitor; Shinobi restarts it. */
  async setMode(camera, mode) {
    if (!MODES.includes(mode)) {
      throw new Error(`Unknown mode "${mode}": ${MODES.join(', ')}`);
    }
    if (!this.client) {
      throw new Error('No Shinobi configuration');
    }
    await this.client.setMode(camera.id, mode);
    logger.info(`Monitor ${camera.id} set to ${mode}`);
    camera.mode = mode;
    // The restart that follows is not an outage.
    camera.offlineSince = Date.now();
    await this.publishStates(camera);
    await this.checkOnline(camera);
    this.requestWidgetRefresh();
  }

  // --- Report --------------------------------------------------------------------

  summary() {
    if (this.server !== 'ok') {
      return { problem: this.server ?? 'unreachable' };
    }
    return {
      url: this.client.label,
      live: this.live,
      socketRefused: !this.live && this.socketError?.kind === 'auth',
      cameras: [...this.cameras.values()].map((camera) => ({
        name: deviceName(camera),
        mode: camera.mode,
        online: camera.online,
        snap: camera.snap,
        detector: camera.detector,
        objects: camera.objects,
      })),
    };
  }
}
