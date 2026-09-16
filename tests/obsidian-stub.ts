// Minimal stand-in for the `obsidian` module so pure logic can run under node:test.
export class TFile {
	path = '';
	basename = '';
	extension = 'md';
	stat = { mtime: 0, ctime: 0, size: 0 };
	parent: TFolder | null = null;
}
export class TFolder {
	path = '';
	name = '';
	children: Array<TFile | TFolder> = [];
}
export class Notice {
	constructor(public message: string) {}
}
export class Modal {}
export class MarkdownRenderChild {
	constructor(public containerEl: unknown) {}
}
export class PluginSettingTab {}
export class Setting {}
export const Platform = { isDesktop: true, isMobile: false };
export const moment = () => ({ format: () => '' });
export function getLanguage() {
	return 'en';
}
export function normalizePath(p: string) {
	return p
		.replace(/\\/g, '/')
		.replace(/\/+/g, '/')
		.replace(/^\/|\/$/g, '');
}
export function debounce<T extends (...a: unknown[]) => unknown>(fn: T) {
	return fn;
}
export function parseYaml(src: string): unknown {
	const out: Record<string, unknown> = {};
	for (const line of src.split('\n')) {
		const m = line.match(/^([\w-]+):\s*(.*)$/);
		if (!m) {
			if (line.trim()) throw new Error('bad yaml');
			continue;
		}
		const k = m[1] as string;
		const v = (m[2] as string).trim();
		if (v === 'true' || v === 'false') out[k] = v === 'true';
		else if (v.startsWith('['))
			out[k] = v
				.slice(1, -1)
				.split(',')
				.map((s) => s.trim())
				.filter(Boolean);
		else if (/^\d+$/.test(v)) out[k] = Number(v);
		else out[k] = v;
	}
	return out;
}
type Req = Record<string, unknown>;
type Res = { status: number; text: string; headers: Record<string, string> };
let requestUrlImpl: (req: Req) => Promise<Res> = () =>
	Promise.reject(new Error('requestUrl not stubbed'));
export function setRequestUrl(fn: (req: Req) => Promise<Res>) {
	requestUrlImpl = fn;
}
export function requestUrl(req: Req) {
	return requestUrlImpl(req);
}
