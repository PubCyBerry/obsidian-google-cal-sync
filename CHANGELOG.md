# Changelog

All notable changes to this plugin are recorded here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow [Semantic Versioning](https://semver.org/). Each version has a matching GitHub release tag that Obsidian installs from.

## [Unreleased]

## [1.1.0] - 2026-09-11

### Added

- The calendar as its own pane: the ribbon calendar icon or the **Open calendar view** command opens it in the right sidebar, and its tab can be dragged into the main area.
- Setting **Hide midnight start times** (on by default). Events that start at 00:00 are drawn without a time, the way Google Calendar shows them.

### Changed

- Calendar colours now match the Google Calendar apps. The API reports the classic palette (for example `#9fe1e7`); the plugin maps it to the modern one (`#039be5`). Custom colours pass through unchanged.
- The calendar list (names, colours, new calendars) is refreshed once an hour during sync and saved only when something changed.
- Events have rounded corners. Multi-day bars stay square on the side where they continue into the previous or next week.
- Day numbers no longer wrap in narrow panes.

## [1.0.4] - 2026-09-11

### Fixed

- Multi-day events were cut at the edge of their first day in reading view. Obsidian clips table cells; the stylesheet now lets the calendar's day cells overflow so the bars span their days.

## [1.0.3] - 2026-09-11

### Fixed

- Multi-day events collapsed to a single cell when the block was drawn or refreshed in a hidden tab. FullCalendar measures column widths when it draws; the block now redraws or re-measures when it becomes visible.

## [1.0.2] - 2026-09-11

### Changed

- The desktop-only loopback server is typed locally so the community directory's lint sees no `any`. No behaviour change.

## [1.0.1] - 2026-09-11

### Changed

- `LICENSE` is plain MIT again so it is recognised; the bundled FullCalendar notice moved to `THIRD_PARTY_NOTICES.md`.
- Date handling uses native helpers (`src/dates.ts`, with unit tests) instead of `moment`, removing the typing warnings raised by the directory's automated review.

## [1.0.0] - 2026-09-11

First release, published under the id `google-cal-sync` after the earlier ids `gcal-sync` and `gcal-block` turned out to be taken or were superseded.

### Added

- `gcal` code block with FullCalendar month, week and day views, every calendar in its Google colour, calendar and task toggles, a status pill, and an offline cache.
- Create, edit, move, resize and delete events. Writes go straight to Google; `If-Match` guards against overwriting a change made elsewhere (412 refreshes the event).
- Incremental sync with Google's sync tokens, a bounded first sync (three months back, six ahead) and automatic full resync on 410.
- Task notes (`type: Task`) in project folders mirrored to a Google Tasks list per project: title, due date and completion in both directions, imports from the Google Tasks app, moves between projects, deletions, and an `obsidian://` back-link in the task notes.
- Desktop loopback OAuth with PKCE and state check; token refresh on every platform; logout with revocation. Mobile reuses the desktop login through vault sync.
- Declarative settings tab, commands (`Log in to Google`, `Log out`, `Sync now`, `Clear cache`), unit tests, and in-app end-to-end scripts against a fake Google backend.

[Unreleased]: https://github.com/PubCyBerry/obsidian-google-cal-sync/compare/1.1.0...HEAD
[1.1.0]: https://github.com/PubCyBerry/obsidian-google-cal-sync/releases/tag/1.1.0
[1.0.4]: https://github.com/PubCyBerry/obsidian-google-cal-sync/releases/tag/1.0.4
[1.0.3]: https://github.com/PubCyBerry/obsidian-google-cal-sync/releases/tag/1.0.3
[1.0.2]: https://github.com/PubCyBerry/obsidian-google-cal-sync/releases/tag/1.0.2
[1.0.1]: https://github.com/PubCyBerry/obsidian-google-cal-sync/releases/tag/1.0.1
[1.0.0]: https://github.com/PubCyBerry/obsidian-google-cal-sync/releases/tag/1.0.0
