import assert from "node:assert/strict";
import { Writable } from "node:stream";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { MockExpressAdapter } from "../src/adapter/mock.js";
import { createSafeLogger } from "../src/logger.js";
import { createMcpServer, toolNames } from "../src/mcp.js";
import { ExpressService } from "../src/service.js";

function textBody(result: Awaited<ReturnType<Client["callTool"]>>): unknown {
  assert.ok(Array.isArray(result.content));
  const first = result.content[0];
  assert.ok(first && first.type === "text");
  return JSON.parse(first.text);
}

test("in-memory MCP integration exposes twelve typed tools", async () => {
  const sink = new Writable({
    write(_chunk, _encoding, callback) {
      callback();
    },
  });
  const logger = createSafeLogger(sink);
  const adapter = new MockExpressAdapter();
  const service = new ExpressService({ adapter, logger });
  const server = createMcpServer(service, logger);
  const client = new Client({ name: "synthetic-test", version: "1.0.0" });
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  await Promise.all([
    server.connect(serverTransport),
    client.connect(clientTransport),
  ]);
  try {
    const listed = await client.listTools();
    assert.deepEqual(
      listed.tools.map((tool) => tool.name),
      toolNames(),
    );
    assert.deepEqual(toolNames(), [
      "express_status",
      "express_list_chats",
      "express_search_direct_chats",
      "express_read_chat",
      "express_list_threads",
      "express_read_thread",
      "express_get_chat_info",
      "express_prepare_attachment",
      "express_send_attachment",
      "express_download_attachment",
      "express_prepare_message",
      "express_send_message",
    ]);
    const searchDefinition = listed.tools[2]!;
    assert.equal(searchDefinition.name, "express_search_direct_chats");
    assert.deepEqual(searchDefinition.inputSchema.required, ["query"]);
    assert.equal(
      searchDefinition.inputSchema.additionalProperties,
      false,
    );
    assert.deepEqual(
      Object.keys(searchDefinition.inputSchema.properties ?? {}).sort(),
      ["cursor", "limit", "query"],
    );

    const status = textBody(
      await client.callTool({ name: "express_status", arguments: {} }),
    ) as { ok: boolean };
    assert.equal(status.ok, true);
    for (const args of [{chatId: "synthetic", limit: 51}, {chatId: "synthetic", url: "https://example.com"}]) {
      const result = textBody(await client.callTool({name: "express_list_threads", arguments: args})) as {error: {code: string}};
      assert.equal(result.error.code, "INVALID_INPUT");
    }
    const noThreads = textBody(await client.callTool({name: "express_read_thread", arguments: {chatId: "synthetic", threadId: "synthetic"}})) as {error: {code: string}};
    assert.equal(noThreads.error.code, "UNSUPPORTED_PROTOCOL");
    const list = textBody(
      await client.callTool({
        name: "express_list_chats",
        arguments: { limit: 1 },
      }),
    ) as { items: Array<{ chatId: string }> };
    const chatId = list.items[0]!.chatId;
    const search = textBody(
      await client.callTool({
        name: "express_search_direct_chats",
        arguments: { query: "  Synthetic  contact  ", limit: 1 },
      }),
    ) as {
      items: Array<{
        chatId: string;
        title: string;
        detail?: string;
        type: string;
      }>;
    };
    assert.equal(adapter.lastSearchQuery, "Synthetic  contact");
    assert.deepEqual(
      Object.keys(search.items[0]!).sort(),
      ["chatId", "detail", "title", "type"].sort(),
    );
    assert.equal(search.items[0]?.type, "direct");
    const heavilyPadded = textBody(
      await client.callTool({
        name: "express_search_direct_chats",
        arguments: { query: `${" ".repeat(600)}Synthetic padded` },
      }),
    ) as { ok: boolean };
    assert.equal(heavilyPadded.ok, true);
    assert.equal(adapter.lastSearchQuery, "Synthetic padded");
    const read = textBody(
      await client.callTool({
        name: "express_read_chat",
        arguments: { chatId, limit: 1 },
      }),
    ) as { mayMarkRead: boolean };
    assert.equal(read.mayMarkRead, true);
    const prepared = textBody(
      await client.callTool({
        name: "express_prepare_message",
        arguments: { chatId, text: "Synthetic MCP text" },
      }),
    ) as { confirmationToken: string };
    assert.equal(adapter.sendCalls, 0);
    const sent = textBody(
      await client.callTool({
        name: "express_send_message",
        arguments: {
          chatId,
          text: "Synthetic MCP text",
          confirmationToken: prepared.confirmationToken,
        },
      }),
    ) as { outcome: string };
    assert.equal(sent.outcome, "verified");
    assert.equal(adapter.sendCalls, 1);

    const invalid = await client.callTool({
      name: "express_list_chats",
      arguments: { limit: 51, unknown: "SENTINEL" },
    });
    assert.equal(invalid.isError, true);
    assert.equal(JSON.stringify(invalid).includes("SENTINEL"), false);

    for (const argumentsValue of [
      {},
      { query: "" },
      { query: " \t " },
      { query: "Synthetic\u007fcontrol" },
      { query: "x".repeat(257) },
      { query: 3 },
      { query: "Synthetic", unknown: "SENTINEL_QUERY" },
      { query: "Synthetic", limit: 1.5 },
      { query: "Synthetic", cursor: "" },
    ]) {
      const rejected = await client.callTool({
        name: "express_search_direct_chats",
        arguments: argumentsValue,
      });
      assert.equal(rejected.isError, true);
      assert.equal(JSON.stringify(rejected).includes("SENTINEL"), false);
    }
  } finally {
    await client.close();
    await server.close();
    await service.close();
  }
});
