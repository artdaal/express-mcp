import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

async function sourceFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(
    entries.map(async (entry) => {
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        return sourceFiles(absolute);
      }
      return entry.isFile() && entry.name.endsWith(".ts")
        ? [absolute]
        : [];
    }),
  );
  return nested.flat();
}

test("all production direct-search selectors remain isolated and versioned", async () => {
  const selectorFile = path.resolve(
    "src/adapter/selectors/express-web-3.66.ts",
  );
  const selectors = [
    ".search-filter-panel-input__editor",
    ".search-filter-panel-input__editor--value",
    ".search-result-panel__phonebook",
    ".phonebook-entry--contacts-list",
    ".phonebook-entry__title-name",
    ".phonebook-entry__extra-info",
    ".layout-pane__chat-list-wrapper",
    ".content-placeholder.content-placeholder--spread-self",
  ];
  const selectorSource = await readFile(selectorFile, "utf8");
  for (const selector of selectors) {
    assert.ok(selectorSource.includes(selector));
  }
  assert.equal(selectorSource.includes(".search-result-panel__empty"), false);
  assert.equal(
    selectorSource.includes('searchResultPanel: ".search-result-panel"'),
    false,
  );

  for (const file of await sourceFiles(path.resolve("src"))) {
    if (file === selectorFile) {
      continue;
    }
    const source = await readFile(file, "utf8");
    for (const selector of selectors) {
      assert.equal(
        source.includes(selector),
        false,
        `${path.relative(process.cwd(), file)} contains ${selector}`,
      );
    }
  }
});

test("browser search uses visible UI, does not open results, and list restores rows", async () => {
  const source = await readFile(
    path.resolve("src/adapter/browser.ts"),
    "utf8",
  );
  const searchBody = source.slice(
    source.indexOf("async searchDirectChats"),
    source.indexOf("async #visibleSearchEditor"),
  );
  assert.ok(searchBody.includes("await this.#disposeDirectTargets()"));
  assert.ok(searchBody.includes("await this.#requireOperational()"));
  assert.ok(searchBody.includes("await this.#clearSearchEditor(editor)"));
  assert.ok(searchBody.includes("await editor.fill(query)"));
  assert.ok(searchBody.includes("SEARCH_SETTLE_MS"));
  assert.ok(searchBody.includes("SEARCH_SETTLE_STABILITY_MS"));
  assert.ok(searchBody.includes("SEARCH_SETTLE_POLL_MS"));
  assert.ok(searchBody.includes("SEARCH_UI_TIMEOUT_MS"));
  assert.ok(searchBody.includes("observeSearchSettlement"));
  assert.ok(searchBody.includes("searchTerminalStateKey(finalSnapshot)"));
  assert.ok(searchBody.includes("settledDirectResultRows"));
  assert.ok(searchBody.includes("EXPRESS_WEB_3_66.directResultRow"));
  assert.equal(searchBody.includes("await row.click"), false);
  assert.equal(searchBody.includes("#openTarget"), false);
  assert.equal(searchBody.includes("composer"), false);
  assert.equal(searchBody.includes("sendMessage"), false);
  assert.equal(searchBody.includes("readChat"), false);

  const clearBody = source.slice(
    source.indexOf("async #clearSearchEditor"),
    source.indexOf("async #clearSearchAndRestoreList"),
  );
  assert.ok(clearBody.includes('editor.press("ControlOrMeta+A")'));
  assert.ok(clearBody.includes('editor.press("Backspace")'));
  assert.ok(
    clearBody.includes("isSemanticallyEmptySearchEditor(state)"),
  );
  assert.ok(clearBody.includes("directRows === 0"));

  const listBody = source.slice(
    source.indexOf("async listChats"),
    source.indexOf("async searchDirectChats"),
  );
  const invalidation = listBody.indexOf("#disposeDirectTargets");
  const clearing = listBody.indexOf("#clearSearchAndRestoreList");
  const enumeration = listBody.indexOf(
    "this.#page.locator(EXPRESS_WEB_3_66.chatRow)",
  );
  assert.ok(invalidation >= 0);
  assert.ok(clearing > invalidation);
  assert.ok(enumeration > clearing);
});

test("direct target resolution requires current fingerprint uniqueness", async () => {
  const source = await readFile(
    path.resolve("src/adapter/browser.ts"),
    "utf8",
  );
  const resolveBody = source.slice(
    source.indexOf("async #resolveDirectTarget"),
    source.indexOf("async validateChatTarget"),
  );
  assert.ok(resolveBody.includes("handleIsCurrentDirectResultRow"));
  assert.ok(resolveBody.includes("directFingerprintForHandle"));
  assert.ok(resolveBody.includes("matching.length !== 1"));
  assert.ok(resolveBody.includes("element === candidate"));
  assert.ok(resolveBody.includes('new ExpressError("CHAT_NOT_TARGETABLE")'));
  assert.equal(resolveBody.includes("title"), false);
  assert.equal(resolveBody.includes("detail"), false);
  assert.equal(resolveBody.includes("nth(target"), false);
});
