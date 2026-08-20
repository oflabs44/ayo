import type { NotebookDoc, NotebookDocMeta, NotebookStore } from "./store";

const VALID_PATH = /^[a-z0-9_./-]+$/;

function validatePath(path: string): void {
	const segments = path.split("/");
	if (
		!path ||
		path.startsWith("/") ||
		path.endsWith("/") ||
		!VALID_PATH.test(path) ||
		segments.some((segment) => !segment || segment === "..")
	) {
		throw new Error(`Invalid notebook path: ${path}`);
	}
}

function copyDoc(doc: NotebookDoc): NotebookDoc {
	return { ...doc, metadata: { ...doc.metadata } };
}

function copyMeta(doc: NotebookDoc): NotebookDocMeta {
	const { content: _content, ...metadata } = copyDoc(doc);
	return metadata;
}

function nextTimestamp(previous?: string): string {
	const now = Date.now();
	const timestamp = previous
		? Math.max(now, Date.parse(previous) + 1)
		: now;
	return new Date(timestamp).toISOString();
}

export class InMemoryNotebookStore implements NotebookStore {
	private readonly docs = new Map<string, NotebookDoc>();
	private version = 0;

	async write(
		path: string,
		input: { content: string; title?: string },
	): Promise<NotebookDoc> {
		validatePath(path);
		const existing = this.docs.get(path);
		const updatedAt = nextTimestamp(existing?.metadata.updatedAt);
		const doc: NotebookDoc = {
			path,
			version: String(++this.version),
			metadata: {
				title: input.title ?? path.split("/").at(-1)!,
				createdAt: existing?.metadata.createdAt ?? updatedAt,
				updatedAt,
			},
			content: input.content,
		};
		this.docs.set(path, doc);
		return copyDoc(doc);
	}

	async read(path: string): Promise<NotebookDoc | null> {
		validatePath(path);
		const doc = this.docs.get(path);
		return doc ? copyDoc(doc) : null;
	}

	async list(prefix?: string): Promise<NotebookDocMeta[]> {
		if (prefix !== undefined) {
			validatePath(prefix);
		}
		return [...this.docs.values()]
			.filter((doc) => prefix === undefined || doc.path.startsWith(prefix))
			.sort((left, right) => left.path.localeCompare(right.path))
			.map(copyMeta);
	}

	async delete(path: string): Promise<void> {
		validatePath(path);
		this.docs.delete(path);
	}
}
