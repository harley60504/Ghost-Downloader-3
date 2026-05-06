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
  MEDIA_DOWNLOAD_OVERLAY_KEY,
  DOMAIN_BLACKLIST_KEY,
  TYPE_BLACKLIST_KEY,
  SIZE_BLACKLIST_KEY,
  NOTIFY_ON_TASK_CREATED_KEY,
} from "./background/constants";
import {
  cancelDownload,
  eraseDownloadFromHistory,
  getTab,
  localStorageGet,
  openActionPopup,
  queryTabs,
} from "./background/chrome-helpers";
import {
  getOnSendHeadersExtraInfoSpec,
  supportsDownloadDeterminingFilename,
  isFirefoxExtension,
  isAndroidFirefoxLike,
} from "./shared/browser";

const desktopBridge = createDesktopBridge();
const resourceBridge = createResourceBridge({
  sendDesktopRequest: (payload) => desktopBridge.sendRequest(payload),
  shouldBlockDownload: shouldBlockByBlacklist,
});
const featureBridge = createFeatureBridge();
const mediaBridge = createMediaBridge();

const resourceBridgeCompat = resourceBridge as unknown as {
  handleNavigationCommitted?: (details: chrome.webNavigation.WebNavigationFramedCallbackDetails) => void;
  handleRequestHeaders?: (details: chrome.webRequest.OnSendHeadersDetails) => void;
  captureRequestResource?: (details: chrome.webRequest.OnSendHeadersDetails) => Promise<void> | void;
  tryInterceptFirefoxDownload?: (details: chrome.webRequest.OnHeadersReceivedDetails) =>
    | chrome.webRequest.BlockingResponse
    | Promise<chrome.webRequest.BlockingResponse | undefined>
    | undefined;
};

let interceptDownloads = true;
let mediaDownloadOverlayEnabled = true;
let domainBlacklist: string[] = [];
let typeBlacklist: string[] = [];
let sizeBlacklistMB = "";
let notifyOnTaskCreated = true;

type TaskStatePayload = Pick<
  PopupStatePayload,
  "connectionState" | "connectionMessage" | "desktopVersion" | "tasks" | "taskCounters"
>;

let cachedTaskState: TaskStatePayload | null = null;
let taskCacheRefreshTimer: ReturnType<typeof setInterval> | null = null;

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

function domainFromRawUrl(rawUrl: string): string {
  try {
    return new URL(rawUrl).hostname;
  } catch {
    return "";
  }
}

function normalizeMediaPanelState(
  mediaPanelState: {
    mediaItems?: Array<{ index: number; label: string; type?: "video" | "audio" }>;
    playbackState?: Record<string, unknown>;
  },
  resolvedTabId: number | null,
  activeTab: chrome.tabs.Tab | null,
) {
  const rawItems = Array.isArray(mediaPanelState.mediaItems) ? mediaPanelState.mediaItems : [];
  const mediaItems = rawItems.map((item) => ({
    index: Number(item.index ?? 0),
    label: String(item.label ?? `media-${Number(item.index ?? 0) + 1}`),
    type: item.type ?? "video",
  }));

  const rawPlayback = mediaPanelState.playbackState ?? {};
  const mediaIndex = Number(rawPlayback.mediaIndex ?? (mediaItems.length > 0 ? 0 : -1));
  const tabId =
    typeof rawPlayback.tabId === "number"
      ? rawPlayback.tabId
      : resolvedTabId;

  const playbackState = {
    available: Boolean(rawPlayback.available),
    stale: Boolean(rawPlayback.stale ?? false),
    message: String(rawPlayback.message ?? ""),
    tabId,
    mediaIndex,
    frameId: Number(rawPlayback.frameId ?? 0),
    count: Number(rawPlayback.count ?? mediaItems.length),
    currentTime: Number(rawPlayback.currentTime ?? 0),
    duration: Number(rawPlayback.duration ?? 0),
    progress: Number(rawPlayback.progress ?? 0),
    volume: Number(rawPlayback.volume ?? 1),
    paused: Boolean(rawPlayback.paused ?? true),
    loop: Boolean(rawPlayback.loop ?? false),
    muted: Boolean(rawPlayback.muted ?? false),
    speed: Number(rawPlayback.speed ?? 1),
    mediaType: String(rawPlayback.mediaType ?? "video") as "video" | "audio" | "",
  };

  const mediaTabs =
    resolvedTabId == null
      ? []
      : [
          {
            tabId: resolvedTabId,
            title: activeTab?.title || "当前标签页",
            domain: domainFromRawUrl(activeTab?.url ?? ""),
          },
        ];

  return {
    mediaTabs,
    mediaItems,
    selectedMediaTabId: tabId,
    selectedMediaIndex: mediaIndex,
    playbackState,
  };
}

async function injectMediaDownloadOverlay(tabId: number) {
  if (!mediaDownloadOverlayEnabled) {
    return;
  }

  const tab = await getTab(tabId);
  if (!tab?.url || !/^https?:/i.test(tab.url)) {
    return;
  }

  try {
    await chrome.scripting.executeScript({
      files: ["catch-script/media-download-overlay.js"],
      injectImmediately: false,
      target: { tabId, allFrames: true },
    });
  } catch {
    // Ignore pages that do not allow extension injection.
  }
}

async function syncMediaDownloadOverlay(enabled: boolean) {
  mediaDownloadOverlayEnabled = enabled;
  await chrome.storage.local.set({ [MEDIA_DOWNLOAD_OVERLAY_KEY]: enabled });

  const tabs = await queryTabs({});
  for (const tab of tabs) {
    if (!tab.id || !tab.url || !/^https?:/i.test(tab.url)) {
      continue;
    }

    chrome.tabs.sendMessage(
      tab.id,
      {
        type: "media_download_overlay_set_enabled",
        enabled,
      },
      () => {
        const lastError = chrome.runtime.lastError;
        if (enabled && lastError && tab.id) {
          void injectMediaDownloadOverlay(tab.id);
        }
      },
    );
  }
}

function taskCounters(tasks: GenericTaskSummary[]) {
  return {
    total: tasks.length,
    active: tasks.filter((task) => task.status !== "completed").length,
    completed: tasks.filter((task) => task.status === "completed").length,
  };
}

async function showTaskCreatedNotification(message?: string) {
  if (!notifyOnTaskCreated) {
    return;
  }

  if (!chrome.notifications?.create) {
    return;
  }

  try {
    await chrome.notifications.create({
      type: "basic",
      iconUrl: chrome.runtime.getURL("icon128.png"),
      title: "Ghost Downloader",
      message: message?.trim() || "新任务已成功加入 Ghost Downloader",
    });
  } catch {
    // 当前浏览器或平台不支持通知时忽略，避免影响下载拦截。
  }
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

  const mediaPanelState = normalizeMediaPanelState(
    await mediaBridge.buildPanelState(
      options.currentView === "advanced" || options.refreshMediaInventory ? resolvedTabId : null,
    ),
    resolvedTabId,
    activeTab,
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
    mediaTabs: mediaPanelState.mediaTabs,
    mediaItems: mediaPanelState.mediaItems,
    selectedMediaTabId: mediaPanelState.selectedMediaTabId,
    selectedMediaIndex: mediaPanelState.selectedMediaIndex,
    mediaPlaybackState: mediaPanelState.playbackState,
    domainBlacklist: domainBlacklist.join("\n"),
    typeBlacklist: typeBlacklist.join("\n"),
    sizeBlacklistMB,
    notifyOnTaskCreated,
    ...resourceState,
  };
}

function buildTaskState(): TaskStatePayload {
  const desktopState = desktopBridge.buildSnapshot();
  return {
    connectionState: desktopState.connectionState,
    connectionMessage: desktopState.connectionMessage,
    desktopVersion: desktopState.desktopVersion,
    tasks: desktopState.tasks,
    taskCounters: taskCounters(desktopState.tasks),
  };
}

function updateTaskCache() {
  try {
    cachedTaskState = buildTaskState();
  } catch (error) {
    console.warn("Failed to update task cache:", error);
  }
}

async function broadcastTaskUpdate() {
  if (!cachedTaskState) {
    return;
  }

  try {
    await chrome.runtime.sendMessage({
      type: "task_update",
      payload: cachedTaskState,
    });
  } catch {
    // popup 没开、没有接收端时，忽略即可
  }
}

function refreshAndBroadcastTaskState() {
  updateTaskCache();
  void broadcastTaskUpdate();
}

function startTaskCacheRefreshLoop() {
  if (taskCacheRefreshTimer) {
    clearInterval(taskCacheRefreshTimer);
  }

  taskCacheRefreshTimer = setInterval(() => {
    refreshAndBroadcastTaskState();
  }, 900);
}

async function initialize() {
  const localState = await localStorageGet<{
    [INTERCEPT_DOWNLOADS_KEY]: boolean;
    [MEDIA_DOWNLOAD_OVERLAY_KEY]: boolean;
    [NOTIFY_ON_TASK_CREATED_KEY]: boolean;
    [DOMAIN_BLACKLIST_KEY]: string;
    [TYPE_BLACKLIST_KEY]: string;
    [SIZE_BLACKLIST_KEY]: string;
  }>({
    [INTERCEPT_DOWNLOADS_KEY]: true,
    [MEDIA_DOWNLOAD_OVERLAY_KEY]: true,
    [NOTIFY_ON_TASK_CREATED_KEY]: true,
    [DOMAIN_BLACKLIST_KEY]: "",
    [TYPE_BLACKLIST_KEY]: "",
    [SIZE_BLACKLIST_KEY]: "",
  });

  interceptDownloads = Boolean(localState[INTERCEPT_DOWNLOADS_KEY] ?? true);
  mediaDownloadOverlayEnabled = Boolean(localState[MEDIA_DOWNLOAD_OVERLAY_KEY] ?? true);
  notifyOnTaskCreated = Boolean(localState[NOTIFY_ON_TASK_CREATED_KEY] ?? true);
  domainBlacklist = parseRuleLines(String(localState[DOMAIN_BLACKLIST_KEY] ?? ""));
  typeBlacklist = parseRuleLines(String(localState[TYPE_BLACKLIST_KEY] ?? ""));
  sizeBlacklistMB = String(localState[SIZE_BLACKLIST_KEY] ?? "").trim();

  await desktopBridge.loadPersistentState();
  await resourceBridge.loadPersistentState();
  await featureBridge.loadPersistentState();

  const mediaBridgeAny = mediaBridge as unknown as {
    loadPersistentState?: () => Promise<void> | void;
  };
  if (typeof mediaBridgeAny.loadPersistentState === "function") {
    await mediaBridgeAny.loadPersistentState();
  }

  const activeTabId = await resourceBridge.resolveActiveTabId();
  if (activeTabId != null) {
    void injectMediaDownloadOverlay(activeTabId);
  }

  if (desktopBridge.buildSnapshot().token) {
    void desktopBridge.connect();
  }

  desktopBridge.ensureReconnectAlarm();

  refreshAndBroadcastTaskState();
  startTaskCacheRefreshLoop();
}

chrome.alarms.onAlarm.addListener((alarm) => {
  desktopBridge.handleReconnectAlarm(alarm);
  refreshAndBroadcastTaskState();
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

  desktopBridge.syncLocalStorageChanges(changes);

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

  refreshAndBroadcastTaskState();
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
  resourceBridge.handleTabRemoved(tabId);
  mediaBridge.handleTabRemoved(tabId);
  featureBridge.handleTabRemoved(tabId);
});

chrome.webNavigation.onCommitted.addListener((details) => {
  resourceBridgeCompat.handleNavigationCommitted?.(details);
  featureBridge.handleNavigationCommitted(details);
});

chrome.webRequest.onSendHeaders.addListener(
  (details) => {
    resourceBridgeCompat.handleRequestHeaders?.(details);
    void resourceBridgeCompat.captureRequestResource?.(details);
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

if (isFirefoxExtension() && typeof resourceBridgeCompat.tryInterceptFirefoxDownload === "function") {
  chrome.webRequest.onHeadersReceived.addListener(
    (details) => {
      if (!interceptDownloads || !desktopBridge.isReady() || !/^https?:/i.test(details.url)) {
        return undefined;
      }

      return resourceBridgeCompat.tryInterceptFirefoxDownload?.(details) ?? undefined;
    },
    { urls: ["<all_urls>"], types: ["main_frame", "sub_frame"] },
    ["blocking", "responseHeaders"] as any,
  );
}

async function interceptBrowserDownload(
  downloadItem: chrome.downloads.DownloadItem,
  options: { eraseFromHistory?: boolean } = {},
) {
  const finalUrl = String(downloadItem.finalUrl || downloadItem.url || "");

  if (!interceptDownloads || !desktopBridge.isReady() || !/^https?:/i.test(finalUrl)) {
    return;
  }

  if (
    shouldBlockByBlacklist({
      url: finalUrl,
      filename: String(downloadItem.filename || ""),
      mime: "",
      size:
        typeof downloadItem.totalBytes === "number" && downloadItem.totalBytes > 0
          ? downloadItem.totalBytes
          : undefined,
    })
  ) {
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
  await showTaskCreatedNotification();
  refreshAndBroadcastTaskState();
}

if (supportsDownloadDeterminingFilename()) {
  chrome.downloads.onDeterminingFilename.addListener((downloadItem, suggest) => {
    suggest();
    void interceptBrowserDownload(downloadItem);
  });
} else if (chrome.downloads?.onCreated?.addListener) {
  chrome.downloads.onCreated.addListener((downloadItem) => {
    void interceptBrowserDownload(downloadItem, { eraseFromHistory: true });
  });
}

function reply(sendResponse: (response?: unknown) => void, response: Promise<unknown>) {
  void response.then(sendResponse);
  return true;
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
    return reply(
      sendResponse,
      (async () => {
        const state = await buildPopupState({
          preferredTabId: typeof message.tabId === "number" ? message.tabId : null,
          currentView: message.view as PopupView | undefined,
        });

        cachedTaskState = {
          connectionState: state.connectionState,
          connectionMessage: state.connectionMessage,
          desktopVersion: state.desktopVersion,
          tasks: state.tasks,
          taskCounters: state.taskCounters,
        };

        return state;
      })(),
    );
  }

  if (message.type === "popup_get_tasks_state") {
    if (!cachedTaskState) {
      updateTaskCache();
    }
    sendResponse(cachedTaskState ?? buildTaskState());
    return true;
  }

  if (message.type === "popup_set_token") {
    return reply(
      sendResponse,
      (async () => {
        await desktopBridge.setToken(String(message.token ?? "").trim());
        refreshAndBroadcastTaskState();
        return buildPopupState({ currentView: message.view as PopupView | undefined });
      })(),
    );
  }

  if (message.type === "popup_set_server_url") {
    return reply(
      sendResponse,
      (async () => {
        await desktopBridge.setServerUrl(String(message.serverUrl ?? ""));
        refreshAndBroadcastTaskState();
        return buildPopupState({ currentView: message.view as PopupView | undefined });
      })(),
    );
  }

  if (message.type === "popup_request_pairing") {
    return reply(
      sendResponse,
      (async (): Promise<DesktopRequestResult> => {
        try {
          await desktopBridge.requestPairing();
          refreshAndBroadcastTaskState();
          return { ok: true, message: "配对成功" };
        } catch (error) {
          refreshAndBroadcastTaskState();
          return {
            ok: false,
            message: error instanceof Error ? error.message : "自动配对失败",
          };
        }
      })(),
    );
  }

  if (message.type === "popup_refresh_connection") {
    return reply(
      sendResponse,
      (async () => {
        await desktopBridge.connect(true);
        refreshAndBroadcastTaskState();
        return buildPopupState({ currentView: message.view as PopupView | undefined });
      })(),
    );
  }

  if (message.type === "popup_set_media_download_overlay") {
    return reply(
      sendResponse,
      (async () => {
        await syncMediaDownloadOverlay(Boolean(message.enabled));
        return buildPopupState({ currentView: message.view as PopupView | undefined });
      })(),
    );
  }

  if (message.type === "popup_set_intercept_downloads") {
    return reply(
      sendResponse,
      (async () => {
        interceptDownloads = Boolean(message.enabled);
        await chrome.storage.local.set({ [INTERCEPT_DOWNLOADS_KEY]: interceptDownloads });
        return buildPopupState({ currentView: message.view as PopupView | undefined });
      })(),
    );
  }

  if (message.type === "popup_task_action") {
    return reply(
      sendResponse,
      (async () => {
        try {
          const result = await desktopBridge.sendRequest<DesktopRequestResult>({
            type: "task_action",
            taskId: message.taskId,
            action: message.action,
          });
          refreshAndBroadcastTaskState();
          return result;
        } catch (error) {
          return {
            ok: false,
            message: error instanceof Error ? error.message : "任务操作失败",
          };
        }
      })(),
    );
  }

  if (message.type === "popup_send_resource") {
    return reply(
      sendResponse,
      (async () => {
        const result = await resourceBridge.sendResource(String(message.resourceId ?? ""));
        if (result.ok) {
          await showTaskCreatedNotification(result.message);
        }
        refreshAndBroadcastTaskState();
        return result;
      })(),
    );
  }

  if (message.type === "popup_merge_resources") {
    return reply(
      sendResponse,
      (async () => {
        const resourceIds = Array.isArray(message.resourceIds)
          ? message.resourceIds.map((value: unknown) => String(value ?? "")).filter(Boolean)
          : [];
        const result = await resourceBridge.mergeResources(resourceIds);
        if (result.ok) {
          await showTaskCreatedNotification(result.message);
        }
        refreshAndBroadcastTaskState();
        return result;
      })(),
    );
  }

  if (message.type === "page_download_media") {
    return reply(
      sendResponse,
      (async () => {
        const result = await resourceBridge.downloadPageMedia(sender, {
          url: String(message.url ?? ""),
          href: String(message.href ?? ""),
          filename: String(message.filename ?? ""),
          poster: String(message.poster ?? ""),
          resourceUrls: Array.isArray(message.resourceUrls)
            ? message.resourceUrls.map((url: unknown) => String(url ?? "")).filter(Boolean)
            : [],
        });
        if (result.ok) {
          await showTaskCreatedNotification(result.message);
          await openActionPopup();
          refreshAndBroadcastTaskState();
        }
        return result;
      })(),
    );
  }

  if (message.type === "page_media_overlay_state") {
    sendResponse({ enabled: mediaDownloadOverlayEnabled });
    return;
  }

  if (message.type === "popup_toggle_feature") {
    return reply(
      sendResponse,
      (async () => {
        const tabId = typeof message.tabId === "number" ? message.tabId : null;
        if (tabId == null) {
          return { ok: false, message: "当前没有可操作的标签页" };
        }
        try {
          const infoMessage = await featureBridge.toggleFeature(message.feature as AdvancedFeatureKey, tabId);
          return { ok: true, message: infoMessage };
        } catch (error) {
          return {
            ok: false,
            message: error instanceof Error ? error.message : "功能切换失败",
          };
        }
      })(),
    );
  }

  if (message.type === "popup_set_media_target" || message.type === "popup_set_media_index") {
    return reply(
      sendResponse,
      (async () => {
        const tabId = Number(message.tabId ?? 0);
        const index = Number(message.index ?? -1);
        const mediaBridgeAny = mediaBridge as unknown as {
          setMediaTarget?: (tabId: number, index: number) => Promise<void> | void;
        };

        if (typeof mediaBridgeAny.setMediaTarget === "function") {
          await mediaBridgeAny.setMediaTarget(tabId, index);
        } else {
          mediaBridge.setMediaIndex(tabId, index);
        }

        return buildPopupState({
          currentView: "advanced",
          refreshMediaInventory: true,
        });
      })(),
    );
  }

  if (message.type === "popup_media_action") {
    return reply(
      sendResponse,
      (async () => {
        const mediaBridgeAny = mediaBridge as unknown as {
          performAction?: (action: string, value?: unknown) => Promise<DesktopRequestResult> | DesktopRequestResult;
        };

        if (typeof mediaBridgeAny.performAction === "function") {
          return mediaBridgeAny.performAction(String(message.action ?? ""), message.value);
        }

        return {
          ok: false,
          message: "当前 media-bridge 版本不支持媒体控制操作",
        };
      })(),
    );
  }

  if (message.type === "popup_set_domain_blacklist") {
    return reply(
      sendResponse,
      (async () => {
        const value = String(message.value ?? "");
        await chrome.storage.local.set({ [DOMAIN_BLACKLIST_KEY]: value });
        return { ok: true };
      })(),
    );
  }

  if (message.type === "popup_set_type_blacklist") {
    return reply(
      sendResponse,
      (async () => {
        const value = String(message.value ?? "");
        await chrome.storage.local.set({ [TYPE_BLACKLIST_KEY]: value });
        return { ok: true };
      })(),
    );
  }

  if (message.type === "popup_set_size_blacklist") {
    return reply(
      sendResponse,
      (async () => {
        const value = String(message.value ?? "").trim();
        await chrome.storage.local.set({ [SIZE_BLACKLIST_KEY]: value });
        return { ok: true };
      })(),
    );
  }

  if (message.type === "popup_set_notify_on_task_created") {
    return reply(
      sendResponse,
      (async () => {
        notifyOnTaskCreated = Boolean(message.enabled);
        await chrome.storage.local.set({
          [NOTIFY_ON_TASK_CREATED_KEY]: notifyOnTaskCreated,
        });
        return buildPopupState({ currentView: message.view as PopupView | undefined });
      })(),
    );
  }
});

void initialize();
