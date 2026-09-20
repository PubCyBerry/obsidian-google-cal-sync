import assert from 'node:assert/strict';
import { test } from 'node:test';
import { setRequestUrl } from 'obsidian';
import { Auth, AuthError } from '../src/auth';
import { Cache, type CalendarCache } from '../src/cache';
import { CalendarSync, fromGoogle, type GoogleEvent, toGoogle } from '../src/calendar';
import { decrypt, encrypt, isEncrypted } from '../src/crypto';
import { GoogleClient, GoogleError } from '../src/google';
import { DEFAULT_SETTINGS, type GCalSettings, loadSettings } from '../src/settings';
import { safeFileName } from '../src/tasks';
import { parseOptions } from '../src/view';

test('loadSettings keeps defaults and drops malformed values', () => {
	assert.deepEqual(loadSettings(null), DEFAULT_SETTINGS);
	const s = loadSettings({
		clientId: 'id',
		syncIntervalMinutes: 0,
		weekStart: 'someday',
		calendars: { a: { name: 'A' }, b: 'junk' },
		taskLists: { p: 'l1', q: 2 },
	});
	assert.equal(s.clientId, 'id');
	assert.equal(s.syncIntervalMinutes, 5);
	assert.equal(s.weekStart, 'monday');
	assert.deepEqual(s.calendars, {
		a: { name: 'A', color: '', enabled: true },
	});
	assert.deepEqual(s.taskLists, { p: 'l1' });
	assert.notEqual(
		s.calendars,
		DEFAULT_SETTINGS.calendars,
		'defaults are not shared by reference',
	);
});

test('parseOptions validates each option', () => {
	assert.deepEqual(parseOptions(''), {
		view: 'month',
		height: 'auto',
		calendars: [],
		tasks: true,
	});
	assert.deepEqual(parseOptions('view: week\nheight: 500px\ncalendars: [a, b]\ntasks: false'), {
		view: 'week',
		height: '500px',
		calendars: ['a', 'b'],
		tasks: false,
	});
	assert.deepEqual(parseOptions('view: list'), {
		view: 'list',
		height: 'auto',
		calendars: [],
		tasks: true,
	});
	assert.match(parseOptions('view: year') as string, /view/);
	assert.match(parseOptions('tasks: yes') as string, /tasks/);
	assert.match(parseOptions('calendars: 3') as string, /calendars/);
});

test('event mapping between Google and the cache', () => {
	const allDay = fromGoogle('c', {
		id: '1',
		summary: ' ',
		start: { date: '2026-09-01' },
		end: { date: '2026-09-03' },
		etag: '"e"',
		location: '본사 3층 회의실',
	});
	assert.deepEqual(allDay, {
		id: '1',
		calendarId: 'c',
		title: '(No title)',
		start: '2026-09-01',
		end: '2026-09-03',
		allDay: true,
		description: '',
		location: '본사 3층 회의실',
		recurringEventId: null,
		etag: '"e"',
	});
	const timed = fromGoogle('c', {
		id: '2',
		summary: 'T',
		start: { dateTime: '2026-09-01T10:00:00+09:00' },
		end: { dateTime: '2026-09-01T11:00:00+09:00' },
		recurringEventId: 'r',
	});
	assert.equal(timed.allDay, false);
	assert.equal(timed.recurringEventId, 'r');
	assert.equal(timed.location, '');
	assert.deepEqual(
		toGoogle(
			{
				title: 'x',
				start: '2026-09-01',
				end: '2026-09-02',
				allDay: true,
			},
			false,
		),
		{
			summary: 'x',
			start: { date: '2026-09-01' },
			end: { date: '2026-09-02' },
		},
	);
	assert.deepEqual(
		toGoogle(
			{
				start: '2026-09-01T10:00:00Z',
				end: '2026-09-01T11:00:00Z',
				allDay: false,
			},
			true,
		),
		{
			start: { dateTime: '2026-09-01T10:00:00Z', date: null },
			end: { dateTime: '2026-09-01T11:00:00Z', date: null },
		},
	);
	assert.deepEqual(toGoogle({ description: '' }, true), { description: '' });
});

test('crypto: passphrase round trip, wrong passphrase rejected, fresh salt and IV each time', async () => {
	const enc = await encrypt('1//0refresh-token', 'correct horse');
	assert.ok(isEncrypted(enc) && !isEncrypted('1//0refresh-token'));
	assert.doesNotMatch(enc, /refresh/);
	assert.equal(await decrypt(enc, 'correct horse'), '1//0refresh-token');
	await assert.rejects(decrypt(enc, 'wrong'));
	await assert.rejects(decrypt('enc1.broken', 'correct horse'));
	assert.notEqual(await encrypt('x', 'p'), await encrypt('x', 'p'));
});

/** A plugin stand-in with one device's keychain; `settings` is the shared data.json that vault sync would carry. */
function fakePlugin(settings: GCalSettings) {
	const keychain = new Map<string, string>();
	return {
		settings,
		saved: 0,
		app: {
			secretStorage: {
				getSecret: (id: string) => keychain.get(id) ?? null,
				setSecret: (id: string, v: string) => keychain.set(id, v),
			},
		},
		saveSettings() {
			this.saved++;
			return Promise.resolve();
		},
		notifyChanged() {},
		cache: { clearAll() {} },
	};
}

test('Auth: a passphrase encrypts the stored login, a second device unlocks it with the same passphrase', async () => {
	const settings: GCalSettings = {
		...DEFAULT_SETTINGS,
		clientId: 'id',
		clientSecret: 'sec',
		refreshToken: 'plain-token',
	};
	const desktop = fakePlugin(settings);
	const auth = new Auth(desktop as never);
	assert.equal(await auth.unlock(), true, 'plain-text login from an earlier version still works');
	assert.ok(auth.plain && !auth.locked);
	await auth.setPassphrase('  pw  ');
	assert.ok(isEncrypted(settings.refreshToken) && !auth.plain && !auth.locked);
	assert.equal(desktop.app.secretStorage.getSecret('google-cal-sync-passphrase'), 'pw');
	assert.equal(desktop.saved, 1);

	const phone = fakePlugin(settings);
	const other = new Auth(phone as never);
	assert.equal(await other.unlock(), false, 'no passphrase on this device');
	assert.ok(other.loggedIn && other.locked);
	await assert.rejects(
		other.setPassphrase('nope'),
		(e: unknown) => e instanceof AuthError && /Wrong/.test(e.message),
	);
	assert.ok(other.locked);
	await other.setPassphrase('pw');
	assert.ok(!other.locked);
	assert.equal(phone.saved, 0, 'unlocking writes nothing to data.json');

	let sent = '';
	setRequestUrl(async (req) => {
		sent = String(req.body);
		return {
			status: 200,
			text: '{"access_token":"at","expires_in":3600}',
			headers: {},
		};
	});
	assert.equal(await other.token(), 'at');
	assert.match(sent, /refresh_token=plain-token/, 'the decrypted token is what Google receives');

	await other.logout();
	assert.equal(settings.refreshToken, '');
	assert.ok(!other.loggedIn && !other.locked);
});

test('safeFileName strips characters Obsidian rejects', () => {
	assert.equal(safeFileName('a/b: c*?"<>|#^[d]'), 'a b c d');
	assert.equal(safeFileName('   '), 'Untitled task');
});

function memoryCache(): Cache {
	const store = new Map<string, unknown>();
	const app = {
		loadLocalStorage: (k: string) => store.get(k) ?? null,
		saveLocalStorage: (k: string, v: unknown) => {
			if (v === null) store.delete(k);
			else store.set(k, JSON.parse(JSON.stringify(v)));
		},
	};
	return new Cache(app as never);
}

test('GoogleClient: query building, 401 retry, error parsing, 204', async () => {
	const calls: Array<Record<string, unknown>> = [];
	let tokens = 0;
	const auth = {
		token: async (force?: boolean) => (force ? `t${++tokens}` : `t${tokens}`),
	};
	setRequestUrl(async (req) => {
		calls.push(req);
		const headers = req.headers as Record<string, string>;
		if (headers.Authorization === 'Bearer t0')
			return {
				status: 401,
				text: '{"error":{"message":"expired"}}',
				headers: {},
			};
		if (String(req.url).includes('/boom'))
			return {
				status: 403,
				text: '{"error":{"message":"Forbidden thing"}}',
				headers: {},
			};
		if (req.method === 'DELETE') return { status: 204, text: '', headers: {} };
		return { status: 200, text: '{"ok":true}', headers: {} };
	});
	const g = new GoogleClient(auth);
	const r = await g.call<{ ok: boolean }>('GET', 'https://x/y', {
		query: { a: 1, b: undefined, c: '', d: 'z' },
	});
	assert.deepEqual(r, { ok: true });
	assert.equal(calls.length, 2, 'one retry after 401');
	assert.equal(calls[1]?.url, 'https://x/y?a=1&d=z');
	assert.equal(
		(calls[1]?.headers as Record<string, string> | undefined)?.Authorization,
		'Bearer t1',
	);
	await assert.rejects(
		g.call('GET', 'https://x/boom'),
		(e: unknown) =>
			e instanceof GoogleError && e.status === 403 && e.message === 'Forbidden thing',
	);
	assert.equal(await g.call('DELETE', 'https://x/y'), undefined);
});

test('CalendarSync: full sync, incremental with cancelled, 410 resync, pagination', async () => {
	const pages: Array<{
		items?: GoogleEvent[];
		nextPageToken?: string;
		nextSyncToken?: string;
	}> = [];
	const urls: string[] = [];
	let fail410 = false;
	setRequestUrl(async (req) => {
		urls.push(String(req.url));
		if (fail410 && String(req.url).includes('syncToken='))
			return {
				status: 410,
				text: '{"error":{"message":"gone"}}',
				headers: {},
			};
		return {
			status: 200,
			text: JSON.stringify(pages.shift() ?? {}),
			headers: {},
		};
	});
	const cache = memoryCache();
	const sync = new CalendarSync(new GoogleClient({ token: async () => 't' }), cache);
	const ev = (id: string, extra: Partial<GoogleEvent> = {}): GoogleEvent => ({
		id,
		summary: id,
		start: { date: '2026-09-01' },
		end: { date: '2026-09-02' },
		...extra,
	});

	pages.push(
		{ items: [ev('a')], nextPageToken: 'p2' },
		{ items: [ev('b')], nextSyncToken: 'S1' },
	);
	let state: CalendarCache = await sync.sync('cal');
	assert.deepEqual(Object.keys(state.events).sort(), ['a', 'b']);
	assert.equal(state.syncToken, 'S1');
	assert.match(urls[0] ?? '', /timeMin=.*timeMax=/);
	assert.match(urls[1] ?? '', /pageToken=p2/);
	assert.doesNotMatch(urls[0] ?? '', /syncToken/);

	pages.push({
		items: [ev('a', { status: 'cancelled' }), ev('c')],
		nextSyncToken: 'S2',
	});
	state = await sync.sync('cal');
	assert.deepEqual(Object.keys(state.events).sort(), ['b', 'c']);
	assert.match(urls[2] ?? '', /syncToken=S1/);
	assert.doesNotMatch(urls[2] ?? '', /timeMin/);

	fail410 = true;
	pages.push({ items: [ev('z')], nextSyncToken: 'S3' });
	state = await sync.sync('cal');
	assert.deepEqual(Object.keys(state.events), ['z'], 'cache rebuilt from the full sync');
	assert.equal(state.syncToken, 'S3');
	assert.match(urls[3] ?? '', /syncToken=S2/);
	assert.match(urls[4] ?? '', /timeMin=/);
});

test('CalendarSync.patch: 412 refreshes the cache and rethrows', async () => {
	setRequestUrl(async (req) => {
		if (req.method === 'PATCH')
			return {
				status: 412,
				text: '{"error":{"message":"Precondition Failed"}}',
				headers: {},
			};
		return {
			status: 200,
			text: JSON.stringify({
				id: 'e',
				summary: 'fresh',
				etag: '"2"',
				start: { date: '2026-09-01' },
				end: { date: '2026-09-02' },
			}),
			headers: {},
		};
	});
	const cache = memoryCache();
	cache.saveCalendar('cal', {
		syncToken: 's',
		syncedAt: 1,
		events: {
			e: {
				id: 'e',
				calendarId: 'cal',
				title: 'old',
				start: '2026-09-01',
				end: '2026-09-02',
				allDay: true,
				description: '',
				recurringEventId: null,
				etag: '"1"',
			},
		},
	});
	const sync = new CalendarSync(new GoogleClient({ token: async () => 't' }), cache);
	await assert.rejects(
		sync.patch('cal', 'e', '"1"', { title: 'mine' }),
		(e: unknown) => e instanceof GoogleError && e.status === 412,
	);
	assert.equal(cache.calendar('cal')?.events.e?.title, 'fresh');
	assert.equal(cache.calendar('cal')?.events.e?.etag, '"2"');
});

test('date helpers: date-only parsing stays local, day arithmetic crosses months, offsets are explicit', async () => {
	const { addDays, fmtDate, fmtLocal, fmtTime, fromNow, parseDate, parseLocal } = await import(
		'../src/dates'
	);
	assert.equal(
		fmtDate(parseDate('2026-09-23')),
		'2026-09-23',
		'no UTC shift for date-only strings',
	);
	assert.equal(addDays('2026-09-30', 1), '2026-10-01');
	assert.equal(addDays('2026-01-01', -1), '2025-12-31');
	const d = parseLocal('2026-09-10', '10:05');
	assert.equal(fmtTime(d), '10:05');
	assert.match(fmtLocal(d), /^2026-09-10T10:05:00[+-]\d{2}:\d{2}$/);
	assert.ok(Number.isNaN(parseLocal('2026-09-10', '').getTime()));
	assert.equal(fromNow(Date.now() - 2 * 3_600_000), '2h ago');
	assert.equal(fromNow(Date.now() - 30_000), 'just now');
	assert.equal(fromNow(Date.now() - 86_400_000), '1d ago');
});

test('calendar colours map from the classic API palette to the modern one', async () => {
	const { modernColor } = await import('../src/colors');
	assert.equal(modernColor('#9fe1e7'), '#039be5');
	assert.equal(modernColor('#92E1C0'), '#33b679');
	assert.equal(modernColor('#123456'), '#123456', 'custom colours pass through');
});
