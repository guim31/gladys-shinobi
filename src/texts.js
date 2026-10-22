// -----------------------------------------------------------------------------
// Texts the integration sends to Gladys outside the widget (src/widgets.js):
// connection status and the "Check the connection" report. Four languages,
// the four of the Gladys interface; German says "du", Spanish "usted".
// test/i18n.test.js checks every table.
// -----------------------------------------------------------------------------

import { modeLabel } from './devices.js';

export const INIT_FAILED = {
  en: 'Initialization failed, check the integration logs.',
  fr: "L'initialisation a échoué, consultez les logs de l'intégration.",
  de: 'Initialisierung fehlgeschlagen, sieh dir die Protokolle der Integration an.',
  es: 'La inicialización ha fallado, consulte los registros de la integración.',
};

// Shown by Gladys under the integration name when it is not connected.
export const CONNECTION_TEXT = {
  noUrl: {
    en: 'Enter the address of Shinobi (port 8080 by default), an API key and the group key in the configuration.',
    fr: "Saisissez l'adresse de Shinobi (port 8080 par défaut), une clé d'API et la clé de groupe dans la configuration.",
    de: 'Gib die Adresse von Shinobi (standardmäßig Port 8080), einen API-Schlüssel und den Gruppenschlüssel in der Konfiguration ein.',
    es: 'Introduzca la dirección de Shinobi (puerto 8080 por defecto), una clave de API y la clave de grupo en la configuración.',
  },
  auth: {
    en: 'Shinobi refuses the API key or the group key.',
    fr: "Shinobi refuse la clé d'API ou la clé de groupe.",
    de: 'Shinobi lehnt den API-Schlüssel oder den Gruppenschlüssel ab.',
    es: 'Shinobi rechaza la clave de API o la clave de grupo.',
  },
  unreachable: {
    en: 'Shinobi does not answer at this address.',
    fr: 'Shinobi ne répond pas à cette adresse.',
    de: 'Shinobi antwortet unter dieser Adresse nicht.',
    es: 'Shinobi no responde en esta dirección.',
  },
  error: {
    en: 'Something answers, but not like Shinobi: check the address and port, and the logs.',
    fr: "Quelque chose répond, mais pas comme Shinobi : vérifiez l'adresse, le port et les logs.",
    de: 'Etwas antwortet, aber nicht wie Shinobi: Prüfe Adresse, Port und die Protokolle.',
    es: 'Algo responde, pero no como Shinobi: compruebe la dirección, el puerto y los registros.',
  },
};

const MAX_LISTED = 10;

// The pieces of the "Check the connection" report, one table per language.
export const CHECK_TEXT = {
  en: {
    connected: (url, count) => `Shinobi answers at ${url}: ${count} camera(s).`,
    live: 'Live detections received.',
    notLive: 'No live detections (socket closed): states every minute only.',
    socketRefused:
      'No live detections: give the API key the permission "Can Authenticate Websocket".',
    online: 'online',
    offline: 'offline',
    noSnap: 'JPEG API off: no image',
    noDetector: 'no motion detector',
    objects: 'objects',
  },
  fr: {
    connected: (url, count) => `Shinobi répond à ${url} : ${count} caméra(s).`,
    live: 'Détections en direct reçues.',
    notLive: 'Pas de détections en direct (socket fermé) : états chaque minute seulement.',
    socketRefused:
      'Pas de détections en direct : donnez à la clé d’API la permission « Can Authenticate Websocket ».',
    online: 'en ligne',
    offline: 'hors ligne',
    noSnap: 'API JPEG désactivée : pas d’image',
    noDetector: 'pas de détecteur de mouvement',
    objects: 'objets',
  },
  de: {
    connected: (url, count) => `Shinobi antwortet unter ${url}: ${count} Kamera(s).`,
    live: 'Live-Erkennungen werden empfangen.',
    notLive: 'Keine Live-Erkennungen (Socket geschlossen): Zustände nur jede Minute.',
    socketRefused:
      'Keine Live-Erkennungen: Gib dem API-Schlüssel die Berechtigung „Can Authenticate Websocket“.',
    online: 'online',
    offline: 'offline',
    noSnap: 'JPEG-API aus: kein Bild',
    noDetector: 'kein Bewegungsmelder',
    objects: 'Objekte',
  },
  es: {
    connected: (url, count) => `Shinobi responde en ${url}: ${count} cámara(s).`,
    live: 'Se reciben detecciones en directo.',
    notLive: 'Sin detecciones en directo (socket cerrado): estados solo cada minuto.',
    socketRefused:
      'Sin detecciones en directo: dé a la clave de API el permiso «Can Authenticate Websocket».',
    online: 'en línea',
    offline: 'sin conexión',
    noSnap: 'API JPEG desactivada: sin imagen',
    noDetector: 'sin detector de movimiento',
    objects: 'objetos',
  },
};

/** The report of the "Check the connection" action, in the four languages. */
export function checkMessage(summary) {
  if (summary.problem) {
    return CONNECTION_TEXT[summary.problem];
  }
  const message = {};
  for (const [language, text] of Object.entries(CHECK_TEXT)) {
    const lines = [
      `${text.connected(summary.url, summary.cameras.length)} ${
        summary.live ? text.live : summary.socketRefused ? text.socketRefused : text.notLive
      }`,
    ];
    for (const camera of summary.cameras.slice(0, MAX_LISTED)) {
      const flags = [
        camera.mode ? modeLabel(camera.mode, language).toLowerCase() : null,
        camera.online === true ? text.online : camera.online === false ? text.offline : null,
        camera.snap ? null : text.noSnap,
        camera.detector ? null : text.noDetector,
        camera.objects ? text.objects : null,
      ].filter(Boolean);
      lines.push(flags.length > 0 ? `- ${camera.name}: ${flags.join(', ')}` : `- ${camera.name}`);
    }
    if (summary.cameras.length > MAX_LISTED) {
      lines.push('…');
    }
    message[language] = lines.join('\n');
  }
  return message;
}
