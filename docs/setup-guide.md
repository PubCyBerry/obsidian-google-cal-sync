# Setup guide

A first-time walkthrough from an empty Google Cloud project to a calendar in a note, then to your phone. Budget about 20 minutes. You do this once; afterwards the plugin refreshes its own access and you never log in again unless you revoke access.

## What you need

| Item | Why |
| --- | --- |
| Obsidian 1.13.7 or later on a desktop (Windows, macOS, Linux) | The login opens a local web server, which only the desktop app can run |
| A Google account with the calendars you want to see | Personal Gmail or Workspace both work |
| Access to [Google Cloud Console](https://console.cloud.google.com/) with that account | You create your own OAuth client, so no third party ever sees your tokens |
| Optional: a phone with Obsidian and a vault sync that copies the `.obsidian` folder | Obsidian Sync, iCloud, Syncthing, Google Drive and similar all work; the login travels inside `data.json` |

## 1. Google Cloud: enable the two APIs

1. Open the [API Library](https://console.cloud.google.com/apis/library). Pick or create a project in the selector at the top.
2. Search **Google Calendar API**, open it, click **Enable**.
3. Search **Google Tasks API**, open it, click **Enable**.

Done when both appear under [Enabled APIs & services](https://console.cloud.google.com/apis/dashboard).

## 2. Google Cloud: consent screen

Google calls this **Google Auth Platform** (older UI: OAuth consent screen).

1. [Branding](https://console.cloud.google.com/auth/branding): app name (anything, e.g. `Google Calendar Tasks Sync`), support email, developer contact.
2. [Audience](https://console.cloud.google.com/auth/audience): choose **External** and add your own Gmail address under **Test users**. Workspace accounts may choose **Internal** and skip test users.
3. [Data access](https://console.cloud.google.com/auth/scopes): add these two scopes and save.

   ```text
   https://www.googleapis.com/auth/calendar
   https://www.googleapis.com/auth/tasks
   ```

Done when your address is a test user and the two scopes are listed.

## 3. Google Cloud: the Desktop app client

1. [Clients](https://console.cloud.google.com/auth/clients) → **Create client** → application type **Desktop app**. Name it anything.
2. Copy the **Client ID** (ends in `.apps.googleusercontent.com`) and the **Client secret**. If you download the JSON instead, the values are `installed.client_id` and `installed.client_secret`.

Do not create a *Web application* client; its redirect URIs will not match and the login fails with `redirect_uri_mismatch`. A Desktop app client accepts any port on `http://127.0.0.1`, which is what the plugin uses.

## 4. Install the plugin

Pick one:

- **Community plugins** (once listed): Settings → Community plugins → Browse → search `Google Calendar Tasks Sync` → Install → Enable.
- **BRAT**: add the repository `PubCyBerry/obsidian-google-cal-sync` as a beta plugin.
- **Manual**: download `main.js`, `manifest.json`, `styles.css` from the [latest release](https://github.com/PubCyBerry/obsidian-google-cal-sync/releases/latest) into `<vault>/.obsidian/plugins/google-cal-sync/`, then enable it under Community plugins.

## 5. Log in (desktop)

1. Settings → **Google Calendar Tasks Sync**. Paste the Client ID and Client secret. The *Log in to Google* button enables once both are filled.
2. Click **Log in to Google**. Your default browser opens Google's sign-in.
3. Choose the account. Because the app is unverified you will see *Google hasn't verified this app*: click **Advanced**, then **Go to <your app name> (unsafe)**. This is your own app; the warning is about Google's review, not about safety.
4. Tick both permissions (calendar and tasks) and continue.
5. The browser lands on a plain page saying *Connected. You can close this window and return to Obsidian.* Back in Obsidian the settings tab shows *Connected as <your email>* and the list of your calendars with toggles.

If nothing comes back within two minutes the plugin gives up; just click the button again.

## 6. Put a calendar in a note

Type this anywhere:

````markdown
```gcal
view: month
```
````

Switch to Reading view or Live Preview. The first render loads the calendar engine and starts the first sync, which fetches three months back and six months ahead from every enabled calendar. Later syncs are incremental and take a fraction of a second.

Try it:

- Click an empty day → **New event** dialog. Give it a title, save, and check Google Calendar on the web: it is there.
- Drag the event to another day, or drag its bottom edge in week view. Each drop is written to Google immediately.
- Click the event → **Edit event**. *Delete* asks for a second click; there is no separate confirmation dialog.
- Toggle a calendar chip above the grid to hide that calendar. The choice is saved and applies to every `gcal` block.

Options you can set in the block: `view` (`month`, `week`, `day`), `height` (CSS length or `auto`), `calendars` (list of calendar ids to pin), `tasks` (`false` hides task notes).

## 7. Publish the consent screen

While the consent screen is in *Testing*, Google expires refresh tokens after 7 days and you would have to log in weekly.

1. [Audience](https://console.cloud.google.com/auth/audience) → **Publish app**. Do not submit for verification; an unverified app in production is allowed up to 100 users and you are the only one.
2. Back in Obsidian: **Log out**, then **Log in to Google** again so the stored refresh token is one issued in production.

## 8. Task notes (optional)

Skip this section, or turn off *Mirror task notes to Google Tasks* in settings, if you only want the calendar.

1. In settings, set **Projects folder** (default `10-projects`). Every direct subfolder is a project.
2. Create a note at `<projects folder>/<project>/tasks/<anything>.md` with this frontmatter:

   ```yaml
   ---
   type: Task
   title: Call the bank
   status: backlog        # backlog | active | blocked | done
   due: 2026-09-20        # optional
   google_task_id:        # leave empty; the plugin fills it
   ---
   ```

3. On the next sync (within the interval, or run **Sync now**) a Google Tasks list named after the project appears with the task in it. On your phone, the Google Calendar app shows it on the due date; the Google Tasks app shows it in the project list.
4. Tick it on the phone. Within one sync interval the note's `status` becomes `done`. Add a task in the Google Tasks app and a new note appears in that project's `tasks/` folder.

Rules worth knowing: deleting a note deletes the Google task; deleting the Google task makes the plugin re-create it from the note (complete it instead); moving a note to another project moves the task to that project's list.

## 9. Phone

1. Wait until your vault sync has copied `.obsidian/plugins/google-cal-sync/` including `data.json` to the phone. On desktop, check the file's modified time and make sure a sync ran after it.
2. Enable the plugin on the phone (Settings → Community plugins). There is no login screen; the settings tab says *Connected as …*.
3. Open the note with the `gcal` block. The month grid keeps a readable width and scrolls sideways. Long-press an event to drag it.

If the block says *Log in on desktop*, `data.json` has not arrived yet.

## Troubleshooting

| Symptom | Cause | Fix |
| --- | --- | --- |
| Login button stays disabled | Client ID or secret empty | Paste both values; whitespace is trimmed automatically |
| `403 access_denied` in the browser | App is in Testing and this account is not a test user | Add the account under Audience → Test users |
| `redirect_uri_mismatch` | A Web application client was used | Create a Desktop app client and use its values |
| Browser never returns to Obsidian | Firewall blocked the local port, or the browser blocked the popup | Click *Log in to Google* again; a new port is chosen each time |
| `invalid_grant` after a week | Testing-mode refresh token expired | Publish the app (step 7) and log in again |
| *Google connection lost. Log in again on desktop.* | Access revoked in the Google account, or 6 months unused | Log in again on desktop; phones pick it up after the next vault sync |
| Error pill on the block | Last request failed | Click the pill to see the reason; the cached events stay visible |
| *This event was changed elsewhere* | Someone edited the event between your last sync and your change | The calendar is refreshed; repeat the change |
| Task not mirrored | Note lacks `type: Task`, or sits outside `<project>/tasks/` | Fix the frontmatter or the folder |
| Phone shows *Log in on desktop* | `data.json` not synced yet | Wait for the vault sync, then reopen the note |
| Duplicate lists in Google Tasks | A list with the project's name was renamed or deleted in Google | The plugin re-uses a list with the exact project name; rename it back or let the plugin create a new one |

## Where your data lives

| Data | Location | Leaves the device? |
| --- | --- | --- |
| Client ID, client secret, refresh token, calendar toggles, list ids | `.obsidian/plugins/google-cal-sync/data.json` | Only through your own vault sync |
| Access token | Memory | No |
| Event cache and sync tokens | Obsidian's per-vault localStorage on each device | No |
| Task state | The note's frontmatter (`status`, `due`, `google_task_id`, `title`) | Through your vault sync, like any note |

To disconnect completely: **Log out** (revokes the token at Google and clears the cache), then remove the app under [Third-party apps & services](https://myaccount.google.com/connections) in your Google account.
