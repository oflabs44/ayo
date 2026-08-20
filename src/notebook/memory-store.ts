import {
	isValidNotebookPath,
	type NotebookDoc,
	type NotebookDocMeta,
	type NotebookStore,
} from "./store";

function validatePath(path: string): void {
	if (!isValidNotebookPath(path)) {
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

function matchesPrefix(path: string, prefix?: string): boolean {
	return prefix === undefined || path === prefix || path.startsWith(`${prefix}/`);
}

function isDirectChild(path: string, prefix?: string): boolean {
	if (path === prefix) return true;
	const relativePath = prefix === undefined ? path : path.slice(prefix.length + 1);
	return relativePath.length > 0 && !relativePath.includes("/");
}

export class InMemoryNotebookStore implements NotebookStore {
	private readonly revisions = new Map<string, NotebookDoc[]>();
	private version = 0;
	private lastUpdatedAt?: string;

	async write(
		path: string,
		input: { content: string; title?: string },
	): Promise<NotebookDoc> {
		validatePath(path);
		const revisions = this.revisions.get(path) ?? [];
		const existing = revisions.at(-1);
		const updatedAt = nextTimestamp(this.lastUpdatedAt);
		this.lastUpdatedAt = updatedAt;
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
		revisions.push(doc);
		this.revisions.set(path, revisions);
		return copyDoc(doc);
	}

	async read(
		path: string,
		opts?: { version?: string },
	): Promise<NotebookDoc | null> {
		validatePath(path);
		const revisions = this.revisions.get(path);
		if (!revisions) return null;
		const doc =
			opts?.version === undefined
				? revisions.at(-1)
				: revisions.find(({ version }) => version === opts.version);
		return doc ? copyDoc(doc) : null;
	}

	async history(
		path: string,
	): Promise<Array<{ version: string; updatedAt: string }>> {
		validatePath(path);
		return (this.revisions.get(path) ?? [])
			.toReversed()
			.map(({ version, metadata }) => ({
				version,
				updatedAt: metadata.updatedAt,
			}));
	}

	async list(
		query: {
			prefix?: string;
			recursive?: boolean;
			orderBy?: "path" | "updatedAt";
			limit?: number;
		} = {},
	): Promise<NotebookDocMeta[]> {
		if (query.prefix !== undefined) {
			validatePath(query.prefix);
		}
		const recursive = query.recursive ?? true;
		const orderBy = query.orderBy ?? "path";
		const docs = [...this.revisions.values()]
			.map((revisions) => revisions.at(-1)!)
			.filter(
				(doc) =>
					matchesPrefix(doc.path, query.prefix) &&
					(recursive || isDirectChild(doc.path, query.prefix)),
			)
			.sort((left, right) =>
				orderBy === "updatedAt"
					? right.metadata.updatedAt.localeCompare(left.metadata.updatedAt) ||
						left.path.localeCompare(right.path)
					: left.path.localeCompare(right.path),
			);
		return docs.slice(0, query.limit).map(copyMeta);
	}

	async delete(path: string): Promise<boolean> {
		validatePath(path);
		return this.revisions.delete(path);
	}
}
