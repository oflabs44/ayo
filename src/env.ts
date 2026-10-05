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

type BureauCalendar = {
	id: string;
	account: string;
	kind: "calendar";
	url: string;
	displayName: string | null;
	color: string | null;
	updatedAt: string;
};
type BureauAddressBook = {
	id: string;
	account: string;
	kind: "addressbook";
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
type BureauContactValue = {
	value: string;
	type?: string;
	pref?: boolean;
};
type BureauContactName = {
	family: string;
	given: string;
	additional: string;
	prefix: string;
	suffix: string;
};
type BureauContactAddress = {
	street: string;
	city: string;
	region: string;
	postal: string;
	country: string;
	type?: string;
};
type BureauContactPhoto = { contentType: string; base64: string };
type BureauContact = {
	id: string;
	addressbook: string;
	uid: string | null;
	fn: string | null;
	n: BureauContactName | null;
	nickname: string | null;
	org: string | null;
	title: string | null;
	emails: BureauContactValue[];
	tels: BureauContactValue[];
	urls: BureauContactValue[];
	adrs: BureauContactAddress[];
	bday: string | null;
	anniversary: string | null;
	note: string | null;
	categories: string[];
	hasPhoto: boolean;
	etag: string;
};
type BureauContactWrite = {
	address: string;
	addressbook: string;
	fn: string;
	n?: BureauContactName;
	nickname?: string;
	org?: string;
	title?: string;
	emails?: BureauContactValue[];
	tels?: BureauContactValue[];
	urls?: BureauContactValue[];
	adrs?: BureauContactAddress[];
	bday?: string;
	anniversary?: string;
	note?: string;
	categories?: string[];
	photo?: BureauContactPhoto;
};
type BureauContactGroupSummary = {
	id: string;
	addressbook: string;
	uid: string | null;
	name: string | null;
	memberCount: number;
	etag: string;
};
type BureauContactGroup = Omit<BureauContactGroupSummary, "memberCount"> & {
	members: Array<{ id: string; uid: string; fn: string | null }>;
	unresolvedMemberUids: string[];
};
type BureauContactUpdate = Omit<BureauContactWrite, "photo"> & {
	id: string;
	etag: string;
	photo?: BureauContactPhoto | null;
};
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
	listAddressBooks(input: { address: string }): Promise<BureauAddressBook[]>;
	listContacts(input: {
		address: string;
		q?: string;
		addressbook?: string;
		categories?: string[];
	}): Promise<BureauContact[]>;
	getContact(input: {
		address: string;
		id: string;
	}): Promise<BureauContact & { raw: string }>;
	createContact(input: BureauContactWrite): Promise<BureauContact>;
	updateContact(input: BureauContactUpdate): Promise<BureauContact>;
	removeContact(input: {
		address: string;
		id: string;
		etag?: string;
	}): Promise<{ id: string }>;
	listContactGroups(input: {
		address: string;
		addressbook?: string;
	}): Promise<BureauContactGroupSummary[]>;
	getContactGroup(input: {
		address: string;
		id: string;
	}): Promise<BureauContactGroup>;
	createContactGroup(input: {
		address: string;
		addressbook: string;
		name: string;
		members?: string[];
	}): Promise<BureauContactGroup>;
	updateContactGroup(input: {
		address: string;
		id: string;
		etag: string;
		name?: string;
		addMembers?: string[];
		removeMembers?: string[];
		removeMemberUids?: string[];
	}): Promise<BureauContactGroup>;
	removeContactGroup(input: {
		address: string;
		id: string;
		etag?: string;
	}): Promise<{ id: string }>;
};

type MailAddress = { address: string; name: string | null };
type MailMessageTag = {
	tag: string;
	/** "user", "agent", or the classifier: "rule" or "clef". */
	source: string;
	confidence: number | null;
};
type MailMessage = {
	id: string;
	threadId: string;
	rfcMessageId: string | null;
	subject: string | null;
	from: MailAddress | null;
	to: MailAddress[];
	cc: MailAddress[];
	date: string | null;
	snippet: string | null;
	hasAttachments: boolean;
	attachments: Array<{
		index: number;
		filename: string | null;
		mimeType: string;
		size: number;
	}>;
	/** One per live copy; a message is unread when a copy has no \Seen flag. */
	copies: Array<{ driverMessageId: string; folder: string; flags: string[] }>;
	tags: MailMessageTag[];
};
type MailMessageDetail = MailMessage & {
	text: string | null;
	inReplyTo: string | null;
	references: string[];
	judgment: { version: number; answers: unknown } | null;
};
type MailListFilters = {
	folder?: string;
	from?: string;
	after?: string;
	before?: string;
	hasAttachments?: boolean;
	tags?: string[];
	unread?: boolean;
	flagged?: boolean;
	limit?: number;
};
type MailFolder = {
	path: string;
	specialUse: string | null;
	delimiter: string;
};
type MailBatchResult = {
	succeeded: string[];
	failed: Array<{ messageId: string; reason: string }>;
};
type MailCopiesOptions = { folder?: string };

type MailRecipient = { address: string; name?: string | null };
export type ComposedMail = {
	to: MailRecipient[];
	cc?: MailRecipient[];
	bcc?: MailRecipient[];
	subject: string;
	text: string;
	html?: string;
	/** References only: Ayo never moves attachment bytes through the sandbox. */
	attachments?: Array<{ messageId: string; index: number; filename?: string }>;
};

/** "refused": nothing was sent. "unknown": the send was not confirmed, so a
 * second send can make a duplicate. */
export type MailSendResult =
	| {
			status: "sent";
			rejected: Array<{ address: string; code: number; response: string }>;
			sentCopy: { id: string; folder: string } | null;
			followUpErrors: Array<{
				step: "sentCopy" | "answered" | "draft";
				message: string;
			}>;
	  }
	| { status: "refused" | "unknown"; message: string };

/** The `mycloud-mail` Worker's `MailReader` WorkerEntrypoint, limited to the
 * methods Ayo calls. It ignores unknown option keys, so callers validate names
 * first. */
export type MailReaderBinding = {
	listAccounts(): Promise<
		Array<{
			address: string;
			label: string | null;
			senderName: string | null;
			imap: unknown;
			smtp: unknown;
		}>
	>;
	listFolders(accountAddress: string): Promise<
		Array<
			Omit<MailFolder, "delimiter"> & {
				/** Null until the next poll reports the folder's state. */
				delimiter: string | null;
				messageCount: number;
				unreadCount: number;
			}
		>
	>;
	listThreads(
		accountAddress: string,
		options?: {
			folder?: string;
			tags?: string[];
			unread?: boolean;
			flagged?: boolean;
			limit?: number;
			before?: { lastDate: string | null; id: string };
		},
	): Promise<unknown[]>;
	listMessages(
		accountAddress: string,
		options?: MailListFilters & {
			cursor?: { date: string | null; id: string };
		},
	): Promise<MailMessage[]>;
	getThread(
		accountAddress: string,
		threadId: string,
	): Promise<MailMessage[] | null>;
	getMessage(
		accountAddress: string,
		messageId: string,
	): Promise<MailMessageDetail | null>;
	listTags(
		accountAddress: string,
	): Promise<Array<{ tag: string; count: number }>>;
	getReplyRecipients(
		accountAddress: string,
		messageId: string,
		options?: { all?: boolean },
	): Promise<{ to: MailAddress[]; cc: MailAddress[] }>;
	/** A null address searches every account. */
	search(
		accountAddress: string | null,
		options: MailListFilters & { query: string },
	): Promise<unknown[]>;
};

/** The `mycloud-mail` Worker's `MailWriter` WorkerEntrypoint, limited to the
 * methods Ayo calls; `emptyFolder` and `deleteMessagesForever` are left out on
 * purpose. It throws `Unknown field <name>` for an unknown key. */
export type MailWriterBinding = {
	moveMessages(
		accountAddress: string,
		messageIds: string[],
		toFolder: string,
		opts?: MailCopiesOptions,
	): Promise<MailBatchResult>;
	trashMessages(
		accountAddress: string,
		messageIds: string[],
		opts?: MailCopiesOptions,
	): Promise<MailBatchResult>;
	setFlags(
		accountAddress: string,
		messageIds: string[],
		change: { add?: string[]; remove?: string[] },
	): Promise<MailBatchResult>;
	tag(
		accountAddress: string,
		messageIds: string[],
		tag: string,
	): Promise<MailBatchResult>;
	untag(
		accountAddress: string,
		messageIds: string[],
		tag: string,
	): Promise<MailBatchResult>;
	createFolder(accountAddress: string, path: string): Promise<MailFolder>;
	renameFolder(
		accountAddress: string,
		path: string,
		to: string,
	): Promise<MailFolder>;
	deleteFolder(accountAddress: string, path: string): Promise<void>;
	send(
		accountAddress: string,
		mail: ComposedMail,
		opts?: { answers?: string },
	): Promise<MailSendResult>;
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

/** The `ocr` Worker's `Ocr` WorkerEntrypoint. Errors arrive as `Error` whose
 * message starts with a code: not_a_pdf, too_large, unsupported_language,
 * timeout, or ocr_failed. */
export type OcrBinding = {
	extract(
		pdf: ReadableStream<Uint8Array> | Uint8Array,
		options?: { languages?: string[] },
	): Promise<{ text: string; pages: number }>;
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
	MAIL_READER?: MailReaderBinding;
	MAIL_WRITER?: MailWriterBinding;
	/** Test-only seam for direct Migadu REST calls. */
	MIGADU_FETCH_FOR_TESTS?: typeof fetch;
	MIGADU_API_KEY?: string;
	MIGADU_USER?: string;
	NOTEBOOK_STORE_FOR_TESTS?: NotebookStore;
	OAUTH_KV: KVNamespace;
	OAUTH_PROVIDER: OAuthHelpers;
	OCR?: OcrBinding;
	/** Public origin of this Worker, e.g. https://ayo.oflabs.dev */
	PUBLIC_BASE_URL: string;
	SEARCH_OFFLINE?: string;
	VECTORIZE?: VectorizeBinding;
	WEBHOOK_SECRET_BUREAU?: string;
};
