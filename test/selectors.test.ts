import assert from "node:assert/strict";
import test from "node:test";
import { parseHTML } from "linkedom";
import {
  EXPRESS_WEB_3_66,
  classifySnapshot,
  directChatFingerprint,
  directResultsFromDocument,
  exactlyOneVisible,
  ephemeralChatFingerprint,
  isSemanticallyEmptySearchEditor,
  snapshotFromDocument,
} from "../src/adapter/selectors/express-web-3.66.js";
import {
  observeSearchSettlement,
  type SearchSettlementTracker,
} from "../src/adapter/search-settlement.js";
import {
  SEARCH_SETTLE_MS,
  SEARCH_SETTLE_STABILITY_MS,
  SELECTOR_BUNDLE_VERSION,
} from "../src/constants.js";
import { ExpressError, safeErrorBody } from "../src/errors.js";

test("saved synthetic signed-in and signed-out fixtures are recognized", () => {
  const signedIn = parseHTML(`
    <html><body>
      <div class="chat-list-entry">
        <span class="chat-list-entry__name">Synthetic team</span>
      </div>
    </body></html>
  `).document;
  const signedOut = parseHTML(`
    <html><body><h2>Select login method</h2>
      <input type="email" />
    </body></html>
  `).document;
  const unsupported = parseHTML(
    "<html><body><main>synthetic unknown UI</main></body></html>",
  ).document;

  assert.deepEqual(
    classifySnapshot(snapshotFromDocument(signedIn)),
    {
      authenticated: true,
      signedOut: false,
      recognized: true,
      version: SELECTOR_BUNDLE_VERSION,
    },
  );
  assert.equal(
    classifySnapshot(snapshotFromDocument(signedOut)).signedOut,
    true,
  );
  assert.equal(
    classifySnapshot(snapshotFromDocument(unsupported)).recognized,
    false,
  );
  assert.equal(EXPRESS_WEB_3_66.version, "express-web-3.66");
});

test("visible search editor selection fails closed unless exactly one exists", () => {
  assert.equal(exactlyOneVisible([]), undefined);
  assert.equal(exactlyOneVisible(["synthetic-editor"]), "synthetic-editor");
  assert.equal(
    exactlyOneVisible(["synthetic-editor-a", "synthetic-editor-b"]),
    undefined,
  );
  assert.equal(
    isSemanticallyEmptySearchEditor({
      active: false,
      visibleText: "Chats, contacts, bots\uFEFF",
    }),
    true,
  );
  assert.equal(
    isSemanticallyEmptySearchEditor({
      active: true,
      visibleText: "Synthetic query",
    }),
    false,
  );
});

test("active direct-search result and settled empty states remain signed in", () => {
  const withResults = parseHTML(`
    <html><body>
      <div class="search-filter-panel-input">
        <div class="search-filter-panel-input__editor search-filter-panel-input__editor--value"
             contenteditable="true">Synthetic query</div>
      </div>
      <div class="search-result-panel__phonebook phonebook-entry--contacts-list">
        <span class="phonebook-entry__title-name text--s-medium">Synthetic contact</span>
      </div>
    </body></html>
  `).document;
  const empty = parseHTML(`
    <html><body>
      <div class="search-filter-panel-input">
        <div class="search-filter-panel-input__editor search-filter-panel-input__editor--value"
             contenteditable="true">Synthetic missing query</div>
      </div>
      <div class="layout-pane__chat-list-wrapper">
        <div class="content-placeholder content-placeholder--spread-self">Synthetic empty state</div>
      </div>
    </body></html>
  `).document;
  const withMatchingChatRows = parseHTML(`
    <html><body>
      <div class="search-filter-panel-input">
        <div class="search-filter-panel-input__editor search-filter-panel-input__editor--value"
             contenteditable="true">Synthetic existing chat</div>
      </div>
      <div class="chat-list-entry">
        <span class="chat-list-entry__name">Synthetic existing chat</span>
      </div>
    </body></html>
  `).document;
  const resultPanelAlone = parseHTML(`
    <html><body>
      <div class="layout-pane__chat-list-wrapper">
        <div class="content-placeholder content-placeholder--spread-self">Synthetic empty state</div>
      </div>
    </body></html>
  `).document;

  assert.equal(
    classifySnapshot(snapshotFromDocument(withResults)).authenticated,
    true,
  );
  assert.equal(
    classifySnapshot(snapshotFromDocument(empty)).authenticated,
    true,
  );
  assert.equal(
    classifySnapshot(snapshotFromDocument(empty)).recognized,
    true,
  );
  assert.equal(
    classifySnapshot(
      snapshotFromDocument(withMatchingChatRows),
    ).authenticated,
    true,
  );
  assert.equal(
    classifySnapshot(snapshotFromDocument(resultPanelAlone)).authenticated,
    false,
  );
});

test("direct extraction uses the same-element contact row and optional detail", () => {
  const document = parseHTML(`
    <html><body>
      <div class="search-result-panel__phonebook phonebook-entry--contacts-list">
        <span class="phonebook-entry__title-name text--s-medium">Synthetic A</span>
        <span class="phonebook-entry__extra-info">Synthetic detail</span>
      </div>
      <div class="search-result-panel__phonebook phonebook-entry--contacts-list">
        <span class="phonebook-entry__title-name text--s-medium">Synthetic B</span>
      </div>
      <div class="search-result-panel__phonebook">
        <div class="phonebook-entry--contacts-list">
          <span class="phonebook-entry__title-name text--s-medium">Nested non-match</span>
        </div>
      </div>
      <div class="search-result-panel__group phonebook-entry--contacts-list">
        <span class="phonebook-entry__title-name text--s-medium">Synthetic group</span>
      </div>
      <div class="search-result-panel__phonebook phonebook-entry--contacts-list">
        <span class="phonebook-entry__extra-info">Missing required title</span>
      </div>
    </body></html>
  `).document;

  assert.deepEqual(directResultsFromDocument(document), [
    {
      title: "Synthetic A",
      detail: "Synthetic detail",
    },
    {
      title: "Synthetic B",
    },
  ]);
  assert.equal(
    directChatFingerprint({
      title: "Synthetic A",
      detail: "Synthetic detail",
    }),
    directChatFingerprint({
      title: "Synthetic A",
      detail: "Synthetic detail",
    }),
  );
  assert.notEqual(
    directChatFingerprint({ title: "Synthetic A" }),
    directChatFingerprint({
      title: "Synthetic A",
      detail: "Synthetic detail",
    }),
  );
});

test("search settlement ignores a transient empty placeholder before direct rows", () => {
  const base = {
    chatRows: 0,
    titledChatRows: 0,
    headingTexts: [],
    corporateEmailControls: 0,
    searchEditors: 1,
    activeValuedSearchEditors: 1,
    signedInSearchShells: 1,
  };
  const empty = {
    ...base,
    searchEmptyStates: 1,
    directResultRows: 0,
  };
  const direct = {
    ...base,
    searchEmptyStates: 0,
    directResultRows: 3,
  };
  const timeline = [
    { atMs: 0, snapshot: empty },
    { atMs: 250, snapshot: empty },
    { atMs: 500, snapshot: empty },
    { atMs: 750, snapshot: direct },
    { atMs: 1_000, snapshot: direct },
  ];
  let tracker: SearchSettlementTracker = { kind: "unsettled" };
  let settledKey: string | undefined;
  for (const observation of timeline) {
    const result = observeSearchSettlement(
      tracker,
      observation.snapshot,
      observation.atMs,
      SEARCH_SETTLE_MS,
      SEARCH_SETTLE_STABILITY_MS,
    );
    tracker = result.tracker;
    if (observation.atMs <= 500) {
      assert.equal(result.settled, false);
    }
    if (result.settled) {
      settledKey = result.terminalKey;
    }
  }
  assert.equal(settledKey, "direct:3");
});

test("search settlement still accepts a true empty state after the grace", () => {
  const empty = {
    chatRows: 0,
    titledChatRows: 0,
    headingTexts: [],
    corporateEmailControls: 0,
    searchEditors: 1,
    activeValuedSearchEditors: 1,
    signedInSearchShells: 1,
    searchEmptyStates: 1,
    directResultRows: 0,
  };
  let tracker: SearchSettlementTracker = { kind: "unsettled" };
  let settled = false;
  for (const atMs of [0, 250, 500, 750, 1_000]) {
    const result = observeSearchSettlement(
      tracker,
      empty,
      atMs,
      SEARCH_SETTLE_MS,
      SEARCH_SETTLE_STABILITY_MS,
    );
    tracker = result.tracker;
    settled = result.settled;
  }
  assert.equal(settled, true);
});

test("ephemeral row fingerprints fail closed when recycled metadata changes", () => {
  const original = ephemeralChatFingerprint({
    title: "Synthetic title A",
    timestamp: "12:00",
    unreadText: "1",
  });
  const recycled = ephemeralChatFingerprint({
    title: "Synthetic title B",
    timestamp: "12:00",
    unreadText: "1",
  });
  assert.notEqual(original, recycled);
});

test("unsupported-client diagnostics are stable and sanitized", () => {
  const sentinel =
    "cookie=SENTINEL_COOKIE bearer=SENTINEL_BEARER message=SENTINEL_BODY";
  const body = safeErrorBody(new ExpressError("UNSUPPORTED_WEB_CLIENT"));
  assert.equal(body.error.code, "UNSUPPORTED_WEB_CLIENT");
  assert.equal(JSON.stringify(body).includes(sentinel), false);
  assert.equal(JSON.stringify(body).includes("express-web-3.66"), true);
  assert.equal(JSON.stringify(body).includes("configured web client"), true);
});
