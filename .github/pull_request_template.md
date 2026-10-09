<!--
The title becomes the squash commit and the changelog line, so it must be a Conventional Commit
(feat:, fix:, docs:, chore:, …). CI checks it.
-->

Closes #

## Why

<!-- The problem, as a user meets it. -->

## What changes

<!--
What the plugin does differently, and anything a user has to do.
Call out any change to data.json keys, local storage keys, the `api` object or the `.gcal` class:
notes and other plugins read them.
-->

## Testing

- [ ] `npm run build`
- [ ] `npm run lint`
- [ ] `npm test`
- [ ] `tests/e2e/e2e.js` in a development vault, for changes to sync, tasks, events or the UI
- [ ] README, `docs/architecture.md` and `tests/e2e/README.md` match the new behaviour

<!-- List what you could not run, and why. -->
