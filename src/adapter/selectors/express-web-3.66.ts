import type { ElementHandle, Locator, Page } from "playwright-core";
import { SELECTOR_BUNDLE_VERSION } from "../../constants.js";

export const EXPRESS_WEB_3_66 = Object.freeze({
  version: SELECTOR_BUNDLE_VERSION,
  chatRow: ".chat-list-entry",
  chatTitle: ".chat-list-entry__name",
  chatTime: ".chat-list-entry__time",
  chatUnread: ".chat-list-entry-counter",
  stableChatAncestor: "[data-rbd-draggable-id]",
  stableChatAttribute: "data-rbd-draggable-id",
  messageRow: ".chat-message-row",
  message: ".chat-message",
  messageText: ".chat-message__text",
  messageTimestamp: ".chat-message__timestamp",
  messageHeader: ".chat-message__header",
  composer: '.slate-message-input[contenteditable="true"]',
  searchEditor:
    '.search-filter-panel-input__editor[contenteditable="true"]',
  searchEditorActive: ".search-filter-panel-input__editor--value",
  signedInSearchShell: ".search-filter-panel-input",
  searchEmptyState:
    ".layout-pane__chat-list-wrapper .content-placeholder.content-placeholder--spread-self",
  directResultRow:
    ".search-result-panel__phonebook.phonebook-entry--contacts-list",
  directResultTitle: ".phonebook-entry__title-name.text--s-medium",
  directResultDetail: ".phonebook-entry__extra-info",
  heading: "h1, h2, h3, [role=\"heading\"]",
  corporateEmail: 'input[type="email"], [data-testid*="email"]',
});

export interface PageSignatureSnapshot {
  chatRows: number;
  titledChatRows: number;
  headingTexts: string[];
  corporateEmailControls: number;
  searchEditors: number;
  activeValuedSearchEditors: number;
  signedInSearchShells: number;
  searchEmptyStates: number;
  directResultRows: number;
}

export interface PageSignature {
  authenticated: boolean;
  signedOut: boolean;
  recognized: boolean;
  version: string;
}

export interface QueryDocument {
  querySelectorAll(selector: string): {
    length: number;
    [index: number]: unknown;
  };
}

export interface DirectResultFields {
  title: string;
  detail?: string;
}

export interface SearchEditorValueState {
  active: boolean;
  visibleText: string;
}

export function isSemanticallyEmptySearchEditor(
  state: SearchEditorValueState,
): boolean {
  return !state.active;
}

export async function searchEditorValueState(
  editor: Locator,
): Promise<SearchEditorValueState> {
  return {
    active: await editor.evaluate(
      (element, activeSelector) => element.matches(activeSelector),
      EXPRESS_WEB_3_66.searchEditorActive,
    ),
    visibleText: await editor.innerText(),
  };
}

export function exactlyOneVisible<T>(
  candidates: readonly T[],
): T | undefined {
  return candidates.length === 1 ? candidates[0] : undefined;
}

function normalizedText(value: unknown): string {
  if (
    typeof value === "object" &&
    value !== null &&
    "textContent" in value &&
    typeof value.textContent === "string"
  ) {
    return value.textContent.trim();
  }
  return "";
}

export function snapshotFromDocument(
  document: QueryDocument,
): PageSignatureSnapshot {
  const chatRows = document.querySelectorAll(EXPRESS_WEB_3_66.chatRow);
  let titledChatRows = 0;
  for (let index = 0; index < chatRows.length; index += 1) {
    const row = chatRows[index] as
      | { querySelector?: (selector: string) => unknown }
      | undefined;
    if (row?.querySelector?.(EXPRESS_WEB_3_66.chatTitle)) {
      titledChatRows += 1;
    }
  }
  const headings = document.querySelectorAll(EXPRESS_WEB_3_66.heading);
  const searchEditors = document.querySelectorAll(
    EXPRESS_WEB_3_66.searchEditor,
  );
  let activeValuedSearchEditors = 0;
  for (let index = 0; index < searchEditors.length; index += 1) {
    const editor = searchEditors[index] as
      | { matches?: (selector: string) => boolean }
      | undefined;
    if (
      editor?.matches?.(EXPRESS_WEB_3_66.searchEditorActive) &&
      normalizedText(editor).length > 0
    ) {
      activeValuedSearchEditors += 1;
    }
  }
  return {
    chatRows: chatRows.length,
    titledChatRows,
    headingTexts: Array.from(
      { length: headings.length },
      (_, index) => normalizedText(headings[index]),
    ),
    corporateEmailControls: document.querySelectorAll(
      EXPRESS_WEB_3_66.corporateEmail,
    ).length,
    searchEditors: searchEditors.length,
    activeValuedSearchEditors,
    signedInSearchShells: document.querySelectorAll(
      EXPRESS_WEB_3_66.signedInSearchShell,
    ).length,
    searchEmptyStates: document.querySelectorAll(
      EXPRESS_WEB_3_66.searchEmptyState,
    ).length,
    directResultRows: document.querySelectorAll(
      EXPRESS_WEB_3_66.directResultRow,
    ).length,
  };
}

export function classifySnapshot(
  snapshot: PageSignatureSnapshot,
): PageSignature {
  const normalChatList =
    snapshot.chatRows > 0 && snapshot.titledChatRows > 0;
  const activeSearch = isSupportedActiveSearchSnapshot(snapshot);
  const authenticated = normalChatList || activeSearch;
  const headingLogin = snapshot.headingTexts.some((heading) =>
    /select login method|corporate email/i.test(heading),
  );
  const signedOut = headingLogin || snapshot.corporateEmailControls > 0;
  return {
    authenticated,
    signedOut,
    recognized: authenticated || signedOut,
    version: EXPRESS_WEB_3_66.version,
  };
}

export function isSupportedActiveSearchSnapshot(
  snapshot: PageSignatureSnapshot,
): boolean {
  return (
    snapshot.searchEditors === 1 &&
    snapshot.activeValuedSearchEditors === 1 &&
    snapshot.signedInSearchShells === 1 &&
    (snapshot.directResultRows > 0 ||
      snapshot.searchEmptyStates > 0 ||
      snapshot.chatRows > 0)
  );
}

export async function snapshotExpressPage(
  page: Page,
): Promise<PageSignatureSnapshot> {
  const visibleCount = async (selector: string): Promise<number> => {
    const locator = page.locator(selector);
    const count = await locator.count();
    let visible = 0;
    for (let index = 0; index < count; index += 1) {
      if (await locator.nth(index).isVisible().catch(() => false)) {
        visible += 1;
      }
    }
    return visible;
  };
  const editors = page.locator(EXPRESS_WEB_3_66.searchEditor);
  let visibleEditors = 0;
  let activeValuedSearchEditors = 0;
  for (let index = 0; index < (await editors.count()); index += 1) {
    const editor = editors.nth(index);
    if (!(await editor.isVisible().catch(() => false))) {
      continue;
    }
    visibleEditors += 1;
    const active = await editor.evaluate(
      (element, activeSelector) => element.matches(activeSelector),
      EXPRESS_WEB_3_66.searchEditorActive,
    );
    if (active && (await editor.innerText()).trim().length > 0) {
      activeValuedSearchEditors += 1;
    }
  }
  return {
    chatRows: await visibleCount(EXPRESS_WEB_3_66.chatRow),
    titledChatRows: await visibleCount(
      `${EXPRESS_WEB_3_66.chatRow} ${EXPRESS_WEB_3_66.chatTitle}`,
    ),
    headingTexts: await page.locator(EXPRESS_WEB_3_66.heading).allTextContents(),
    corporateEmailControls: await page
      .locator(EXPRESS_WEB_3_66.corporateEmail)
      .count(),
    searchEditors: visibleEditors,
    activeValuedSearchEditors,
    signedInSearchShells: await visibleCount(
      EXPRESS_WEB_3_66.signedInSearchShell,
    ),
    searchEmptyStates: await visibleCount(
      EXPRESS_WEB_3_66.searchEmptyState,
    ),
    directResultRows: await visibleCount(
      EXPRESS_WEB_3_66.directResultRow,
    ),
  };
}

export async function inspectExpressPage(page: Page): Promise<PageSignature> {
  return classifySnapshot(await snapshotExpressPage(page));
}

export function directChatFingerprint(fields: DirectResultFields): string {
  return JSON.stringify([fields.title, fields.detail ?? ""]);
}

export function directResultsFromDocument(
  document: QueryDocument,
): DirectResultFields[] {
  const rows = document.querySelectorAll(EXPRESS_WEB_3_66.directResultRow);
  const results: DirectResultFields[] = [];
  for (let index = 0; index < rows.length; index += 1) {
    const row = rows[index] as
      | {
          querySelector?: (selector: string) => unknown;
        }
      | undefined;
    if (!row?.querySelector) {
      continue;
    }
    const title = normalizedText(
      row.querySelector(EXPRESS_WEB_3_66.directResultTitle),
    );
    if (!title) {
      continue;
    }
    const detail = normalizedText(
      row.querySelector(EXPRESS_WEB_3_66.directResultDetail),
    );
    results.push({
      title,
      ...(detail ? { detail } : {}),
    });
  }
  return results;
}

export async function stableChatIdForRow(
  row: Locator,
): Promise<string | undefined> {
  return row.evaluate(
    (element, parameters) =>
      element
        .closest(parameters.ancestor)
        ?.getAttribute(parameters.attribute) ?? undefined,
    {
      ancestor: EXPRESS_WEB_3_66.stableChatAncestor,
      attribute: EXPRESS_WEB_3_66.stableChatAttribute,
    },
  );
}

export async function handleIsCurrentChatRow(
  handle: ElementHandle<HTMLElement>,
): Promise<boolean> {
  return handle.evaluate(
    (element, selector) =>
      element.isConnected && element.matches(selector),
    EXPRESS_WEB_3_66.chatRow,
  );
}

export async function stableChatIdForHandle(
  handle: ElementHandle<HTMLElement>,
): Promise<string | undefined> {
  return handle.evaluate(
    (element, parameters) =>
      element
        .closest(parameters.ancestor)
        ?.getAttribute(parameters.attribute) ?? undefined,
    {
      ancestor: EXPRESS_WEB_3_66.stableChatAncestor,
      attribute: EXPRESS_WEB_3_66.stableChatAttribute,
    },
  );
}

export function ephemeralChatFingerprint(fields: {
  title: string;
  timestamp?: string;
  unreadText?: string;
}): string {
  return JSON.stringify([
    fields.title,
    fields.timestamp ?? "",
    fields.unreadText ?? "",
  ]);
}

export async function ephemeralFingerprintForHandle(
  handle: ElementHandle<HTMLElement>,
): Promise<string> {
  const fields = await handle.evaluate(
    (element, selectors) => {
      const text = (selector: string) =>
        element.querySelector(selector)?.textContent?.trim() ?? "";
      return {
        title: text(selectors.title),
        timestamp: text(selectors.timestamp),
        unreadText: text(selectors.unread),
      };
    },
    {
      title: EXPRESS_WEB_3_66.chatTitle,
      timestamp: EXPRESS_WEB_3_66.chatTime,
      unread: EXPRESS_WEB_3_66.chatUnread,
    },
  );
  return ephemeralChatFingerprint(fields);
}

export async function handleIsCurrentDirectResultRow(
  handle: ElementHandle<HTMLElement>,
): Promise<boolean> {
  return handle.evaluate(
    (element, selector) =>
      element.isConnected && element.matches(selector),
    EXPRESS_WEB_3_66.directResultRow,
  );
}

export async function directFingerprintForHandle(
  handle: ElementHandle<HTMLElement>,
): Promise<string> {
  const fields = await handle.evaluate(
    (element, selectors) => {
      const text = (selector: string) =>
        element.querySelector(selector)?.textContent?.trim() ?? "";
      return {
        title: text(selectors.title),
        detail: text(selectors.detail),
      };
    },
    {
      title: EXPRESS_WEB_3_66.directResultTitle,
      detail: EXPRESS_WEB_3_66.directResultDetail,
    },
  );
  return directChatFingerprint({
    title: fields.title,
    ...(fields.detail ? { detail: fields.detail } : {}),
  });
}

export async function locatorText(
  parent: Locator,
  childSelector: string,
): Promise<string | undefined> {
  const child = parent.locator(childSelector).first();
  if ((await child.count()) === 0) {
    return undefined;
  }
  return (await child.innerText()).trim();
}
