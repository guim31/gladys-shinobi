// The integration end to end, against the SDK's fake Gladys and a simulated
// Shinobi (answers recorded from the Shinobi of 20/10/2026): discovery,
// states, images, live detections and their triggers, offline monitors, a
// server down, the socket lost or refused, the mode, the manifest action.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import jpeg from 'jpeg-js';
import { TRIGGERS, parseDetection, percentOf } from '../src/hub.js';
import { MAX_CAMERA_IMAGE } from '../src/image.js';
import { EVENTS } from './helpers/fakeShinobi.js';
import { DEFAULT_CONFIG, FakeShinobi, createAll, createWorld, settle } from './helpers/world.js';

function idOf(world, monitor, feature) {
  const ids = world.hub.ids({ id: monitor });
  return feature ? ids.feature(feature) : ids.device;
}

const lastState = (world, monitor, feature) => world.fake.lastState(idOf(world, monitor, feature));
const events = (world, key) => world.fake.sceneEvents.filter((event) => event.key === key);
const featureKeys = (device) =>
  device.features.map((feature) => feature.external_id.split(':').pop());

// The detections recorded from Shinobi: motion on the whole image, motion
// in the region "driveway", objects (person, car) sent through its API.
const recorded = EVENTS.filter((event) => event.f === 'detector_trigger');
const [FULL_FRAME_MOTION, OBJECTS, REGION_MOTION] = [
  recorded.find((event) => event.details.matrices[0].tag === 'FULL_FRAME').details,
  recorded.find((event) => event.details.reason === 'object').details,
  recorded.find((event) => event.details.matrices[0].tag === 'driveway').details,
];

async function detect(world, monitor, details) {
  world.server.detect(monitor, details);
  await settle(world);
}

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test('one device per monitor, with what Shinobi detects on it, without the scheduler', async (t) => {
  const world = await createWorld();
  t.after(() => world.app.stop());
  const devices = world.fake.discoveredDevices;
  assert.deepEqual(
    devices.map((device) => [device.name, device.should_poll]),
    [
      ['Front door', false],
      ['Garage', false],
    ],
  );
  // Front door uses an object detector plugin, Garage no detector at all.
  assert.deepEqual(featureKeys(devices[0]), ['image', 'motion', 'object', 'mode']);
  assert.deepEqual(featureKeys(devices[1]), ['image', 'motion', 'mode']);
  const mode = devices[0].features.find((feature) => feature.type === 'select');
  assert.deepEqual(
    mode.supported_options.map((option) => [option.value, option.label]),
    [
      ['start', 'Watch only'],
      ['record', 'Record'],
      ['idle', 'Idle'],
      ['stop', 'Disabled'],
    ],
  );
  assert.deepEqual(world.fake.connectionStatus, { connected: true });
  assert.equal(world.hub.live, true);
  // The socket logged in with the user of the key and follows both monitors.
  const [socket] = world.server.sockets;
  assert.deepEqual([...socket.followed], ['FrontDoor', 'Garage']);
});

test('adding the devices publishes every state, the badge and an image', async (t) => {
  const world = await createWorld();
  t.after(() => world.app.stop());
  await createAll(world);
  assert.equal(lastState(world, 'FrontDoor', 'motion'), 0);
  assert.equal(lastState(world, 'FrontDoor', 'object'), 0);
  assert.equal(lastState(world, 'Garage', 'motion'), 0);
  assert.equal(world.hub.cameras.get('FrontDoor').online, true);
  const mode = world.fake.states.findLast(
    (state) => state.device_feature_external_id === idOf(world, 'Garage', 'mode'),
  );
  assert.equal(mode.text, 'start');
  const transports = Object.fromEntries(
    world.fake.transports.map((entry) => [entry.device_external_id, entry.transport]),
  );
  assert.equal(transports[idOf(world, 'FrontDoor')], 'local');
  // The image goes with the DEVICE external id (the core answers 404 to a feature's).
  const images = new Set(world.fake.cameraImages.map((image) => image.device_external_id));
  assert.ok(images.has(idOf(world, 'FrontDoor')) && images.has(idOf(world, 'Garage')));
  assert.match(world.fake.cameraImages[0].image, /^image\/jpg;base64,\/9j\//);
  assert.ok(world.fake.widgetRefreshes.includes('camera'));
});

test('the container sends the images on its own: no onPoll needed', async (t) => {
  const world = await createWorld({ config: { ...DEFAULT_CONFIG, snapshot_interval: '10' } });
  t.after(() => world.app.stop());
  await createAll(world);
  const before = world.fake.cameraImages.length;
  for (const camera of world.hub.cameras.values()) {
    camera.lastPublishAt -= 10000;
  }
  await world.hub.imageTick();
  assert.equal(world.fake.cameraImages.length, before + 2);
  await world.hub.imageTick();
  assert.equal(world.fake.cameraImages.length, before + 2, 'not before the interval');
});

test('motion (recorded): the state, an image, the trigger once; back to none after the delay', async (t) => {
  const world = await createWorld();
  t.after(() => world.app.stop());
  await createAll(world);
  const before = world.fake.cameraImages.length;
  await detect(world, 'Garage', FULL_FRAME_MOTION);
  await detect(world, 'Garage', FULL_FRAME_MOTION);
  assert.equal(lastState(world, 'Garage', 'motion'), 1);
  assert.equal(world.fake.cameraImages.length, before + 1);
  assert.deepEqual(
    events(world, TRIGGERS.MOTION).map((event) => event.data),
    [{ camera: idOf(world, 'Garage'), camera_name: 'Garage', region: '', score: 6 }],
  );
  // Shinobi never says the motion is over: `motion_reset` seconds later.
  await world.hub.endDetection(world.hub.cameras.get('Garage'), 'motion');
  assert.equal(lastState(world, 'Garage', 'motion'), 0);
  // A detection after the delay is news again.
  for (const [key, at] of world.hub.cameras.get('Garage').seen) {
    world.hub.cameras.get('Garage').seen.set(key, at - 31000);
  }
  await detect(world, 'Garage', FULL_FRAME_MOTION);
  assert.equal(events(world, TRIGGERS.MOTION).length, 2);
});

test('the detection state goes back to none by itself, with the timers on', async (t) => {
  const world = await createWorld();
  t.after(() => world.app.stop());
  await createAll(world);
  world.hub.useTimers = true;
  world.hub.config = { ...world.hub.config, motionResetSeconds: 0.02 };
  await detect(world, 'Garage', FULL_FRAME_MOTION);
  assert.equal(lastState(world, 'Garage', 'motion'), 1);
  await wait(40);
  await settle(world);
  assert.equal(lastState(world, 'Garage', 'motion'), 0);
});

test('motion in a region (recorded) gives the region to the trigger', async (t) => {
  const world = await createWorld();
  t.after(() => world.app.stop());
  await createAll(world);
  await detect(world, 'FrontDoor', REGION_MOTION);
  assert.deepEqual(
    events(world, TRIGGERS.MOTION).map((event) => [event.data.region, event.data.score]),
    [['driveway', 6]],
  );
});

test('objects (recorded): the state, one trigger per label with its confidence', async (t) => {
  const world = await createWorld();
  t.after(() => world.app.stop());
  await createAll(world);
  await detect(world, 'FrontDoor', OBJECTS);
  assert.equal(lastState(world, 'FrontDoor', 'object'), 1);
  assert.equal(lastState(world, 'FrontDoor', 'motion'), 0, 'an object is not motion');
  assert.deepEqual(
    events(world, TRIGGERS.OBJECT).map((event) => event.data),
    [
      { camera: idOf(world, 'FrontDoor'), camera_name: 'Front door', label: 'person', score: 87 },
      { camera: idOf(world, 'FrontDoor'), camera_name: 'Front door', label: 'car', score: 66 },
    ],
  );
  assert.deepEqual(events(world, TRIGGERS.MOTION), []);
});

test('an object seen on a monitor without the flag adds the feature', async (t) => {
  const world = await createWorld();
  t.after(() => world.app.stop());
  await detect(world, 'Garage', OBJECTS);
  await world.hub.refresh();
  const garage = world.fake.discoveredDevices.find((device) => device.name === 'Garage');
  assert.deepEqual(featureKeys(garage), ['image', 'motion', 'object', 'mode']);
});

test('the detections: regions, labels, scores, a detection without matrices', () => {
  assert.deepEqual(parseDetection(FULL_FRAME_MOTION), {
    kind: 'motion',
    hits: [{ region: '', label: '', score: 6 }],
  });
  assert.deepEqual(parseDetection(OBJECTS).hits, [
    { region: '', label: 'person', score: 87 },
    { region: '', label: 'car', score: 66 },
  ]);
  // Sent through the motion API without matrices: the name is the region.
  assert.deepEqual(parseDetection({ reason: 'motion', name: 'gate', confidence: 55 }).hits, [
    { region: 'gate', label: '', score: 55 },
  ]);
  assert.deepEqual(parseDetection({ name: 'multipleRegions' }).hits, [
    { region: '', label: '', score: null },
  ]);
  assert.equal(percentOf(0.912), 91);
  assert.equal(percentOf(250), 100);
  assert.equal(percentOf('x'), null);
});

test('a detection without live events stays unseen: no trigger before adding', async (t) => {
  const world = await createWorld();
  t.after(() => world.app.stop());
  await detect(world, 'Garage', FULL_FRAME_MOTION);
  assert.deepEqual(world.fake.sceneEvents, [], 'a camera not added fires nothing');
});

test('a monitor losing its stream: offline after the delay, the trigger, then back', async (t) => {
  const world = await createWorld();
  t.after(() => world.app.stop());
  await createAll(world);
  world.server.setStatus('Garage', 7, 'Died');
  await settle(world);
  assert.equal(world.hub.cameras.get('Garage').online, false);
  assert.deepEqual(
    events(world, TRIGGERS.OFFLINE).map((event) => event.data),
    [{ camera: idOf(world, 'Garage'), camera_name: 'Garage' }],
  );
  assert.equal(world.fake.transports.at(-1).transport, 'unreachable');
  world.server.setStatus('Garage', 2, 'Watching');
  await settle(world);
  assert.equal(world.hub.cameras.get('Garage').online, true);
  assert.equal(world.fake.transports.at(-1).transport, 'local');
});

test('a restart shorter than the delay is not an outage', async (t) => {
  const world = await createWorld({ timings: { minImageSpacingMs: 0, offlineAfterMs: 60000 } });
  t.after(() => world.app.stop());
  await createAll(world);
  // Recorded: Shinobi restarting a monitor it found not streaming.
  for (const event of EVENTS.filter(
    (item) => item.id === 'FrontDoor' && item.f !== 'detector_trigger',
  )) {
    world.server.emit(event);
  }
  await settle(world);
  assert.equal(world.hub.cameras.get('FrontDoor').online, true);
  assert.deepEqual(events(world, TRIGGERS.OFFLINE), []);
});

test('a monitor disabled in Shinobi is offline without alarm', async (t) => {
  const world = await createWorld();
  t.after(() => world.app.stop());
  await createAll(world);
  world.server.setMode('Garage', 'stop');
  await world.hub.refresh();
  await settle(world);
  assert.equal(world.hub.cameras.get('Garage').online, false);
  assert.deepEqual(events(world, TRIGGERS.OFFLINE), []);
});

test('Shinobi down: one lost answer is not an outage, two are; then back', async (t) => {
  const world = await createWorld();
  t.after(() => world.app.stop());
  await createAll(world);
  world.server.down = true;
  world.server.dropSockets();
  await settle(world);
  assert.equal(world.hub.live, false);
  await world.hub.refresh();
  assert.equal(world.hub.server, 'ok');
  await world.hub.refresh();
  assert.equal(world.hub.server, 'unreachable');
  assert.equal(world.fake.connectionStatus.connected, false);
  assert.equal(events(world, TRIGGERS.OFFLINE).length, 2);
  assert.equal(world.hub.cameras.get('FrontDoor').online, false);
  world.server.down = false;
  await world.hub.refresh();
  await settle(world);
  assert.deepEqual(world.fake.connectionStatus, { connected: true });
  assert.equal(world.hub.cameras.get('FrontDoor').online, true);
  // The socket is open again and follows the monitors: live events flow.
  await wait(20);
  await settle(world);
  assert.equal(world.hub.live, true);
  await detect(world, 'Garage', FULL_FRAME_MOTION);
  assert.equal(events(world, TRIGGERS.MOTION).length, 1);
});

test('the socket lost alone: detections back to none, then opened again', async (t) => {
  const world = await createWorld();
  t.after(() => world.app.stop());
  await createAll(world);
  await detect(world, 'Garage', FULL_FRAME_MOTION);
  world.server.socketDown = true;
  world.server.dropSockets();
  await settle(world);
  assert.equal(world.hub.live, false);
  assert.equal(lastState(world, 'Garage', 'motion'), 0);
  world.server.socketDown = false;
  await wait(20);
  await settle(world);
  assert.equal(world.hub.live, true);
});

test('an older Shinobi (Engine.IO 3): told by its open packet, the client pings', async (t) => {
  const server = new FakeShinobi();
  server.eio = 3;
  const world = await createWorld({ server });
  t.after(() => world.app.stop());
  assert.equal(world.hub.live, true);
  const [socket] = server.sockets;
  assert.ok(!socket.sent.includes('40'), 'the server joins the namespace itself');
  assert.equal(world.hub.socket.eio, 3);
  assert.ok(world.hub.socket.pingTimer, 'Engine.IO 3: the client pings');
  await createAll(world);
  await detect(world, 'Garage', FULL_FRAME_MOTION);
  assert.equal(events(world, TRIGGERS.MOTION).length, 1);
});

test('a key without the socket permission: the states work, the report says why', async (t) => {
  const server = new FakeShinobi();
  server.canSocket = false;
  const world = await createWorld({ server });
  t.after(() => world.app.stop());
  assert.equal(world.hub.server, 'ok');
  assert.equal(world.hub.live, false);
  assert.equal(world.fake.discoveredDevices.length, 2);
  const ack = await world.fake.action('check', {});
  assert.equal(ack.success, true, ack.error);
  assert.match(ack.data.message.en, /Can Authenticate Websocket/);
});

test('a wrong API key or group key: said in the integration status, no device', async (t) => {
  const world = await createWorld({ config: { ...DEFAULT_CONFIG, group_key: 'Other' } });
  t.after(() => world.app.stop());
  assert.equal(world.hub.server, 'auth');
  assert.equal(world.fake.connectionStatus.connected, false);
  assert.match(world.fake.connectionStatus.message.fr, /clé d'API ou la clé de groupe/);
  assert.equal(world.fake.discoveredDevices.length, 0);
});

test('the mode list, the scene action: Shinobi switches the monitor', async (t) => {
  const world = await createWorld();
  t.after(() => world.app.stop());
  await createAll(world);
  const device = world.fake.discoveredDevices.find((item) => item.name === 'Garage');
  const feature = device.features.find((item) => item.type === 'select');
  let ack = await world.fake.setValue(device, feature, 'record');
  assert.equal(ack.success, true, ack.error);
  assert.equal(world.server.monitor('Garage').mode, 'record');
  await settle(world);
  assert.equal(world.hub.cameras.get('Garage').mode, 'record');
  assert.equal(world.hub.cameras.get('Garage').online, true, 'the restart is not an outage');
  ack = await world.fake.sceneAction('set_mode', { camera: device.external_id, mode: 'start' });
  assert.equal(ack.success, true, ack.error);
  assert.equal(world.server.monitor('Garage').mode, 'start');
  // Already in that mode: not an error.
  ack = await world.fake.sceneAction('set_mode', { camera: device.external_id, mode: 'start' });
  assert.equal(ack.success, true, ack.error);
  ack = await world.fake.sceneAction('set_mode', { camera: device.external_id, mode: 'stop' });
  assert.equal(ack.success, false, 'disabling is not a scene action');
});

test('a heavy frame is made smaller in the container, under 150 KB', async (t) => {
  const server = new FakeShinobi();
  // A 1280 × 720 frame of noise: far over 150 KB.
  const width = 1280;
  const height = 720;
  const data = Buffer.alloc(width * height * 4);
  for (let i = 0; i < data.length; i += 1) {
    data[i] = (i * 7919) % 251;
  }
  server.frame = Buffer.from(jpeg.encode({ width, height, data }, 95).data);
  assert.ok(server.frame.length > MAX_CAMERA_IMAGE);
  const world = await createWorld({ server });
  t.after(() => world.app.stop());
  await createAll(world);
  const image = world.fake.cameraImages.at(-1).image;
  assert.ok(image.length <= MAX_CAMERA_IMAGE, `${image.length} characters`);
});

test('the JPEG API off: no image asked (Shinobi would send its placeholder)', async (t) => {
  const server = new FakeShinobi();
  server.monitor('Garage').details.snap = '0';
  const world = await createWorld({ server });
  t.after(() => world.app.stop());
  await createAll(world);
  const images = world.fake.cameraImages.map((image) => image.device_external_id);
  assert.ok(!images.includes(idOf(world, 'Garage')));
  assert.ok(!server.requests.some((path) => path.includes('/jpeg/TestGroup/Garage/')));
  const ack = await world.fake.action('check', {});
  assert.match(ack.data.message.fr, /- Garage: .*API JPEG désactivée/);
});

test('the check action lists the monitors, in four languages', async (t) => {
  const world = await createWorld();
  t.after(() => world.app.stop());
  const ack = await world.fake.action('check', {});
  assert.equal(ack.success, true, ack.error);
  const { message } = ack.data;
  assert.deepEqual(Object.keys(message), ['en', 'fr', 'de', 'es']);
  assert.match(message.en, /Shinobi answers at http:\/\/192\.0\.2\.10:8080: 2 camera\(s\)\. Live/);
  assert.match(message.fr, /- Front door: surveillance, en ligne, objets/);
  assert.match(message.fr, /- Garage: surveillance, en ligne, pas de détecteur de mouvement/);
  // Never the key, in any language.
  for (const text of Object.values(message)) {
    assert.ok(!text.includes(DEFAULT_CONFIG.api_key));
  }
});

test('without a complete configuration: a sentence in the integration status, no request', async (t) => {
  const server = new FakeShinobi();
  const world = await createWorld({ server, config: { url: '192.0.2.10' } });
  t.after(() => world.app.stop());
  assert.equal(world.hub.server, 'noUrl');
  assert.match(world.fake.connectionStatus.message.de, /API-Schlüssel/);
  assert.deepEqual(server.requests, []);
});

test('a new monitor is followed by the socket; Gladys back resends the states', async (t) => {
  const world = await createWorld();
  t.after(() => world.app.stop());
  await createAll(world);
  world.server.monitors.push({
    ...structuredClone(world.server.monitor('Garage')),
    mid: 'Back',
    name: 'Back',
  });
  await world.hub.refresh();
  await settle(world);
  const [socket] = world.server.sockets;
  assert.ok(socket.followed.has('Back'));
  const before = world.fake.states.length;
  await world.hub.resync(world.hub.config);
  assert.ok(world.fake.states.length > before);
});

test('an added camera keeps its object feature when the plugin is gone', async (t) => {
  const first = await createWorld();
  await createAll(first);
  const created = first.fake.devices ?? first.gladys.devices;
  await first.app.stop();
  const server = new FakeShinobi();
  server.monitor('FrontDoor').details.detector_use_detect_object = '0';
  const world = await createWorld({ server, created });
  t.after(() => world.app.stop());
  const front = world.fake.discoveredDevices.find((device) => device.name === 'Front door');
  assert.ok(featureKeys(front).includes('object'));
});
