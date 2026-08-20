import type { BureauBinding } from "../env";
import type {
	NotebookDoc,
	NotebookDocMeta,
	NotebookStore,
} from "./store";

type BureauNotebookDoc = NonNullable<
	Awaited<ReturnType<BureauBinding["readNotebookDoc"]>>
>;
type BureauNotebookDocMeta = Awaited<
	ReturnType<BureauBinding["listNotebookDocs"]>
>[number];

function mapMetadata(doc: BureauNotebookDocMeta): NotebookDocMeta {
	return {
		path: doc.path,
		version: doc.version,
		metadata: {
			title: doc.metadata.title,
			createdAt: doc.metadata.createdAt,
			updatedAt: doc.metadata.updatedAt,
		},
	};
}

function mapDocument(doc: BureauNotebookDoc): NotebookDoc {
	return { ...mapMetadata(doc), content: doc.content };
}

export class BureauNotebookStore implements NotebookStore {
	constructor(private readonly bureau: BureauBinding) {}

	async write(
		path: string,
		input: { content: string; title?: string },
	): Promise<NotebookDoc> {
		return mapDocument(await this.bureau.writeNotebookDoc({ path, ...input }));
	}

	async read(
		path: string,
		opts?: { version?: string },
	): Promise<NotebookDoc | null> {
		const doc = await this.bureau.readNotebookDoc({ path, ...opts });
		return doc ? mapDocument(doc) : null;
	}

	async list(
		query: {
			prefix?: string;
			recursive?: boolean;
			orderBy?: "path" | "updatedAt";
			limit?: number;
		} = {},
	): Promise<NotebookDocMeta[]> {
		return (await this.bureau.listNotebookDocs(query)).map(mapMetadata);
	}

	async history(
		path: string,
	): Promise<Array<{ version: string; updatedAt: string }>> {
		return (await this.bureau.notebookHistory({ path })).map(
			({ version, updatedAt }) => ({ version, updatedAt }),
		);
	}

	delete(path: string): Promise<boolean> {
		return this.bureau.deleteNotebookDoc({ path });
	}
}
