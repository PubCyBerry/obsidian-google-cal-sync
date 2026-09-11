import { MarkdownRenderChild, Notice, Platform, getLanguage, parseYaml } from 'obsidian';
import type { Calendar, EventInput as FcEvent, EventClickArg, EventDropArg, EventContentArg } from '@fullcalendar/core';
import type { EventResizeDoneArg } from '@fullcalendar/interaction';
import type { CachedEvent } from './cache';
import { addDays, fmtLocal, fromNow } from './dates';
import type GCalSync from './main';
import { EventModal } from './modal';
import { errorMessage, WEEKDAYS } from './settings';

const VIEWS = { month: 'dayGridMonth', week: 'timeGridWeek', day: 'timeGridDay' } as const;

export interface BlockOptions {
	view: keyof typeof VIEWS;
	height: string;
	calendars: string[];
	tasks: boolean;
}

export function parseOptions(source: string): BlockOptions | string {
	let raw: unknown;
	try {
		raw = source.trim() ? parseYaml(source) : {};
	} catch {
		return 'gcal: options must be YAML (key: value per line)';
	}
	const o = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
	const opts: BlockOptions = { view: 'month', height: 'auto', calendars: [], tasks: true };
	if (o.view !== undefined) {
		if (typeof o.view !== 'string' || !(o.view in VIEWS)) return 'gcal: `view` must be one of month, week, day';
		opts.view = o.view as BlockOptions['view'];
	}
	if (o.height !== undefined) {
		if (typeof o.height !== 'string' && typeof o.height !== 'number') return 'gcal: `height` must be a CSS length or auto';
		opts.height = String(o.height);
	}
	if (o.calendars !== undefined) {
		if (!Array.isArray(o.calendars) || !o.calendars.every((c) => typeof c === 'string')) return 'gcal: `calendars` must be a list of calendar ids';
		opts.calendars = o.calendars;
	}
	if (o.tasks !== undefined) {
		if (typeof o.tasks !== 'boolean') return 'gcal: `tasks` must be true or false';
		opts.tasks = o.tasks;
	}
	return opts;
}

type Kind = { kind: 'event'; ev: CachedEvent } | { kind: 'task'; path: string; status: string };

export class GCalBlock extends MarkdownRenderChild {
	private calendar: Calendar | null = null;
	private toolbar!: HTMLElement;
	private pill!: HTMLElement;
	private showTasks: boolean;
	private lastState = '';
	/** A redraw was requested while the block had no size (hidden tab); done when it becomes visible. */
	private dirty = false;
	private resizeObserver: ResizeObserver | null = null;

	constructor(
		containerEl: HTMLElement,
		private plugin: GCalSync,
		private opts: BlockOptions,
	) {
		super(containerEl);
		this.showTasks = opts.tasks;
	}

	onload(): void {
		this.containerEl.addClass('gcal');
		this.plugin.addListener(this.refresh);
		this.registerDomEvent(window, 'focus', () => void this.plugin.sync());
		// FullCalendar measures column widths when it draws. Drawn in a hidden tab (width 0), multi-day bars
		// collapse to one cell, so redraw or re-measure whenever the block gains or changes size.
		this.resizeObserver = new ResizeObserver(() => this.onResize());
		this.resizeObserver.observe(this.containerEl);
		void this.render();
	}

	onunload(): void {
		this.plugin.removeListener(this.refresh);
		this.resizeObserver?.disconnect();
		this.resizeObserver = null;
		this.calendar?.destroy();
		this.calendar = null;
	}

	private get hidden(): boolean {
		return this.containerEl.offsetWidth === 0;
	}

	private onResize(): void {
		if (!this.calendar || this.hidden) return;
		if (this.dirty) {
			this.dirty = false;
			this.calendar.refetchEvents();
		} else {
			this.calendar.updateSize();
		}
	}

	private refresh = (): void => {
		const state = this.stateKey();
		if (state !== this.lastState) {
			void this.render();
			return;
		}
		this.renderToolbar();
		this.calendar?.setOption('firstDay', WEEKDAYS.indexOf(this.plugin.settings.weekStart));
		if (this.hidden) {
			this.dirty = true;
			return;
		}
		this.calendar?.refetchEvents();
	};

	private stateKey(): string {
		const s = this.plugin.settings;
		return !s.clientId || !s.clientSecret ? 'no-client' : !s.refreshToken ? 'no-token' : 'ready';
	}

	private async render(): Promise<void> {
		const state = (this.lastState = this.stateKey());
		this.calendar?.destroy();
		this.calendar = null;
		this.containerEl.empty();
		if (state === 'no-client') {
			this.containerEl.createEl('p', { cls: 'gcal-empty', text: 'Enter a Google client ID and secret in the plugin settings.' });
			return;
		}
		if (state === 'no-token') {
			this.containerEl.createEl('p', {
				cls: 'gcal-empty',
				text: Platform.isDesktop ? 'Log in to Google in the plugin settings to see your calendar here.' : 'Log in on desktop. The calendar appears here once the vault syncs the login to this device.',
			});
			return;
		}
		this.toolbar = this.containerEl.createDiv({ cls: 'gcal-toolbar' });
		const calEl = this.containerEl.createDiv({ cls: 'gcal-calendar' });
		this.renderToolbar();
		const fc = await import('./fc');
		if (!this.containerEl.isConnected && !this.containerEl.parentElement) return;
		const s = this.plugin.settings;
		this.calendar = new fc.Calendar(calEl, {
			plugins: [fc.dayGridPlugin, fc.timeGridPlugin, fc.interactionPlugin],
			locales: fc.allLocales,
			locale: getLanguage(),
			initialView: VIEWS[this.opts.view],
			headerToolbar: { left: 'today prev,next title', center: '', right: 'timeGridDay,timeGridWeek,dayGridMonth' },
			firstDay: WEEKDAYS.indexOf(s.weekStart),
			height: this.opts.height === 'auto' ? 'auto' : this.opts.height,
			slotMinTime: '07:00:00',
			slotMaxTime: '22:00:00',
			nowIndicator: true,
			dayMaxEvents: true,
			editable: true,
			selectable: true,
			longPressDelay: 500,
			eventLongPressDelay: 500,
			selectLongPressDelay: 500,
			events: (_info, success) => success(this.events()),
			// A plain click selects one day (or one slot), so `select` covers both click and drag-to-select.
			select: (info) => {
				this.calendar?.unselect();
				this.openModal({ start: info.startStr, end: info.endStr, allDay: info.allDay });
			},
			eventClick: (info) => this.onEventClick(info),
			eventDrop: (info) => void this.onMove(info),
			eventResize: (info) => void this.onMove(info),
			eventContent: (arg) => this.taskContent(arg),
			eventDidMount: (arg) => {
				const start = arg.event.start;
				if (this.plugin.settings.hideMidnightTime && !arg.event.allDay && start && start.getHours() === 0 && start.getMinutes() === 0) {
					arg.el.querySelector('.fc-event-time')?.remove();
				}
			},
		});
		this.calendar.render();
		if (this.hidden) this.dirty = true;
		void this.plugin.sync();
	}

	private renderToolbar(): void {
		if (!this.toolbar) return;
		const s = this.plugin.settings;
		this.toolbar.empty();
		const toggles = this.toolbar.createDiv({ cls: 'gcal-toggles' });
		if (this.opts.calendars.length === 0) {
			for (const cal of Object.values(s.calendars)) {
				const b = toggles.createEl('button', { cls: ['gcal-toggle', cal.enabled ? 'is-on' : ''], text: cal.name });
				b.createSpan({ cls: 'gcal-dot' }).setCssProps({ '--gcal-color': cal.color });
				b.prepend(b.lastChild as Node);
				b.onclick = async () => {
					cal.enabled = !cal.enabled;
					await this.plugin.saveSettings();
					this.plugin.notifyChanged();
				};
			}
		}
		if (this.opts.tasks) {
			const b = toggles.createEl('button', { cls: ['gcal-toggle', 'gcal-toggle-tasks', this.showTasks ? 'is-on' : ''], text: 'Tasks' });
			b.onclick = () => {
				this.showTasks = !this.showTasks;
				this.renderToolbar();
				this.calendar?.refetchEvents();
			};
		}
		this.pill = this.toolbar.createSpan({ cls: 'gcal-pill' });
		this.renderPill();
	}

	private renderPill(): void {
		const st = this.plugin.status;
		this.pill.className = 'gcal-pill';
		this.pill.onclick = null;
		if (st.syncing) {
			this.pill.setText('Syncing…');
		} else if (st.lastError) {
			this.pill.addClass('is-error');
			this.pill.setText('Error');
			this.pill.onclick = () => new Notice(st.lastError);
		} else if (st.lastSyncAt && Date.now() - st.lastSyncAt > 3_600_000) {
			this.pill.addClass('is-stale');
			this.pill.setText(`Synced ${fromNow(st.lastSyncAt)}`);
		} else {
			this.pill.setText('');
		}
	}

	private visibleCalendars(): string[] {
		const s = this.plugin.settings;
		if (this.opts.calendars.length) return this.opts.calendars;
		return Object.keys(s.calendars).filter((id) => s.calendars[id]?.enabled);
	}

	private events(): FcEvent[] {
		const s = this.plugin.settings;
		const out: FcEvent[] = [];
		for (const calId of this.visibleCalendars()) {
			const color = s.calendars[calId]?.color || undefined;
			const cache = this.plugin.cache.calendar(calId);
			if (!cache) continue;
			for (const ev of Object.values(cache.events)) {
				const kind: Kind = { kind: 'event', ev };
				out.push({ id: `${calId}::${ev.id}`, title: ev.title, start: ev.start, end: ev.end || undefined, allDay: ev.allDay, backgroundColor: color, borderColor: color, extendedProps: kind });
			}
		}
		if (this.showTasks) {
			for (const t of this.plugin.taskNotes()) {
				if (!t.due || (t.status === 'done' && !s.showCompletedTasks)) continue;
				const kind: Kind = { kind: 'task', path: t.file.path, status: t.status };
				out.push({
					id: `task::${t.file.path}`,
					title: t.title,
					start: t.due,
					allDay: true,
					editable: false,
					classNames: ['gcal-task', t.status === 'done' ? 'is-done' : '', t.status === 'blocked' ? 'is-blocked' : ''].filter(Boolean),
					extendedProps: kind,
				});
			}
		}
		return out;
	}

	private taskContent(arg: EventContentArg): { domNodes: Node[] } | true {
		const kind = arg.event.extendedProps as Kind;
		if (kind.kind !== 'task') return true;
		const frag = createFragment();
		const box = frag.createEl('input', { type: 'checkbox', cls: 'gcal-task-check' });
		box.checked = kind.status === 'done';
		box.onclick = (e) => {
			e.stopPropagation();
			void this.toggleTask(kind.path, box.checked);
		};
		frag.createSpan({ cls: 'gcal-task-title', text: arg.event.title });
		return { domNodes: Array.from(frag.childNodes) };
	}

	private async toggleTask(path: string, done: boolean): Promise<void> {
		const file = this.plugin.app.vault.getFileByPath(path);
		if (!file) return;
		await this.plugin.app.fileManager.processFrontMatter(file, (fm: Record<string, unknown>) => {
			fm.status = done ? 'done' : 'backlog';
		});
		// The metadata 'changed' event redraws and mirrors once the cache has the new status.
	}

	private onEventClick(info: EventClickArg): void {
		const kind = info.event.extendedProps as Kind;
		if (kind.kind === 'task') {
			void this.plugin.app.workspace.openLinkText(kind.path, '', false);
			return;
		}
		info.jsEvent.preventDefault();
		this.openModal({ event: kind.ev });
	}

	private openModal(params: ConstructorParameters<typeof EventModal>[1]): void {
		new EventModal(this.plugin, params, () => this.plugin.notifyChanged()).open();
	}

	private async onMove(info: EventDropArg | EventResizeDoneArg): Promise<void> {
		const kind = info.event.extendedProps as Kind;
		if (kind.kind !== 'event') {
			info.revert();
			return;
		}
		const ev = kind.ev;
		const allDay = info.event.allDay;
		const start = info.event.startStr;
		const end = info.event.endStr || (allDay ? addDays(start, 1) : fmtLocal(new Date((info.event.start?.getTime() ?? Date.now()) + 3_600_000)));
		try {
			await this.plugin.calendars.patch(ev.calendarId, ev.id, ev.etag, { start, end, allDay });
			this.plugin.notifyChanged();
		} catch (e) {
			info.revert();
			new Notice(`Could not save to Google: ${errorMessage(e)}`);
			this.plugin.notifyChanged();
		}
	}
}
