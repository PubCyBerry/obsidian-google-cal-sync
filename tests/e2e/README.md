# In-app checks

These scripts run inside a development vault that has this repository linked at
`.obsidian/plugins/google-cal-sync` and the plugin enabled. They need no Google account:
`fake-google.js` replaces the HTTP transport with an in-memory Google, so real
status handling (401, 410, 412, 404) still runs through the plugin's own code.

Vault layout the scripts expect:

```
Calendar.md                                  # contains a ```gcal block
10-projects/Test Project/tasks/Write the README.md   # type: Task, due 2026-09-15, status active
10-projects/Test Project/tasks/Wait for review.md    # status blocked, due 2026-09-18
10-projects/Second Project/tasks/Ship it.md          # status done, due 2026-09-12
```

Copy the three `.js` files into the vault root, open `Calendar.md`, then with the
[Obsidian CLI](https://help.obsidian.md/cli):

```bash
obsidian eval code="app.vault.adapter.read('fake-google.js').then(s => (0, eval)(s))"
obsidian eval code="app.vault.adapter.read('e2e.js').then(s => (0, eval)(s))"
obsidian eval code="window.__e2e.steps.map(s => (s.ok ? 'PASS ' : 'FAIL ') + s.name).join('\n')"
obsidian eval code="app.vault.adapter.read('login-test.js').then(s => (0, eval)(s))"
obsidian eval code="window.__login.steps.map(s => (s.ok ? 'PASS ' : 'FAIL ') + s.name).join('\n')"
```

`e2e.js` covers event insert/patch/412/410/delete, incremental sync, every task
mirroring rule, the request budget, calendar toggles and the task checkbox.
`login-test.js` drives the loopback server with a fake browser: PKCE parameters,
state mismatch, Google error, and a bogus code that is exchanged against the real
token endpoint (needs a client ID and secret in `data.json`). Reset the task notes
and the plugin cache between runs.
