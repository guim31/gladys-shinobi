// -----------------------------------------------------------------------------
// Dashboard widget (manifest `widgets`, Gladys 5.1+): `camera`.
//
// The Gladys camera box shows the image only. This widget adds what Shinobi
// knows: motion, the objects seen (by label), the mode, online, and buttons
// to record or go back to watch only, and to bring a new image.
//
// Budget (8 components, 2 texts, 4 buttons): a caption, the image, one status
// list, two buttons.
// -----------------------------------------------------------------------------

import { createHash } from 'node:crypto';
import { WIDGET_COLORS } from '@gladysassistant/integration-sdk';
import { deviceName, modeLabel, namesFor } from './devices.js';
import { WIDGET_KEY } from './hub.js';

// Numbered: the core drops a button whose action key is already taken.
export const ACTIONS = {
  RECORD: 'record_1',
  WATCH: 'watch_1',
  REFRESH: 'refresh_1',
};
// How long `get` waits for a first image before showing the caption alone.
const FIRST_IMAGE_WAIT_MS = 8000;
// A status value holds 40 characters at most.
const MAX_VALUE = 40;

export const TEXT = {
  pick: {
    en: 'Choose a camera in the settings of this widget.',
    fr: 'Choisissez une caméra dans les réglages de ce widget.',
    de: 'Wähle in den Einstellungen dieses Widgets eine Kamera aus.',
    es: 'Elija una cámara en la configuración de este widget.',
  },
  unknown: {
    en: 'This camera is no longer in Shinobi, or Shinobi does not answer.',
    fr: 'Cette caméra n’est plus dans Shinobi, ou Shinobi ne répond pas.',
    de: 'Diese Kamera ist nicht mehr in Shinobi, oder Shinobi antwortet nicht.',
    es: 'Esta cámara ya no está en Shinobi, o Shinobi no responde.',
  },
  imageAt: { en: 'Image', fr: 'Image', de: 'Bild', es: 'Imagen' },
  noImage: {
    en: 'No image yet',
    fr: 'Pas encore d’image',
    de: 'Noch kein Bild',
    es: 'Aún no hay imagen',
  },
  offline: { en: 'offline', fr: 'hors ligne', de: 'offline', es: 'sin conexión' },
  noSnap: {
    en: 'JPEG API off in Shinobi',
    fr: 'API JPEG désactivée dans Shinobi',
    de: 'JPEG-API in Shinobi aus',
    es: 'API JPEG desactivada en Shinobi',
  },
  objects: { en: 'Objects', fr: 'Objets', de: 'Objekte', es: 'Objetos' },
  yes: { en: 'Yes', fr: 'Oui', de: 'Ja', es: 'Sí' },
  no: { en: 'No', fr: 'Non', de: 'Nein', es: 'No' },
  detected: { en: 'Detected', fr: 'Détecté', de: 'Erkannt', es: 'Detectado' },
  none: { en: 'None', fr: 'Aucun', de: 'Keine', es: 'Ninguno' },
  record: { en: 'Record', fr: 'Enregistrer', de: 'Aufnehmen', es: 'Grabar' },
  watch: {
    en: 'Watch only',
    fr: 'Surveillance seule',
    de: 'Nur überwachen',
    es: 'Solo vigilancia',
  },
  refresh: { en: 'New image', fr: 'Nouvelle image', de: 'Neues Bild', es: 'Nueva imagen' },
  recordingStarted: {
    en: 'Recording started',
    fr: 'Enregistrement démarré',
    de: 'Aufnahme gestartet',
    es: 'Grabación iniciada',
  },
  watching: {
    en: 'Back to watch only',
    fr: 'Retour à la surveillance seule',
    de: 'Zurück zu nur überwachen',
    es: 'De vuelta a solo vigilancia',
  },
  refused: {
    en: 'Shinobi refuses: the API key needs the permission to control monitors.',
    fr: 'Shinobi refuse : la clé d’API doit avoir la permission de contrôler les caméras.',
    de: 'Shinobi lehnt ab: Der API-Schlüssel braucht die Berechtigung, Kameras zu steuern.',
    es: 'Shinobi lo rechaza: la clave de API necesita el permiso para controlar las cámaras.',
  },
};

const t = (text, language) => text[language] ?? text.en;

// Image keys are `[a-z0-9-]`: a monitor identifier (`FrontDoor`) is not.
const tagOf = (camera) => createHash('sha1').update(String(camera.id)).digest('hex').slice(0, 12);

export const imageKey = (camera) => `cam-${tagOf(camera)}-${camera.imageSeq.toString(36)}`;

function message(text, language) {
  return {
    ttl_seconds: 60,
    components: [{ type: 'text', variant: 'body', text: t(text, language) }],
  };
}

function timeOf(at, language) {
  return new Intl.DateTimeFormat(language, {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).format(new Date(at));
}

const button = (label, icon, key) => ({
  type: 'button',
  label,
  icon,
  style: 'secondary',
  action: { key },
});

/** The objects seen a moment ago, by label ("person, car"), or null. */
function objectsSeen(camera, language) {
  if (!camera.object) {
    return null;
  }
  const text = camera.lastLabels.join(', ');
  if (!text) {
    return t(TEXT.detected, language);
  }
  return text.length > MAX_VALUE ? `${text.slice(0, MAX_VALUE - 1)}…` : text;
}

async function get(hub, { settings, language = 'en' }) {
  const camera = settings?.camera ? hub.resolveDevice(settings.camera) : null;
  if (!camera) {
    return message(settings?.camera ? TEXT.unknown : TEXT.pick, language);
  }
  if (!camera.image && camera.online && camera.snap && hub.client && hub.server === 'ok') {
    // The first look at this camera: wait a little for an image.
    await Promise.race([
      hub.grab(camera).catch(() => {}),
      new Promise((resolve) => setTimeout(resolve, FIRST_IMAGE_WAIT_MS).unref?.()),
    ]);
  }
  const names = namesFor(language);
  const caption = [
    camera.image
      ? `${t(TEXT.imageAt, language)} ${timeOf(camera.image.at, language)}`
      : t(TEXT.noImage, language),
  ];
  if (!camera.snap) {
    caption.push(t(TEXT.noSnap, language));
  } else if (camera.online === false && camera.mode !== 'stop' && camera.mode !== 'idle') {
    caption.push(t(TEXT.offline, language));
  }
  const components = [{ type: 'text', variant: 'caption', text: caption.join(' · ') }];
  if (camera.image) {
    components.push({
      type: 'image',
      key: imageKey(camera),
      alt: deviceName(camera),
      fit: 'contain',
    });
  }
  const items = [];
  items.push({
    label: names.motion,
    icon: 'activity',
    value: t(camera.motion ? TEXT.detected : TEXT.none, language),
    color: camera.motion ? WIDGET_COLORS.WARNING : WIDGET_COLORS.NEUTRAL,
  });
  if (camera.objects) {
    const objects = objectsSeen(camera, language);
    items.push({
      label: t(TEXT.objects, language),
      icon: 'eye',
      value: objects ?? t(TEXT.none, language),
      color: objects ? WIDGET_COLORS.DANGER : WIDGET_COLORS.NEUTRAL,
    });
  }
  items.push({
    label: names.mode,
    icon: 'video',
    value: camera.mode ? modeLabel(camera.mode, language) : '-',
    color:
      camera.mode === 'record'
        ? WIDGET_COLORS.DANGER
        : camera.mode === 'start'
          ? WIDGET_COLORS.SUCCESS
          : WIDGET_COLORS.NEUTRAL,
  });
  items.push({
    label: names.online,
    icon: 'wifi',
    value: camera.online === null ? '-' : t(camera.online ? TEXT.yes : TEXT.no, language),
    color: camera.online === false ? WIDGET_COLORS.WARNING : WIDGET_COLORS.SUCCESS,
  });
  components.push({ type: 'status', items });
  if (camera.mode === 'record') {
    components.push(button(t(TEXT.watch, language), 'eye', ACTIONS.WATCH));
  } else if (camera.mode === 'start') {
    components.push(button(t(TEXT.record, language), 'circle', ACTIONS.RECORD));
  }
  if (camera.online) {
    components.push(button(t(TEXT.refresh, language), 'refresh-cw', ACTIONS.REFRESH));
  }
  return {
    ttl_seconds: Math.min(Math.max(hub.config.snapshotSeconds, 10), 300),
    components,
  };
}

async function action(hub, { actionKey, settings }) {
  if (!settings?.camera) {
    throw new Error(TEXT.pick.en);
  }
  const camera = hub.require(settings.camera);
  switch (actionKey) {
    case ACTIONS.REFRESH:
      await hub.grab(camera);
      return {};
    case ACTIONS.RECORD:
    case ACTIONS.WATCH: {
      const record = actionKey === ACTIONS.RECORD;
      try {
        await hub.setMode(camera, record ? 'record' : 'start');
      } catch (err) {
        if (err.kind === 'refused' || err.kind === 'auth') {
          return { message: TEXT.refused };
        }
        throw err;
      }
      return { message: record ? TEXT.recordingStarted : TEXT.watching };
    }
    default:
      throw new Error(`Unknown action ${actionKey}`);
  }
}

/** The bytes behind an image key of the widget (raw base64). */
export async function widgetImage(hub, key) {
  const match = /^cam-([0-9a-f]{12})-[0-9a-z]+$/.exec(String(key));
  const camera = match ? [...hub.cameras.values()].find((item) => tagOf(item) === match[1]) : null;
  if (!camera?.image) {
    throw new Error(`Unknown image ${key}`);
  }
  // Already fit for Gladys (150 KB), well under the 300 KB of a widget image.
  return camera.image.jpeg.toString('base64');
}

export const WIDGETS = {
  [WIDGET_KEY]: { get, action },
};
