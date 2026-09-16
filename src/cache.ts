import type { App } from 'obsidian';

export interface CachedEvent {
	id: string;
	calendarId: string;
	title: string;
	start: string;
	end: string;
	allDay: boolean;
	description: string;
	recurringEventId: string | null;
	etag: string;
}

export interface CalendarCache {
	syncToken: string;
	syncedAt: number;
	events: Record<string, CachedEvent>;
}

/** Previous sync's Google task ids → note path, used to tell "note deleted" from "never mirrored". */
export type TaskIndex = Record<string, string>;

const PREFIX = 'google-cal-sync:';
const TASKS_KEY = `${PREFIX}tasks`;

/** Per-device cache in Obsidian's vault-scoped localStorage. Never touches data.json. */
export class Cache {
	constructor(private app: App) {}

	calendar(calendarId: string): CalendarCache | null {
		const v = this.app.loadLocalStorage(PREFIX + calendarId) as Partial<CalendarCache> | null;
		if (!v || typeof v !== 'object' || !v.events) return null;
		return {
			syncToken: v.syncToken ?? '',
			syncedAt: v.syncedAt ?? 0,
			events: v.events,
		};
	}

	saveCalendar(calendarId: string, data: CalendarCache): void {
		this.app.saveLocalStorage(PREFIX + calendarId, data);
	}

	clearCalendar(calendarId: string): void {
		this.app.saveLocalStorage(PREFIX + calendarId, null);
	}

	taskIndex(): TaskIndex {
		const v = this.app.loadLocalStorage(TASKS_KEY) as TaskIndex | null;
		return v && typeof v === 'object' ? v : {};
	}

	saveTaskIndex(index: TaskIndex): void {
		this.app.saveLocalStorage(TASKS_KEY, index);
	}

	clearAll(calendarIds: string[]): void {
		for (const id of calendarIds) this.clearCalendar(id);
		this.app.saveLocalStorage(TASKS_KEY, null);
	}
}
