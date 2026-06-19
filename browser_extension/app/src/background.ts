import type {
    DesktopRequestResult,
    GenericTaskSummary,
    PopupStatePayload,
    PopupView,
} from "./shared/types";
import type {PopupCommand} from "./shared/popup-protocol";
import {createDesktopBridge} from "./background/desktop-bridge";
import {createFeatureBridge} from "./background/feature-bridge";
import {createMediaBridge} from "./background/media-bridge";
import {createResourceBridge} from "./background/resource-bridge";
import {
  DOMAIN_BLACKLIST_KEY,
  INTERCEPT_DOWNLOADS_KEY,
  MEDIA_DOWNLOAD_OVERLAY_KEY,
  NOTIFY_ON_TASK_CREATED_KEY,
  SIZE_BLACKLIST_KEY,
  TYPE_BLACKLIST_KEY,
} from "./background/constants";
import {
    cancelDownload,
    eraseDownloadFromHistory,
    findTab,
    loadFromLocalStorage,
    openActionPopup,
    queryTabs,
} from "./background/chrome-helpers";
import {
  isAndroidFirefoxLike,
  isFirefoxExtension,
  onSendHeadersExtraInfoSpec,
  supportsDownloadDeterminingFilename,
} from "./shared/browser";

const desktopBridge = createDesktopBridge();
const resourceBridge = createResourceBridge({
  sendDesktopRequest: (payload) => desktopBridge.sendRequest(payload),
  onTaskCreated: (message) => showTaskCreatedNotification(message),
  shouldBlockDownload: shouldBlockByBlacklist,
});
const featureBridge = createFeatureBridge();
const mediaBridge = createMediaBridge();

let interceptDownloads = true;
let mediaDownloadOverlayEnabled = true;
let domainBlacklist: string[] = [];
let typeBlacklist: string[] = [];
let sizeBlacklistMB = "";
let notifyOnTaskCreated = true;

function parseRuleLines(value: string): string[] {
  return String(value ?? "")
    .split(/\r?\n/)
    .map((line) => line.trim().toLowerCase())
    .filter(Boolean);
}

function isDomainBlacklisted(rawUrl: string): boolean {
  try {
    const hostname = new URL(rawUrl).hostname.toLowerCase();
    return domainBlacklist.some((rule) => hostname === rule || hostname.endsWith(`.${rule}`));
  } catch {
    return false;
  }
}

function isTypeBlacklistedByMeta(filename: string, mime: string, rawUrl: string): boolean {
  const normalizedUrl = String(rawUrl ?? "").toLowerCase();
  const normalizedFilename = String(filename ?? "").toLowerCase();
  const normalizedMime = String(mime ?? "").toLowerCase();

  return typeBlacklist.some((rule) => {
    if (rule.startsWith(".")) {
      return normalizedUrl.includes(rule) || normalizedFilename.endsWith(rule);
    }
    return (
      normalizedUrl.includes(rule)
      || normalizedFilename.includes(rule)
      || normalizedMime.includes(rule)
    );
  });
}

function parseSizeRuleToBytes(value: string): number {
  const raw = String(value ?? "").trim().toLowerCase();
  if (!raw) {
    return 0;
  }

  const match = raw.match(/^\s*(?:<|<=)?\s*(\d+(?:\.\d+)?)\s*(b|kb|kib|mb|mib|gb|gib)?\s*$/i);
  if (!match) {
    return 0;
  }

  const amount = Number(match[1]);
  if (!Number.isFinite(amount) || amount <= 0) {
    return 0;
  }

  const unit = (match[2] || "mb").toLowerCase();
  if (unit === "b") {
    return amount;
  }
  if (unit === "kb" || unit === "kib") {
    return amount * 1024;
  }
  if (unit === "gb" || unit === "gib") {
    return amount * 1024 * 1024 * 1024;
  }
  return amount * 1024 * 1024;
}

function isSizeBlacklistedByValue(sizeBytes: number): boolean {
  const thresholdBytes = parseSizeRuleToBytes(sizeBlacklistMB);
  if (!Number.isFinite(thresholdBytes) || thresholdBytes <= 0) {
    return false;
  }
  if (!Number.isFinite(sizeBytes) || sizeBytes <= 0) {
    return false;
  }
  return sizeBytes < thresholdBytes;
}

function shouldBlockByBlacklist(input: {
  url: string;
  filename?: string;
  mime?: string;
  size?: number;
}): boolean {
  if (isDomainBlacklisted(input.url)) {
    return true;
  }
  if (isTypeBlacklistedByMeta(input.filename ?? "", input.mime ?? "", input.url)) {
    return true;
  }
  return typeof input.size === "number" && isSizeBlacklistedByValue(input.size);
}

async function showTaskCreatedNotification(message?: string) {
  if (!notifyOnTaskCreated) {
    return;
  }

  try {
    const notificationPayload = {
      type: "basic",
      iconUrl: chrome.runtime.getURL("icon128.png"),
      title: "Ghost Downloader",
      message: message?.trim() || "新任务已成功加入 Ghost Downloader",
    } as const;

    if (chrome.notifications?.create) {
      await chrome.notifications.create(notificationPayload);
      return;
    }

    const browserApi = (globalThis as unknown as {
      browser?: {
        notifications?: {
          create?: (options: typeof notificationPayload) => Promise<string> | string;
        };
      };
    }).browser;

    if (browserApi?.notifications?.create) {
      await browserApi.notifications.create(notificationPayload);
    }
  } catch {
    // Notifications are best-effort across browsers and platforms.
  }
}

async function injectMediaDownloadOverlay(tabId: number) {
  if (!mediaDownloadOverlayEnabled) {
    return;
  }
  const tab = await findTab(tabId);
  if (!tab?.url || !/^https?:/i.test(tab.url)) {
    return;
  }

  try {
    await chrome.scripting.executeScript({
      files: ["page-media-overlay.js"],
      injectImmediately: false,
      target: { tabId, allFrames: true },
    });
  } catch {
    // chrome:// and similar reject injection.
  }
}

async function updateMediaDownloadOverlay(enabled: boolean) {
  mediaDownloadOverlayEnabled = enabled;
  await chrome.storage.local.set({ [MEDIA_DOWNLOAD_OVERLAY_KEY]: enabled });

  const tabs = await queryTabs({});
  for (const tab of tabs) {
    if (!tab.id || !tab.url || !/^https?:/i.test(tab.url)) {
      continue;
    }
    chrome.tabs.sendMessage(tab.id, {
      type: "media_download_overlay_set_enabled",
      enabled,
    }, () => {
      const lastError = chrome.runtime.lastError;
      if (enabled && lastError && tab.id) {
        void injectMediaDownloadOverlay(tab.id);
      }
    });
  }
}

function taskCounters(tasks: GenericTaskSummary[]) {
  return {
    total: tasks.length,
    active: tasks.filter((task) => task.status !== "completed").length,
    completed: tasks.filter((task) => task.status === "completed").length,
  };
}

async function buildPopupState(options: {
  preferredTabId?: number | null;
  currentView?: PopupView;
} = {}): Promise<PopupStatePayload> {
  const resolvedTabId = await resourceBridge.resolveActiveTabId(options.preferredTabId ?? null);
  const activeTab = resolvedTabId != null ? await findTab(resolvedTabId) : null;
  const desktopState = desktopBridge.buildSnapshot();
  const resourceState = resourceBridge.buildPopupStateData(resolvedTabId, activeTab);

  const mediaPanelState = await mediaBridge.buildPanelState(
    options.currentView === "advanced" ? resolvedTabId : null,
  );

  return {
    connectionState: desktopState.connectionState,
    connectionMessage: desktopState.connectionMessage,
    desktopVersion: desktopState.desktopVersion,
    token: desktopState.token,
    serverUrl: desktopState.serverUrl,
    interceptDownloads,
    mediaDownloadOverlayEnabled,
    tasks: desktopState.tasks,
    taskCounters: taskCounters(desktopState.tasks),
    tabId: resolvedTabId,
    featureStates: featureBridge.createFeatureStateMap(resolvedTabId),
    mediaItems: mediaPanelState.mediaItems,
    mediaPlaybackState: mediaPanelState.playbackState,
    domainBlacklist: domainBlacklist.join("\n"),
    typeBlacklist: typeBlacklist.join("\n"),
    sizeBlacklistMB,
    notifyOnTaskCreated,
    ...resourceState,
  };
}

async function initialize() {
  const localState = await loadFromLocalStorage<{
    [INTERCEPT_DOWNLOADS_KEY]: boolean;
    [MEDIA_DOWNLOAD_OVERLAY_KEY]: boolean;
    [DOMAIN_BLACKLIST_KEY]: string;
    [TYPE_BLACKLIST_KEY]: string;
    [SIZE_BLACKLIST_KEY]: string;
    [NOTIFY_ON_TASK_CREATED_KEY]: boolean;
  }>({
    [INTERCEPT_DOWNLOADS_KEY]: true,
    [MEDIA_DOWNLOAD_OVERLAY_KEY]: true,
    [DOMAIN_BLACKLIST_KEY]: "",
    [TYPE_BLACKLIST_KEY]: "",
    [SIZE_BLACKLIST_KEY]: "",
    [NOTIFY_ON_TASK_CREATED_KEY]: true,
  });

  interceptDownloads = Boolean(localState[INTERCEPT_DOWNLOADS_KEY] ?? true);
  mediaDownloadOverlayEnabled = Boolean(localState[MEDIA_DOWNLOAD_OVERLAY_KEY] ?? true);
  domainBlacklist = parseRuleLines(String(localState[DOMAIN_BLACKLIST_KEY] ?? ""));
  typeBlacklist = parseRuleLines(String(localState[TYPE_BLACKLIST_KEY] ?? ""));
  sizeBlacklistMB = String(localState[SIZE_BLACKLIST_KEY] ?? "").trim();
  notifyOnTaskCreated = Boolean(localState[NOTIFY_ON_TASK_CREATED_KEY] ?? true);

  await desktopBridge.loadPersistentState();
  await resourceBridge.loadPersistentState();
  await featureBridge.loadPersistentState();
  const activeTabId = await resourceBridge.resolveActiveTabId();
  if (activeTabId != null) {
    void injectMediaDownloadOverlay(activeTabId);
  }

  if (desktopBridge.buildSnapshot().token) {
    void desktopBridge.connect();
  }

  desktopBridge.ensureReconnectAlarm();
}

chrome.alarms.onAlarm.addListener((alarm) => {
  desktopBridge.onReconnectAlarm(alarm);
});

chrome.runtime.onConnect.addListener((port) => {
  if (port.name === "HeartBeat") {
    port.postMessage("HeartBeat");
  }
});

chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName !== "local") {
    return;
  }
  desktopBridge.onLocalStorageChanged(changes);
  if (changes[INTERCEPT_DOWNLOADS_KEY]) {
    interceptDownloads = Boolean(changes[INTERCEPT_DOWNLOADS_KEY].newValue ?? true);
  }
  if (changes[MEDIA_DOWNLOAD_OVERLAY_KEY]) {
    mediaDownloadOverlayEnabled = Boolean(changes[MEDIA_DOWNLOAD_OVERLAY_KEY].newValue ?? true);
  }
  if (changes[DOMAIN_BLACKLIST_KEY]) {
    domainBlacklist = parseRuleLines(String(changes[DOMAIN_BLACKLIST_KEY].newValue ?? ""));
  }
  if (changes[TYPE_BLACKLIST_KEY]) {
    typeBlacklist = parseRuleLines(String(changes[TYPE_BLACKLIST_KEY].newValue ?? ""));
  }
  if (changes[SIZE_BLACKLIST_KEY]) {
    sizeBlacklistMB = String(changes[SIZE_BLACKLIST_KEY].newValue ?? "").trim();
  }
  if (changes[NOTIFY_ON_TASK_CREATED_KEY]) {
    notifyOnTaskCreated = Boolean(changes[NOTIFY_ON_TASK_CREATED_KEY].newValue ?? true);
  }
});

chrome.tabs.onActivated.addListener((activeInfo) => {
  void resourceBridge.setLastActiveTab(activeInfo.tabId);
  void injectMediaDownloadOverlay(activeInfo.tabId);
});

if (!isAndroidFirefoxLike()) {
  chrome.windows.onFocusChanged.addListener((windowId) => {
    if (windowId === chrome.windows.WINDOW_ID_NONE) {
      return;
    }
    void resourceBridge.refreshActiveTabFromBrowser().then((tabId) => {
      if (tabId != null) {
        void injectMediaDownloadOverlay(tabId);
      }
    });
  });
}

chrome.tabs.onRemoved.addListener((tabId) => {
  resourceBridge.onTabRemoved(tabId);
  mediaBridge.onTabRemoved(tabId);
  featureBridge.onTabRemoved(tabId);
});

chrome.webNavigation.onCommitted.addListener((details) => {
  resourceBridge.onNavigationCommitted(details);
  featureBridge.onNavigationCommitted(details);
});

chrome.webRequest.onSendHeaders.addListener(
  (details) => {
    resourceBridge.onRequestHeaders(details);
    void resourceBridge.captureRequestResource(details);
  },
  { urls: ["<all_urls>"] },
  onSendHeadersExtraInfoSpec(),
);

chrome.webRequest.onResponseStarted.addListener(
  (details) => {
    void resourceBridge.captureNetworkResource(details);
  },
  { urls: ["<all_urls>"] },
  ["responseHeaders"],
);

async function interceptBrowserDownload(
  downloadItem: chrome.downloads.DownloadItem,
  options: { eraseFromHistory?: boolean } = {},
) {
  const finalUrl = downloadItem.finalUrl || downloadItem.url;
  if (!interceptDownloads || !desktopBridge.isReady() || !/^https?:/i.test(finalUrl)) {
    return;
  }
  if (shouldBlockByBlacklist({
    url: finalUrl,
    filename: downloadItem.filename,
    mime: downloadItem.mime,
    size: downloadItem.totalBytes > 0 ? downloadItem.totalBytes : undefined,
  })) {
    return;
  }

  try {
    await cancelDownload(downloadItem.id);
    if (options.eraseFromHistory) {
      await eraseDownloadFromHistory(downloadItem.id);
    }
  } catch {
    // Cleanup failed but the browser will still finish the download as fallback.
  }

  await resourceBridge.handoffBrowserDownload(downloadItem);
}

function reply(sendResponse: (response?: unknown) => void, response: Promise<unknown>) {
  void response.then(sendResponse);
  return true;
}

if (isFirefoxExtension()) {
  chrome.webRequest.onHeadersReceived.addListener(
    (details) => {
      if (!interceptDownloads || !desktopBridge.isReady() || !/^https?:/i.test(details.url)) {
        return undefined;
      }
      return resourceBridge.tryInterceptFirefoxDownload(details);
    },
    { urls: ["<all_urls>"], types: ["main_frame", "sub_frame"] },
    ["blocking", "responseHeaders"] as chrome.webRequest.OnHeadersReceivedOptions[],
  );
} else {
  if (supportsDownloadDeterminingFilename()) {
    chrome.downloads.onDeterminingFilename.addListener((downloadItem, suggest) => {
      suggest();
      void interceptBrowserDownload(downloadItem);
    });
  } else if (chrome.downloads.onCreated?.addListener) {
    chrome.downloads.onCreated.addListener((downloadItem) => {
      void interceptBrowserDownload(downloadItem, { eraseFromHistory: true });
    });
  }
}

// The typed receiver half of the popup command seam (shared/popup-protocol.ts): one
// exhaustive switch over the command union. Each case narrows the command to its own shape
// (no cast); the never-typed default makes a missing case a compile error.
async function handlePopupCommand(command: PopupCommand): Promise<PopupStatePayload | DesktopRequestResult> {
  switch (command.type) {
    case "popup_get_state":
      return buildPopupState({
        preferredTabId: typeof command.tabId === "number" ? command.tabId : null,
        currentView: command.view,
      });
    case "popup_set_token":
      await desktopBridge.setToken(command.token.trim());
      return buildPopupState({ currentView: command.view });
    case "popup_set_server_url":
      await desktopBridge.setServerUrl(command.serverUrl);
      return buildPopupState({ currentView: command.view });
    case "popup_refresh_connection":
      await desktopBridge.connect(true);
      return buildPopupState({ currentView: command.view });
    case "popup_set_intercept_downloads":
      interceptDownloads = command.enabled;
      await chrome.storage.local.set({ [INTERCEPT_DOWNLOADS_KEY]: interceptDownloads });
      return buildPopupState({ currentView: command.view });
    case "popup_set_media_download_overlay":
      await updateMediaDownloadOverlay(command.enabled);
      return buildPopupState({ currentView: command.view });
    case "popup_set_notify_on_task_created":
      notifyOnTaskCreated = command.enabled;
      await chrome.storage.local.set({ [NOTIFY_ON_TASK_CREATED_KEY]: notifyOnTaskCreated });
      return buildPopupState({ currentView: command.view });
    case "popup_set_media_index":
      await mediaBridge.setMediaIndex(command.tabId, command.index);
      return buildPopupState({ currentView: "advanced" });
    case "popup_request_pairing":
      void desktopBridge.requestPairing().catch(() => {
        // The bridge snapshot carries the user-facing pairing failure message.
      });
      return { ok: true, message: "请确认配对" };
    case "popup_task_action":
      try {
        return await desktopBridge.sendRequest<DesktopRequestResult>({
          type: "task_action",
          taskId: command.taskId,
          action: command.action,
        });
      } catch (error) {
        return { ok: false, message: error instanceof Error ? error.message : "任务操作失败" };
      }
    case "popup_send_resource":
      return resourceBridge.sendResource(command.resourceId);
    case "popup_merge_resources":
      return resourceBridge.mergeResources(command.resourceIds);
    case "popup_toggle_feature":
      try {
        const infoMessage = await featureBridge.toggleFeature(command.feature, command.tabId);
        return { ok: true, message: infoMessage };
      } catch (error) {
        return { ok: false, message: error instanceof Error ? error.message : "功能切换失败" };
      }
    case "popup_set_domain_blacklist":
      await chrome.storage.local.set({ [DOMAIN_BLACKLIST_KEY]: command.value });
      return { ok: true };
    case "popup_set_type_blacklist":
      await chrome.storage.local.set({ [TYPE_BLACKLIST_KEY]: command.value });
      return { ok: true };
    case "popup_set_size_blacklist":
      await chrome.storage.local.set({ [SIZE_BLACKLIST_KEY]: command.value.trim() });
      return { ok: true };
    default:
      return unknownPopupCommand(command);
  }
}

// Reached only by a popup_ message whose type is not a known command. The `never` parameter
// makes the switch above exhaustive at compile time; at runtime it returns a structured
// error instead of throwing, so the caller still gets a response.
function unknownPopupCommand(command: never): DesktopRequestResult {
  return { ok: false, message: `未知命令: ${(command as { type?: string }).type ?? ""}` };
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || typeof message !== "object") {
    return;
  }

  if (message.Message === "addMedia" && typeof message.url === "string") {
    void resourceBridge.capturePageResource(sender, {
      url: message.url,
      href: message.href,
      mime: message.mime,
      ext: message.extraExt,
      requestHeaders: message.requestHeaders,
    });
    sendResponse("ok");
    return true;
  }

  if (typeof message.type !== "string") {
    return;
  }

  if (message.type === "bridge_page_command") {
    void featureBridge.onBridgeScriptCommand(message.payload, sender);
    sendResponse({ ok: true });
    return true;
  }

  if (message.type === "page_download_media") {
    return reply(sendResponse, (async () => {
      const result = await resourceBridge.downloadPageMedia(sender, {
        selection: message.selection,
        href: String(message.href ?? ""),
        title: String(message.title ?? ""),
      });
      if (result.ok) {
        await showTaskCreatedNotification(result.message);
      }
      return result;
    })());
  }

  if (message.type === "page_media_overlay_state") {
    sendResponse({ enabled: mediaDownloadOverlayEnabled });
    return;
  }

  // popup_ commands are privileged (set token / server URL / merge resources). A page can
  // forward arbitrary runtime messages through cat-catch's content script, so the sender —
  // not just the type prefix — is the guard: only the extension's own popup (a
  // chrome-extension:// page, never a tab) may reach the dispatcher. That lets the cast trust
  // the payload, since the popup is the sole, typed caller.
  if (message.type.startsWith("popup_")) {
    if (!sender.url?.startsWith("chrome-extension://")) { return; }
    return reply(sendResponse, handlePopupCommand(message as PopupCommand));
  }
});

void initialize();
