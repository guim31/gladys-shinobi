# Shinobi for Gladys Assistant

A [Gladys Assistant](https://gladysassistant.com) integration for
[Shinobi](https://shinobi.video/), the self-hosted network video recorder. It
brings each Shinobi monitor into Gladys as a camera with its image, the motion
Shinobi detects, the objects seen by an object detection plugin, its mode (watch
only, record, disabled) and whether it is online, with scene triggers fed by
Shinobi's live detections, a scene action and a dashboard widget. Everything
stays on the local network: no cloud.

Developed without the hardware: feedback welcome. Tested against a real Shinobi
server in Docker with a simulated camera, not yet on an installation in service
with real cameras: tell us how it goes in the
[issues](https://github.com/guim31/gladys-shinobi/issues).

## Features

- **One Gladys camera per Shinobi monitor**, named as in Shinobi:
  - **Image**, read from the monitor's JPEG API at the chosen pace (10 s to
    15 min) and at once on a detection, made smaller in the container when it
    is over what Gladys keeps (150 KB);
  - **Motion** (Shinobi's built-in motion detector) and **Object detected**
    (object detection plugins: Tensorflow, YOLO, DeepStack…), back to 0 after a
    chosen delay without a new detection, since Shinobi never sends the end of
    one;
  - **Mode**, a list: watch only, record, idle, disabled;
  - **Online**: the monitor runs and its stream comes in (read only).
- **Scene triggers**: "Shinobi: motion detected" (camera and region filters,
  confidence), "Shinobi: object detected" (camera and label filters,
  confidence), "Shinobi: camera offline". The image of the moment is sent to
  Gladys before the scene starts.
- **Scene action**: "Shinobi: record or watch only".
- **Dashboard widget** "Shinobi camera": image, motion, objects, mode, online,
  and buttons to record (or go back to watch only) and refresh the image.
- **Check the connection**: what the integration reads, and what is missing
  (JPEG API off, no detector, no socket permission).
- Texts and documentation in English, French, German and Spanish.

## Requirements

- Gladys 5.1 or later.
- Shinobi reachable from Gladys (port 8080 by default); an up-to-date Shinobi
  for the live detections.
- Per monitor: the JPEG API on (images), the detector on (motion), an object
  detection plugin (objects).
- An API key of the Shinobi account with the permissions to see and control
  monitors, see snapshots and "Can Authenticate Websocket", and the group key.

## Installation

In Gladys, **Integrations → Install from GitHub**, with the address of this
repository: `https://github.com/guim31/gladys-shinobi`. Then fill in the
configuration (Shinobi address, API key, group key) and open the Discovery tab.
The full guide: [English](docs/en.md), [français](docs/fr.md),
[Deutsch](docs/de.md), [español](docs/es.md).

## How it works

- **REST**, every minute and after a status change: `GET
<key>/monitor/<group>` (names, mode, status code, JPEG API, detector,
  object detection); `GET <key>/jpeg/<group>/<monitor>/s.jpg` (images);
  `GET <key>/monitor/<group>/<monitor>/<mode>` (mode); `GET
<key>/userInfo/<group>` (the user of the key, for the socket login). Shinobi
  answers a refused key with HTTP 200 and `{ ok: false }`.
- **Socket.IO**, live, spoken over a plain WebSocket (Engine.IO 4, Engine.IO 3
  on the next try for an older Shinobi): `init` with the key, the group key and
  the user id, then `detector_on` per monitor; `detector_trigger` (motion with
  its regions, objects with their labels) and `monitor_status` come in.
  Reopened after a loss.
- Shinobi sends each detection, never its end: the states go back to 0 after
  `motion_reset` seconds, and a trigger fires again for a region or a label not
  seen during that time.
- Nothing is stored under `/data`. Devices are published with
  `should_poll: false`: the container runs its own timers.

## Checked, and what was not

- In Docker, against the official Shinobi image
  (`registry.gitlab.com/shinobi-systems/shinobi:dev`, code of 20/10/2026, with
  its MariaDB), a camera served by `mediamtx` from an `ffmpeg` test pattern
  with a square moving 6 s out of 40, Shinobi's built-in motion detector with a
  region; the integration running in its own image under the Gladys sandbox
  limits (`--cap-drop ALL`, read-only, 256 MB, 18 MB at rest, under 150 MB
  while shrinking a 1080p frame): discovery, states, images, a real motion
  trigger with its region, the mode changed from the list and the scene action,
  the widget, "Check the connection", a wrong group key, a key without the
  socket and control permissions, Shinobi stopped then started again (offline
  triggers, then back). The test fixtures are answers recorded there.
- Not checked: real cameras and long-running use, a real object detection
  plugin (the object detections were sent through Shinobi's own
  `motion` API, which gives the same `detector_trigger`), an older Shinobi
  (Engine.IO 3, no `detector_on`), Shinobi behind a reverse proxy, the
  multi-server (child node) setups.

## Limits

- No live video: Gladys shows images (12 a minute per camera at most).
- Regions and labels are filtered as written in Shinobi.
- Past recordings, events history, PTZ and timelapses are not covered.
- One Shinobi group (one group key) per integration.

## Development

```bash
npm ci
npm test
npm run lint
npm run format:check
npx github:GladysAssistant/integration-store .
```

See [CLAUDE.md](CLAUDE.md) for the architecture and the rules of the code.

## Credits

- [Shinobi](https://gitlab.com/Shinobi-Systems/Shinobi) (by Shinobi Systems,
  Moe Alam): its web server and Socket.IO code were read to use the API; no
  code is copied.
- [ha-shinobi](https://github.com/elad-bar/ha-shinobi) (by Elad Bar), the Home
  Assistant integration: read for how it follows Shinobi's socket.
- The JPEG shrinking (`src/image.js`, `src/image-worker.js`,
  `src/jpeg-scaled.js`) comes from guim31/gladys-ezviz and
  guim31/gladys-unifi-protect; it uses [jpeg-js](https://github.com/jpeg-js/jpeg-js)
  (BSD-3-Clause).
- Logo of the cover: the Shinobi logo from its official repository
  (`web/libs/img/icon/circle-text.png`).

This integration is not affiliated with Shinobi Systems.

## License

[Apache 2.0](LICENSE)
