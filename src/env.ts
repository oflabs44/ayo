import type { OAuthHelpers } from "@cloudflare/workers-oauth-provider";
import type {
	JsonObject,
	NotebookMetadata,
	NotebookStore,
} from "./notebook/store";

type AiBinding = {
	run(
		model: string,
		input: { text: string[] },
	): Promise<{ data: number[][] }>;
	run(
		model: string,
		input: Record<string, unknown>,
		options?: {
			gateway: { id: string; skipCache?: boolean; cacheTtl?: number };
		},
	): Promise<unknown>;
	aiGatewayLogId?: string | null;
};

type BureauNotebookDocMeta = {
	path: string;
	version: string;
	metadata: NotebookMetadata;
};

type BureauNotebookDoc = BureauNotebookDocMeta & { content: string };

type BureauMessageSummary = { id: string } & Record<string, unknown>;
type BureauThread = { messages: BureauMessageSummary[] } & Record<
	string,
	unknown
>;
type BureauRecipient = { address: string; name?: string };
type BureauMailbox = {
	path: string;
	name: string;
	/** One of Bureau's SPECIAL_USE_ATTRIBUTES; never \Inbox, which IMAP has no
	 * attribute for. INBOX is identified by its path. */
	specialUse: string | null;
	delimiter: string;
	/** \Noselect: a naming node that cannot be SELECTed, so not a move target. */
	noselect: boolean;
	/** Present only when the server advertises LIST-STATUS (RFC 5819);
	 * absent is not zero. */
	messages?: number;
	unseen?: number;
};
type BureauCalendar = {
	id: string;
	account: string;
	kind: "calendar";
	url: string;
	displayName: string | null;
	color: string | null;
	updatedAt: string;
};
type BureauCalendarEvent = {
	id: string;
	calendar: string;
	uid: string;
	summary: string | null;
	start: string;
	end: string;
	allDay: boolean;
	location: string | null;
	description: string | null;
	rrule?: string;
	alarms: BureauAlarmRead[];
	status: string | null;
	etag: string;
};
type BureauCalendarEventWrite = {
	address: string;
	calendar: string;
	summary: string;
	start: string;
	end?: string;
	duration?: string;
	allDay?: boolean;
	location?: string;
	description?: string;
	rrule?: string;
	alarms?: BureauAlarmWrite[];
};
type BureauTodo = {
	id: string;
	calendar: string;
	uid: string;
	summary: string | null;
	status: string | null;
	start: string | null;
	due: string | null;
	completed: string | null;
	priority: number | null;
	rrule?: string;
	alarms: BureauAlarmRead[];
	etag: string;
};
type BureauTag = {
	id: string;
	name: string;
	keyword: string;
	color: string | null;
	createdAt: string;
};
type BureauContact = {
	id: string;
	addressbook: string;
	fn: string | null;
	emails: Array<Record<string, unknown>>;
	tels: Array<Record<string, unknown>>;
	etag: string;
} & Record<string, unknown>;
type BureauContactWrite = {
	address: string;
	addressbook: string;
	fn: string;
} & Record<string, unknown>;
type BureauAlarmRead = {
	trigger: string;
	action?: string;
	related?: "START" | "END";
	description?: string;
};
type BureauAlarmWrite = {
	trigger: string;
	action?: "DISPLAY" | "EMAIL" | "AUDIO";
	related?: "START" | "END";
	description?: string;
};
type BureauTodoCreate = {
	address: string;
	calendar: string;
	summary: string;
	start?: string;
	due?: string;
	description?: string;
	priority?: number;
	status?: string;
	rrule?: string;
	alarms?: BureauAlarmWrite[];
};
type BureauTodoUpdate = {
	address: string;
	id: string;
	etag?: string;
	status?: string;
	start?: string | null;
	due?: string | null;
	summary?: string | null;
	description?: string | null;
	priority?: number | null;
	rrule?: string | null;
	alarms?: BureauAlarmWrite[] | null;
};

export type BureauBinding = {
	writeNotebookDoc(input: {
		path: string;
		content: string;
		title?: string;
		metadata?: JsonObject;
	}): Promise<BureauNotebookDoc>;
	readNotebookDoc(input: {
		path: string;
		version?: string;
	}): Promise<BureauNotebookDoc | null>;
	listNotebookDocs(input: {
		prefix?: string;
		recursive?: boolean;
		orderBy?: "path" | "updatedAt";
		limit?: number;
	}): Promise<BureauNotebookDocMeta[]>;
	notebookHistory(input: {
		path: string;
	}): Promise<Array<{ version: string; updatedAt: string }>>;
	deleteNotebookDoc(input: { path: string }): Promise<boolean>;
	listAccounts(input: Record<string, never>): Promise<unknown[]>;
	listMailboxes(input: { address: string }): Promise<BureauMailbox[]>;
	createMailbox(input: {
		address: string;
		path: string;
	}): Promise<{ path: string }>;
	renameMailbox(input: {
		address: string;
		path: string;
		to: string;
	}): Promise<{ path: string }>;
	deleteMailbox(input: {
		address: string;
		path: string;
	}): Promise<{ path: string }>;
	listTags(input: Record<string, never>): Promise<BureauTag[]>;
	createTag(input: { name: string; color?: string }): Promise<BureauTag>;
	updateTag(input: {
		id: string;
		name?: string;
		color?: string | null;
	}): Promise<BureauTag>;
	deleteTag(input: { id: string }): Promise<{ id: string }>;
	listThreads(input: {
		address: string;
		folder?: string;
		starred?: boolean;
		tag?: string;
		limit?: number;
		before?: string;
		beforeId?: string;
	}): Promise<unknown[]>;
	listMessages(input: {
		address: string;
		folder?: string;
		threadId?: string;
		tag?: string;
		limit?: number;
		before?: string;
	}): Promise<unknown[]>;
	getThread(input: { address: string; id: string }): Promise<BureauThread>;
	getMessage(input: {
		address: string;
		id: string;
	}): Promise<Record<string, unknown>>;
	moveMessage(input: {
		address: string;
		id: string;
		to: string;
	}): Promise<BureauMessageSummary>;
	setMessageFlags(input: {
		address: string;
		id: string;
		add?: string[];
		remove?: string[];
	}): Promise<BureauMessageSummary>;
	send(input: {
		address: string;
		to?: BureauRecipient[];
		cc?: BureauRecipient[];
		bcc?: BureauRecipient[];
		fromName?: string;
		subject: string;
		text: string;
		html?: string;
		reference?: { id: string; action: "reply" | "replyAll" | "forward" };
	}): Promise<{
		id: string | null;
		threadId: string | null;
		messageId: string;
		rejected: string[];
		warning?: string;
	}>;
	listCalendars(input: { address: string }): Promise<BureauCalendar[]>;
	createCalendar(input: {
		address: string;
		name: string;
		color?: string;
	}): Promise<BureauCalendar>;
	listEvents(input: {
		address: string;
		from: string;
		to: string;
		calendar?: string;
	}): Promise<BureauCalendarEvent[]>;
	getEvent(input: {
		address: string;
		id: string;
	}): Promise<BureauCalendarEvent & { raw: string }>;
	createEvent(input: BureauCalendarEventWrite): Promise<BureauCalendarEvent>;
	updateEvent(
		input: BureauCalendarEventWrite & { id: string; etag: string },
	): Promise<BureauCalendarEvent>;
	removeEvent(input: {
		address: string;
		id: string;
		etag?: string;
	}): Promise<{ id: string }>;
	listTodos(input: {
		address: string;
		calendar?: string;
		status?: string;
		dueBefore?: string;
	}): Promise<BureauTodo[]>;
	getTodo(input: {
		address: string;
		id: string;
	}): Promise<BureauTodo & { raw: string }>;
	createTodo(input: BureauTodoCreate): Promise<BureauTodo>;
	updateTodo(input: BureauTodoUpdate): Promise<BureauTodo>;
	removeTodo(input: {
		address: string;
		id: string;
		etag?: string;
	}): Promise<{ id: string }>;
	listContacts(input: {
		address: string;
		q?: string;
		addressbook?: string;
	}): Promise<BureauContact[]>;
	getContact(input: {
		address: string;
		id: string;
	}): Promise<BureauContact & { raw: string }>;
	createContact(input: BureauContactWrite): Promise<BureauContact>;
	removeContact(input: {
		address: string;
		id: string;
		etag?: string;
	}): Promise<{ id: string }>;
};

export type DocumentType =
	| "invoice"
	| "contract"
	| "notice"
	| "statement"
	| "reminder"
	| "letter"
	| "other";
export type OcrStatus = "pending" | "processing" | "completed" | "failed";
export type ProcessingStatus = "pending" | "processing" | "completed" | "failed";

export type PublicDocument = {
	id: string;
	/** Falls back to `originalName` while `titleOverride` is null. */
	title: string;
	titleOverride: string | null;
	originalName: string;
	mimeType: string;
	size: number;
	checksum: string;
	folderId: string | null;
	folder: { id: string; name: string; path: string } | null;
	tags: Array<{ id: string; name: string }>;
	correspondent: string | null;
	type: DocumentType | null;
	receivedOn: string | null;
	notes: string | null;
	processingStatus: ProcessingStatus;
	ocrStatus: OcrStatus;
	ocrText: string | null;
	ocrError: string | null;
	pageCount: number | null;
	ocrCompletedAt: string | null;
	preview: { kind: "image" | "pdf" | "unsupported" };
	createdAt: string;
	updatedAt: string;
	deletedAt: string | null;
};

/** `listDocuments`/`searchDocuments`/`moveDocuments`/`trashDocuments` shape:
 * every `PublicDocument` field except the ones a list page should not carry. */
export type PublicDocumentSummary = Omit<
	PublicDocument,
	"checksum" | "notes" | "ocrText"
>;

export type DocumentListInput = {
	query?: string;
	/** A folder id, or the literal "unfiled" for documents in no folder. */
	folderId?: string;
	tagIds?: string[];
	correspondents?: string[];
	types?: DocumentType[];
	ocrStatuses?: OcrStatus[];
	processingStatuses?: ProcessingStatus[];
	receivedFrom?: string;
	receivedTo?: string;
	trashed?: boolean;
	limit?: number;
	cursor?: string;
};

export type DocumentPage = {
	documents: PublicDocumentSummary[];
	nextCursor: string | null;
};

export type DocumentUpdateInput = {
	id: string;
	title?: string | null;
	correspondent?: string | null;
	type?: DocumentType | null;
	receivedOn?: string | null;
	notes?: string | null;
};

type DocumentFolder = {
	id: string;
	parentId: string | null;
	name: string;
	createdAt: string;
	updatedAt: string;
	depth: number;
	path: string;
	documentCount: number;
};
type DocumentTag = {
	id: string;
	name: string;
	documentCount: number;
	createdAt: string;
};

/** Bureau's `bureau-files` FilesRpc WorkerEntrypoint. */
export type FilesBinding = {
	listDocuments(input: DocumentListInput): Promise<DocumentPage>;
	searchDocuments(
		input: DocumentListInput & { query: string },
	): Promise<DocumentPage>;
	getDocument(input: { id: string }): Promise<PublicDocument | null>;
	listCorrespondents(input: Record<string, never>): Promise<string[]>;
	updateDocument(input: DocumentUpdateInput): Promise<PublicDocument>;
	/** Full replacement of the document's tag set. */
	updateDocumentTags(input: {
		id: string;
		tagIds: string[];
	}): Promise<PublicDocument>;
	/** Atomic add-and-remove delta against the document's tag set. */
	changeDocumentTags(input: {
		id: string;
		addTagIds?: string[];
		removeTagIds?: string[];
	}): Promise<PublicDocument>;
	moveDocuments(input: {
		ids: string[];
		folderId: string | null;
	}): Promise<PublicDocumentSummary[]>;
	trashDocuments(input: { ids: string[] }): Promise<PublicDocumentSummary[]>;
	restoreDocument(input: { id: string }): Promise<PublicDocument>;
	retryDocumentProcessing(input: { id: string }): Promise<PublicDocument>;
	listDocumentFolders(input: Record<string, never>): Promise<DocumentFolder[]>;
	createDocumentFolder(input: {
		name: string;
		parentId?: string | null;
	}): Promise<DocumentFolder>;
	updateDocumentFolder(input: {
		id: string;
		name?: string;
		parentId?: string | null;
	}): Promise<DocumentFolder>;
	deleteDocumentFolder(input: { id: string }): Promise<{ deleted: true }>;
	listDocumentTags(input: Record<string, never>): Promise<DocumentTag[]>;
	createDocumentTag(input: { name: string }): Promise<DocumentTag>;
	updateDocumentTag(input: { id: string; name: string }): Promise<DocumentTag>;
	deleteDocumentTag(input: { id: string }): Promise<{ deleted: true }>;
	/** Streams the request body straight through; callers must not buffer it. */
	uploadDocument(
		input: {
			filename: string;
			mime: string;
			size: number;
			title?: string | null;
			folderId?: string | null;
		},
		body: ReadableStream<Uint8Array>,
	): Promise<{
		status: "created" | "existing" | "restored";
		document: PublicDocument;
	}>;
	getDocumentFile(input: { id: string }): Promise<Response>;
	getDocumentPreview(input: { id: string }): Promise<Response>;
};

type VectorizeBinding = {
	deleteByIds(ids: string[]): Promise<unknown>;
	upsert(
		vectors: Array<{ id: string; values: number[]; namespace: string }>,
	): Promise<unknown>;
	query(
		vector: number[],
		options: { topK: number; namespace: string },
	): Promise<{ matches: Array<{ id: string; score: number }> }>;
};

export type OwnerProps = {
	email: string;
	name: string;
	sub: string;
};

export type Env = {
	[key: string]: unknown;
	ACCESS_OIDC_CLIENT_ID: string;
	ACCESS_OIDC_CLIENT_SECRET: string;
	ACCESS_OIDC_ISSUER: string;
	AI?: AiBinding;
	AI_GATEWAY_ID?: string;
	BUREAU?: BureauBinding;
	FILES?: FilesBinding;
	/** Test-only seam for direct GitHub REST calls. */
	GITHUB_FETCH_FOR_TESTS?: typeof fetch;
	GITHUB_TOKEN?: string;
	JOBS_DB: D1Database;
	LOADER?: WorkerLoader;
	/** Test-only seam for direct Migadu REST calls. */
	MIGADU_FETCH_FOR_TESTS?: typeof fetch;
	MIGADU_API_KEY?: string;
	MIGADU_USER?: string;
	NOTEBOOK_STORE_FOR_TESTS?: NotebookStore;
	OAUTH_KV: KVNamespace;
	OAUTH_PROVIDER: OAuthHelpers;
	/** Public origin of this Worker, e.g. https://ayo.oflabs.dev */
	PUBLIC_BASE_URL: string;
	SEARCH_OFFLINE?: string;
	VECTORIZE?: VectorizeBinding;
	WEBHOOK_SECRET_BUREAU?: string;
};
