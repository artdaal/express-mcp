import assert from "node:assert/strict";
import { Writable } from "node:stream";
import test from "node:test";
import type {
  ExpressAdapter,
  AdapterStatus,
  ChatSummary,
  DirectChatSummary,
  SendOutcome,
  VisibleMessage,
} from "../src/adapter/types.js";
import { MockExpressAdapter } from "../src/adapter/mock.js";
import { serializedResultBytes } from "../src/bounds.js";
import { ConfirmationStore } from "../src/confirmation.js";
import { MAX_SERIALIZED_RESULT_BYTES } from "../src/constants.js";
import { CursorStore } from "../src/cursors.js";
import { ExpressError } from "../src/errors.js";
import { createSafeLogger } from "../src/logger.js";
import {
  ExpressService,
  validateSearchQuery,
  validateText,
} from "../src/service.js";

function loggerCapture(): { logger: ReturnType<typeof createSafeLogger>; read: () => string } {
  let output = "";
  const stream = new Writable({
    write(chunk, _encoding, callback) {
      output += String(chunk);
      callback();
    },
  });
  return {
    logger: createSafeLogger(stream),
    read: () => output,
  };
}

test("mock service covers status, list, read, prepare, and exact send", async () => {
  let now = 50_000;
  const confirmations = new ConfirmationStore({
    now: () => now,
    randomToken: () => "opaque-confirmation",
  });
  const adapter = new MockExpressAdapter();
  const capture = loggerCapture();
  const service = new ExpressService({
    adapter,
    logger: capture.logger,
    confirmations,
  });

  const status = await service.status();
  assert.equal(status.status.authentication, "authenticated");
  const list = await service.listChats({});
  assert.equal(list.count, 20);
  assert.equal("text" in list.items[0]!, false);
  assert.equal(list.items[0]?.title, "Synthetic chat 1");
  const read = await service.readChat("synthetic-chat-1", { limit: 2 });
  assert.equal(read.count, 2);
  assert.equal(read.mayMarkRead, true);

  const prepared = await service.prepareMessage(
    "synthetic-chat-1",
    " exact synthetic text ",
  );
  assert.equal(adapter.sendCalls, 0);
  assert.deepEqual(prepared.preview, {
    chatId: "synthetic-chat-1",
    text: " exact synthetic text ",
  });
  assert.equal(prepared.expiresInSeconds, 120);

  await assert.rejects(
    service.sendMessage(
      "synthetic-chat-1",
      "exact synthetic text",
      prepared.confirmationToken,
    ),
    (error: unknown) =>
      error instanceof ExpressError &&
      error.code === "CONFIRMATION_MISMATCH",
  );
  assert.equal(adapter.sendCalls, 0);

  const sent = await service.sendMessage(
    "synthetic-chat-1",
    " exact synthetic text ",
    prepared.confirmationToken,
  );
  assert.equal(sent.outcome, "verified");
  assert.equal(adapter.sendCalls, 1);
  await assert.rejects(
    service.sendMessage(
      "synthetic-chat-1",
      " exact synthetic text ",
      prepared.confirmationToken,
    ),
    (error: unknown) =>
      error instanceof ExpressError &&
      error.code === "CONFIRMATION_UNKNOWN",
  );
  assert.equal(adapter.sendCalls, 1);

  now += 1;
  const logs = capture.read();
  assert.equal(logs.includes(" exact synthetic text "), false);
  assert.equal(logs.includes(prepared.confirmationToken), false);
  assert.equal(logs.includes("synthetic-chat-1"), false);
});

test("unknown adapter outcome consumes the token and is never retried", async () => {
  const adapter = new MockExpressAdapter({ sendOutcome: "unknown" });
  const service = new ExpressService({
    adapter,
    logger: loggerCapture().logger,
  });
  const prepared = await service.prepareMessage(
    "synthetic-chat-1",
    "Synthetic uncertain message",
  );
  const result = await service.sendMessage(
    "synthetic-chat-1",
    "Synthetic uncertain message",
    prepared.confirmationToken,
  );
  assert.equal(result.outcome, "unknown");
  assert.equal(adapter.sendCalls, 1);
  assert.equal(result.retryAttempted, false);
  await assert.rejects(
    service.sendMessage(
      "synthetic-chat-1",
      "Synthetic uncertain message",
      prepared.confirmationToken,
    ),
    (error: unknown) =>
      error instanceof ExpressError &&
      error.code === "CONFIRMATION_UNKNOWN",
  );
  assert.equal(adapter.sendCalls, 1);
});

test("a thrown adapter failure after consume becomes SEND_OUTCOME_UNKNOWN", async () => {
  class ThrowingAdapter implements ExpressAdapter {
    calls = 0;
    async status(): Promise<AdapterStatus> {
      return new MockExpressAdapter().status();
    }
    async listChats(): Promise<ChatSummary[]> {
      return [{ chatId: "synthetic-chat", title: "Synthetic" }];
    }
    async searchDirectChats(
      _query: string,
    ): Promise<DirectChatSummary[]> {
      return [];
    }
    async readChat(_chatId: string): Promise<VisibleMessage[]> {
      return [];
    }
    async validateChatTarget(_chatId: string): Promise<void> {}
    async sendMessage(
      _chatId: string,
      _text: string,
    ): Promise<SendOutcome> {
      this.calls += 1;
      throw new Error("SENTINEL_ADAPTER_FAILURE");
    }
    async close(): Promise<void> {}
  }

  const adapter = new ThrowingAdapter();
  const capture = loggerCapture();
  const service = new ExpressService({ adapter, logger: capture.logger });
  const prepared = await service.prepareMessage(
    "synthetic-chat",
    "SENTINEL_MESSAGE_BODY",
  );
  const result = await service.sendMessage(
    "synthetic-chat",
    "SENTINEL_MESSAGE_BODY",
    prepared.confirmationToken,
  );
  assert.equal(result.ok, false);
  assert.equal(result.error.code, "SEND_OUTCOME_UNKNOWN");
  assert.equal(adapter.calls, 1);
  assert.equal(capture.read().includes("SENTINEL"), false);
  await assert.rejects(
    service.sendMessage(
      "synthetic-chat",
      "SENTINEL_MESSAGE_BODY",
      prepared.confirmationToken,
    ),
    (error: unknown) =>
      error instanceof ExpressError &&
      error.code === "CONFIRMATION_UNKNOWN",
  );
  assert.equal(adapter.calls, 1);
});

test("message bounds are enforced on exact UTF-8 bytes", () => {
  assert.doesNotThrow(() => validateText("😀".repeat(16_384)));
  assert.throws(
    () => validateText("😀".repeat(16_385)),
    (error: unknown) =>
      error instanceof ExpressError && error.code === "INVALID_INPUT",
  );
});

test("direct search trims only the query and returns bounded direct metadata", async () => {
  let sequence = 0;
  const adapter = new MockExpressAdapter({
    randomToken: () => `opaque-${sequence++}`,
  });
  const capture = loggerCapture();
  const service = new ExpressService({
    adapter,
    logger: capture.logger,
    cursors: new CursorStore(() => `cursor-${sequence++}`),
  });

  const first = await service.searchDirectChats({
    query: "\t Synthetic  query \n",
  });
  assert.equal(adapter.lastSearchQuery, "Synthetic  query");
  assert.equal(first.count, 20);
  assert.equal(first.limit, 20);
  assert.ok(first.nextCursor);
  assert.equal(first.items.every((item) => item.type === "direct"), true);
  assert.deepEqual(
    Object.keys(first.items[0]!).sort(),
    ["chatId", "detail", "title", "type"].sort(),
  );
  assert.equal(
    first.items[0]!.chatId.includes("Synthetic"),
    false,
  );
  assert.equal("timestamp" in first.items[0]!, false);
  assert.equal("preview" in first.items[0]!, false);
  assert.equal("query" in first, false);
  const searchLogs = capture.read();
  assert.equal(searchLogs.includes("Synthetic  query"), false);
  assert.equal(searchLogs.includes(first.items[0]!.title), false);
  assert.equal(searchLogs.includes(first.items[0]!.detail ?? ""), false);
  assert.equal(searchLogs.includes(first.items[0]!.chatId), false);

  const firstId = first.items[0]!.chatId;
  const second = await service.searchDirectChats({
    query: "Synthetic  query",
    cursor: first.nextCursor,
    limit: 50,
  });
  assert.equal(second.count, 50);
  await assert.rejects(
    service.readChat(firstId, {}),
    (error: unknown) =>
      error instanceof ExpressError &&
      error.code === "CHAT_NOT_TARGETABLE",
  );

  await assert.rejects(
    service.searchDirectChats({
      query: "Synthetic other query",
      cursor: first.nextCursor,
    }),
    (error: unknown) =>
      error instanceof ExpressError && error.code === "INVALID_CURSOR",
  );
  await service.close();
});

test("direct targets interoperate with read and exact two-phase send", async () => {
  let sequence = 0;
  const adapter = new MockExpressAdapter({
    directChats: [
      {
        title: "Synthetic direct display",
        detail: "Synthetic direct detail",
      },
    ],
    randomToken: () => `target-${sequence++}`,
  });
  const service = new ExpressService({
    adapter,
    logger: loggerCapture().logger,
  });

  const readSearch = await service.searchDirectChats({
    query: "Synthetic read",
  });
  const read = await service.readChat(readSearch.items[0]!.chatId, {
    limit: 1,
  });
  assert.equal(read.count, 1);
  assert.equal(adapter.readCalls, 1);

  const sendSearch = await service.searchDirectChats({
    query: "Synthetic send",
  });
  const directId = sendSearch.items[0]!.chatId;
  const prepared = await service.prepareMessage(
    directId,
    " exact synthetic direct text ",
  );
  assert.equal(adapter.sendCalls, 0);
  const sent = await service.sendMessage(
    directId,
    " exact synthetic direct text ",
    prepared.confirmationToken,
  );
  assert.equal(sent.outcome, "verified");
  assert.equal(adapter.sendCalls, 1);
  await assert.rejects(
    service.prepareMessage(
      "Synthetic direct display",
      "Synthetic text",
    ),
    (error: unknown) =>
      error instanceof ExpressError &&
      error.code === "CHAT_NOT_TARGETABLE",
  );
  await service.close();
});

test("later search/list, recycling, detachment, ambiguity, and restart fail closed", async () => {
  let sequence = 0;
  const adapter = new MockExpressAdapter({
    directChats: [
      { title: "Synthetic unique", detail: "Synthetic detail" },
    ],
    randomToken: () => `opaque-${sequence++}`,
  });
  const service = new ExpressService({
    adapter,
    logger: loggerCapture().logger,
  });

  const beforeLaterSearch = await service.searchDirectChats({
    query: "Synthetic first",
  });
  const oldSearchId = beforeLaterSearch.items[0]!.chatId;
  await service.searchDirectChats({ query: "Synthetic second" });
  await assert.rejects(
    service.prepareMessage(oldSearchId, "Synthetic text"),
    (error: unknown) =>
      error instanceof ExpressError &&
      error.code === "CHAT_NOT_TARGETABLE",
  );

  const beforeList = await service.searchDirectChats({
    query: "Synthetic before list",
  });
  const oldListId = beforeList.items[0]!.chatId;
  await service.listChats({ limit: 1 });
  await assert.rejects(
    service.readChat(oldListId, {}),
    (error: unknown) =>
      error instanceof ExpressError &&
      error.code === "CHAT_NOT_TARGETABLE",
  );
  assert.doesNotReject(
    service.prepareMessage("synthetic-chat-1", "Synthetic stable text"),
  );

  const recycled = await service.searchDirectChats({
    query: "Synthetic recycled",
  });
  adapter.recycleDirectTarget(recycled.items[0]!.chatId);
  await assert.rejects(
    service.prepareMessage(
      recycled.items[0]!.chatId,
      "Synthetic recycled text",
    ),
    (error: unknown) =>
      error instanceof ExpressError &&
      error.code === "CHAT_NOT_TARGETABLE",
  );

  const detached = await service.searchDirectChats({
    query: "Synthetic detached",
  });
  adapter.detachDirectTarget(detached.items[0]!.chatId);
  await assert.rejects(
    service.prepareMessage(
      detached.items[0]!.chatId,
      "Synthetic detached text",
    ),
    (error: unknown) =>
      error instanceof ExpressError &&
      error.code === "CHAT_NOT_TARGETABLE",
  );

  const restarted = new ExpressService({
    adapter: new MockExpressAdapter(),
    logger: loggerCapture().logger,
  });
  const processLocal = await service.searchDirectChats({
    query: "Synthetic process local",
  });
  await assert.rejects(
    restarted.readChat(processLocal.items[0]!.chatId, {}),
    (error: unknown) =>
      error instanceof ExpressError &&
      error.code === "CHAT_NOT_TARGETABLE",
  );
  await restarted.close();
  await service.close();

  let duplicateSequence = 0;
  const duplicateAdapter = new MockExpressAdapter({
    directChats: [
      { title: "Synthetic duplicate", detail: "Same detail" },
      { title: "Synthetic duplicate", detail: "Same detail" },
    ],
    randomToken: () => `duplicate-${duplicateSequence++}`,
  });
  const duplicateService = new ExpressService({
    adapter: duplicateAdapter,
    logger: loggerCapture().logger,
  });
  const duplicates = await duplicateService.searchDirectChats({
    query: "Synthetic duplicate",
  });
  for (const item of duplicates.items) {
    await assert.rejects(
      duplicateService.prepareMessage(
        item.chatId,
        "Synthetic duplicate text",
      ),
      (error: unknown) =>
        error instanceof ExpressError &&
        error.code === "CHAT_NOT_TARGETABLE",
    );
  }
  assert.equal(duplicateAdapter.sendCalls, 0);
  await duplicateService.close();
});

test("direct target registry and serialized search results stay bounded", async () => {
  let sequence = 0;
  const adapter = new MockExpressAdapter({
    directChats: Array.from({ length: 205 }, (_, index) => ({
      title: `Synthetic bounded ${index}`,
    })),
    randomToken: () => `bounded-${sequence++}`,
  });
  const service = new ExpressService({
    adapter,
    logger: loggerCapture().logger,
  });
  const page = await service.searchDirectChats({
    query: "Synthetic bounded",
    limit: 50,
  });
  assert.equal(adapter.directTargetCount(), 200);
  await assert.rejects(
    service.prepareMessage(page.items[0]!.chatId, "Synthetic evicted"),
    (error: unknown) =>
      error instanceof ExpressError &&
      error.code === "CHAT_NOT_TARGETABLE",
  );
  await service.close();

  const largeAdapter = new MockExpressAdapter({
    directChats: Array.from({ length: 50 }, (_, index) => ({
      title: `Synthetic large ${index}`,
      detail: "x".repeat(100_000),
    })),
  });
  const largeService = new ExpressService({
    adapter: largeAdapter,
    logger: loggerCapture().logger,
  });
  const large = await largeService.searchDirectChats({
    query: "Synthetic large",
    limit: 50,
  });
  assert.ok(
    serializedResultBytes(large) <= MAX_SERIALIZED_RESULT_BYTES,
  );
  assert.equal(large.truncated, true);
  assert.ok(large.nextCursor);
  await largeService.close();
});

test("search query validation is code-point, UTF-8, control, and trim strict", () => {
  assert.equal(
    validateSearchQuery("  Synthetic  interior  "),
    "Synthetic  interior",
  );
  assert.equal(validateSearchQuery("😀".repeat(256)), "😀".repeat(256));
  for (const invalid of [
    "",
    " \n ",
    "Synthetic\u0000query",
    "Synthetic\u007fquery",
    "Synthetic\u0085query",
    "x".repeat(257),
    "😀".repeat(257),
  ]) {
    assert.throws(
      () => validateSearchQuery(invalid),
      (error: unknown) =>
        error instanceof ExpressError && error.code === "INVALID_INPUT",
    );
  }
});
