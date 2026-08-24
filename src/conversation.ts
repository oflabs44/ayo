export function mintConversationId(): string {
	return crypto.randomUUID();
}
