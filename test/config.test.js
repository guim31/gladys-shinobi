import { test } from 'node:test';
import assert from 'node:assert/strict';
import { connectionKey, normalizeConfig } from '../src/config.js';
import { parseServerUrl } from '../src/shinobi/client.js';

test('the defaults: incomplete, an image a minute, 30 s for a detection, French names', () => {
  const config = normalizeConfig({});
  assert.deepEqual(config, {
    url: '',
    validUrl: false,
    apiKey: '',
    groupKey: '',
    complete: false,
    snapshotSeconds: 60,
    motionResetSeconds: 30,
    language: 'fr',
  });
});

test('values outside the lists fall back to the defaults; blanks are trimmed', () => {
  const config = normalizeConfig({
    url: ' 192.0.2.10 ',
    api_key: ' key ',
    group_key: ' group ',
    snapshot_interval: 'often',
    motion_reset: '7',
    language: 'it',
  });
  assert.equal(config.url, '192.0.2.10');
  assert.equal(config.complete, true);
  assert.deepEqual([config.apiKey, config.groupKey], ['key', 'group']);
  assert.equal(config.snapshotSeconds, 60);
  assert.equal(config.motionResetSeconds, 30);
  assert.equal(config.language, 'fr');
  assert.equal(normalizeConfig({ snapshot_interval: '10' }).snapshotSeconds, 10);
  assert.equal(normalizeConfig({ motion_reset: '120' }).motionResetSeconds, 120);
  assert.equal(normalizeConfig({ url: '192.0.2.10', group_key: 'g' }).complete, false);
});

test('a new key is a new connection, a new interval is not', () => {
  const base = normalizeConfig({ url: '192.0.2.10', api_key: 'a', group_key: 'g' });
  assert.notEqual(connectionKey(base), connectionKey({ ...base, apiKey: 'b' }));
  assert.notEqual(connectionKey(base), connectionKey({ ...base, groupKey: 'h' }));
  assert.equal(connectionKey(base), connectionKey({ ...base, snapshotSeconds: 10 }));
});

test('the address: port 8080 by default, a path kept, no credentials', () => {
  assert.deepEqual(parseServerUrl('192.0.2.10'), {
    origin: 'http://192.0.2.10:8080',
    basePath: '',
  });
  assert.deepEqual(parseServerUrl('https://nvr.example/shinobi/'), {
    origin: 'https://nvr.example',
    basePath: '/shinobi',
  });
  assert.equal(parseServerUrl('http://user:pass@192.0.2.10'), null);
  assert.equal(parseServerUrl('ftp://192.0.2.10'), null);
  assert.equal(parseServerUrl(''), null);
});
