# Google Calendar Tasks Sync

A `gcal` code block that turns into your **Google Calendar** (all calendars, month/week/day, create/edit/drag/delete), plus **task notes mirrored to Google Tasks** so they show up as checkboxes in the Google Calendar app on your phone.

- One code block, every calendar, each in its own Google colour.
- Create, edit, move, resize and delete events. Changes go straight to Google; Google is the source of truth for events.
- Task notes (`type: Task` frontmatter) inside project folders are mirrored to a Google Tasks list per project. Title, due date and completion sync both ways; Obsidian is the source of truth for tasks.
- Also available as its own pane: the ribbon icon or the **Open calendar view** command opens it in the right sidebar, and you can drag it into a tab.
- Log in once on desktop; phones and tablets reuse that login through your vault sync. No login screen on mobile. The login travels encrypted: each device unlocks it once with a passphrase you choose.
- Offline: the last synced state is drawn from a per-device cache.

## Documentation

- [Setup guide](docs/setup-guide.md): first-time walkthrough from Google Cloud to your phone, with troubleshooting.
- [Architecture](docs/architecture.md): C4 context, containers and components, runtime flows, data, decisions.
- [Changelog](CHANGELOG.md): what changed in each release.

## Setup

You bring your own Google Cloud OAuth client, so nothing goes through a third-party server. The short version follows; the [setup guide](docs/setup-guide.md) has every click.

1. In [Google Cloud Console](https://console.cloud.google.com/) create or pick a project, then enable **Google Calendar API** and **Google Tasks API**.
2. Under **Google Auth Platform**, configure the consent screen (External), add yourself as a test user, and add the scopes `https://www.googleapis.com/auth/calendar.calendarlist.readonly`, `https://www.googleapis.com/auth/calendar.events` and `https://www.googleapis.com/auth/tasks`.
3. Create an OAuth client of type **Desktop app**. Copy its Client ID and Client secret.
4. In Obsidian → Settings → Google Calendar Tasks Sync, paste both values, set a **Sync passphrase** (it encrypts the login before it is written to disk) and click **Log in to Google**. A browser window opens; approve both permissions. The browser returns to `http://127.0.0.1:<port>` and the plugin stores the encrypted refresh token.
5. Put a code block in any note:

   ````markdown
   ```gcal
   view: month
   ```
   ````

6. Publish the consent screen (Audience → Publish app). Refresh tokens issued while the app is in *Testing* expire after 7 days. Log in once more after publishing.

### Code block options

| Option      | Values                                   | Default | Meaning                                                                 |
| ----------- | ---------------------------------------- | ------- | ----------------------------------------------------------------------- |
| `view`      | `month`, `week`, `day`                   | `month` | Initial view                                                            |
| `height`    | CSS length or `auto`                     | `auto`  | Calendar height                                                         |
| `calendars` | list of calendar ids                     | `[]`    | Empty follows the toggles in settings; a list pins those calendars only |
| `tasks`     | `true`, `false`                          | `true`  | Draw task notes on their due date                                       |

### Task mirroring

Task notes live in `<projects folder>/<project>/tasks/*.md` (projects folder defaults to `10-projects`) and need this frontmatter:

```yaml
---
type: Task
title: Write the README
status: active        # backlog | active | blocked | done
due: 2026-09-15       # optional, YYYY-MM-DD
google_task_id:       # filled by the plugin
---
```

- Each project folder gets a Google Tasks list with the project's name.
- `status: done` ↔ completed. Any other status is *needs action*; completing a task on the phone sets the note to `done`, and un-completing a `done` note sets it to `backlog`.
- A task added in the Google Tasks app appears as a new note in that project's `tasks/` folder with `status: backlog`.
- Deleting a note deletes the Google task. Deleting a task in Google (instead of completing it) makes the plugin re-create it from the note.
- Moving a note to another project moves the task to that project's list.
- Only `title`, `due`, `status` and `google_task_id` are ever written to a note; bodies and other properties are left alone. Google's task notes field holds an `obsidian://` link back to the note.

Turn mirroring off in settings and the Google Tasks API is never called.

### Display

Calendar colours follow the Google Calendar apps (the API reports the classic palette; the plugin maps it to the modern one you see on the web and phone) and are refreshed once an hour. Events that start at 00:00 are drawn without a time, like Google does; turn **Hide midnight start times** off in settings to show it.

### Commands

`Log in to Google` (desktop only), `Log out`, `Sync now`, `Clear cache`, `Open calendar view`.

## Mobile

Obsidian Mobile cannot run the local login server, so log in on desktop. The encrypted refresh token is stored in this plugin's `data.json`, which your vault sync (Obsidian Sync, iCloud, Syncthing, …) carries to the other devices. On each of them, enter the same sync passphrase once in the plugin settings and press **Unlock**; from then on the plugin refreshes the access token by itself. If a device shows "Log in on desktop", its `data.json` has not arrived yet; if it shows "Enter the sync passphrase", it has arrived and is waiting for the passphrase.

## Network use and data storage (please read)

- The plugin talks only to Google: `accounts.google.com` and `oauth2.googleapis.com` for OAuth, `www.googleapis.com/calendar/v3` for events, and `tasks.googleapis.com/tasks/v1` for tasks. No other server, no telemetry.
- Permissions requested from Google: `calendar.calendarlist.readonly` (list your calendars), `calendar.events` (read and write events) and `tasks`. The plugin cannot share, delete or reconfigure a calendar.
- Your OAuth client ID and client secret are stored in plain text in `.obsidian/plugins/google-cal-sync/data.json`. Google does not treat the secret of a desktop app as confidential, and both are needed on every device to refresh the access token.
- The **refresh token is stored encrypted in the same file**, with a key derived from your sync passphrase (PBKDF2-SHA256, 600,000 iterations, AES-256-GCM). Your vault sync therefore carries only ciphertext. Each device keeps the passphrase in Obsidian's keychain (Settings → Keychain, encrypted by the operating system) and decrypts the token into memory only. A login stored by a version before 1.2.0 stays in plain text until you set a passphrase; the settings tab tells you so.
- Calendar events are cached per device in Obsidian's local storage (not in notes). `Clear cache` removes it; `Log out` revokes the token at Google and removes it too. If you suspect a copy of `data.json` leaked together with the passphrase, remove the app under [Third-party apps & services](https://myaccount.google.com/connections) in your Google account, which invalidates the token immediately.
- Requests per sync: one per enabled calendar (incremental with Google's sync tokens) and one per project task list, plus one request per change you make.

## Development

```bash
npm install
npm run dev     # watch build to main.js
npm run build   # type check + production build
npm run lint    # eslint with eslint-plugin-obsidianmd
npm test        # unit tests (node:test)
```

Symlink or copy the repository folder to `<vault>/.obsidian/plugins/google-cal-sync/`. FullCalendar (MIT) is bundled into `main.js` and loaded lazily when the first code block renders, so it does not add to app start time.

## Compatibility

| Plugin | Obsidian |
| ------ | -------- |
| 1.x    | 1.13.7+  |

## License

MIT. FullCalendar (MIT) is bundled; see [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
