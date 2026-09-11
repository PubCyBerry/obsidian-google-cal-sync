import { Modal, Notice, Setting, moment } from 'obsidian';
import type { CachedEvent } from './cache';
import type { EventInput } from './calendar';
import type GCalSync from './main';
import { errorMessage } from './settings';

export interface EventModalParams {
	/** Existing event to edit; omitted when creating. */
	event?: CachedEvent;
	calendarId?: string;
	start?: string;
	end?: string;
	allDay?: boolean;
}

const DATE = 'YYYY-MM-DD';
const TIME = 'HH:mm';

/** Create/edit/delete one Google Calendar event. Tasks never open this; they open their note. */
export class EventModal extends Modal {
	private title = '';
	private calendarId = '';
	private allDay = false;
	private startDate = '';
	private startTime = '09:00';
	private endDate = '';
	private endTime = '10:00';
	private description = '';
	private deleteArmed = false;
	private busy = false;

	constructor(
		private plugin: GCalSync,
		private params: EventModalParams,
		private onDone: () => void,
	) {
		super(plugin.app);
		const ev = params.event;
		const enabled = Object.entries(plugin.settings.calendars).filter(([, c]) => c.enabled);
		this.calendarId = ev?.calendarId ?? params.calendarId ?? (enabled.find(([id]) => id === 'primary')?.[0] || enabled[0]?.[0] || '');
		this.allDay = ev?.allDay ?? params.allDay ?? false;
		this.title = ev?.title ?? '';
		this.description = ev?.description ?? '';
		const start = ev?.start ?? params.start ?? moment().format();
		const end = ev?.end ?? params.end ?? '';
		this.startDate = moment(start).format(DATE);
		if (this.allDay) {
			this.endDate = end ? moment(end).subtract(1, 'day').format(DATE) : this.startDate;
			if (moment(this.endDate).isBefore(this.startDate)) this.endDate = this.startDate;
		} else {
			const s = moment(start);
			const e = end ? moment(end) : s.clone().add(1, 'hour');
			this.startTime = s.format(TIME);
			this.endDate = e.format(DATE);
			this.endTime = e.format(TIME);
		}
	}

	onOpen(): void {
		const { contentEl } = this;
		const ev = this.params.event;
		this.modalEl.addClass('gcal-modal');
		this.setTitle(ev ? 'Edit event' : 'New event');
		if (ev?.recurringEventId) contentEl.createEl('p', { text: 'This is one occurrence of a repeating event. Changes apply to this occurrence only.', cls: 'gcal-modal-note' });

		new Setting(contentEl).setName('Title').addText((t) => {
			t.setValue(this.title).onChange((v) => {
				this.title = v;
				this.validate();
			});
			t.inputEl.addClass('gcal-modal-title');
			window.setTimeout(() => t.inputEl.focus(), 0);
		});
		new Setting(contentEl).setName('Calendar').addDropdown((d) => {
			for (const [id, c] of Object.entries(this.plugin.settings.calendars)) if (c.enabled || id === this.calendarId) d.addOption(id, c.name);
			d.setValue(this.calendarId).onChange((v) => {
				this.calendarId = v;
			});
			d.setDisabled(!!ev);
		});
		new Setting(contentEl).setName('All day').addToggle((t) =>
			t.setValue(this.allDay).onChange((v) => {
				this.allDay = v;
				times.forEach((el) => el.toggleClass('is-hidden', v));
				this.validate();
			}),
		);
		const times: HTMLElement[] = [];
		const dateRow = (name: string, date: string, time: string, set: (d: string, t: string) => void) => {
			const row = new Setting(contentEl).setName(name);
			const dateEl = row.controlEl.createEl('input', { type: 'date', value: date });
			const timeEl = row.controlEl.createEl('input', { type: 'time', value: time });
			timeEl.toggleClass('is-hidden', this.allDay);
			times.push(timeEl);
			const update = () => {
				set(dateEl.value, timeEl.value);
				this.validate();
			};
			dateEl.addEventListener('change', update);
			timeEl.addEventListener('change', update);
		};
		dateRow('Start', this.startDate, this.startTime, (d, t) => {
			this.startDate = d;
			this.startTime = t;
		});
		dateRow('End', this.endDate, this.endTime, (d, t) => {
			this.endDate = d;
			this.endTime = t;
		});
		new Setting(contentEl).setName('Notes').addTextArea((t) =>
			t.setValue(this.description).onChange((v) => {
				this.description = v;
			}),
		);

		const buttons = new Setting(contentEl);
		buttons.addButton((b) => {
			this.saveButton = b.buttonEl;
			b.setButtonText('Save').setCta().onClick(() => void this.save());
		});
		if (ev) {
			buttons.addButton((b) => {
				b.setButtonText('Delete').setDestructive().onClick(() => {
					if (!this.deleteArmed) {
						this.deleteArmed = true;
						b.setButtonText('Click again to delete');
						return;
					}
					void this.remove();
				});
			});
		}
		buttons.addButton((b) => b.setButtonText('Cancel').onClick(() => this.close()));
		this.validate();
	}

	onClose(): void {
		this.contentEl.empty();
	}

	private saveButton: HTMLButtonElement | null = null;

	private input(): EventInput | null {
		if (!this.title.trim() || !this.calendarId || !this.startDate || !this.endDate) return null;
		if (this.allDay) {
			if (moment(this.endDate).isBefore(this.startDate)) return null;
			return { title: this.title.trim(), allDay: true, start: this.startDate, end: moment(this.endDate).add(1, 'day').format(DATE), description: this.description };
		}
		const s = moment(`${this.startDate}T${this.startTime || '00:00'}`);
		const e = moment(`${this.endDate}T${this.endTime || '00:00'}`);
		if (!s.isValid() || !e.isValid() || e.isBefore(s)) return null;
		return { title: this.title.trim(), allDay: false, start: s.format(), end: e.format(), description: this.description };
	}

	private validate(): void {
		if (this.saveButton) this.saveButton.disabled = this.busy || !this.input();
	}

	private async save(): Promise<void> {
		const input = this.input();
		if (!input || this.busy) return;
		this.busy = true;
		this.validate();
		try {
			const ev = this.params.event;
			if (ev) await this.plugin.calendars.patch(ev.calendarId, ev.id, ev.etag, input);
			else await this.plugin.calendars.insert(this.calendarId, input);
			this.onDone();
			this.close();
		} catch (e) {
			new Notice(`Could not save to Google: ${errorMessage(e)}`);
			this.onDone();
		} finally {
			this.busy = false;
			this.validate();
		}
	}

	private async remove(): Promise<void> {
		const ev = this.params.event;
		if (!ev || this.busy) return;
		this.busy = true;
		try {
			await this.plugin.calendars.remove(ev.calendarId, ev.id);
			this.onDone();
			this.close();
		} catch (e) {
			new Notice(`Could not save to Google: ${errorMessage(e)}`);
		} finally {
			this.busy = false;
		}
	}
}
