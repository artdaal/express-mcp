import {attachmentInputSchema} from "./attachments.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { z } from "zod";
import {
  DEFAULT_PAGE_LIMIT,
  MAX_CHAT_ID_LENGTH,
  MAX_CONFIRMATION_TOKEN_LENGTH,
  MAX_CURSOR_LENGTH,
  MAX_MESSAGE_TEXT_LENGTH,
  MAX_PAGE_LIMIT,
  MAX_SERIALIZED_RESULT_BYTES,
} from "./constants.js";
import { ExpressError, asExpressError, safeErrorBody } from "./errors.js";
import type { SafeLogger } from "./logger.js";
import type { ServiceApi } from "./service.js";

const emptySchema = z.object({}).strict();
const pageSchema = z
  .object({
    cursor: z.string().min(1).max(MAX_CURSOR_LENGTH).optional(),
    limit: z.number().int().min(1).max(MAX_PAGE_LIMIT).optional(),
  })
  .strict();
const searchSchema = pageSchema.extend({
  query: z.string(),
});
const readSchema = pageSchema.extend({
  chatId: z.string().min(1).max(MAX_CHAT_ID_LENGTH),
});
const threadReadSchema = readSchema.extend({threadId: z.string().min(1).max(MAX_CHAT_ID_LENGTH)});
const threadListSchema = z.object({chatId: z.string().min(1).max(MAX_CHAT_ID_LENGTH), limit: z.number().int().min(1).max(MAX_PAGE_LIMIT).optional()}).strict();
const prepareSchema = z
  .object({
    chatId: z.string().min(1).max(MAX_CHAT_ID_LENGTH),
    text: z.string().min(1).max(MAX_MESSAGE_TEXT_LENGTH),
  })
  .strict();
const sendSchema = prepareSchema
  .extend({
    confirmationToken: z
      .string()
      .min(1)
      .max(MAX_CONFIRMATION_TOKEN_LENGTH),
  })
  .strict();

const attachmentSendSchema = attachmentInputSchema.extend({confirmationToken: z.string().min(1).max(MAX_CONFIRMATION_TOKEN_LENGTH)}).strict();
const attachmentDownloadSchema = z.object({chatId: z.string().uuid(), messageId: z.string().uuid()}).strict();
const chatInfoSchema = z.object({chatId: z.string().uuid()}).strict();
const attachmentProperties = {
  chatId: {type: "string", format: "uuid"}, filePath: {type: "string", minLength: 1, maxLength: 4096, description: "Absolute local path to a regular owned file, 1 byte to 10 MiB. No symlinks."},
  kind: {type: "string", enum: ["document", "image"], description: "image supports PNG only; document preserves original bytes."},
  caption: {type: "string", maxLength: 16000, default: ""}, selfOnly: {type: "boolean", default: false, description: "Require a group with this account as its sole current member, checked before upload."},
};

const TOOL_DEFINITIONS = [
  {
    name: "express_status",
    description:
      "Read-only broker, credential, refresh and transport diagnostics. Available offline; does not start login or prove upstream access.",
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
  },
  {
    name: "express_list_chats",
    description:
      "List bounded chat metadata without message bodies or previews.",
    inputSchema: {
      type: "object",
      properties: {
        cursor: {
          type: "string",
          minLength: 1,
          maxLength: MAX_CURSOR_LENGTH,
          description: "Opaque cursor returned by this operation.",
        },
        limit: {
          type: "integer",
          minimum: 1,
          maximum: MAX_PAGE_LIMIT,
          default: DEFAULT_PAGE_LIMIT,
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: "express_search_direct_chats",
    description:
      "Search the corporate phonebook and return matching existing direct chats. Returns exact chat identifiers and metadata without message previews. Does not create new chats.",
    inputSchema: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description:
            "Trimmed once for search, then limited to 1-256 Unicode code points and 1024 UTF-8 bytes with control characters rejected.",
        },
        cursor: {
          type: "string",
          minLength: 1,
          maxLength: MAX_CURSOR_LENGTH,
          description:
            "Opaque cursor bound to this exact trimmed direct-search query.",
        },
        limit: {
          type: "integer",
          minimum: 1,
          maximum: MAX_PAGE_LIMIT,
          default: DEFAULT_PAGE_LIMIT,
        },
      },
      required: ["query"],
      additionalProperties: false,
    },
  },
  {
    name: "express_read_chat",
    description:
      "Read a bounded server page of authenticated, decrypted messages with safe attachment metadata using an exact chat identifier. History pagination uses an opaque caller-bound cursor. The legacy browser adapter may clear unread state.",
    inputSchema: {
      type: "object",
      properties: {
        chatId: {
          type: "string",
          minLength: 1,
          maxLength: MAX_CHAT_ID_LENGTH,
          description:
            "Opaque chat identifier returned by listing or direct search; never a title.",
        },
        cursor: {
          type: "string",
          minLength: 1,
          maxLength: MAX_CURSOR_LENGTH,
          description: "Opaque cursor returned by this chat read.",
        },
        limit: {
          type: "integer",
          minimum: 1,
          maximum: MAX_PAGE_LIMIT,
          default: DEFAULT_PAGE_LIMIT,
        },
      },
      required: ["chatId"],
      additionalProperties: false,
    },
  },
  {
    name: "express_list_threads",
    description: "List recent thread metadata for an exact group/channel chat ID. No message bodies. truncated=true means older threads were omitted; server list pagination is not exposed yet.",
    inputSchema: {type: "object", properties: {chatId: {type: "string", minLength: 1, maxLength: MAX_CHAT_ID_LENGTH}, limit: {type: "integer", minimum: 1, maximum: MAX_PAGE_LIMIT, default: DEFAULT_PAGE_LIMIT}}, required: ["chatId"], additionalProperties: false},
  },
  {
    name: "express_read_thread",
    description: "Read and decrypt a bounded page of one thread after verifying its exact parent group/channel. Use threadId from list_threads and its parent chatId. Cursor is bound to caller, account, parent and thread. senderId/isSelf identify actual participation. Does not send messages.",
    inputSchema: {type: "object", properties: {chatId: {type: "string", minLength: 1, maxLength: MAX_CHAT_ID_LENGTH}, threadId: {type: "string", minLength: 1, maxLength: MAX_CHAT_ID_LENGTH}, cursor: {type: "string", minLength: 1, maxLength: MAX_CURSOR_LENGTH}, limit: {type: "integer", minimum: 1, maximum: MAX_PAGE_LIMIT, default: DEFAULT_PAGE_LIMIT}}, required: ["chatId", "threadId"], additionalProperties: false},
  },
  {name: "express_get_chat_info", description: "Read current exact chat metadata and member count. onlySelf verifies the sole participant is the authenticated account.", inputSchema: {type: "object", properties: {chatId: {type: "string", format: "uuid"}}, required: ["chatId"], additionalProperties: false}},
  {name: "express_prepare_attachment", description: "Read and hash a local attachment without uploading. Prepare a caller-bound single-use 120-second confirmation of exact bytes, target, kind and caption. Images: PNG; max 10 MiB.", inputSchema: {type: "object", properties: attachmentProperties, required: ["chatId", "filePath", "kind"], additionalProperties: false}},
  {name: "express_send_attachment", description: "Re-read the file and consume its exact confirmation before encrypted upload and one message submit. No automatic retry. Unknown outcome includes messageId and phase for read-only reconciliation; do not blindly prepare/send again.", inputSchema: {type: "object", properties: {...attachmentProperties, confirmationToken: {type: "string", minLength: 1, maxLength: MAX_CONFIRMATION_TOKEN_LENGTH}}, required: ["chatId", "filePath", "kind", "confirmationToken"], additionalProperties: false}},
  {name: "express_download_attachment", description: "Fetch one exact message attachment, verify signature, decrypt file and check size/hash. Save a new private local file without overwriting. Returns path and SHA-256; never file keys or download URLs. Max 10 MiB, stream algorithm, document/image messages.", inputSchema: {type: "object", properties: {chatId: {type: "string", format: "uuid"}, messageId: {type: "string", format: "uuid"}}, required: ["chatId", "messageId"], additionalProperties: false}},
  {
    name: "express_prepare_message",
    description:
      "Validate an exact chat/text pair without submitting. Returns a caller-bound, single-use 120-second confirmation.",
    inputSchema: {
      type: "object",
      properties: {
        chatId: {
          type: "string",
          minLength: 1,
          maxLength: MAX_CHAT_ID_LENGTH,
        },
        text: {
          type: "string",
          minLength: 1,
          maxLength: MAX_MESSAGE_TEXT_LENGTH,
          description:
            "Exact, unnormalized message text intentionally echoed in the preview.",
        },
      },
      required: ["chatId", "text"],
      additionalProperties: false,
    },
  },
  {
    name: "express_send_message",
    description:
      "Consume one exact confirmation and submit at most once. Verify the exact message when possible; uncertain outcomes are never automatically retried.",
    inputSchema: {
      type: "object",
      properties: {
        chatId: {
          type: "string",
          minLength: 1,
          maxLength: MAX_CHAT_ID_LENGTH,
        },
        text: {
          type: "string",
          minLength: 1,
          maxLength: MAX_MESSAGE_TEXT_LENGTH,
        },
        confirmationToken: {
          type: "string",
          minLength: 1,
          maxLength: MAX_CONFIRMATION_TOKEN_LENGTH,
        },
      },
      required: ["chatId", "text", "confirmationToken"],
      additionalProperties: false,
    },
  },
] as const;

function parse<T extends z.ZodTypeAny>(
  schema: T,
  value: unknown,
): z.infer<T> {
  const parsed = schema.safeParse(value ?? {});
  if (!parsed.success) {
    throw new ExpressError("INVALID_INPUT");
  }
  return parsed.data;
}

function toolResult(value: unknown, isError = false) {
  const text = JSON.stringify(value);
  if (Buffer.byteLength(text, "utf8") > MAX_SERIALIZED_RESULT_BYTES) {
    return {
      content: [
        {
          type: "text" as const,
          text: JSON.stringify(
            safeErrorBody(new ExpressError("INTERNAL_ERROR")),
          ),
        },
      ],
      isError: true,
    };
  }
  return {
    content: [{ type: "text" as const, text }],
    ...(isError ? { isError: true } : {}),
  };
}

export function toolNames(): string[] {
  return TOOL_DEFINITIONS.map((tool) => tool.name);
}

export function createMcpServer(
  service: ServiceApi,
  logger: SafeLogger,
): Server {
  const server = new Server(
    {
      name: "express-mcp",
      version: "0.1.0",
    },
    {
      capabilities: {
        tools: {},
      },
    },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: TOOL_DEFINITIONS.map((tool) => ({ ...tool })),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    try {
      const args = request.params.arguments ?? {};
      switch (request.params.name) {
        case "express_status":
          parse(emptySchema, args);
          return toolResult(await service.status());
        case "express_list_chats": {
          const input = parse(pageSchema, args);
          return toolResult(
            await service.listChats({
              ...(input.cursor ? { cursor: input.cursor } : {}),
              ...(input.limit ? { limit: input.limit } : {}),
            }),
          );
        }
        case "express_search_direct_chats": {
          const input = parse(searchSchema, args);
          return toolResult(
            await service.searchDirectChats({
              query: input.query,
              ...(input.cursor ? { cursor: input.cursor } : {}),
              ...(input.limit ? { limit: input.limit } : {}),
            }),
          );
        }
        case "express_read_chat": {
          const input = parse(readSchema, args);
          return toolResult(
            await service.readChat(input.chatId, {
              ...(input.cursor ? { cursor: input.cursor } : {}),
              ...(input.limit ? { limit: input.limit } : {}),
            }),
          );
        }
        case "express_list_threads": {
          const input = parse(threadListSchema, args);
          return toolResult(await service.listThreads(input.chatId, input.limit));
        }
        case "express_read_thread": {
          const input = parse(threadReadSchema, args);
          return toolResult(await service.readThread(input.chatId, input.threadId, {...(input.limit ? {limit: input.limit} : {}), ...(input.cursor ? {cursor: input.cursor} : {})}));
        }
        case "express_get_chat_info": { const input = parse(chatInfoSchema, args); return toolResult(await service.getChatInfo(input.chatId)); }
        case "express_prepare_attachment": { return toolResult(await service.prepareAttachment(parse(attachmentInputSchema, args))); }
        case "express_send_attachment": { const {confirmationToken, ...input} = parse(attachmentSendSchema, args); const result = await service.sendAttachment(input, confirmationToken); return toolResult(result, !result.ok); }
        case "express_download_attachment": { const input = parse(attachmentDownloadSchema, args); return toolResult(await service.downloadAttachment(input.chatId, input.messageId)); }
        case "express_prepare_message": {
          const input = parse(prepareSchema, args);
          return toolResult(
            await service.prepareMessage(input.chatId, input.text),
          );
        }
        case "express_send_message": {
          const input = parse(sendSchema, args);
          const result = await service.sendMessage(
            input.chatId,
            input.text,
            input.confirmationToken,
          );
          return toolResult(result, !result.ok);
        }
        default:
          throw new ExpressError("INVALID_INPUT");
      }
    } catch (error) {
      const safe = asExpressError(error);
      logger.warn({
        operation: "tool_call",
        code: safe.code,
      });
      return toolResult(safeErrorBody(safe), true);
    }
  });

  return server;
}
