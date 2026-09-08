export type AuthenticationState = "authenticated" | "signed_out" | "unknown";

export interface AdapterStatus {
  profileReady: boolean;
  authentication: AuthenticationState;
  officialOrigin: boolean;
  selectorCompatible: boolean;
  selectorVersion: string;
  diagnosticCode?: string;
  guidance: string;
  session?: Record<string, unknown>;
}

export interface ChatSummary {
  chatId: string;
  title: string;
  timestamp?: string;
  unreadCount?: number;
}

export interface DirectChatSummary {
  chatId: string;
  title: string;
  detail?: string;
  type: "direct";
}

export interface VisibleMessage {
  messageId: string;
  text: string;
  timestamp?: string;
  header?: string;
  senderId?: string;
  isSelf?: boolean;
  decryptionError?: string;
  attachment?: import("../attachments.js").AttachmentMetadata;
}

export interface ThreadSummary {
  threadId: string;
  parentChatId: string;
  timestamp?: string;
}

export type SendOutcome = "verified" | "unknown";

export interface ExpressAdapter {
  getChatInfo?(chatId: string): Promise<{chatId: string; title: string; type: string; memberCount: number; onlySelf: boolean}>;
  sendAttachment?(input: import("../attachments.js").AttachmentInput, source: import("../attachments.js").AttachmentSource, messageId: string): Promise<import("../attachments.js").AttachmentSendResult>;
  downloadAttachment?(chatId: string, messageId: string): Promise<{bytes: Buffer; metadata: import("../attachments.js").AttachmentMetadata}>;
  status(): Promise<AdapterStatus>;
  listChats(): Promise<ChatSummary[]>;
  searchDirectChats(query: string): Promise<DirectChatSummary[]>;
  readChat(chatId: string): Promise<VisibleMessage[]>;
  readChatPage?(chatId: string, input: import("../bounds.js").PageInput, cursors: import("../cursors.js").CursorStore): Promise<import("../bounds.js").PageResult<VisibleMessage>>;
  listThreads?(chatId: string, limit: number): Promise<import("../bounds.js").PageResult<ThreadSummary>>;
  readThreadPage?(chatId: string, threadId: string, input: import("../bounds.js").PageInput, cursors: import("../cursors.js").CursorStore): Promise<import("../bounds.js").PageResult<VisibleMessage>>;
  validateChatTarget(chatId: string): Promise<void>;
  sendMessage(chatId: string, text: string): Promise<SendOutcome>;
  close(): Promise<void>;
}
