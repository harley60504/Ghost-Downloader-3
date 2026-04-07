import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Dispatch, SetStateAction } from "react";

import {
  DOMAIN_BLACKLIST_KEY,
  INTERCEPT_DOWNLOADS_KEY,
  NOTIFY_ON_TASK_CREATED_KEY,
  PAIR_TOKEN_KEY,
  SERVER_URL_KEY,
  SIZE_BLACKLIST_KEY,
  TYPE_BLACKLIST_KEY,
} from "../../background/constants";
import { DEFAULT_SERVER_URL, ADVANCED_FEATURES } from "../../shared/constants";
import { isAndroidFirefoxLike } from "../../shared/browser";
import type {
  AdvancedFeatureKey,
  DesktopRequestResult,
  FeatureStateMap,
  MediaPlaybackState,
  PopupStatePayload,
  TaskAction,
  PopupView,
} from "../../shared/types";
import { sortTasks } from "../../shared/utils";

const REFRESH_INTERVAL_MS = isAndroidFirefoxLike() ? 3500 : 1000;
const FLASH_TIMEOUT_MS = 2800;

type FlashTone = "neutral" | "success" | "error";

type PopupSettingsState = Pick<
  PopupStatePayload,
  | "token"
  | "serverUrl"
  | "interceptDownloads"
  | "domainBlacklist"
  | "typeBlacklist"
  | "sizeBlacklistMB"
  | "notifyOnTaskCreated"
>;

const STORAGE_DEFAULTS = {
  [PAIR_TOKEN_KEY]: "",
  [SERVER_URL_KEY]: DEFAULT_SERVER_URL,
  [INTERCEPT_DOWNLOADS_KEY]: true,
  [DOMAIN_BLACKLIST_KEY]: "",
  [TYPE_BLACKLIST_KEY]: "",
  [SIZE_BLACKLIST_KEY]: "",
  [NOTIFY_ON_TASK_CREATED_KEY]: true,
} as const;

function sendRuntimeMessage<T>(message: unknown): Promise<T> {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage(message, (response: T) => {
      const lastError = chrome.runtime.lastError;
      if (lastError) {
        reject(new Error(lastError.message));
        return;
      }
      resolve(response);
    });
  });
}

function sendMessageToTab<T>(
  tabId: number,
  message: Record<string, unknown>,
  options?: chrome.tabs.MessageSendOptions,
): Promise<T> {
  return new Promise((resolve, reject) => {
    chrome.tabs.sendMessage(tabId, message, options ?? {}, (response: T) => {
      const lastError = chrome.runtime.lastError;
      if (lastError) {
        reject(new Error(lastError.message));
        return;
      }
      resolve(response);
    });
  });
}

async function highlightTab(tabId: number): Promise<void> {
  await chrome.tabs.update(tabId, { active: true });
}

function createEmptyFeatureStates(): FeatureStateMap {
  const state = {} as FeatureStateMap;
  for (const { key } of ADVANCED_FEATURES) {
    state[key] = false;
  }
  return state;
}

function createEmptyMediaState(): MediaPlaybackState {
  return {
    available: false,
    stale: false,
    message: "",
    tabId: null,
    mediaIndex: -1,
    frameId: 0,
    count: 0,
    currentTime: 0,
    duration: 0,
    progress: 0,
    volume: 1,
    paused: true,
    loop: false,
    muted: false,
    speed: 1,
    mediaType: "",
  };
}

function createEmptyPayload(): PopupStatePayload {
  return {
    connectionState: "missing_token",
    connectionMessage: "请先在扩展设置里填写配对令牌",
    desktopVersion: "",
    token: "",
    serverUrl: DEFAULT_SERVER_URL,
    interceptDownloads: true,
    tasks: [],
    taskCounters: { total: 0, active: 0, completed: 0 },
    resourceState: "restoring",
    resourceStateMessage: "正在恢复已捕获的资源",
    currentResources: [],
    otherResources: [],
    tabId: null,
    activePageDomain: "",
    featureStates: createEmptyFeatureStates(),
    mediaTabs: [],
    mediaItems: [],
    selectedMediaTabId: null,
    selectedMediaIndex: -1,
    mediaPlaybackState: createEmptyMediaState(),
    domainBlacklist: "",
    typeBlacklist: "",
    sizeBlacklistMB: "",
    notifyOnTaskCreated: true,
  };
}

function updateBusyState<T>(
  setter: Dispatch<SetStateAction<ReadonlySet<T>>>,
  value: T,
  active: boolean,
) {
  setter((current) => {
    const next = new Set(current);
    if (active) {
      next.add(value);
    } else {
      next.delete(value);
    }
    return next;
  });
}

function getErrorMessage(error: unknown, fallback: string) {
  return error instanceof Error ? error.message : fallback;
}

async function readSettingsFromStorage(): Promise<PopupSettingsState> {
  const stored = await chrome.storage.local.get(STORAGE_DEFAULTS);
  return {
    token: String(stored[PAIR_TOKEN_KEY] ?? ""),
    serverUrl: String(stored[SERVER_URL_KEY] ?? DEFAULT_SERVER_URL) || DEFAULT_SERVER_URL,
    interceptDownloads: Boolean(stored[INTERCEPT_DOWNLOADS_KEY] ?? true),
    domainBlacklist: String(stored[DOMAIN_BLACKLIST_KEY] ?? ""),
    typeBlacklist: String(stored[TYPE_BLACKLIST_KEY] ?? ""),
    sizeBlacklistMB: String(stored[SIZE_BLACKLIST_KEY] ?? ""),
    notifyOnTaskCreated: Boolean(stored[NOTIFY_ON_TASK_CREATED_KEY] ?? true),
  };
}

function mergeSettingsIntoPayload(current: PopupStatePayload, settings: PopupSettingsState): PopupStatePayload {
  return {
    ...current,
    ...settings,
  };
}

export function usePopupBridge(activeView: PopupView) {
  const [payload, setPayload] = useState<PopupStatePayload>(createEmptyPayload);
  const [busyTaskIds, setBusyTaskIds] = useState<ReadonlySet<string>>(() => new Set());
  const [busyResourceIds, setBusyResourceIds] = useState<ReadonlySet<string>>(() => new Set());
  const [busyFeatureKeys, setBusyFeatureKeys] = useState<ReadonlySet<AdvancedFeatureKey>>(() => new Set());
  const [flashMessage, setFlashMessage] = useState("");
  const [flashTone, setFlashTone] = useState<FlashTone>("neutral");
  const [isSavingToken, setIsSavingToken] = useState(false);
  const [isSavingServerUrl, setIsSavingServerUrl] = useState(false);
  const [isRefreshingConnection, setIsRefreshingConnection] = useState(false);
  const [isUpdatingIntercept, setIsUpdatingIntercept] = useState(false);
  const [isUpdatingMedia, setIsUpdatingMedia] = useState(false);
  const [isUpdatingNotifyOnTaskCreated, setIsUpdatingNotifyOnTaskCreated] = useState(false);
  const [backgroundUnavailable, setBackgroundUnavailable] = useState(false);

  const mountedRef = useRef(true);
  const flashTimerRef = useRef<number | null>(null);
  const refreshPromiseRef = useRef<Promise<void> | null>(null);
  const lastContentViewRef = useRef<Exclude<PopupView, "settings">>("tasks");
  const activeViewRef = useRef(activeView);

  const requestView = useCallback((view: PopupView): Exclude<PopupView, "settings"> => {
    return view === "settings" ? lastContentViewRef.current : view;
  }, []);

  const applyPopupState = useCallback((next: PopupStatePayload) => {
    if (!mountedRef.current) {
      return;
    }
    setPayload(next);
  }, []);

  const patchSettingsFromStorage = useCallback(async () => {
    const settings = await readSettingsFromStorage();
    if (!mountedRef.current) {
      return settings;
    }
    setPayload((current) => mergeSettingsIntoPayload(current, settings));
    return settings;
  }, []);

  const setFlash = useCallback((message: string, tone: FlashTone = "neutral") => {
    if (!mountedRef.current) {
      return;
    }
    setFlashMessage(message);
    setFlashTone(tone);
    if (flashTimerRef.current !== null) {
      window.clearTimeout(flashTimerRef.current);
    }
    flashTimerRef.current = window.setTimeout(() => {
      if (!mountedRef.current) {
        return;
      }
      setFlashMessage("");
      flashTimerRef.current = null;
    }, FLASH_TIMEOUT_MS);
  }, []);

  const refreshState = useCallback(
    async (view: PopupView) => {
      if (refreshPromiseRef.current) {
        return refreshPromiseRef.current;
      }

      refreshPromiseRef.current = (async () => {
        const settings = await patchSettingsFromStorage();
        try {
          const next = await sendRuntimeMessage<PopupStatePayload>({
            type: "popup_get_state",
            view: requestView(view),
          });
          applyPopupState(mergeSettingsIntoPayload(next, settings));
          if (mountedRef.current) {
            setBackgroundUnavailable(false);
          }
        } catch (error) {
          if (mountedRef.current) {
            setBackgroundUnavailable(true);
            setPayload((current) => ({
              ...mergeSettingsIntoPayload(current, settings),
              connectionState: settings.token ? current.connectionState : "missing_token",
              connectionMessage: settings.token
                ? "背景暂时不可用，已保留本地设置"
                : "请先在扩展设置里填写配对令牌",
            }));
          }
          throw error;
        }
      })();

      try {
        await refreshPromiseRef.current;
      } finally {
        refreshPromiseRef.current = null;
      }
    },
    [applyPopupState, patchSettingsFromStorage, requestView],
  );

  useEffect(() => {
    mountedRef.current = true;
    void patchSettingsFromStorage();
    return () => {
      mountedRef.current = false;
      if (flashTimerRef.current !== null) {
        window.clearTimeout(flashTimerRef.current);
      }
    };
  }, [patchSettingsFromStorage]);

  useEffect(() => {
    const handleStorageChange = (
      changes: { [key: string]: chrome.storage.StorageChange },
      areaName: string,
    ) => {
      if (areaName !== "local") {
        return;
      }

      setPayload((current) => {
        let next = current;
        if (changes[PAIR_TOKEN_KEY]) {
          next = { ...next, token: String(changes[PAIR_TOKEN_KEY].newValue ?? "") };
        }
        if (changes[SERVER_URL_KEY]) {
          next = { ...next, serverUrl: String(changes[SERVER_URL_KEY].newValue ?? DEFAULT_SERVER_URL) || DEFAULT_SERVER_URL };
        }
        if (changes[INTERCEPT_DOWNLOADS_KEY]) {
          next = { ...next, interceptDownloads: Boolean(changes[INTERCEPT_DOWNLOADS_KEY].newValue ?? true) };
        }
        if (changes[DOMAIN_BLACKLIST_KEY]) {
          next = { ...next, domainBlacklist: String(changes[DOMAIN_BLACKLIST_KEY].newValue ?? "") };
        }
        if (changes[TYPE_BLACKLIST_KEY]) {
          next = { ...next, typeBlacklist: String(changes[TYPE_BLACKLIST_KEY].newValue ?? "") };
        }
        if (changes[SIZE_BLACKLIST_KEY]) {
          next = { ...next, sizeBlacklistMB: String(changes[SIZE_BLACKLIST_KEY].newValue ?? "") };
        }
        if (changes[NOTIFY_ON_TASK_CREATED_KEY]) {
          next = { ...next, notifyOnTaskCreated: Boolean(changes[NOTIFY_ON_TASK_CREATED_KEY].newValue ?? true) };
        }
        return next;
      });
    };

    chrome.storage.onChanged.addListener(handleStorageChange);
    return () => chrome.storage.onChanged.removeListener(handleStorageChange);
  }, []);

  useEffect(() => {
    activeViewRef.current = activeView;
    if (activeView !== "settings") {
      lastContentViewRef.current = activeView;
    }
    void refreshState(activeView).catch(() => {
      // Ignore transient popup refresh failures.
    });
  }, [activeView, refreshState]);

  useEffect(() => {
    if (activeViewRef.current === "settings") {
      return;
    }

    const timer = window.setInterval(() => {
      void refreshState(activeViewRef.current).catch(() => {
        // Ignore transient popup polling failures.
      });
    }, REFRESH_INTERVAL_MS);

    return () => {
      window.clearInterval(timer);
    };
  }, [refreshState]);

  const setBusyFeature = useCallback((feature: AdvancedFeatureKey, active: boolean) => {
    updateBusyState(setBusyFeatureKeys, feature, active);
  }, []);

  const saveToken = useCallback(
    async (value: string) => {
      const trimmed = value.trim();
      setIsSavingToken(true);
      try {
        await chrome.storage.local.set({ [PAIR_TOKEN_KEY]: trimmed });
        setPayload((current) => ({ ...current, token: trimmed }));
        try {
          const next = await sendRuntimeMessage<PopupStatePayload>({
            type: "popup_set_token",
            token: trimmed,
            view: requestView(activeViewRef.current),
          });
          applyPopupState(next);
          setBackgroundUnavailable(false);
          setFlash(
            next.connectionState === "connected" ? "配对令牌已保存" : next.connectionMessage,
            next.connectionState === "connected" ? "success" : "neutral",
          );
        } catch {
          setBackgroundUnavailable(true);
          setFlash("配对令牌已保存，等待背景重新连线", "neutral");
        }
        return true;
      } catch (error) {
        setFlash(getErrorMessage(error, "保存配对令牌失败"), "error");
        return false;
      } finally {
        if (mountedRef.current) {
          setIsSavingToken(false);
        }
      }
    },
    [applyPopupState, requestView, setFlash],
  );

  const saveServerUrl = useCallback(
    async (value: string) => {
      const normalized = value.trim() || DEFAULT_SERVER_URL;
      setIsSavingServerUrl(true);
      try {
        await chrome.storage.local.set({ [SERVER_URL_KEY]: normalized });
        setPayload((current) => ({ ...current, serverUrl: normalized }));
        try {
          const next = await sendRuntimeMessage<PopupStatePayload>({
            type: "popup_set_server_url",
            serverUrl: normalized,
            view: requestView(activeViewRef.current),
          });
          applyPopupState(next);
          setBackgroundUnavailable(false);
          setFlash(
            next.connectionState === "connected" ? "服务地址已保存并重新连接" : next.connectionMessage,
            next.connectionState === "connected" ? "success" : "neutral",
          );
        } catch {
          setBackgroundUnavailable(true);
          setFlash("服务地址已保存，等待背景重新连线", "neutral");
        }
        return true;
      } catch (error) {
        setFlash(getErrorMessage(error, "保存服务地址失败"), "error");
        return false;
      } finally {
        if (mountedRef.current) {
          setIsSavingServerUrl(false);
        }
      }
    },
    [applyPopupState, requestView, setFlash],
  );

  const saveDomainBlacklist = useCallback(
    async (value: string) => {
      try {
        await chrome.storage.local.set({ [DOMAIN_BLACKLIST_KEY]: value });
        setPayload((current) => ({ ...current, domainBlacklist: value }));
        setFlash("网域黑名单已保存", "success");
        return true;
      } catch (error) {
        setFlash(getErrorMessage(error, "保存网域黑名单失败"), "error");
        return false;
      }
    },
    [setFlash],
  );

  const saveTypeBlacklist = useCallback(
    async (value: string) => {
      try {
        await chrome.storage.local.set({ [TYPE_BLACKLIST_KEY]: value });
        setPayload((current) => ({ ...current, typeBlacklist: value }));
        setFlash("类型黑名单已保存", "success");
        return true;
      } catch (error) {
        setFlash(getErrorMessage(error, "保存类型黑名单失败"), "error");
        return false;
      }
    },
    [setFlash],
  );

  const saveSizeBlacklist = useCallback(
    async (value: string) => {
      const normalized = value.trim();
      try {
        await chrome.storage.local.set({ [SIZE_BLACKLIST_KEY]: normalized });
        setPayload((current) => ({ ...current, sizeBlacklistMB: normalized }));
        setFlash("大小门槛已保存", "success");
        return true;
      } catch (error) {
        setFlash(getErrorMessage(error, "保存大小门槛失败"), "error");
        return false;
      }
    },
    [setFlash],
  );

  const setNotifyOnTaskCreated = useCallback(
    async (enabled: boolean) => {
      setIsUpdatingNotifyOnTaskCreated(true);
      try {
        await chrome.storage.local.set({ [NOTIFY_ON_TASK_CREATED_KEY]: enabled });
        setPayload((current) => ({ ...current, notifyOnTaskCreated: enabled }));
        try {
          const next = await sendRuntimeMessage<PopupStatePayload>({
            type: "popup_set_notify_on_task_created",
            enabled,
            view: requestView(activeViewRef.current),
          });
          applyPopupState(next);
          setBackgroundUnavailable(false);
        } catch {
          setBackgroundUnavailable(true);
        }
      } catch (error) {
        setFlash(getErrorMessage(error, "更新任务通知设置失败"), "error");
      } finally {
        if (mountedRef.current) {
          setIsUpdatingNotifyOnTaskCreated(false);
        }
      }
    },
    [applyPopupState, requestView, setFlash],
  );

  const refreshConnection = useCallback(async () => {
    setIsRefreshingConnection(true);
    try {
      const next = await sendRuntimeMessage<PopupStatePayload>({
        type: "popup_refresh_connection",
        view: requestView(activeViewRef.current),
      });
      applyPopupState(next);
      setBackgroundUnavailable(false);
      setFlash(next.connectionMessage, next.connectionState === "connected" ? "success" : "neutral");
      return true;
    } catch (error) {
      setBackgroundUnavailable(true);
      setFlash(getErrorMessage(error, "重新连接失败"), "error");
      return false;
    } finally {
      if (mountedRef.current) {
        setIsRefreshingConnection(false);
      }
    }
  }, [applyPopupState, requestView, setFlash]);

  const setInterceptDownloads = useCallback(
    async (enabled: boolean) => {
      setIsUpdatingIntercept(true);
      try {
        await chrome.storage.local.set({ [INTERCEPT_DOWNLOADS_KEY]: enabled });
        setPayload((current) => ({ ...current, interceptDownloads: enabled }));
        try {
          const next = await sendRuntimeMessage<PopupStatePayload>({
            type: "popup_set_intercept_downloads",
            enabled,
            view: requestView(activeViewRef.current),
          });
          applyPopupState(next);
          setBackgroundUnavailable(false);
        } catch {
          setBackgroundUnavailable(true);
        }
      } catch (error) {
        setFlash(getErrorMessage(error, "更新拦截下载失败"), "error");
      } finally {
        if (mountedRef.current) {
          setIsUpdatingIntercept(false);
        }
      }
    },
    [applyPopupState, requestView, setFlash],
  );

  const performTaskAction = useCallback(
    async (taskId: string, action: TaskAction) => {
      updateBusyState(setBusyTaskIds, taskId, true);
      try {
        const result = await sendRuntimeMessage<DesktopRequestResult>({
          type: "popup_task_action",
          taskId,
          action,
        });
        setBackgroundUnavailable(false);
        if (!result.ok) {
          throw new Error(result.message || "任务操作失败");
        }
        await refreshState(activeViewRef.current);
        setFlash("任务操作已发送", "success");
      } catch (error) {
        setBackgroundUnavailable(true);
        setFlash(getErrorMessage(error, "任务操作失败"), "error");
      } finally {
        updateBusyState(setBusyTaskIds, taskId, false);
      }
    },
    [refreshState, setFlash],
  );

  const sendResource = useCallback(
    async (resourceId: string) => {
      updateBusyState(setBusyResourceIds, resourceId, true);
      try {
        const result = await sendRuntimeMessage<DesktopRequestResult>({
          type: "popup_send_resource",
          resourceId,
        });
        setBackgroundUnavailable(false);
        if (!result.ok) {
          throw new Error(result.message || "发送资源失败");
        }
        await refreshState(activeViewRef.current);
        setFlash(result.message || "资源处理成功", "success");
      } catch (error) {
        setBackgroundUnavailable(true);
        setFlash(getErrorMessage(error, "发送资源失败"), "error");
      } finally {
        updateBusyState(setBusyResourceIds, resourceId, false);
      }
    },
    [refreshState, setFlash],
  );

  const mergeResources = useCallback(
    async (resourceIds: string[]) => {
      const ids = [...new Set(resourceIds.map((value) => String(value || "")).filter(Boolean))];
      ids.forEach((resourceId) => updateBusyState(setBusyResourceIds, resourceId, true));
      try {
        const result = await sendRuntimeMessage<DesktopRequestResult>({
          type: "popup_merge_resources",
          resourceIds: ids,
        });
        setBackgroundUnavailable(false);
        if (!result.ok) {
          throw new Error(result.message || "在线合并失败");
        }
        await refreshState(activeViewRef.current);
        setFlash(result.message || "资源已发送到 Ghost Downloader", "success");
        return true;
      } catch (error) {
        setBackgroundUnavailable(true);
        setFlash(getErrorMessage(error, "在线合并失败"), "error");
        return false;
      } finally {
        ids.forEach((resourceId) => updateBusyState(setBusyResourceIds, resourceId, false));
      }
    },
    [refreshState, setFlash],
  );

  const toggleFeature = useCallback(
    async (feature: AdvancedFeatureKey) => {
      if (payload.tabId == null) {
        setFlash("当前没有可操作的标签页", "error");
        return;
      }
      setBusyFeature(feature, true);
      try {
        const result = await sendRuntimeMessage<DesktopRequestResult>({
          type: "popup_toggle_feature",
          feature,
          tabId: payload.tabId,
        });
        setBackgroundUnavailable(false);
        if (!result.ok) {
          throw new Error(result.message || "功能切换失败");
        }
        await refreshState(activeViewRef.current);
        setFlash(result.message || "功能状态已更新", "success");
      } catch (error) {
        setBackgroundUnavailable(true);
        setFlash(getErrorMessage(error, "功能切换失败"), "error");
      } finally {
        setBusyFeature(feature, false);
      }
    },
    [payload.tabId, refreshState, setBusyFeature, setFlash],
  );

  const setMediaTarget = useCallback(
    async (tabId: number | null, index: number) => {
      if (!tabId) {
        return;
      }
      try {
        const next = await sendRuntimeMessage<PopupStatePayload>({
          type: "popup_set_media_target",
          tabId,
          index,
        });
        applyPopupState(next);
        setBackgroundUnavailable(false);
      } catch (error) {
        setBackgroundUnavailable(true);
        setFlash(getErrorMessage(error, "切换媒体失败"), "error");
      }
    },
    [applyPopupState, setFlash],
  );

  const performMediaAction = useCallback(
    async (action: string, value?: number | boolean) => {
      setIsUpdatingMedia(true);
      try {
        const sendDesktopMediaAction = async (nextAction: string, nextValue?: number | boolean) => {
          const result = await sendRuntimeMessage<DesktopRequestResult>({
            type: "popup_media_action",
            action: nextAction,
            value: nextValue,
          });
          setBackgroundUnavailable(false);
          if (!result.ok) {
            throw new Error(result.message || "媒体控制失败");
          }
        };

        if (action === "pip" || action === "fullscreen") {
          const tabId = payload.selectedMediaTabId;
          const index = payload.selectedMediaIndex;
          if (!tabId || index < 0) {
            throw new Error("当前没有可控制的媒体");
          }

          if (action === "fullscreen") {
            await highlightTab(tabId);
          }

          const response = await sendMessageToTab<{ ok?: boolean; message?: string }>(
            tabId,
            {
              Message: action === "fullscreen" ? "fullScreen" : "pip",
              index,
            },
            { frameId: payload.mediaPlaybackState.frameId ?? 0 },
          );

          if (response?.ok === false) {
            throw new Error(response.message || "媒体控制失败");
          }

          await refreshState("advanced");
          return;
        }

        if (
          action === "set_volume"
          && typeof value === "number"
          && value > 0
          && payload.mediaPlaybackState.muted
        ) {
          await sendDesktopMediaAction("toggle_muted", false);
        }

        await sendDesktopMediaAction(action, value);
        await refreshState("advanced");
      } catch (error) {
        setBackgroundUnavailable(true);
        setFlash(getErrorMessage(error, "媒体控制失败"), "error");
      } finally {
        if (mountedRef.current) {
          setIsUpdatingMedia(false);
        }
      }
    },
    [payload.mediaPlaybackState.frameId, payload.mediaPlaybackState.muted, payload.selectedMediaIndex, payload.selectedMediaTabId, refreshState, setFlash],
  );

  const sortedTasks = useMemo(() => sortTasks(payload.tasks), [payload.tasks]);

  return {
    ...payload,
    flashMessage,
    flashTone,
    backgroundUnavailable,
    isConnected: payload.connectionState === "connected",
    isSavingToken,
    isSavingServerUrl,
    isRefreshingConnection,
    isUpdatingIntercept,
    isUpdatingMedia,
    saveToken,
    saveServerUrl,
    refreshConnection,
    setInterceptDownloads,
    performTaskAction,
    sendResource,
    mergeResources,
    toggleFeature,
    setMediaTarget,
    performMediaAction,
    saveDomainBlacklist,
    saveTypeBlacklist,
    saveSizeBlacklist,
    isUpdatingNotifyOnTaskCreated,
    setNotifyOnTaskCreated,
    sortedTasks,
    isTaskBusy: (taskId: string) => busyTaskIds.has(taskId),
    isResourceBusy: (resourceId: string) => busyResourceIds.has(resourceId),
    isFeatureBusy: (featureKey: AdvancedFeatureKey) => busyFeatureKeys.has(featureKey),
  };
}
