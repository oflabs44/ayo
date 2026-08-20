export type NotebookDoc = {
	path: string;
	version: string;
	metadata: {
		title: string;
		createdAt: string;
		updatedAt: string;
	};
	content: string;
	sourceUrl?: string;
};

export type NotebookDocMeta = Omit<NotebookDoc, "content">;

export interface NotebookStore {
	write(
		path: string,
		input: { content: string; title?: string },
	): Promise<NotebookDoc>;
	read(path: string, opts?: { version?: string }): Promise<NotebookDoc | null>;
	history(path: string): Promise<Array<{ version: string; updatedAt: string }>>;
	list(query?: {
		prefix?: string;
		recursive?: boolean;
		orderBy?: "path" | "updatedAt";
		limit?: number;
	}): Promise<NotebookDocMeta[]>;
	/** Returns whether a document existed at the path and was removed. */
	delete(path: string): Promise<boolean>;
}

const VALID_PATH = /^[a-z0-9_./-]+$/;

/** Single authority for notebook path validity, shared by stores and schemas. */
export function isValidNotebookPath(path: string): boolean {
	return (
		path.length > 0 &&
		!path.startsWith("/") &&
		!path.endsWith("/") &&
		VALID_PATH.test(path) &&
		path
			.split("/")
			.every((segment) => segment !== "" && segment !== "." && segment !== "..")
	);
}
