// The `camera` widget: content inside the core's vocabulary and budget, the
// image served, the record, watch and refresh buttons.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateWidgetContent, validateWidgetImage } from '@gladysassistant/integration-sdk';
import { ACTIONS } from '../src/widgets.js';
import { EVENTS } from './helpers/fakeShinobi.js';
import { createAll, createWorld, settle } from './helpers/world.js';

const get = (world, camera, language = 'en') =>
  world.fake.widgetGet('camera', { settings: { camera }, language });
const cameraId = (world, name) =>
  world.fake.discoveredDevices.find((device) => device.name === name).external_id;
const press = (world, name, key) =>
  world.fake.widgetAction('camera', key, {}, { settings: { camera: cameraId(world, name) } });
const objects = EVENTS.find((event) => event.details?.reason === 'object');

test('the widget shows the image, motion, objects, mode, online and two buttons', async (t) => {
  const world = await createWorld();
  t.after(() => world.app.stop());
  await createAll(world);
  world.server.detect('FrontDoor', objects.details);
  await settle(world);
  for (const language of ['en', 'fr', 'de', 'es']) {
    const ack = await get(world, cameraId(world, 'Front door'), language);
    assert.equal(ack.success, true, ack.error);
    const { content } = ack.data;
    assert.deepEqual(validateWidgetContent(content), [], language);
    assert.deepEqual(
      content.components.map((component) => component.type),
      ['text', 'image', 'status', 'button', 'button'],
    );
    assert.deepEqual(
      content.components.slice(3).map((button) => button.action.key),
      [ACTIONS.RECORD, ACTIONS.REFRESH],
    );
    if (language === 'fr') {
      assert.deepEqual(
        content.components[2].items.map((item) => [item.label, item.value]),
        [
          ['Mouvement', 'Aucun'],
          ['Objets', 'person, car'],
          ['Mode', 'Surveillance'],
          ['En ligne', 'Oui'],
        ],
      );
    }
    const image = await world.fake.widgetGetImage(content.components[1].key);
    assert.equal(image.success, true, image.error);
    assert.deepEqual(validateWidgetImage(image.data.image), []);
  }
});

test('the buttons record, go back to watch only and bring a new image', async (t) => {
  const world = await createWorld();
  t.after(() => world.app.stop());
  await createAll(world);
  let ack = await press(world, 'Garage', ACTIONS.RECORD);
  assert.equal(ack.success, true, ack.error);
  assert.match(ack.data.message.fr, /Enregistrement démarré/);
  assert.equal(world.server.monitor('Garage').mode, 'record');
  await settle(world);
  const content = (await get(world, cameraId(world, 'Garage'))).data.content;
  assert.equal(content.components.find((c) => c.type === 'button').action.key, ACTIONS.WATCH);
  ack = await press(world, 'Garage', ACTIONS.WATCH);
  assert.match(ack.data.message.de, /Zurück zu nur überwachen/);
  assert.equal(world.server.monitor('Garage').mode, 'start');
  const before = world.hub.cameras.get('Garage').imageSeq;
  ack = await press(world, 'Garage', ACTIONS.REFRESH);
  assert.equal(ack.success, true, ack.error);
  assert.equal(world.hub.cameras.get('Garage').imageSeq, before + 1);
});

test('a key without the control permission: a sentence, not a crash', async (t) => {
  const world = await createWorld();
  t.after(() => world.app.stop());
  await createAll(world);
  world.server.canControl = false;
  const ack = await press(world, 'Garage', ACTIONS.RECORD);
  assert.equal(ack.success, true, ack.error);
  assert.match(ack.data.message.en, /permission to control monitors/);
});

test('without a camera, or with one Shinobi no longer has: a sentence', async (t) => {
  const world = await createWorld();
  t.after(() => world.app.stop());
  let ack = await world.fake.widgetGet('camera', { settings: {}, language: 'de' });
  assert.match(ack.data.content.components[0].text, /Wähle/);
  ack = await get(world, 'ext:x:camera:nope');
  assert.match(ack.data.content.components[0].text, /no longer in Shinobi/);
});
