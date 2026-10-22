// The info level keeps the life of the integration only (start, server or
// camera lost and back, user actions): nothing per detection, per state or
// per image, and a failure tried again and again is one line, then one when
// it ends. Never the API key: it is part of every Shinobi URL.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EVENTS } from './helpers/fakeShinobi.js';
import { DEFAULT_CONFIG, FakeShinobi, createAll, createWorld, settle } from './helpers/world.js';

/** Capture what the SDK logger writes (console.log / console.error) at `info`. */
function captureLogs(t) {
  const lines = [];
  const previous = process.env.LOG_LEVEL;
  process.env.LOG_LEVEL = 'info';
  const keep = (...args) => lines.push(args.join(' '));
  t.mock.method(console, 'log', keep);
  t.mock.method(console, 'error', keep);
  t.mock.method(console, 'warn', keep);
  const restore = () => {
    process.env.LOG_LEVEL = previous;
    t.mock.restoreAll();
  };
  t.after(restore);
  return { lines, restore };
}

const count = (lines, text) => lines.filter((line) => line.includes(text)).length;
const detections = EVENTS.filter((event) => event.f === 'detector_trigger');

test('a normal cycle (detections, images, monitor list) writes nothing at info', async (t) => {
  const world = await createWorld({ config: { ...DEFAULT_CONFIG, snapshot_interval: '10' } });
  t.after(() => world.app.stop());
  await createAll(world);
  const { lines, restore } = captureLogs(t);
  for (let round = 0; round < 3; round += 1) {
    for (const event of detections) {
      world.server.detect(event.id, event.details);
    }
    await settle(world);
    for (const camera of world.hub.cameras.values()) {
      await world.hub.endDetection(camera, 'motion');
      await world.hub.endDetection(camera, 'object');
    }
    await world.hub.refresh();
    await world.hub.imageTick();
  }
  await world.fake.widgetGet('camera', {
    settings: { camera: world.fake.discoveredDevices[0].external_id },
  });
  await settle(world);
  restore();
  assert.deepEqual(lines, []);
});

test('a server down is one line, then one when it is back; never the key', async (t) => {
  const world = await createWorld();
  t.after(() => world.app.stop());
  await createAll(world);
  const { lines, restore } = captureLogs(t);
  process.env.LOG_LEVEL = 'debug';
  world.server.down = true;
  world.server.dropSockets();
  for (let round = 0; round < 5; round += 1) {
    await world.hub.refresh();
    await settle(world);
  }
  world.server.down = false;
  await world.hub.refresh();
  await new Promise((resolve) => setTimeout(resolve, 20));
  await settle(world);
  restore();
  const info = lines.filter((line) => !/debug/i.test(line));
  assert.equal(count(info, 'does not answer'), 1, info.join('\n'));
  assert.equal(count(info, 'answers again'), 1, info.join('\n'));
  assert.equal(count(info, 'live events unavailable'), 1, info.join('\n'));
  assert.equal(count(info, 'live events are back'), 1, info.join('\n'));
  // Not even in debug: the key is in every URL.
  assert.ok(
    lines.every((line) => !line.includes(DEFAULT_CONFIG.api_key)),
    lines.join('\n'),
  );
});

test('a key refused on the socket: one warning, not one per try', async (t) => {
  const server = new FakeShinobi();
  server.canSocket = false;
  const { lines, restore } = captureLogs(t);
  const world = await createWorld({ server });
  t.after(() => world.app.stop());
  await new Promise((resolve) => setTimeout(resolve, 30));
  await settle(world);
  restore();
  assert.equal(count(lines, 'live events unavailable'), 1, lines.join('\n'));
  assert.match(lines.join('\n'), /do not allow authentication with Websocket/);
  assert.ok(lines.every((line) => !line.includes(DEFAULT_CONFIG.api_key)));
});

test('a user action is one line', async (t) => {
  const world = await createWorld();
  t.after(() => world.app.stop());
  await createAll(world);
  const { lines, restore } = captureLogs(t);
  await world.fake.sceneAction('set_mode', {
    camera: world.fake.discoveredDevices[1].external_id,
    mode: 'record',
  });
  await settle(world);
  restore();
  assert.equal(lines.length, 1, lines.join('\n'));
  assert.match(lines[0], /Monitor Garage set to record/);
});
