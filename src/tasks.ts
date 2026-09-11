import { TFile, TFolder, normalizePath, type App } from 'obsidian';
import type { Cache, TaskIndex } from './cache';
import { GoogleError, type GoogleClient } from './google';

const API = 'https://tasks.googleapis.com/tasks/v1';
export const TASK_STATUSES = ['backlog', 'active', 'blocked', 'done'] as const;

export interface TaskNote {
	file: TFile;
	project: string;
	title: string;
	due: string;
	status: string;
	googleId: string;
}

interface GoogleTask {
	id: string;
	title?: string;
	notes?: string;
	status?: 'needsAction' | 'completed';
	due?: string;
	completed?: string | null;
	updated?: string;
	deleted?: boolean;
}

interface Remote {
	task: GoogleTask;
	listId: string;
	project: string;
}

export interface MirrorResult {
	pushed: number;
	pulled: number;
	imported: number;
	deleted: number;
	total: number;
}

export interface MirrorHost {
	app: App;
	google: GoogleClient;
	cache: Cache;
	settings: { projectsFolder: string; taskLists: Record<string, string> };
	/** Persists settings after taskLists changed. */
	saveSettings(): Promise<void>;
}

function fmString(v: unknown): string {
	if (typeof v === 'string') return v.trim();
	if (typeof v === 'number') return String(v);
	if (v instanceof Date) return v.toISOString().slice(0, 10);
	return '';
}

type Frontmatter = Record<string, unknown>;

/** Task notes under <projectsFolder>/<project>/tasks/*.md whose frontmatter has type: Task. */
export function collectTaskNotes(app: App, projectsFolder: string): TaskNote[] {
	const root = app.vault.getFolderByPath(normalizePath(projectsFolder));
	const out: TaskNote[] = [];
	if (!root) return out;
	for (const project of root.children) {
		if (!(project instanceof TFolder)) continue;
		const tasks = app.vault.getFolderByPath(`${project.path}/tasks`);
		if (!tasks) continue;
		for (const f of tasks.children) {
			if (!(f instanceof TFile) || f.extension !== 'md') continue;
			const fm = app.metadataCache.getFileCache(f)?.frontmatter;
			if (!fm || fm.type !== 'Task') continue;
			out.push({
				file: f,
				project: project.name,
				title: fmString(fm.title) || f.basename,
				due: fmString(fm.due).slice(0, 10),
				status: fmString(fm.status) || 'backlog',
				googleId: fmString(fm.google_task_id),
			});
		}
	}
	return out;
}

export function safeFileName(title: string): string {
	const s = title
		.replace(/[\\/:*?"<>|#^[\]]/g, ' ')
		.replace(/\s+/g, ' ')
		.trim();
	return s || 'Untitled task';
}

function toDue(due: string): string | undefined {
	return /^\d{4}-\d{2}-\d{2}$/.test(due) ? `${due}T00:00:00.000Z` : undefined;
}

export class TaskMirror {
	private lists: Array<{ id: string; title: string }> | null = null;

	constructor(private host: MirrorHost) {}

	private get app() {
		return this.host.app;
	}

	async sync(): Promise<MirrorResult> {
		const result: MirrorResult = { pushed: 0, pulled: 0, imported: 0, deleted: 0, total: 0 };
		const root = this.app.vault.getFolderByPath(normalizePath(this.host.settings.projectsFolder));
		if (!root) return result;
		const projects = root.children.filter((c): c is TFolder => c instanceof TFolder).map((f) => f.name);
		if (projects.length === 0) return result;
		this.lists = null;
		let listsChanged = false;

		// 1. Remote tasks of every current project list.
		const remote = new Map<string, Remote>();
		const listOf: Record<string, string> = {};
		for (const project of projects) {
			let listId: string = this.host.settings.taskLists[project] ?? '';
			let tasks: GoogleTask[] | null = listId ? await this.listTasks(listId) : null;
			if (!tasks) {
				listId = await this.ensureList(project);
				listsChanged = true;
				tasks = (await this.listTasks(listId)) ?? [];
			}
			listOf[project] = listId;
			for (const t of tasks) if (!t.deleted) remote.set(t.id, { task: t, listId, project });
		}

		// 2. Local notes.
		const notes = collectTaskNotes(this.app, this.host.settings.projectsFolder);
		const index = this.host.cache.taskIndex();
		const idByPath = new Map(Object.entries(index).map(([id, path]) => [path, id]));
		const nextIndex: TaskIndex = {};
		const matched = new Set<string>();

		for (const note of notes) {
			const listId = listOf[note.project];
			if (!listId) continue;
			// The metadata cache can lag behind an id this plugin just wrote; the previous index knows it.
			const googleId = remote.has(note.googleId) ? note.googleId : (idByPath.get(note.file.path) ?? note.googleId);
			let r = googleId ? remote.get(googleId) : undefined;
			if (r && matched.has(r.task.id)) r = undefined; // two notes claim one task: the second is re-created
			if (!r) {
				const created = await this.insert(listId, note);
				await this.app.fileManager.processFrontMatter(note.file, (fm: Frontmatter) => {
					fm.google_task_id = created.id;
				});
				nextIndex[created.id] = note.file.path;
				result.pushed++;
				continue;
			}
			matched.add(r.task.id);
			if (r.listId !== listId) {
				r.task = await this.host.google.call<GoogleTask>('POST', `${API}/lists/${enc(r.listId)}/tasks/${enc(r.task.id)}/move`, {
					query: { destinationTasklist: listId },
				});
				r.listId = listId;
				result.pushed++;
			}
			const changed = await this.reconcile(note, r);
			if (changed === 'pushed') result.pushed++;
			else if (changed === 'pulled') result.pulled++;
			nextIndex[r.task.id] = note.file.path;
		}

		// 3. Remote tasks without a note: deleted note → delete task; otherwise import as a note.
		for (const [id, r] of remote) {
			if (matched.has(id)) continue;
			const knownPath = index[id];
			if (knownPath) {
				const existing = this.app.vault.getFileByPath(knownPath);
				if (existing) {
					// The note still exists but was not scanned (metadata not ready or moved out of the projects folder). Leave both sides alone.
					nextIndex[id] = knownPath;
					continue;
				}
				await this.host.google.call('DELETE', `${API}/lists/${enc(r.listId)}/tasks/${enc(id)}`);
				result.deleted++;
				continue;
			}
			const path = await this.importNote(r);
			nextIndex[id] = path;
			result.imported++;
		}

		this.host.cache.saveTaskIndex(nextIndex);
		if (listsChanged) await this.host.saveSettings();
		result.total = Object.keys(nextIndex).length;
		return result;
	}

	private async listTasks(listId: string): Promise<GoogleTask[] | null> {
		const out: GoogleTask[] = [];
		let pageToken: string | undefined;
		try {
			do {
				const page = await this.host.google.call<{ items?: GoogleTask[]; nextPageToken?: string }>('GET', `${API}/lists/${enc(listId)}/tasks`, {
					query: { showCompleted: true, showHidden: true, maxResults: 100, pageToken },
				});
				out.push(...(page.items ?? []));
				pageToken = page.nextPageToken;
			} while (pageToken);
		} catch (e) {
			if (e instanceof GoogleError && e.status === 404) return null; // list was deleted at Google
			throw e;
		}
		return out;
	}

	private async ensureList(project: string): Promise<string> {
		if (!this.lists) {
			const page = await this.host.google.call<{ items?: Array<{ id: string; title: string }> }>('GET', `${API}/users/@me/lists`, { query: { maxResults: 100 } });
			this.lists = page.items ?? [];
		}
		let list = this.lists.find((l) => l.title === project);
		if (!list) {
			list = await this.host.google.call<{ id: string; title: string }>('POST', `${API}/users/@me/lists`, { body: { title: project } });
			this.lists.push(list);
		}
		this.host.settings.taskLists[project] = list.id;
		return list.id;
	}

	private body(note: TaskNote): Record<string, unknown> {
		const body: Record<string, unknown> = {
			title: note.title,
			status: note.status === 'done' ? 'completed' : 'needsAction',
			notes: this.backlink(note.file),
		};
		const due = toDue(note.due);
		if (due) body.due = due;
		return body;
	}

	private backlink(file: TFile): string {
		const vault = encodeURIComponent(this.app.vault.getName());
		return `obsidian://open?vault=${vault}&file=${encodeURIComponent(file.path.replace(/\.md$/, ''))}`;
	}

	private insert(listId: string, note: TaskNote): Promise<GoogleTask> {
		return this.host.google.call<GoogleTask>('POST', `${API}/lists/${enc(listId)}/tasks`, { body: this.body(note) });
	}

	/** Field owners: note wins unless Google's `updated` is newer than the file's mtime. Only differing fields move. */
	private async reconcile(note: TaskNote, r: Remote): Promise<'pushed' | 'pulled' | null> {
		const t = r.task;
		const remoteDue = (t.due ?? '').slice(0, 10);
		const remoteDone = t.status === 'completed';
		const localDone = note.status === 'done';
		const diff = {
			title: (t.title ?? '') !== note.title,
			due: remoteDue !== note.due,
			status: remoteDone !== localDone,
		};
		if (!diff.title && !diff.due && !diff.status) return null;
		const remoteNewer = Date.parse(t.updated ?? '') > note.file.stat.mtime;
		if (remoteNewer) {
			await this.app.fileManager.processFrontMatter(note.file, (fm: Frontmatter) => {
				if (diff.title) fm.title = t.title ?? '';
				if (diff.due) {
					if (remoteDue) fm.due = remoteDue;
					else delete fm.due;
				}
				if (diff.status) {
					if (remoteDone) fm.status = 'done';
					else if (localDone) fm.status = 'backlog';
				}
			});
			if (diff.title && t.title) {
				const target = await this.freePath(note.file.parent?.path ?? '', t.title, note.file);
				if (target !== note.file.path) await this.app.fileManager.renameFile(note.file, target);
			}
			return 'pulled';
		}
		const patch: Record<string, unknown> = {};
		if (diff.title) patch.title = note.title;
		if (diff.due) patch.due = toDue(note.due) ?? null;
		if (diff.status) {
			patch.status = localDone ? 'completed' : 'needsAction';
			if (!localDone) patch.completed = null;
		}
		r.task = await this.host.google.call<GoogleTask>('PATCH', `${API}/lists/${enc(r.listId)}/tasks/${enc(t.id)}`, { body: patch });
		return 'pushed';
	}

	private async importNote(r: Remote): Promise<string> {
		const folder = normalizePath(`${this.host.settings.projectsFolder}/${r.project}/tasks`);
		if (!this.app.vault.getFolderByPath(folder)) await this.app.vault.createFolder(folder);
		const title = (r.task.title ?? '').trim() || 'Untitled task';
		const path = await this.freePath(folder, title, null);
		const today = new Date().toISOString().slice(0, 10);
		const due = (r.task.due ?? '').slice(0, 10);
		const lines = [
			'---',
			'type: Task',
			`title: ${JSON.stringify(title)}`,
			'description: ""',
			'resources: []',
			'tags: []',
			`status: ${r.task.status === 'completed' ? 'done' : 'backlog'}`,
			`due: ${due}`,
			'blocked_by: ',
			`google_task_id: ${r.task.id}`,
			`created: ${today}`,
			`modified: ${today}`,
			'---',
			'',
		];
		const file = await this.app.vault.create(path, lines.join('\n'));
		await this.host.google.call('PATCH', `${API}/lists/${enc(r.listId)}/tasks/${enc(r.task.id)}`, { body: { notes: this.backlink(file) } });
		return file.path;
	}

	/** `<folder>/<title>.md`, adding " 2", " 3", … while another file owns the path. */
	private async freePath(folder: string, title: string, self: TFile | null): Promise<string> {
		const base = safeFileName(title);
		for (let n = 1; ; n++) {
			const path = normalizePath(`${folder}/${base}${n > 1 ? ` ${n}` : ''}.md`);
			const existing = this.app.vault.getAbstractFileByPath(path);
			if (!existing || existing === self) return path;
		}
	}
}

function enc(s: string): string {
	return encodeURIComponent(s);
}
