// Interfaces, not a recursive type alias: the alias trips TS2589 where the
// Bureau binding types instantiate it, the same way it does in Bureau.
export type JsonValue = string | number | boolean | null | JsonArray | JsonObject;
export interface JsonArray extends Array<JsonValue> {}
export interface JsonObject {
	[key: string]: JsonValue;
}

const RESERVED_METADATA_KEYS = ["title", "createdAt", "updatedAt"] as const;
const MAX_METADATA_BYTES = 8 * 1_024;

type ReservedMetadataKey = (typeof RESERVED_METADATA_KEYS)[number];

/** The reserved keys the store owns, beside whatever JSON the caller filed. */
export interface NotebookMetadata extends Record<ReservedMetadataKey, string> {
	[key: string]: JsonValue;
}

export type NotebookWriteInput = {
	content: string;
	title?: string;
	/** Omitted inherits the live document's metadata; an empty object clears it. */
	metadata?: JsonObject;
};

export type NotebookDoc = {
	path: string;
	version: string;
	metadata: NotebookMetadata;
	content: string;
	sourceUrl?: string;
};

export type NotebookDocMeta = Omit<NotebookDoc, "content">;

export interface NotebookStore {
	write(path: string, input: NotebookWriteInput): Promise<NotebookDoc>;
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

/**
 * Single authority for caller-defined metadata validity, shared by stores and
 * schemas. Mirrors Bureau: reserved keys and over 8 KB serialized are refused.
 */
export function notebookMetadataIssue(
	metadata: JsonObject,
): string | undefined {
	const reserved = Object.keys(metadata).filter((key) =>
		RESERVED_METADATA_KEYS.some((reservedKey) => reservedKey === key),
	);
	if (reserved.length > 0) {
		return `Notebook metadata keys are reserved: ${reserved.join(", ")}`;
	}

	const size = new TextEncoder().encode(JSON.stringify(metadata)).length;
	if (size > MAX_METADATA_BYTES) {
		return `Notebook metadata is ${size} bytes, over the ${MAX_METADATA_BYTES}-byte limit`;
	}
	return undefined;
}
