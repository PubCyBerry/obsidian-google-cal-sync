// End-to-end checks against the fake Google backend. Results land in window.__e2e.
(async () => {
	const out = (window.__e2e = { steps: [], done: false });
	const plugin = app.plugins.getPlugin('google-cal-sync');
	const F = window.__fake;
	const sleep = (ms) => new Promise((r) => window.setTimeout(r, ms));
	const step = async (name, fn) => {
		try {
			const detail = await fn();
			out.steps.push({ name, ok: true, detail });
		} catch (e) {
			out.steps.push({ name, ok: false, detail: String(e && e.message ? e.message : e) });
		}
	};
	const assert = (c, msg) => {
		if (!c) throw new Error(msg);
	};
	const sync = () => plugin.sync({ force: true });
	const cacheOf = (c) => plugin.cache.calendar(c);
	const uiTitles = () => [...document.querySelectorAll('.gcal .fc-event')].map((e) => e.textContent.trim());
	const fm = (path) => app.metadataCache.getFileCache(app.vault.getFileByPath(path))?.frontmatter ?? {};
	const waitFor = async (pred, ms = 6000) => {
		const t0 = Date.now();
		while (Date.now() - t0 < ms) {
			if (pred()) return true;
			await sleep(200);
		}
		return false;
	};
	const now = () => new Date().toISOString();

	await step('initial sync clears stale error', async () => {
		await sync();
		assert(plugin.status.lastError === '', 'lastError: ' + plugin.status.lastError);
		assert(Object.keys(cacheOf('primary').events).length === 2, 'primary cache has 2 events');
		return { lastSyncAt: plugin.status.lastSyncAt };
	});

	let created;
	await step('insert event (modal save path)', async () => {
		created = await plugin.calendars.insert('primary', { title: 'E2E created', start: '2026-09-16T10:00:00+09:00', end: '2026-09-16T11:00:00+09:00', allDay: false, description: 'd' });
		assert(created.id && created.etag, 'created has id/etag');
		assert(F.events.primary[created.id].summary === 'E2E created', 'fake has event');
		assert(cacheOf('primary').events[created.id], 'cache has event');
		plugin.notifyChanged();
		assert(await waitFor(() => uiTitles().some((t) => t.includes('E2E created'))), 'UI shows new event');
		return created.id;
	});

	await step('patch event (drag/resize path) with If-Match', async () => {
		const before = F.events.primary[created.id].etag;
		const ev = await plugin.calendars.patch('primary', created.id, created.etag, { start: '2026-09-17', end: '2026-09-18', allDay: true });
		assert(ev.allDay === true && ev.start === '2026-09-17', 'now all-day on 17th: ' + JSON.stringify(ev));
		assert(F.events.primary[created.id].etag !== before, 'etag rotated');
		assert(!('dateTime' in F.events.primary[created.id].start), 'dateTime cleared on Google');
		created = ev;
		return ev;
	});

	await step('patch with stale etag → 412, cache refreshed', async () => {
		let threw = null;
		try {
			await plugin.calendars.patch('primary', created.id, '"stale"', { title: 'should not apply' });
		} catch (e) {
			threw = e;
		}
		assert(threw && threw.status === 412, 'threw 412: ' + threw);
		assert(F.events.primary[created.id].summary === 'E2E created', 'title untouched on Google');
		assert(cacheOf('primary').events[created.id].title === 'E2E created', 'cache still fresh');
		return threw.message;
	});

	await step('Google-side edit and delete arrive via incremental sync', async () => {
		const e = F.events.primary[created.id];
		e.summary = 'Renamed on Google';
		e.etag = '"g1"';
		F.changes.primary.push(JSON.parse(JSON.stringify(e)));
		const victim = Object.values(F.events['home@group.calendar.google.com'])[0];
		delete F.events['home@group.calendar.google.com'][victim.id];
		F.changes['home@group.calendar.google.com'].push({ ...victim, status: 'cancelled' });
		const logLen = F.log.length;
		await sync();
		const calls = F.log.slice(logLen).filter((l) => l.url.includes('/events?')).map((l) => l.url);
		assert(calls.every((u) => u.includes('syncToken=')), 'all event calls incremental: ' + calls.join(' | '));
		assert(cacheOf('primary').events[created.id].title === 'Renamed on Google', 'rename pulled');
		assert(!cacheOf('home@group.calendar.google.com').events[victim.id], 'cancelled removed');
		return calls.length;
	});

	await step('410 → full resync', async () => {
		F.expireSyncToken = true;
		const logLen = F.log.length;
		await sync();
		F.expireSyncToken = false;
		const calls = F.log.slice(logLen).filter((l) => l.url.includes('/events?'));
		assert(calls.some((l) => l.status === 410), 'saw 410');
		assert(calls.some((l) => l.url.includes('timeMin=')), 'full sync followed');
		assert(plugin.status.lastError === '', 'no error after resync: ' + plugin.status.lastError);
		assert(Object.keys(cacheOf('primary').events).length === 3, 'primary has 3 events');
		return calls.map((l) => l.status);
	});

	await step('delete event', async () => {
		await plugin.calendars.remove('primary', created.id);
		assert(!F.events.primary[created.id], 'gone on Google');
		assert(!cacheOf('primary').events[created.id], 'gone in cache');
		return 'ok';
	});

	// ---- Tasks ----
	const listTest = plugin.settings.taskLists['Test Project'];
	const listSecond = plugin.settings.taskLists['Second Project'];
	const taskOf = (title) => Object.values(F.tasks).flatMap((l) => Object.values(l)).find((t) => t.title === title);

	await step('Google completes a task → note becomes done', async () => {
		await sleep(50);
		const t = taskOf('Write the README');
		t.status = 'completed';
		t.completed = now();
		t.updated = now();
		await sync();
		assert(await waitFor(() => fm('10-projects/Test Project/tasks/Write the README.md').status === 'done'), 'note status done');
		return t.id;
	});

	await step('Google un-completes (needsAction, newer) → done note becomes backlog', async () => {
		await sleep(1100);
		const t = taskOf('Write the README');
		t.status = 'needsAction';
		delete t.completed;
		t.updated = now();
		await sync();
		assert(await waitFor(() => fm('10-projects/Test Project/tasks/Write the README.md').status === 'backlog'), 'note status backlog');
		return 'ok';
	});

	await step('note edited later than Google → pushed', async () => {
		await sleep(1100);
		const file = app.vault.getFileByPath('10-projects/Test Project/tasks/Write the README.md');
		await app.fileManager.processFrontMatter(file, (f) => {
			f.status = 'active';
			f.due = '2026-09-20';
		});
		await sleep(300);
		await sync();
		const t = taskOf('Write the README');
		assert(t.status === 'needsAction' && t.due === '2026-09-20T00:00:00.000Z', 'pushed due: ' + JSON.stringify(t));
		return t.due;
	});

	await step('Google renames a task (newer) → note title and file renamed', async () => {
		await sleep(1100);
		const t = taskOf('Wait for review');
		t.title = 'Wait for review: v2';
		t.updated = now();
		await sync();
		const f = app.vault.getFileByPath('10-projects/Test Project/tasks/Wait for review v2.md');
		assert(f, 'renamed file exists (colon stripped)');
		assert(await waitFor(() => fm(f.path).title === 'Wait for review: v2'), 'title frontmatter updated');
		return f.path;
	});

	await step('new task on Google → note imported with backlink', async () => {
		const t = { id: 'phone1', title: 'From phone', status: 'needsAction', due: '2026-09-22T00:00:00.000Z', updated: now() };
		F.tasks[listTest][t.id] = t;
		await sync();
		const f = app.vault.getFileByPath('10-projects/Test Project/tasks/From phone.md');
		assert(f, 'note created');
		assert(await waitFor(() => fm(f.path).google_task_id === 'phone1'), 'google_task_id set');
		assert(fm(f.path).status === 'backlog' && fm(f.path).due === '2026-09-22', 'fields: ' + JSON.stringify(fm(f.path)));
		assert((t.notes || '').startsWith('obsidian://open?vault='), 'backlink patched: ' + t.notes);
		return f.path;
	});

	await step('note deleted → Google task deleted', async () => {
		const t = taskOf('Ship it');
		await app.fileManager.trashFile(app.vault.getFileByPath('10-projects/Second Project/tasks/Ship it.md'));
		await sleep(300);
		await sync();
		assert(!F.tasks[listSecond][t.id], 'task removed on Google');
		return t.id;
	});

	await step('note moved to another project → tasks.move', async () => {
		const f = app.vault.getFileByPath('10-projects/Test Project/tasks/From phone.md');
		await app.fileManager.renameFile(f, '10-projects/Second Project/tasks/From phone.md');
		await sleep(300);
		const logLen = F.log.length;
		await sync();
		assert(F.log.slice(logLen).some((l) => l.url.includes('/move?destinationTasklist=' + listSecond)), 'move called');
		assert(F.tasks[listSecond].phone1 && !F.tasks[listTest].phone1, 'task now in Second Project list');
		return 'ok';
	});

	await step('Google deleted a task → note re-created it', async () => {
		delete F.tasks[listSecond].phone1;
		await sync();
		assert(await waitFor(() => fm('10-projects/Second Project/tasks/From phone.md').google_task_id !== 'phone1'), 'new id written');
		const gid = fm('10-projects/Second Project/tasks/From phone.md').google_task_id;
		assert(gid && F.tasks[listSecond][gid], 'new task exists: ' + gid);
		return gid;
	});

	await step('mirror off → no Tasks API calls', async () => {
		plugin.settings.mirror = false;
		const logLen = F.log.length;
		await sync();
		plugin.settings.mirror = true;
		assert(!F.log.slice(logLen).some((l) => l.url.startsWith('/tasks/')), 'no tasks calls');
		return 'ok';
	});

	await step('request budget: one list call per calendar and per project', async () => {
		const logLen = F.log.length;
		await sync();
		const calls = F.log.slice(logLen).map((l) => l.method + ' ' + l.url.split('?')[0]);
		const events = calls.filter((c) => c.endsWith('/events')).length;
		const tasks = calls.filter((c) => /\/tasks$/.test(c)).length;
		assert(events === 3 && tasks === 2 && calls.length === 5, 'calls: ' + calls.join(' | '));
		return calls.length;
	});

	await step('calendar toggle off hides its events and persists', async () => {
		plugin.settings.calendars['work@group.calendar.google.com'].enabled = false;
		await plugin.saveSettings();
		plugin.notifyChanged();
		assert(await waitFor(() => !uiTitles().some((t) => t.includes('Offsite'))), 'Offsite hidden');
		const saved = JSON.parse(await app.vault.adapter.read(app.vault.configDir + '/plugins/google-cal-sync/data.json'));
		assert(saved.calendars['work@group.calendar.google.com'].enabled === false, 'persisted');
		plugin.settings.calendars['work@group.calendar.google.com'].enabled = true;
		await plugin.saveSettings();
		plugin.notifyChanged();
		return 'ok';
	});

	await step('task checkbox click → note done → pushed to Google', async () => {
		await sleep(1100);
		const box = [...document.querySelectorAll('.gcal .gcal-task')].find((e) => e.textContent.includes('Write the README'))?.querySelector('input');
		assert(box, 'checkbox found');
		box.click();
		assert(await waitFor(() => fm('10-projects/Test Project/tasks/Write the README.md').status === 'done'), 'note done');
		assert(await waitFor(() => taskOf('Write the README').status === 'completed', 8000), 'Google completed');
		return 'ok';
	});

	out.done = true;
})();
