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
	read(path: string): Promise<NotebookDoc | null>;
	list(prefix?: string): Promise<NotebookDocMeta[]>;
	delete(path: string): Promise<void>;
}
