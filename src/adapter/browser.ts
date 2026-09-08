import { randomBytes } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { access } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import {
  chromium,
  type BrowserContext,
  type ElementHandle,
  type Locator,
  type Page,
} from "playwright-core";
import {
  EXPRESS_ENTRY_URL,
  EXPRESS_ORIGIN,
  MAX_CHAT_ID_LENGTH,
  SEARCH_SETTLE_POLL_MS,
  SEARCH_SETTLE_MS,
  SEARCH_SETTLE_STABILITY_MS,
  SEARCH_UI_TIMEOUT_MS,
  SELECTOR_BUNDLE_VERSION,
} from "../constants.js";
import { ExpressError } from "../errors.js";
import {
  observeSearchSettlement,
  searchTerminalStateKey,
  type SearchSettlementTracker,
} from "./search-settlement.js";
import {
  EXPRESS_WEB_3_66,
  classifySnapshot,
  directChatFingerprint,
  directFingerprintForHandle,
  exactlyOneVisible,
  ephemeralChatFingerprint,
  ephemeralFingerprintForHandle,
  handleIsCurrentDirectResultRow,
  handleIsCurrentChatRow,
  inspectExpressPage,
  isSemanticallyEmptySearchEditor,
  locatorText,
  searchEditorValueState,
  snapshotExpressPage,
  stableChatIdForRow,
  stableChatIdForHandle,
} from "./selectors/express-web-3.66.js";
import type {
  ExpressAdapter,
  AdapterStatus,
  ChatSummary,
  DirectChatSummary,
  SendOutcome,
  VisibleMessage,
} from "./types.js";

interface StableTarget {
  kind: "stable";
  stableId: string;
  handle: ElementHandle<HTMLElement>;
}

interface EphemeralTarget {
  kind: "ephemeral";
  handle: ElementHandle<HTMLElement>;
  fingerprint: string;
}

interface DirectTarget {
  kind: "direct";
  handle: ElementHandle<HTMLElement>;
  fingerprint: string;
}

type ChatTarget = StableTarget | EphemeralTarget | DirectTarget;
const MAX_RETAINED_CHAT_TARGETS = 200;
const MAX_RETAINED_DIRECT_TARGETS = 200;

export interface BrowserAdapterOptions {
  profileDir: string;
  headless: boolean;
  executablePath?: string;
}

function executableCandidates(
  platform: NodeJS.Platform = process.platform,
): string[] {
  if (platform === "darwin") {
    return [
      "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
      path.join(
        homedir(),
        "Applications",
        "Google Chrome.app",
        "Contents",
        "MacOS",
        "Google Chrome",
      ),
      "/Applications/Chromium.app/Contents/MacOS/Chromium",
    ];
  }
  if (platform === "win32") {
    return [
      path.join(
        process.env.PROGRAMFILES ?? "C:\\Program Files",
        "Google",
        "Chrome",
        "Application",
        "chrome.exe",
      ),
      path.join(
        process.env["PROGRAMFILES(X86)"] ?? "C:\\Program Files (x86)",
        "Google",
        "Chrome",
        "Application",
        "chrome.exe",
      ),
      path.join(
        process.env.LOCALAPPDATA ?? "",
        "Google",
        "Chrome",
        "Application",
        "chrome.exe",
      ),
    ];
  }
  return [
    "/usr/bin/google-chrome-stable",
    "/usr/bin/google-chrome",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
  ];
}

export async function discoverChromeExecutable(
  explicitPath?: string,
  platform: NodeJS.Platform = process.platform,
): Promise<string> {
  const candidates = explicitPath
    ? [path.resolve(explicitPath)]
    : executableCandidates(platform);
  for (const candidate of candidates) {
    if (!candidate) {
      continue;
    }
    try {
      await access(candidate, fsConstants.X_OK);
      return candidate;
    } catch {
      // Continue platform discovery without exposing local paths in errors.
    }
  }
  throw new ExpressError("CHROME_NOT_FOUND");
}

function pageOrigin(page: Page): string | undefined {
  try {
    return new URL(page.url()).origin;
  } catch {
    return undefined;
  }
}

async function firstPage(context: BrowserContext): Promise<Page> {
  return context.pages()[0] ?? context.newPage();
}

export class PlaywrightExpressAdapter implements ExpressAdapter {
  readonly #context: BrowserContext;
  readonly #page: Page;
  readonly #targets = new Map<string, ChatTarget>();

  private constructor(context: BrowserContext, page: Page) {
    this.#context = context;
    this.#page = page;
  }

  static async launch(
    options: BrowserAdapterOptions,
  ): Promise<PlaywrightExpressAdapter> {
    const executablePath = await discoverChromeExecutable(
      options.executablePath,
    );
    let context: BrowserContext;
    try {
      context = await chromium.launchPersistentContext(options.profileDir, {
        executablePath,
        headless: options.headless,
      });
    } catch {
      throw new ExpressError("BROWSER_OPERATION_FAILED");
    }
    const page = await firstPage(context);
    const adapter = new PlaywrightExpressAdapter(context, page);
    await adapter.#navigateToEntry();
    return adapter;
  }

  async #navigateToEntry(): Promise<void> {
    try {
      await this.#page.goto(EXPRESS_ENTRY_URL, {
        waitUntil: "domcontentloaded",
        timeout: 30_000,
      });
    } catch {
      throw new ExpressError("BROWSER_OPERATION_FAILED");
    }
  }

  async #requireOperational(): Promise<void> {
    if (pageOrigin(this.#page) !== EXPRESS_ORIGIN) {
      throw new ExpressError("OFFICIAL_ORIGIN_REQUIRED");
    }
    const signature = await inspectExpressPage(this.#page);
    if (signature.signedOut) {
      throw new ExpressError("SIGNED_OUT");
    }
    if (!signature.authenticated || !signature.recognized) {
      throw new ExpressError("UNSUPPORTED_WEB_CLIENT");
    }
  }

  async status(): Promise<AdapterStatus> {
    const originOk = pageOrigin(this.#page) === EXPRESS_ORIGIN;
    if (!originOk) {
      return {
        profileReady: true,
        authentication: "signed_out",
        officialOrigin: false,
        selectorCompatible: false,
        selectorVersion: SELECTOR_BUNDLE_VERSION,
        diagnosticCode: "OFFICIAL_ORIGIN_REQUIRED",
        guidance:
          "Run express-mcp login and return to the official Express web client.",
      };
    }
    const signature = await inspectExpressPage(this.#page);
    if (signature.authenticated) {
      return {
        profileReady: true,
        authentication: "authenticated",
        officialOrigin: true,
        selectorCompatible: true,
        selectorVersion: SELECTOR_BUNDLE_VERSION,
        guidance: "The dedicated profile is ready.",
      };
    }
    if (signature.signedOut) {
      return {
        profileReady: true,
        authentication: "signed_out",
        officialOrigin: true,
        selectorCompatible: true,
        selectorVersion: SELECTOR_BUNDLE_VERSION,
        diagnosticCode: "SIGNED_OUT",
        guidance: "Run express-mcp login and complete SSO/2FA manually.",
      };
    }
    return {
      profileReady: true,
      authentication: "signed_out",
      officialOrigin: true,
      selectorCompatible: false,
      selectorVersion: SELECTOR_BUNDLE_VERSION,
      diagnosticCode: "UNSUPPORTED_WEB_CLIENT",
      guidance:
        "Run status and inspect the headed official client before retrying.",
    };
  }

  async listChats(): Promise<ChatSummary[]> {
    await this.#disposeDirectTargets();
    await this.#requireOperational();
    await this.#clearSearchAndRestoreList();
    await this.#requireOperational();
    const rows = this.#page.locator(EXPRESS_WEB_3_66.chatRow);
    const count = await rows.count();
    const chats: ChatSummary[] = [];
    for (let index = 0; index < count; index += 1) {
      const row = rows.nth(index);
      const handle = (await row.elementHandle()) as
        | ElementHandle<HTMLElement>
        | null;
      if (!handle) {
        continue;
      }
      const title =
        (await locatorText(row, EXPRESS_WEB_3_66.chatTitle)) ?? "";
      const stableId = await stableChatIdForRow(row);
      const chatId =
        stableId && stableId.length <= MAX_CHAT_ID_LENGTH
          ? stableId
          : `local_${randomBytes(24).toString("base64url")}`;
      const timestamp = await locatorText(row, EXPRESS_WEB_3_66.chatTime);
      const unreadText = await locatorText(row, EXPRESS_WEB_3_66.chatUnread);
      const fingerprint = ephemeralChatFingerprint({
        title,
        ...(timestamp ? { timestamp } : {}),
        ...(unreadText ? { unreadText } : {}),
      });
      await this.#storeTarget(
        chatId,
        stableId && stableId.length <= MAX_CHAT_ID_LENGTH
          ? { kind: "stable", stableId, handle }
          : { kind: "ephemeral", handle, fingerprint },
      );
      const unreadCount =
        unreadText && /^\d+$/.test(unreadText)
          ? Number.parseInt(unreadText, 10)
          : undefined;
      chats.push({
        chatId,
        title,
        ...(timestamp ? { timestamp } : {}),
        ...(unreadCount !== undefined ? { unreadCount } : {}),
      });
    }
    return chats;
  }

  async searchDirectChats(query: string): Promise<DirectChatSummary[]> {
    await this.#disposeDirectTargets();
    await this.#requireOperational();
    const editor = await this.#visibleSearchEditor();
    try {
      await this.#clearSearchEditor(editor);
      await editor.click();
      await editor.fill(query);
      await this.#page.waitForFunction(
        ({ editorSelector, activeSelector, expected }) => {
          const candidates = Array.from(
            document.querySelectorAll<HTMLElement>(editorSelector),
          ).filter((element) => {
            const style = window.getComputedStyle(element);
            const rect = element.getBoundingClientRect();
            return (
              style.visibility !== "hidden" &&
              style.display !== "none" &&
              rect.width > 0 &&
              rect.height > 0
            );
          });
          const candidate = candidates[0];
          return (
            candidates.length === 1 &&
            candidate?.matches(activeSelector) === true &&
            candidate.innerText === expected
          );
        },
        {
          editorSelector: EXPRESS_WEB_3_66.searchEditor,
          activeSelector: EXPRESS_WEB_3_66.searchEditorActive,
          expected: query,
        },
        { timeout: SEARCH_UI_TIMEOUT_MS },
      );
      const settleStartedAt = Date.now();
      const deadline = settleStartedAt + SEARCH_UI_TIMEOUT_MS;
      let tracker: SearchSettlementTracker = { kind: "unsettled" };
      let settled = false;
      let settledDirectResultRows = 0;
      while (Date.now() < deadline) {
        if (pageOrigin(this.#page) !== EXPRESS_ORIGIN) {
          throw new ExpressError("OFFICIAL_ORIGIN_REQUIRED");
        }
        const snapshot = await snapshotExpressPage(this.#page);
        const signature = classifySnapshot(snapshot);
        if (signature.signedOut) {
          throw new ExpressError("SIGNED_OUT");
        }
        const observation = observeSearchSettlement(
          tracker,
          snapshot,
          Date.now() - settleStartedAt,
          SEARCH_SETTLE_MS,
          SEARCH_SETTLE_STABILITY_MS,
        );
        tracker = observation.tracker;
        if (observation.settled && observation.terminalKey) {
          if (pageOrigin(this.#page) !== EXPRESS_ORIGIN) {
            throw new ExpressError("OFFICIAL_ORIGIN_REQUIRED");
          }
          const finalSnapshot = await snapshotExpressPage(this.#page);
          const finalSignature = classifySnapshot(finalSnapshot);
          if (finalSignature.signedOut) {
            throw new ExpressError("SIGNED_OUT");
          }
          if (
            searchTerminalStateKey(finalSnapshot) ===
            observation.terminalKey
          ) {
            settled = true;
            settledDirectResultRows = finalSnapshot.directResultRows;
            break;
          }
          tracker = observeSearchSettlement(
            tracker,
            finalSnapshot,
            Date.now() - settleStartedAt,
            SEARCH_SETTLE_MS,
            SEARCH_SETTLE_STABILITY_MS,
          ).tracker;
        }
        const remainingMs = deadline - Date.now();
        if (remainingMs > 0) {
          await this.#page.waitForTimeout(
            Math.min(SEARCH_SETTLE_POLL_MS, remainingMs),
          );
        }
      }
      if (!settled) {
        throw new ExpressError("UNSUPPORTED_WEB_CLIENT");
      }

      const rows = this.#page.locator(EXPRESS_WEB_3_66.directResultRow);
      const count = await rows.count();
      if (count !== settledDirectResultRows) {
        throw new ExpressError("UNSUPPORTED_WEB_CLIENT");
      }
      const chats: DirectChatSummary[] = [];
      for (let index = 0; index < count; index += 1) {
        const row = rows.nth(index);
        if (!(await row.isVisible().catch(() => false))) {
          continue;
        }
        const handle = (await row.elementHandle()) as
          | ElementHandle<HTMLElement>
          | null;
        if (!handle) {
          continue;
        }
        const title =
          (await locatorText(row, EXPRESS_WEB_3_66.directResultTitle)) ?? "";
        if (!title) {
          await handle.dispose().catch(() => undefined);
          continue;
        }
        const detail = await locatorText(
          row,
          EXPRESS_WEB_3_66.directResultDetail,
        );
        const fingerprint = directChatFingerprint({
          title,
          ...(detail ? { detail } : {}),
        });
        const chatId = `direct_${randomBytes(24).toString("base64url")}`;
        await this.#storeTarget(chatId, {
          kind: "direct",
          handle,
          fingerprint,
        });
        chats.push({
          chatId,
          title,
          ...(detail ? { detail } : {}),
          type: "direct",
        });
      }
      return chats;
    } catch (error) {
      await this.#disposeDirectTargets();
      if (error instanceof ExpressError) {
        throw error;
      }
      throw new ExpressError("UNSUPPORTED_WEB_CLIENT");
    }
  }

  async #visibleSearchEditor(): Promise<Locator> {
    const editors = this.#page.locator(EXPRESS_WEB_3_66.searchEditor);
    const visible = [];
    for (let index = 0; index < (await editors.count()); index += 1) {
      const editor = editors.nth(index);
      if (await editor.isVisible().catch(() => false)) {
        visible.push(editor);
      }
    }
    const editor = exactlyOneVisible(visible);
    if (!editor) {
      throw new ExpressError("UNSUPPORTED_WEB_CLIENT");
    }
    return editor;
  }

  async #clearSearchEditor(
    editor: Locator,
  ): Promise<void> {
    await editor.click();
    await editor.press("ControlOrMeta+A");
    await editor.press("Backspace");
    const deadline = Date.now() + SEARCH_UI_TIMEOUT_MS;
    while (Date.now() < deadline) {
      const state = await searchEditorValueState(editor).catch(
        () => undefined,
      );
      const directRows = await this.#page
        .locator(EXPRESS_WEB_3_66.directResultRow)
        .count()
        .catch(() => -1);
      if (
        state &&
        isSemanticallyEmptySearchEditor(state) &&
        directRows === 0
      ) {
        return;
      }
      await this.#page.waitForTimeout(100);
    }
    throw new ExpressError("UNSUPPORTED_WEB_CLIENT");
  }

  async #clearSearchAndRestoreList(): Promise<void> {
    const editor = await this.#visibleSearchEditor();
    await this.#clearSearchEditor(editor);
    try {
      await this.#page
        .locator(EXPRESS_WEB_3_66.chatRow)
        .first()
        .waitFor({ state: "visible", timeout: SEARCH_UI_TIMEOUT_MS });
    } catch {
      throw new ExpressError("UNSUPPORTED_WEB_CLIENT");
    }
  }

  async #disposeDirectTargets(): Promise<void> {
    const directEntries = [...this.#targets.entries()].filter(
      ([, target]) => target.kind === "direct",
    );
    for (const [chatId, target] of directEntries) {
      this.#targets.delete(chatId);
      await target.handle.dispose().catch(() => undefined);
    }
  }

  async #storeTarget(chatId: string, target: ChatTarget): Promise<void> {
    const previous = this.#targets.get(chatId);
    if (previous && previous.handle !== target.handle) {
      await previous.handle.dispose().catch(() => undefined);
    }
    this.#targets.delete(chatId);
    this.#targets.set(chatId, target);
    if (target.kind === "direct") {
      const directEntries = [...this.#targets.entries()].filter(
        ([, candidate]) => candidate.kind === "direct",
      );
      while (directEntries.length > MAX_RETAINED_DIRECT_TARGETS) {
        const oldest = directEntries.shift();
        if (!oldest) {
          break;
        }
        this.#targets.delete(oldest[0]);
        await oldest[1].handle.dispose().catch(() => undefined);
      }
    }
    const retainedListTargets = [...this.#targets.entries()].filter(
      ([, candidate]) => candidate.kind !== "direct",
    );
    while (retainedListTargets.length > MAX_RETAINED_CHAT_TARGETS) {
      const oldest = retainedListTargets.shift();
      if (!oldest) {
        break;
      }
      this.#targets.delete(oldest[0]);
      await oldest[1].handle.dispose().catch(() => undefined);
    }
  }

  async #findStableHandle(
    stableId: string,
  ): Promise<ElementHandle<HTMLElement> | undefined> {
    const rows = this.#page.locator(EXPRESS_WEB_3_66.chatRow);
    const count = await rows.count();
    for (let index = 0; index < count; index += 1) {
      const row = rows.nth(index);
      if ((await stableChatIdForRow(row)) === stableId) {
        return (await row.elementHandle()) as
          | ElementHandle<HTMLElement>
          | undefined;
      }
    }
    return undefined;
  }

  async #resolveTarget(chatId: string): Promise<ElementHandle<HTMLElement>> {
    const target = this.#targets.get(chatId);
    if (!target) {
      throw new ExpressError("CHAT_NOT_TARGETABLE");
    }
    if (target.kind === "direct") {
      return this.#resolveDirectTarget(chatId, target);
    }
    const connected = await handleIsCurrentChatRow(target.handle).catch(
      () => false,
    );
    if (connected && target.kind === "stable") {
      const currentStableId = await stableChatIdForHandle(
        target.handle,
      ).catch(() => undefined);
      if (currentStableId === target.stableId) {
        return target.handle;
      }
    }
    if (connected && target.kind === "ephemeral") {
      const currentFingerprint = await ephemeralFingerprintForHandle(
        target.handle,
      ).catch(() => undefined);
      if (currentFingerprint === target.fingerprint) {
        return target.handle;
      }
    }
    if (target.kind === "stable") {
      const refreshed = await this.#findStableHandle(target.stableId);
      if (refreshed) {
        await this.#storeTarget(chatId, { ...target, handle: refreshed });
        return refreshed;
      }
    }
    this.#targets.delete(chatId);
    await target.handle.dispose().catch(() => undefined);
    throw new ExpressError("CHAT_NOT_TARGETABLE");
  }

  async #resolveDirectTarget(
    chatId: string,
    target: DirectTarget,
  ): Promise<ElementHandle<HTMLElement>> {
    const fail = async (): Promise<never> => {
      this.#targets.delete(chatId);
      await target.handle.dispose().catch(() => undefined);
      throw new ExpressError("CHAT_NOT_TARGETABLE");
    };
    const connected = await handleIsCurrentDirectResultRow(
      target.handle,
    ).catch(() => false);
    if (!connected) {
      return fail();
    }
    const retainedFingerprint = await directFingerprintForHandle(
      target.handle,
    ).catch(() => undefined);
    if (retainedFingerprint !== target.fingerprint) {
      return fail();
    }

    const rows = this.#page.locator(EXPRESS_WEB_3_66.directResultRow);
    const matching: ElementHandle<HTMLElement>[] = [];
    for (let index = 0; index < (await rows.count()); index += 1) {
      const row = rows.nth(index);
      const handle = (await row.elementHandle()) as
        | ElementHandle<HTMLElement>
        | null;
      if (
        handle &&
        (await directFingerprintForHandle(handle).catch(() => undefined)) ===
          target.fingerprint
      ) {
        matching.push(handle);
      } else {
        await handle?.dispose().catch(() => undefined);
      }
    }
    if (matching.length !== 1) {
      for (const handle of matching) {
        if (handle !== target.handle) {
          await handle.dispose().catch(() => undefined);
        }
      }
      return fail();
    }
    const retainedIsUnique = await target.handle
      .evaluate(
        (element, candidate) => element === candidate,
        matching[0]!,
      )
      .catch(() => false);
    if (matching[0] !== target.handle) {
      await matching[0]?.dispose().catch(() => undefined);
    }
    if (!retainedIsUnique) {
      return fail();
    }
    return target.handle;
  }

  async validateChatTarget(chatId: string): Promise<void> {
    await this.#requireOperational();
    await this.#resolveTarget(chatId);
  }

  async #openTarget(chatId: string): Promise<void> {
    const target = await this.#resolveTarget(chatId);
    await target.click();
    await this.#page
      .locator(EXPRESS_WEB_3_66.messageRow)
      .first()
      .waitFor({ state: "attached", timeout: 10_000 })
      .catch(() => undefined);
  }

  async readChat(chatId: string): Promise<VisibleMessage[]> {
    await this.#requireOperational();
    await this.#openTarget(chatId);
    await this.#requireOperational();
    const rows = this.#page.locator(EXPRESS_WEB_3_66.messageRow);
    const count = await rows.count();
    const messages: VisibleMessage[] = [];
    for (let index = 0; index < count; index += 1) {
      const row = rows.nth(index);
      const message = row.locator(EXPRESS_WEB_3_66.message).first();
      if ((await message.count()) === 0) {
        continue;
      }
      const text = await locatorText(message, EXPRESS_WEB_3_66.messageText);
      if (text === undefined) {
        continue;
      }
      const messageId =
        (await message.getAttribute("id")) ??
        `visible_${randomBytes(18).toString("base64url")}`;
      const timestamp = await locatorText(
        message,
        EXPRESS_WEB_3_66.messageTimestamp,
      );
      const header = await locatorText(
        message,
        EXPRESS_WEB_3_66.messageHeader,
      );
      messages.push({
        messageId,
        text,
        ...(timestamp ? { timestamp } : {}),
        ...(header ? { header } : {}),
      });
    }
    return messages;
  }

  async sendMessage(chatId: string, text: string): Promise<SendOutcome> {
    let submitted = false;
    try {
      await this.#requireOperational();
      await this.#openTarget(chatId);
      await this.#requireOperational();
      const existingIds = new Set(
        await this.#page
          .locator(EXPRESS_WEB_3_66.message)
          .evaluateAll((elements) =>
            elements
              .map((element) => element.getAttribute("id"))
              .filter((value): value is string => value !== null),
          ),
      );
      const composer = this.#page.locator(EXPRESS_WEB_3_66.composer).first();
      await composer.waitFor({ state: "visible", timeout: 10_000 });
      await composer.fill(text);
      await composer.press("Enter");
      submitted = true;

      const deadline = Date.now() + 5_000;
      while (Date.now() < deadline) {
        const messages = this.#page.locator(EXPRESS_WEB_3_66.message);
        const messageCount = await messages.count();
        for (let index = Math.max(0, messageCount - 5); index < messageCount; index += 1) {
          const message = messages.nth(index);
          const id = await message.getAttribute("id");
          const visibleText = await locatorText(
            message,
            EXPRESS_WEB_3_66.messageText,
          );
          if (id && !existingIds.has(id) && visibleText === text) {
            return "verified";
          }
        }
        await this.#page.waitForTimeout(100);
      }
      return "unknown";
    } catch {
      if (submitted) {
        return "unknown";
      }
      throw new ExpressError("BROWSER_OPERATION_FAILED");
    }
  }

  async close(): Promise<void> {
    for (const target of this.#targets.values()) {
      await target.handle.dispose().catch(() => undefined);
    }
    this.#targets.clear();
    await this.#context.close().catch(() => undefined);
  }
}

export type LoginOutcome = "authenticated" | "cancelled" | "unsupported";

export async function runHeadedLogin(options: {
  profileDir: string;
  executablePath?: string;
  timeoutMs?: number;
}): Promise<LoginOutcome> {
  const executablePath = await discoverChromeExecutable(
    options.executablePath,
  );
  let context: BrowserContext;
  try {
    context = await chromium.launchPersistentContext(options.profileDir, {
      executablePath,
      headless: false,
    });
  } catch {
    throw new ExpressError("BROWSER_OPERATION_FAILED");
  }
  const timeoutMs = options.timeoutMs ?? 15 * 60_000;
  const deadline = Date.now() + timeoutMs;
  let unsupportedChecks = 0;
  try {
    const page = await firstPage(context);
    await page.goto(EXPRESS_ENTRY_URL, {
      waitUntil: "domcontentloaded",
      timeout: 30_000,
    });
    while (Date.now() < deadline) {
      if (context.pages().length === 0 || page.isClosed()) {
        return "cancelled";
      }
      if (pageOrigin(page) === EXPRESS_ORIGIN) {
        const signature = await inspectExpressPage(page);
        if (signature.authenticated) {
          return "authenticated";
        }
        if (signature.signedOut) {
          unsupportedChecks = 0;
        } else {
          unsupportedChecks += 1;
          if (unsupportedChecks >= 10) {
            return "unsupported";
          }
        }
      }
      await page.waitForTimeout(1_000);
    }
    throw new ExpressError("LOGIN_TIMEOUT");
  } catch (error) {
    if (error instanceof ExpressError) {
      throw error;
    }
    return "cancelled";
  } finally {
    await context.close().catch(() => undefined);
  }
}
