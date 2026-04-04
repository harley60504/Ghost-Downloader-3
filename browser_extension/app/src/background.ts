import type {
  AdvancedFeatureKey,
  DesktopRequestResult,
  GenericTaskSummary,
  PopupStatePayload,
  PopupView,
} from "./shared/types";
import { createDesktopBridge } from "./background/desktop-bridge";
import { createFeatureBridge } from "./background/feature-bridge";
import { createMediaBridge } from "./background/media-bridge";
import { createResourceBridge } from "./background/resource-bridge";
import {
  INTERCEPT_DOWNLOADS_KEY,
  DOMAIN_BLACKLIST_KEY,
  TYPE_BLACKLIST_KEY,
  SIZE_BLACKLIST_KEY,
} from "./background/constants";
import {
  cancelDownload,
  eraseDownloadFromHistory,
  getTab,
  localStorageGet,
} from "./background/chrome-helpers";
import {
  getOnSendHeadersExtraInfoSpec,
  supportsDownloadDeterminingFilename,
  isFirefoxExtension,
} from "./shared/browser";

const desktopBridge = createDesktopBridge();
const featureBridge = createFeatureBridge();
const mediaBridge = createMediaBridge();

let interceptDownloads = true;
let domainBlacklist: string[] = [];
let typeBlacklist: string[] = [];
let sizeBlacklistMB = "";

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
      normalizedUrl.includes(rule) ||
      normalizedFilename.includes(rule) ||
      normalizedMime.includes(rule)
    );
  });
}

function isTypeBlacklisted(downloadItem: chrome.downloads.DownloadItem): boolean {
  return isTypeBlacklistedByMeta(
    String(downloadItem.filename || ""),
    "",
    String(downloadItem.finalUrl || downloadItem.url || ""),
  );
}

function isSizeBlacklistedByValue(sizeBytes: number): boolean {
  const raw = String(sizeBlacklistMB ?? "").trim();
  if (!raw) {
    return false;
  }

  const thresholdMB = Number(raw);
  if (!Number.isFinite(thresholdMB) || thresholdMB <= 0) {
    return false;
  }

  if (!Number.isFinite(sizeBytes) || sizeBytes <= 0) {
    return false;
  }

  return sizeBytes < thresholdMB * 1024 * 1024;
}

function isSizeBlacklisted(downloadItem: chrome.downloads.DownloadItem): boolean {
  const sizeBytes =
    typeof downloadItem.totalBytes === "number" && downloadItem.totalBytes > 0
      ? downloadItem.totalBytes
      : typeof downloadItem.fileSize === "number" && downloadItem.fileSize > 0
        ? downloadItem.fileSize
        : -1;

  return isSizeBlacklistedByValue(sizeBytes);
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

  if (typeof input.size === "number" && isSizeBlacklistedByValue(input.size)) {
    return true;
  }

  return false;
}

const resourceBridge = createResourceBridge({
  isDesktopReady: () => desktopBridge.isReady(),
  sendDesktopRequest: (payload) => desktopBridge.sendRequest(payload),
  shouldBlockFirefoxIntercept: shouldBlockByBlacklist,
});

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
  refreshMediaInventory?: boolean;
} = {}): Promise<PopupStatePayload> {
  const resolvedTabId = await resourceBridge.resolveActiveTabId(options.preferredTabId ?? null);
  const activeTab = resolvedTabId != null ? await getTab(resolvedTabId) : null;
  const desktopState = desktopBridge.buildSnapshot();
  const resourceState = resourceBridge.buildPopupStateData(resolvedTabId, activeTab);

  const mediaPanelState =
    options.currentView === "advanced" || options.refreshMediaInventory
      ? await mediaBridge.buildPanelState(resolvedTabId, {
          refreshInventory: Boolean(options.refreshMediaInventory),
          refreshTarget: true,
        })
      : mediaBridge.getLastPanelState();

  return {
    connectionState: desktopState.connectionState,
    connectionMessage: desktopState.connectionMessage,
    desktopVersion: desktopState.desktopVersion,
    token: desktopState.token,
    serverUrl: desktopState.serverUrl,
    interceptDownloads,
    tasks: desktopState.tasks,
    taskCounters: taskCounters(desktopState.tasks),
    tabId: resolvedTabId,
    featureStates: featureBridge.createFeatureStateMap(resolvedTabId),
    mediaTabs: mediaPanelState.mediaTabs,
    mediaItems: mediaPanelState.mediaItems,
    selectedMediaTabId: mediaPanelState.selectedMediaTabId,
    selectedMediaIndex: mediaPanelState.selectedMediaIndex,
    mediaPlaybackState: mediaPanelState.playbackState,

    domainBlacklist: domainBlacklist.join("\n"),
    typeBlacklist: typeBlacklist.join("\n"),
    sizeBlacklistMB,

    ...resourceState,
  };
}

async function initialize() {
  const localState = await localStorageGet<{
    [INTERCEPT_DOWNLOADS_KEY]: boolean;
    [DOMAIN_BLACKLIST_KEY]: string;
    [TYPE_BLACKLIST_KEY]: string;
    [SIZE_BLACKLIST_KEY]: string;
  }>({
    [INTERCEPT_DOWNLOADS_KEY]: true,
    [DOMAIN_BLACKLIST_KEY]: "",
    [TYPE_BLACKLIST_KEY]: "",
    [SIZE_BLACKLIST_KEY]: "",
  });

  interceptDownloads = Boolean(localState[INTERCEPT_DOWNLOADS_KEY] ?? true);
  domainBlacklist = parseRuleLines(String(localState[DOMAIN_BLACKLIST_KEY] ?? ""));
  typeBlacklist = parseRuleLines(String(localState[TYPE_BLACKLIST_KEY] ?? ""));
  sizeBlacklistMB = String(localState[SIZE_BLACKLIST_KEY] ?? "").trim();

  await desktopBridge.loadPersistentState();
  await resourceBridge.loadPersistentState();
  await featureBridge.loadPersistentState();
  await mediaBridge.loadPersistentState();
  await resourceBridge.resolveActiveTabId();

  if (desktopBridge.buildSnapshot().token) {
    void desktopBridge.connect();
  }

  desktopBridge.ensureReconnectAlarm();
}

chrome.alarms.onAlarm.addListener((alarm) => {
  desktopBridge.handleReconnectAlarm(alarm);
});

chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName !== "local") {
    return;
  }

  desktopBridge.syncLocalStorageChanges(changes);

  if (changes[INTERCEPT_DOWNLOADS_KEY]) {
    interceptDownloads = Boolean(changes[INTERCEPT_DOWNLOADS_KEY].newValue ?? true);
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
});

chrome.tabs.onActivated.addListener((activeInfo) => {
  void resourceBridge.setLastActiveTab(activeInfo.tabId);
});

chrome.windows.onFocusChanged.addListener((windowId) => {
  if (windowId === chrome.windows.WINDOW_ID_NONE) {
    return;
  }
  void resourceBridge.refreshActiveTabFromBrowser();
});

chrome.tabs.onRemoved.addListener((tabId) => {
  resourceBridge.handleTabRemoved(tabId);
  mediaBridge.handleTabRemoved(tabId);
  featureBridge.handleTabRemoved(tabId);
});

chrome.webNavigation.onCommitted.addListener((details) => {
  resourceBridge.handleNavigationCommitted(details);
  mediaBridge.handleNavigationCommitted(details);
  featureBridge.handleNavigationCommitted(details);
});

chrome.webRequest.onSendHeaders.addListener(
  (details) => {
    resourceBridge.handleRequestHeaders(details);
  },
  { urls: ["<all_urls>"] },
  getOnSendHeadersExtraInfoSpec(),
);

chrome.webRequest.onResponseStarted.addListener(
  (details) => {
    void resourceBridge.captureNetworkResource(details);
  },
  { urls: ["<all_urls>"] },
  ["responseHeaders"],
);

if (isFirefoxExtension()) {
  chrome.webRequest.onHeadersReceived.addListener(
    (details) => {
      return resourceBridge.tryInterceptFirefoxDownload(details);
    },
    { urls: ["<all_urls>"], types: ["main_frame", "sub_frame"] },
    ["blocking", "responseHeaders"] as any,
  );
}

chrome.webRequest.onErrorOccurred.addListener(
  (details) => {
    resourceBridge.clearRequestHeaders(details.requestId);
  },
  { urls: ["<all_urls>"] },
);

chrome.webRequest.onCompleted.addListener(
  (details) => {
    resourceBridge.clearRequestHeaders(details.requestId);
  },
  { urls: ["<all_urls>"] },
);

async function interceptBrowserDownload(
  downloadItem: chrome.downloads.DownloadItem,
  options: { eraseFromHistory?: boolean } = {},
) {
  const rawUrl = String(downloadItem.finalUrl || downloadItem.url || "");
  const matchedResource = resourceBridge.findBestResourceForDownload(rawUrl);

  const blacklistFilename =
    matchedResource?.filename ||
    String(downloadItem.filename || "");
  const blacklistMime = matchedResource?.mime || "";
  const blacklistSize =
    matchedResource?.size && matchedResource.size > 0
      ? matchedResource.size
      : typeof downloadItem.totalBytes === "number" && downloadItem.totalBytes > 0
        ? downloadItem.totalBytes
        : typeof downloadItem.fileSize === "number" && downloadItem.fileSize > 0
          ? downloadItem.fileSize
          : -1;

  if (
    shouldBlockByBlacklist({
      url: rawUrl,
      filename: blacklistFilename,
      mime: blacklistMime,
      size: blacklistSize > 0 ? blacklistSize : undefined,
    })
  ) {
    return;
  }

  if (!resourceBridge.shouldHandoffBrowserDownload(downloadItem, interceptDownloads)) {
    return;
  }

  try {
    await cancelDownload(downloadItem.id);
    if (options.eraseFromHistory) {
      await eraseDownloadFromHistory(downloadItem.id);
    }
  } catch {
    // Ignore cancellation cleanup failures; the browser download may continue as fallback.
  }

  await resourceBridge.handoffBrowserDownload(downloadItem);
}

if (!isFirefoxExtension()) {
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

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || typeof message.type !== "string") {
    return;
  }

  if (message.type === "bridge_page_media") {
    void resourceBridge.capturePageResource(sender, message.payload);
    sendResponse({ ok: true });
    return true;
  }

  if (message.type === "bridge_page_command") {
    void featureBridge.handleBridgeScriptCommand(message.payload, sender);
    sendResponse({ ok: true });
    return true;
  }

  if (message.type === "popup_get_state") {
    void (async () => {
      sendResponse(
        await buildPopupState({
          preferredTabId: typeof message.tabId === "number" ? message.tabId : null,
          currentView: message.view as PopupView | undefined,
        }),
      );
    })();
    return true;
  }

  if (message.type === "popup_set_token") {
    void (async () => {
      await desktopBridge.setToken(String(message.token ?? "").trim());
      sendResponse(await buildPopupState({ currentView: message.view as PopupView | undefined }));
    })();
    return true;
  }

  if (message.type === "popup_set_server_url") {
    void (async () => {
      await desktopBridge.setServerUrl(String(message.serverUrl ?? ""));
      sendResponse(await buildPopupState({ currentView: message.view as PopupView | undefined }));
    })();
    return true;
  }

  if (message.type === "popup_refresh_connection") {
    void (async () => {
      await desktopBridge.connect(true);
      sendResponse(await buildPopupState({ currentView: message.view as PopupView | undefined }));
    })();
    return true;
  }

  if (message.type === "popup_set_intercept_downloads") {
    void (async () => {
      interceptDownloads = Boolean(message.enabled);
      await chrome.storage.local.set({ [INTERCEPT_DOWNLOADS_KEY]: interceptDownloads });
      sendResponse(await buildPopupState({ currentView: message.view as PopupView | undefined }));
    })();
    return true;
  }

  if (message.type === "popup_task_action") {
    void (async () => {
      try {
        const result = await desktopBridge.sendRequest<DesktopRequestResult>({
          type: "task_action",
          taskId: message.taskId,
          action: message.action,
        });
        sendResponse(result);
      } catch (error) {
        sendResponse({
          ok: false,
          message: error instanceof Error ? error.message : "任务操作失败",
        });
      }
    })();
    return true;
  }

  if (message.type === "popup_send_resource") {
    void (async () => {
      sendResponse(await resourceBridge.sendResource(String(message.resourceId ?? "")));
    })();
    return true;
  }

  if (message.type === "popup_merge_resources") {
    void (async () => {
      const resourceIds = Array.isArray(message.resourceIds)
        ? message.resourceIds.map((value: unknown) => String(value ?? "")).filter(Boolean)
        : [];
      sendResponse(await resourceBridge.mergeResources(resourceIds));
    })();
    return true;
  }

  if (message.type === "popup_toggle_feature") {
    void (async () => {
      const tabId = typeof message.tabId === "number" ? message.tabId : null;
      if (tabId == null) {
        sendResponse({ ok: false, message: "当前没有可操作的标签页" });
        return;
      }
      try {
        const infoMessage = await featureBridge.toggleFeature(message.feature as AdvancedFeatureKey, tabId);
        sendResponse({ ok: true, message: infoMessage });
      } catch (error) {
        sendResponse({
          ok: false,
          message: error instanceof Error ? error.message : "功能切换失败",
        });
      }
    })();
    return true;
  }

  if (message.type === "popup_set_media_target") {
    void (async () => {
      await mediaBridge.setMediaTarget(Number(message.tabId ?? 0), Number(message.index ?? -1));
      sendResponse(
        await buildPopupState({
          currentView: "advanced",
          refreshMediaInventory: true,
        }),
      );
    })();
    return true;
  }

  if (message.type === "popup_media_action") {
    void (async () => {
      sendResponse(await mediaBridge.performAction(String(message.action ?? ""), message.value));
    })();
    return true;
  }

  if (message.type === "popup_set_domain_blacklist") {
    void (async () => {
      const value = String(message.value ?? "");
      await chrome.storage.local.set({ [DOMAIN_BLACKLIST_KEY]: value });
      sendResponse({ ok: true });
    })();
    return true;
  }

  if (message.type === "popup_set_type_blacklist") {
    void (async () => {
      const value = String(message.value ?? "");
      await chrome.storage.local.set({ [TYPE_BLACKLIST_KEY]: value });
      sendResponse({ ok: true });
    })();
    return true;
  }

  if (message.type === "popup_set_size_blacklist") {
    void (async () => {
      const value = String(message.value ?? "").trim();
      await chrome.storage.local.set({ [SIZE_BLACKLIST_KEY]: value });
      sendResponse({ ok: true });
    })();
    return true;
  }
});

void initialize();