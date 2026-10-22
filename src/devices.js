// -----------------------------------------------------------------------------
// What Shinobi becomes in Gladys: one camera device per Shinobi monitor, with
//   - its image (`camera/image`), pushed by the integration;
//   - `motion`: Shinobi's built-in motion detector saw motion a moment ago
//     (`motion-sensor/binary`): Shinobi sends a detection, never its end, so
//     the state goes back to 0 after `motion_reset` seconds without one;
//   - `object`: an object detector plugin saw an object a moment ago
//     (`motion-sensor/binary`, same reset), when the monitor uses one;
//   - `mode`: the mode of the monitor (`text/select`: `start` watch only,
//     `record`, `idle`, `stop`), which the dashboard can change: a deliberate
//     choice in a list, never a toggle a voice assistant flips;
//   - `online`: the monitor runs and its stream comes in (`camera/enabled`,
//     read only).
//
// Feature keys are forever: they are part of the external ids.
// -----------------------------------------------------------------------------

import { MODES } from './shinobi/client.js';

export const DEVICE_TYPE = 'camera';

export const FEATURE_KEYS = {
  IMAGE: 'image',
  MOTION: 'motion',
  OBJECT: 'object',
  MODE: 'mode',
  ONLINE: 'online',
};

// Feature names, frozen when the user adds the device.
export const NAMES = {
  en: {
    image: 'Image',
    motion: 'Motion',
    object: 'Object detected',
    mode: 'Mode',
    online: 'Online',
  },
  fr: {
    image: 'Image',
    motion: 'Mouvement',
    object: 'Objet détecté',
    mode: 'Mode',
    online: 'En ligne',
  },
  de: {
    image: 'Bild',
    motion: 'Bewegung',
    object: 'Objekt erkannt',
    mode: 'Modus',
    online: 'Online',
  },
  es: {
    image: 'Imagen',
    motion: 'Movimiento',
    object: 'Objeto detectado',
    mode: 'Modo',
    online: 'En línea',
  },
};

// The modes as the Shinobi interface names them, in each language.
export const MODE_LABELS = {
  start: { en: 'Watch only', fr: 'Surveillance', de: 'Nur überwachen', es: 'Solo vigilancia' },
  record: { en: 'Record', fr: 'Enregistrement', de: 'Aufnahme', es: 'Grabación' },
  idle: { en: 'Idle', fr: 'En veille', de: 'Leerlauf', es: 'En reposo' },
  stop: { en: 'Disabled', fr: 'Désactivée', de: 'Deaktiviert', es: 'Desactivada' },
};

export const namesFor = (language) => NAMES[language] ?? NAMES.en;

export const modeLabel = (mode, language) =>
  MODE_LABELS[mode]?.[language] ?? MODE_LABELS[mode]?.en ?? String(mode);

/** The ids of one camera: its Shinobi monitor id, unique in the group. */
export function deviceIds(gladys, monitorId) {
  return gladys.externalIds(DEVICE_TYPE, String(monitorId));
}

/** The feature key behind a feature external id (`…:mode`). */
export function featureKeyOf(externalId) {
  return (
    String(externalId ?? '')
      .split(':')
      .pop() || null
  );
}

const binary = (key, category, type, name) => ({
  key,
  category,
  type,
  name,
  min: 0,
  max: 1,
  read_only: true,
  has_feedback: true,
  keep_history: true,
});

/** The features of a monitor: `{ objects: bool }` says whether it detects objects. */
export function featureSpecs(monitor, language) {
  const names = namesFor(language);
  const specs = [
    {
      key: FEATURE_KEYS.IMAGE,
      category: 'camera',
      type: 'image',
      name: names.image,
      min: 0,
      max: 0,
      read_only: true,
      has_feedback: false,
      keep_history: false,
    },
    binary(FEATURE_KEYS.MOTION, 'motion-sensor', 'binary', names.motion),
  ];
  if (monitor.objects) {
    specs.push(binary(FEATURE_KEYS.OBJECT, 'motion-sensor', 'binary', names.object));
  }
  specs.push({
    key: FEATURE_KEYS.MODE,
    category: 'text',
    type: 'select',
    name: names.mode,
    min: 0,
    max: 0,
    read_only: false,
    has_feedback: true,
    keep_history: true,
    supported_options: MODES.map((value, index) => ({
      value,
      label: modeLabel(value, language),
      sort_order: index,
    })),
  });
  specs.push(binary(FEATURE_KEYS.ONLINE, 'camera', 'enabled', names.online));
  return specs;
}

/** The monitor name in Shinobi, or its identifier. */
export function deviceName(monitor) {
  const name = String(monitor.name ?? '').trim();
  return (name || String(monitor.id)).slice(0, 80);
}

export function buildDevice(gladys, monitor, language) {
  const ids = deviceIds(gladys, monitor.id);
  return {
    name: deviceName(monitor),
    external_id: ids.device,
    model: 'Shinobi',
    // Live events come through Socket.IO and the monitor list is read by the
    // container: the Gladys scheduler has no use here.
    should_poll: false,
    params: [{ name: 'SHINOBI_MONITOR', value: String(monitor.id) }],
    features: featureSpecs(monitor, language).map(({ key, ...spec }) => ({
      ...spec,
      external_id: ids.feature(key),
    })),
  };
}

export { MODES };
