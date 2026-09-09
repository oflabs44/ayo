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
	alarms?: BureauAlarm[];
};
type BureauTodo = {
	id: string;
	calendar: string;
	uid: string;
	summary: string | null;
	status: string | null;
	due: string | null;
	completed: string | null;
	priority: number | null;
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
type BureauAlarm = {
	trigger: string;
	action?: "DISPLAY" | "EMAIL" | "AUDIO";
	description?: string;
};
type BureauTodoCreate = {
	address: string;
	calendar: string;
	summary: string;
	due?: string;
	description?: string;
	priority?: number;
	status?: string;
	alarms?: BureauAlarm[];
};
type BureauTodoUpdate = {
	address: string;
	id: string;
	etag?: string;
	status?: string;
	due?: string | null;
	summary?: string | null;
	description?: string | null;
	priority?: number | null;
	alarms?: BureauAlarm[] | null;
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
	JOBS_DB: D1Database;
	LOADER?: WorkerLoader;
	NOTEBOOK_STORE_FOR_TESTS?: NotebookStore;
	OAUTH_KV: KVNamespace;
	OAUTH_PROVIDER: OAuthHelpers;
	SEARCH_OFFLINE?: string;
	VECTORIZE?: VectorizeBinding;
	WEBHOOK_SECRET_BUREAU?: string;
};
