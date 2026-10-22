// -----------------------------------------------------------------------------
// Scene actions (manifest `scene_actions`, Gladys 5.1+).
//
// What it adds to "Control a device": a camera put to record (continuous
// recording) or back to watch only by any scene, e.g. record while nobody is
// home, or when the alarm goes off. Disabling a camera stays a choice made in
// the mode list or in Shinobi. The API key needs the permission to control
// monitors.
// -----------------------------------------------------------------------------

export const SCENE_MODES = ['record', 'start'];

async function setMode(hub, { fields }) {
  if (!SCENE_MODES.includes(fields?.mode)) {
    throw new Error(`Unknown mode "${fields?.mode}": record or start`);
  }
  if (!fields?.camera) {
    throw new Error('Choose a camera');
  }
  await hub.setMode(hub.require(fields.camera), fields.mode);
}

export const SCENE_ACTIONS = { set_mode: setMode };
