# Changelog

All notable changes to this integration are documented in this file. The format
follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project
uses [semantic versioning](https://semver.org/).

Describe each change under `## [Unreleased]` as you make it. The Release
workflow moves that section under the version it ships, and the section becomes
the notes of the version's GitHub Release.

## [Unreleased]

### Added

- Shinobi servers, reached at the address of the configuration (port 8080 by
  default) with an API key and the group key of the account.
- One Gladys camera per Shinobi monitor: its image, read from the monitor's
  JPEG API at the chosen pace and at once on a detection, made smaller in the
  container when too heavy for Gladys; "Motion" (Shinobi's built-in detector)
  and "Object detected" (object detection plugins), back to none after a
  chosen delay without a new detection; "Mode", a list (watch only, record,
  idle, disabled) the dashboard can change; "Online" (read only).
- Live detections and monitor status through Shinobi's Socket.IO, reopened
  after a loss; the monitor list read every minute.
- Monitors whose stream is lost show as unreachable in Gladys.
- Scene triggers "Shinobi: motion detected" (camera and region filters; region
  and confidence as variables), "Shinobi: object detected" (camera and label
  filters; label and confidence as variables) and "Shinobi: camera offline";
  scene action "Shinobi: record or watch only"; dashboard widget "Shinobi
  camera"; action "Check the connection".
