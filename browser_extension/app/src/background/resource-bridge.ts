import type { CapturedResource, DesktopRequestResult, PopupStatePayload } from "../shared/types";
import {
  canUseOnlineMerge,
  canUseOnlineMergeSelection,
  describeResource,
  domainFromUrl,
  fileExtension,
  filenameFromUrl,
  mimeFromUrl,
  sortResourcesForOnlineMerge,
} from "../shared/utils";
import { isCatCatchMedia } from "../shared/cat-catch";
import {
  BRIDGE_HEADER_SNAPSHOTS_KEY,
  BRIDGE_LAST_ACTIVE_TAB_KEY,
  BRIDGE_PERSIST_DEBOUNCE_MS,
  BRIDGE_RESOURCE_CACHE_KEY,
  HEADER_EXPIRATION_MS,
  HEADER_SNAPSHOT_LIMIT,
  RESOURCE_LIMIT,
} from "./constants";
import {
  bridgeStorageGet,
  bridgeStorageSet,
  getTab,
  openActionPopup,
  queryTabs,
} from "./chrome-helpers";
import { pickSiteMediaResources } from "./media-download-adapters";

type BridgeHeaderSnapshot = {
  url: string;
  headers: Record<string, string>;
  capturedAt: number;
  tabId: number | null;
  supportsRange: boolean;
};

type BridgeResourcePayload = {
  url: string;
  href?: string;
  filename?: string;
  mime?: string;
  ext?: string;
  poster?: string;
  resourceUrls?: string[];
  requestHeaders?: Record<string, string>;
};

type PreparedDownloadHandoff = {
  finalUrl: string;
  filename: string;
  mime: string;
  headers: Record<string, string>;
  size: number;
  supportsRange: boolean;
  matchedResource: CapturedResource | null;
};

type NetworkResponseMeta = {
  size: number;
  mime: string;
  filename: string;
  supportsRange: boolean;
};

type DesktopRequestSender = <T extends DesktopRequestResult>(payload: Record<string, unknown>) => Promise<T>;

type DownloadBlockInput = {
  url: string;
  filename?: string;
  mime?: string;
  size?: number;
};

type DownloadBlockPredicate = (input: DownloadBlockInput) => boolean;
type TaskCreatedCallback = (message?: string) => Promise<void> | void;

type ResourceBucket = Map<string, CapturedResource>;

const HEADER_WHITELIST = new Set([
  "accept",
  "accept-language",
  "authorization",
  "cookie",
  "origin",
  "referer",
  "sec-ch-ua",
  "sec-ch-ua-arch",
  "sec-ch-ua-bitness",
  "sec-ch-ua-full-version",
  "sec-ch-ua-full-version-list",
  "sec-ch-ua-mobile",
  "sec-ch-ua-model",
  "sec-ch-ua-platform",
  "sec-ch-ua-platform-version",
  "sec-fetch-dest",
  "sec-fetch-mode",
  "sec-fetch-site",
  "user-agent",
  "priority",
]);

const MIME_EXTENSIONS: Record<string, string> = {
  "application/dash+xml": "mpd",
  "application/mpegurl": "m3u8",
  "application/vnd.apple.mpegurl": "m3u8",
  "application/x-mpegurl": "m3u8",
  "audio/aac": "aac",
  "audio/flac": "flac",
  "audio/mp4": "m4a",
  "audio/mpeg": "mp3",
  "audio/ogg": "ogg",
  "audio/wav": "wav",
  "audio/webm": "webm",
  "video/mp2t": "ts",
  "video/mp4": "mp4",
  "video/quicktime": "mov",
  "video/webm": "webm",
  "video/x-flv": "flv",
  "video/x-m4v": "m4v",
  "video/x-ms-wmv": "wmv",
};

export function createResourceBridge(options: {
  sendDesktopRequest: DesktopRequestSender;
  shouldBlockDownload?: DownloadBlockPredicate;
  onTaskCreated?: TaskCreatedCallback;
}) {
  let bridgePersistTimer: number | null = null;
  let bridgeStateReady = false;
  let lastActiveTabId: number | null = null;

  const resourceCache = new Map<number, ResourceBucket>();
  const resourcesById = new Map<string, CapturedResource>();
  const headerSnapshotsByUrl = new Map<string, BridgeHeaderSnapshot>();

  function normalizeHeaders(headers: Record<string, string> | undefined): Record<string, string> {
    const result: Record<string, string> = {};
    for (const [key, value] of Object.entries(headers ?? {})) {
      const name = String(key || "").trim().toLowerCase();
      if (!HEADER_WHITELIST.has(name)) {
        continue;
      }
      const text = String(value ?? "").trim();
      if (!text) {
        continue;
      }
      result[name] = text;
    }
    return result;
  }

  function trimFilename(value: string): string {
    const text = String(value || "").trim();
    if (!text) {
      return "";
    }
    const slashIndex = Math.max(text.lastIndexOf("/"), text.lastIndexOf("\\"));
    return slashIndex >= 0 ? text.slice(slashIndex + 1) : text;
  }

  function isCapturableUrl(rawUrl: string): boolean {
    return /^https?:/i.test(rawUrl);
  }

  function sortResources(resources: Iterable<CapturedResource>): CapturedResource[] {
    return [...resources].sort((left, right) => right.capturedAt - left.capturedAt);
  }

  function normalizeUrl(value: string, allowBlob = false): string {
    const text = String(value || "").trim();
    if (!text) {
      return "";
    }

    if (allowBlob && text.startsWith("blob:")) {
      return text;
    }

    try {
      const url = new URL(text);
      url.hash = "";
      return url.toString();
    } catch {
      return text.split("#", 1)[0] ?? text;
    }
  }

  function normalizeCapturedResource(resource: CapturedResource): CapturedResource {
    return {
      id: String(resource.id ?? ""),
      tabId: Number(resource.tabId),
      url: String(resource.url ?? ""),
      pageTitle: String(resource.pageTitle ?? ""),
      pageUrl: String(resource.pageUrl ?? ""),
      filename: String(resource.filename ?? ""),
      mime: String(resource.mime ?? "").toLowerCase(),
      size: Number(resource.size ?? 0),
      supportsRange: Boolean(resource.supportsRange),
      referer: String(resource.referer ?? ""),
      requestHeaders: normalizeHeaders(resource.requestHeaders),
      capturedAt: Number(resource.capturedAt ?? Date.now()),
      sentToDesktopAt: resource.sentToDesktopAt ? Number(resource.sentToDesktopAt) : undefined,
    };
  }

  function normalizeBridgeHeaderSnapshot(snapshot: BridgeHeaderSnapshot): BridgeHeaderSnapshot {
    return {
      url: String(snapshot.url ?? ""),
      headers: normalizeHeaders(snapshot.headers),
      capturedAt: Number(snapshot.capturedAt ?? Date.now()),
      tabId: Number.isInteger(snapshot.tabId) ? Number(snapshot.tabId) : null,
      supportsRange: Boolean(snapshot.supportsRange),
    };
  }

  function responseMeta(headers: chrome.webRequest.HttpHeader[] | undefined): NetworkResponseMeta {
    const meta: NetworkResponseMeta = { size: 0, mime: "", filename: "", supportsRange: false };
    let contentLengthSize = 0;
    let contentRangeSize = 0;
    for (const header of headers ?? []) {
      const name = String(header.name ?? "").toLowerCase();
      const value = String(header.value ?? "").trim();
      if (
        name === "content-length"
        || name === "x-file-size"
        || name === "x-original-content-length"
        || name === "x-goog-stored-content-length"
      ) {
        const size = Number.parseInt(value.replace(/[^0-9]/g, ""), 10);
        contentLengthSize = Number.isFinite(size) && size > 0 ? size : contentLengthSize;
      } else if (name === "content-type") {
        meta.mime = value.split(";")[0]?.trim().toLowerCase() ?? "";
      } else if (name === "content-disposition") {
        const match = /filename\*\s*=\s*UTF-8''([^;]+)|filename\s*=\s*"?([^";]+)"?/i.exec(value);
        const filename = match?.[1] ?? match?.[2] ?? "";
        try {
          meta.filename = trimFilename(decodeURIComponent(filename));
        } catch {
          meta.filename = trimFilename(filename);
        }
      } else if (name === "accept-ranges") {
        meta.supportsRange = value.toLowerCase().includes("bytes");
      } else if (name === "content-range") {
        const totalText = value.split("/")[1] ?? "";
        const size = Number.parseInt(totalText.replace(/[^0-9]/g, ""), 10);
        contentRangeSize = Number.isFinite(size) && size > 0 ? size : contentRangeSize;
        meta.supportsRange = true;
      }
    }
    meta.size = contentRangeSize || contentLengthSize;
    return meta;
  }

  function shouldBlockParsedDownload(url: string, meta: NetworkResponseMeta): boolean {
    return Boolean(options.shouldBlockDownload?.({
      url,
      filename: meta.filename || trimFilename(filenameFromUrl(url)),
      mime: meta.mime || mimeFromUrl(url),
      size: meta.size > 0 ? meta.size : undefined,
    }));
  }
  function shouldBlockPreparedDownload(prepared: PreparedDownloadHandoff): boolean {
    return Boolean(options.shouldBlockDownload?.({
      url: prepared.finalUrl,
      filename: prepared.filename,
      mime: prepared.mime,
      size: prepared.size > 0 ? prepared.size : undefined,
    }));
  }


  function shouldCaptureNetworkResource(details: chrome.webRequest.OnResponseStartedDetails, meta: NetworkResponseMeta): boolean {
    if (!isCapturableUrl(details.url)) {
      return false;
    }
    const extension = fileExtension(meta.filename || filenameFromUrl(details.url));
    return details.type === "media" || isCatCatchMedia(extension, meta.mime);
  }

  function shouldCaptureRequestResource(details: chrome.webRequest.OnSendHeadersDetails): boolean {
    if (!isCapturableUrl(details.url)) {
      return false;
    }
    return details.type === "media" || isCatCatchMedia(fileExtension(filenameFromUrl(details.url)), mimeFromUrl(details.url));
  }

  function urlsLikelySamePage(left: string, right: string): boolean {
    const normalizedLeft = normalizeUrl(left);
    const normalizedRight = normalizeUrl(right);
    if (!normalizedLeft || !normalizedRight) {
      return false;
    }
    return normalizedLeft === normalizedRight || normalizedLeft.startsWith(normalizedRight) || normalizedRight.startsWith(normalizedLeft);
  }

  async function resolveTabIdFromPageUrl(pageUrl: string): Promise<number | null> {
    const normalizedPageUrl = normalizeUrl(pageUrl);
    if (!normalizedPageUrl) {
      return null;
    }

    const tabs = await queryTabs({});
    const exactMatch = tabs.find((tab) => tab.id && tab.url && urlsLikelySamePage(tab.url, normalizedPageUrl));
    if (exactMatch?.id) {
      return exactMatch.id;
    }

    try {
      const initiatorUrl = new URL(normalizedPageUrl);
      const originMatch = tabs.find((tab) => {
        if (!tab.id || !tab.url) {
          return false;
        }
        try {
          return new URL(tab.url).origin === initiatorUrl.origin;
        } catch {
          return false;
        }
      });
      if (originMatch?.id) {
        return originMatch.id;
      }
    } catch {
      // Ignore invalid page URLs.
    }

    return null;
  }

  async function persistBridgeState() {
    bridgePersistTimer = null;
    pruneHeaderSnapshots();
    await bridgeStorageSet({
      [BRIDGE_RESOURCE_CACHE_KEY]: serializeResourceCache(),
      [BRIDGE_HEADER_SNAPSHOTS_KEY]: [...headerSnapshotsByUrl.values()],
      [BRIDGE_LAST_ACTIVE_TAB_KEY]: lastActiveTabId ?? 0,
    });
  }

  function scheduleBridgeStatePersist() {
    if (bridgePersistTimer !== null) {
      return;
    }
    bridgePersistTimer = self.setTimeout(() => {
      void persistBridgeState();
    }, BRIDGE_PERSIST_DEBOUNCE_MS);
  }

  function serializeResourceCache(): Record<string, CapturedResource[]> {
    const result: Record<string, CapturedResource[]> = {};
    for (const [tabId, bucket] of resourceCache.entries()) {
      result[String(tabId)] = sortResources(bucket.values()).slice(0, RESOURCE_LIMIT);
    }
    return result;
  }

  function pruneHeaderSnapshots() {
    const now = Date.now();
    const snapshots = [...headerSnapshotsByUrl.values()]
      .filter((snapshot) => snapshot.url && now - snapshot.capturedAt <= HEADER_EXPIRATION_MS)
      .sort((left, right) => right.capturedAt - left.capturedAt)
      .slice(0, HEADER_SNAPSHOT_LIMIT);

    headerSnapshotsByUrl.clear();
    for (const snapshot of snapshots) {
      headerSnapshotsByUrl.set(snapshot.url, snapshot);
    }
  }

  function clearResourcesForTab(tabId: number) {
    const bucket = resourceCache.get(tabId);
    if (!bucket) {
      return;
    }
    for (const resourceId of bucket.keys()) {
      resourcesById.delete(resourceId);
    }
    resourceCache.delete(tabId);
    scheduleBridgeStatePersist();
  }

  function clearHeaderSnapshotsForTab(tabId: number) {
    let changed = false;
    for (const [url, snapshot] of headerSnapshotsByUrl.entries()) {
      if (snapshot.tabId === tabId) {
        headerSnapshotsByUrl.delete(url);
        changed = true;
      }
    }
    if (changed) {
      scheduleBridgeStatePersist();
    }
  }

  async function setLastActiveTab(tabId: number | null) {
    if (lastActiveTabId === tabId) {
      return;
    }
    lastActiveTabId = tabId;
    scheduleBridgeStatePersist();
  }

  async function refreshActiveTabFromBrowser(): Promise<number | null> {
    const tabs = await queryTabs({ active: true, currentWindow: true });
    const tabId = tabs[0]?.id ?? null;
    await setLastActiveTab(tabId);
    return tabId;
  }

  async function resolveActiveTabId(preferredTabId: number | null = null): Promise<number | null> {
    if (preferredTabId != null) {
      const preferredTab = await getTab(preferredTabId);
      if (preferredTab?.id) {
        await setLastActiveTab(preferredTab.id);
        return preferredTab.id;
      }
    }

    const activeTabId = await refreshActiveTabFromBrowser();
    if (activeTabId != null) {
      return activeTabId;
    }

    if (lastActiveTabId != null) {
      const current = await getTab(lastActiveTabId);
      if (current?.id) {
        return current.id;
      }
    }

    return null;
  }

  function filenameWithExtension(baseName: string, extension: string): string {
    const trimmedBaseName = cleanFilename(baseName) || "resource";
    const normalizedExt = extension.trim().replace(/^\./, "").toLowerCase();
    if (!normalizedExt) {
      return trimmedBaseName;
    }
    if (fileExtension(trimmedBaseName) === normalizedExt) {
      return trimmedBaseName;
    }
    return `${trimmedBaseName}.${normalizedExt}`;
  }

  function cleanFilename(value?: string): string {
    return (value ?? "")
      .trim()
      .replace(/[<>:"/\\|?*\x00-\x1f]+/g, " ")
      .replace(/\s+/g, " ")
      .replace(/[. ]+$/g, "")
      .trim()
      .slice(0, 160);
  }

  function extensionFromMime(mime?: string): string {
    const type = mime?.split(";")[0]?.trim().toLowerCase() ?? "";
    return MIME_EXTENSIONS[type] ?? "";
  }

  function resolveBridgeFilename(payload: BridgeResourcePayload): string {
    const ext = payload.ext?.trim() || extensionFromMime(payload.mime);
    const explicit = cleanFilename(payload.filename);
    if (explicit) {
      return ext && !fileExtension(explicit) ? filenameWithExtension(explicit, ext) : explicit;
    }

    const fromUrl = cleanFilename(filenameFromUrl(payload.url));
    if (fromUrl) {
      return ext ? filenameWithExtension(fromUrl, ext) : fromUrl;
    }

    return ext ? filenameWithExtension("resource", ext) : "resource";
  }

  function filenameForDesktop(resource: CapturedResource): string {
    const urlFilename = filenameFromUrl(resource.url);
    const current = cleanFilename(resource.filename || urlFilename);
    const extension = fileExtension(current)
      || fileExtension(urlFilename)
      || extensionFromMime(resource.mime);
    const title = cleanFilename(resource.pageTitle);
    const baseName = title || current || "resource";
    return filenameWithExtension(baseName, extension);
  }

  async function resolveBridgeResourceTabId(sender: chrome.runtime.MessageSender, href?: string): Promise<number | null> {
    if (sender.tab?.id) {
      await setLastActiveTab(sender.tab.id);
      return sender.tab.id;
    }

    const normalizedHref = href?.trim() ?? "";
    if (normalizedHref) {
      const matchedTabId = await resolveTabIdFromPageUrl(normalizedHref);
      if (matchedTabId != null) {
        return matchedTabId;
      }
    }

    return resolveActiveTabId();
  }

  async function resolveNetworkResourceTabId(details: chrome.webRequest.OnResponseStartedDetails): Promise<number | null> {
    if (details.tabId > 0) {
      return details.tabId;
    }
    const snapshotTabId = resolveHeaderSnapshot(details.url)?.tabId;
    if (snapshotTabId != null) {
      return snapshotTabId;
    }
    const matchedTabId = await resolveTabIdFromPageUrl(details.initiator ?? "");
    return matchedTabId ?? resolveActiveTabId();
  }

  function bucketForTab(tabId: number): ResourceBucket {
    const existing = resourceCache.get(tabId);
    if (existing) {
      return existing;
    }

    const bucket = new Map<string, CapturedResource>();
    resourceCache.set(tabId, bucket);
    return bucket;
  }

  function trimBucket(tabId: number) {
    const bucket = resourceCache.get(tabId);
    if (!bucket || bucket.size <= RESOURCE_LIMIT) {
      return;
    }

    const keepIds = new Set(sortResources(bucket.values()).slice(0, RESOURCE_LIMIT).map((resource) => resource.id));
    for (const resourceId of bucket.keys()) {
      if (keepIds.has(resourceId)) {
        continue;
      }
      bucket.delete(resourceId);
      resourcesById.delete(resourceId);
    }
  }

  function cacheResource(resource: CapturedResource) {
    const bucket = bucketForTab(resource.tabId);
    const existing = bucket.get(resource.id);
    const merged: CapturedResource = existing
      ? {
          ...existing,
          ...resource,
          pageTitle: resource.pageTitle || existing.pageTitle,
          pageUrl: resource.pageUrl || existing.pageUrl,
          filename: resource.filename || existing.filename,
          mime: resource.mime || existing.mime,
          size: resource.size > 0 ? resource.size : existing.size,
          supportsRange: resource.supportsRange || existing.supportsRange,
          referer: resource.referer || existing.referer,
          requestHeaders: {
            ...resource.requestHeaders,
            ...existing.requestHeaders,
          },
          capturedAt: Math.max(existing.capturedAt, resource.capturedAt),
          sentToDesktopAt: existing.sentToDesktopAt ?? resource.sentToDesktopAt,
        }
      : resource;

    bucket.set(merged.id, merged);
    resourcesById.set(merged.id, merged);
    const mergedUrl = normalizeUrl(merged.url, true);
    if (mergedUrl && (merged.size > 0 || merged.mime || merged.supportsRange)) {
      for (const resource of resourcesById.values()) {
        if (resource.id === merged.id || !resource.id.endsWith(`:${mergedUrl}`)) {
          continue;
        }
        resource.size = merged.size > 0 ? merged.size : resource.size;
        resource.mime = merged.mime || resource.mime;
        resource.filename = resource.filename && resource.filename !== "resource" ? resource.filename : merged.filename;
        resource.supportsRange = merged.supportsRange || resource.supportsRange;
      }
    }
    trimBucket(resource.tabId);
    scheduleBridgeStatePersist();
  }

  function findResourceByUrl(rawUrl: string, tabId?: number): CapturedResource | null {
    const resourceIdSuffix = `:${normalizeUrl(rawUrl, true)}`;
    let matched: CapturedResource | null = null;
    const resources = tabId == null ? resourcesById.values() : (resourceCache.get(tabId)?.values() ?? []);
    for (const resource of resources) {
      if (!resource.id.endsWith(resourceIdSuffix)) {
        continue;
      }
      if (matched == null || resource.capturedAt > matched.capturedAt) {
        matched = resource;
      }
    }
    return matched;
  }

  function markResourceSent(resourceId: string) {
    const resource = resourcesById.get(resourceId);
    if (!resource) {
      return;
    }
    resource.sentToDesktopAt = Date.now();
    scheduleBridgeStatePersist();
  }

  function rememberHeaderSnapshot(
    url: string,
    headers: Record<string, string>,
    tabId: number | null,
    supportsRange: boolean,
  ) {
    const existing = headerSnapshotsByUrl.get(url);
    const mergedHeaders = {
      ...(existing?.headers ?? {}),
      ...headers,
    };
    const mergedSupportsRange = supportsRange || Boolean(existing?.supportsRange);
    if (Object.keys(mergedHeaders).length === 0 && !mergedSupportsRange) {
      return;
    }
    headerSnapshotsByUrl.set(url, {
      url,
      headers: mergedHeaders,
      capturedAt: Date.now(),
      tabId: tabId ?? existing?.tabId ?? null,
      supportsRange: mergedSupportsRange,
    });
    pruneHeaderSnapshots();
    scheduleBridgeStatePersist();
  }

  function resolveHeaderSnapshot(url: string): BridgeHeaderSnapshot | null {
    pruneHeaderSnapshots();
    return headerSnapshotsByUrl.get(url) ?? null;
  }

  function otherResourcesForTab(activeTabId: number | null): CapturedResource[] {
    const result: CapturedResource[] = [];
    for (const [tabId, bucket] of resourceCache.entries()) {
      if (activeTabId != null && tabId === activeTabId) {
        continue;
      }
      result.push(...bucket.values());
    }
    return sortResources(result);
  }

  function canSendOneClickResource(resource: CapturedResource): boolean {
    const hint = describeResource(resource).parserHint;
    return hint === "m3u8" || hint === "mpd" || resource.size > 0 || resource.supportsRange;
  }

  function recentAudioVideoPair(resources: CapturedResource[]): CapturedResource[] {
    const recentResources = resources.filter((resource) => Date.now() - resource.capturedAt <= 120000);
    const video = recentResources.find((resource) => describeResource(resource).category === "video");
    const audio = recentResources.find((resource) => describeResource(resource).category === "audio");
    if (!video || !audio || Math.abs(video.capturedAt - audio.capturedAt) > 30000) {
      return [];
    }
    return canUseOnlineMergeSelection([video, audio]) ? [video, audio] : [];
  }

  function deriveMergeOutputTitle(resources: CapturedResource[]): string {
    const pageTitle = (resources[0]?.pageTitle ?? "").trim();
    if (pageTitle) {
      return pageTitle;
    }

    const firstFileName = trimFilename(resources[0]?.filename || filenameFromUrl(resources[0]?.url || ""));
    if (firstFileName) {
      const extension = fileExtension(firstFileName);
      return extension ? firstFileName.slice(0, -(extension.length + 1)) : firstFileName;
    }

    return "merged-media";
  }

  async function downloadResourceViaBrowser(resource: CapturedResource): Promise<void> {
    const filename = filenameForDesktop(resource);

    return new Promise((resolve, reject) => {
      chrome.downloads.download(
        {
          url: resource.url,
          filename,
        },
        (downloadId) => {
          const lastError = chrome.runtime.lastError;
          if (lastError) {
            reject(new Error(lastError.message));
            return;
          }
          if (typeof downloadId !== "number") {
            reject(new Error("浏览器未返回下载任务"));
            return;
          }
          resolve();
        },
      );
    });
  }

  async function loadPersistentState() {
    const bridgeState = await bridgeStorageGet<{
      [BRIDGE_RESOURCE_CACHE_KEY]: Record<string, CapturedResource[]>;
      [BRIDGE_HEADER_SNAPSHOTS_KEY]: BridgeHeaderSnapshot[];
      [BRIDGE_LAST_ACTIVE_TAB_KEY]: number;
    }>({
      [BRIDGE_RESOURCE_CACHE_KEY]: {},
      [BRIDGE_HEADER_SNAPSHOTS_KEY]: [],
      [BRIDGE_LAST_ACTIVE_TAB_KEY]: 0,
    });

    resourceCache.clear();
    resourcesById.clear();
    for (const [tabIdText, resources] of Object.entries(bridgeState[BRIDGE_RESOURCE_CACHE_KEY] ?? {})) {
      const tabId = Number(tabIdText);
      if (!Number.isInteger(tabId) || tabId <= 0 || !Array.isArray(resources)) {
        continue;
      }
      const bucket = new Map<string, CapturedResource>();
      for (const resource of sortResources(resources.map(normalizeCapturedResource)).slice(0, RESOURCE_LIMIT)) {
        bucket.set(resource.id, resource);
        resourcesById.set(resource.id, resource);
      }
      resourceCache.set(tabId, bucket);
    }

    headerSnapshotsByUrl.clear();
    for (const snapshot of bridgeState[BRIDGE_HEADER_SNAPSHOTS_KEY] ?? []) {
      const normalized = normalizeBridgeHeaderSnapshot(snapshot);
      if (!normalized.url) {
        continue;
      }
      headerSnapshotsByUrl.set(normalized.url, normalized);
    }
    pruneHeaderSnapshots();

    lastActiveTabId = Number(bridgeState[BRIDGE_LAST_ACTIVE_TAB_KEY] ?? 0) || null;
    bridgeStateReady = true;
  }

  async function capturePageResource(sender: chrome.runtime.MessageSender, payload: BridgeResourcePayload) {
    const tabId = await resolveBridgeResourceTabId(sender, payload.href);
    if (!tabId || !/^(https?:|blob:)/i.test(payload.url)) {
      return;
    }

    const tab = await getTab(tabId);
    const headerSnapshot = resolveHeaderSnapshot(payload.url);
    const headers = {
      ...(headerSnapshot?.headers ?? {}),
      ...normalizeHeaders(payload.requestHeaders),
    };
    const filename = resolveBridgeFilename(payload);
    const mime = payload.mime?.toLowerCase() || mimeFromUrl(payload.url);

    cacheResource({
      id: `${tabId}:${normalizeUrl(payload.url, true)}`,
      tabId,
      url: payload.url,
      pageTitle: tab?.title ?? "",
      pageUrl: payload.href ?? tab?.url ?? "",
      filename,
      mime,
      size: 0,
      supportsRange: Boolean(headerSnapshot?.supportsRange),
      referer: headers.referer ?? payload.href ?? tab?.url ?? "",
      requestHeaders: headers,
      capturedAt: Date.now(),
    });
  }

  async function captureNetworkResource(details: chrome.webRequest.OnResponseStartedDetails) {
    const meta = responseMeta(details.responseHeaders);
    meta.mime = mimeFromUrl(details.url) || meta.mime;
    const responseSupportsRange = meta.supportsRange || details.statusCode === 206;
    if (responseSupportsRange && isCapturableUrl(details.url)) {
      rememberHeaderSnapshot(details.url, {}, details.tabId > 0 ? details.tabId : lastActiveTabId, true);
    }

    if (!shouldCaptureNetworkResource(details, meta)) {
      return;
    }

    const tabId = await resolveNetworkResourceTabId(details);
    if (!tabId) {
      return;
    }

    const tab = await getTab(tabId);
    const headerSnapshot = resolveHeaderSnapshot(details.url);
    const headers = { ...(headerSnapshot?.headers ?? {}) };
    const referer = headers.referer || (details.initiator && details.initiator !== "null" ? details.initiator : tab?.url) || "";
    if (referer) {
      headers.referer = referer;
    }

    cacheResource({
      id: `${tabId}:${normalizeUrl(details.url, true)}`,
      tabId,
      url: details.url,
      pageTitle: tab?.title ?? "",
      pageUrl: details.initiator && details.initiator !== "null" ? details.initiator : tab?.url ?? "",
      filename: meta.filename || trimFilename(filenameFromUrl(details.url)) || "resource",
      mime: meta.mime,
      size: meta.size,
      supportsRange: responseSupportsRange || Boolean(headerSnapshot?.supportsRange),
      referer,
      requestHeaders: headers,
      capturedAt: Date.now(),
    });
  }

  async function captureRequestResource(details: chrome.webRequest.OnSendHeadersDetails) {
    if (!shouldCaptureRequestResource(details)) {
      return;
    }

    const tabId = details.tabId > 0 ? details.tabId : (lastActiveTabId ?? await resolveActiveTabId());
    if (!tabId) {
      return;
    }

    const tab = await getTab(tabId);
    const headerSnapshot = resolveHeaderSnapshot(details.url);
    const headers = { ...(headerSnapshot?.headers ?? {}) };
    const referer = headers.referer || (details.initiator && details.initiator !== "null" ? details.initiator : tab?.url) || "";
    if (referer) {
      headers.referer = referer;
    }

    cacheResource({
      id: `${tabId}:${normalizeUrl(details.url, true)}`,
      tabId,
      url: details.url,
      pageTitle: tab?.title ?? "",
      pageUrl: details.initiator && details.initiator !== "null" ? details.initiator : tab?.url ?? "",
      filename: trimFilename(filenameFromUrl(details.url)) || "resource",
      mime: mimeFromUrl(details.url),
      size: 0,
      supportsRange: Boolean(headerSnapshot?.supportsRange),
      referer,
      requestHeaders: headers,
      capturedAt: Date.now(),
    });
  }

  function responseHeaderValue(headers: chrome.webRequest.HttpHeader[] | undefined, headerName: string): string {
    const normalizedName = headerName.toLowerCase();
    return String(
      (headers ?? []).find((header) => String(header.name ?? "").toLowerCase() === normalizedName)?.value ?? "",
    ).trim();
  }

  function isLikelyFirefoxDownloadResponse(
    details: chrome.webRequest.OnHeadersReceivedDetails,
    meta: NetworkResponseMeta,
  ): boolean {
    if (!isCapturableUrl(details.url)) {
      return false;
    }

    const statusCode = Number(details.statusCode ?? 0);
    if (statusCode < 200 || statusCode >= 400) {
      return false;
    }

    const contentDisposition = responseHeaderValue(details.responseHeaders, "content-disposition").toLowerCase();
    const isAttachment = contentDisposition.includes("attachment");
    const extension = fileExtension(meta.filename || filenameFromUrl(details.url));
    const mime = (mimeFromUrl(details.url) || meta.mime || "").toLowerCase();

    if (isAttachment || meta.filename) {
      return true;
    }

    if (!extension && !mime) {
      return false;
    }

    if (
      mime.startsWith("text/html")
      || mime.startsWith("text/css")
      || mime.startsWith("text/javascript")
      || mime.includes("javascript")
      || mime === "application/json"
      || mime === "application/xml"
      || mime === "text/xml"
    ) {
      return false;
    }

    return (
      isCatCatchMedia(extension, mime)
      || Boolean(extension && meta.size > 0)
      || mime === "application/octet-stream"
      || mime === "application/x-msdownload"
      || mime === "application/x-zip-compressed"
      || mime === "application/zip"
    );
  }

  function prepareFirefoxWebRequestHandoff(
    details: chrome.webRequest.OnHeadersReceivedDetails,
  ): PreparedDownloadHandoff | null {
    const meta = responseMeta(details.responseHeaders);
    meta.mime = mimeFromUrl(details.url) || meta.mime;

    if (!isLikelyFirefoxDownloadResponse(details, meta)) {
      return null;
    }

    const finalUrl = details.url;
    const headerSnapshot = resolveHeaderSnapshot(finalUrl);
    const matchedResource = findResourceByUrl(finalUrl);
    const headers = { ...(headerSnapshot?.headers ?? {}) };
    const referer =
      headers.referer
      || (details.originUrl && details.originUrl !== "null" ? details.originUrl : "")
      || (details.initiator && details.initiator !== "null" ? details.initiator : "")
      || matchedResource?.referer
      || "";

    if (referer) {
      headers.referer = referer;
    }

    const filename =
      meta.filename
      || trimFilename(matchedResource?.filename ?? "")
      || trimFilename(filenameFromUrl(finalUrl))
      || "resource";
    const mime = meta.mime || matchedResource?.mime || "";
    const size = meta.size > 0 ? meta.size : matchedResource?.size && matchedResource.size > 0 ? matchedResource.size : 0;

    return {
      finalUrl,
      filename,
      mime,
      headers,
      size,
      supportsRange: Boolean(meta.supportsRange || headerSnapshot?.supportsRange || matchedResource?.supportsRange),
      matchedResource,
      source: "firefox_web_request",
    };
  }

  async function tryInterceptFirefoxDownload(
    details: chrome.webRequest.OnHeadersReceivedDetails,
  ): Promise<chrome.webRequest.BlockingResponse | undefined> {
    const prepared = prepareFirefoxWebRequestHandoff(details);
    if (!prepared || shouldBlockPreparedDownload(prepared)) {
      return undefined;
    }

    void handoffPreparedDownload(prepared);
    return { cancel: true };
  }

  function findBestResourceForDownload(rawUrl: string): CapturedResource | null {
    const normalizedUrl = normalizeUrl(rawUrl, true);
    if (!normalizedUrl) {
      return null;
    }

    let bestResource: CapturedResource | null = null;
    let bestScore = -1;

    for (const resource of resourcesById.values()) {
      const resourceUrl = normalizeUrl(resource.url, true);
      if (!resourceUrl) {
        continue;
      }

      let score = -1;
      if (resourceUrl === normalizedUrl) {
        score = 100;
      } else if (resourceUrl.includes(normalizedUrl) || normalizedUrl.includes(resourceUrl)) {
        score = 60;
      } else {
        continue;
      }

      if (resource.size > 0) {
        score += 10;
      }
      if (resource.mime) {
        score += 5;
      }
      if (resource.filename && resource.filename !== "resource") {
        score += 5;
      }

      if (!bestResource || score > bestScore || (score === bestScore && resource.capturedAt > bestResource.capturedAt)) {
        bestResource = resource;
        bestScore = score;
      }
    }

    return bestResource;
  }

  function resolveHeaderSnapshotLoosely(rawUrl: string): BridgeHeaderSnapshot | null {
    pruneHeaderSnapshots();
    const normalizedUrl = normalizeUrl(rawUrl, true);
    if (!normalizedUrl) {
      return null;
    }

    const exact = headerSnapshotsByUrl.get(normalizedUrl) ?? headerSnapshotsByUrl.get(rawUrl);
    if (exact) {
      return exact;
    }

    let matched: BridgeHeaderSnapshot | null = null;
    for (const snapshot of headerSnapshotsByUrl.values()) {
      const snapshotUrl = normalizeUrl(snapshot.url, true);
      if (!snapshotUrl) {
        continue;
      }
      if (snapshotUrl === normalizedUrl || snapshotUrl.includes(normalizedUrl) || normalizedUrl.includes(snapshotUrl)) {
        if (!matched || snapshot.capturedAt > matched.capturedAt) {
          matched = snapshot;
        }
      }
    }

    return matched;
  }

  function mergeReplayHeaders(...sources: Array<Record<string, string> | undefined>): Record<string, string> {
    const merged: Record<string, string> = {};
    for (const source of sources) {
      Object.assign(merged, normalizeHeaders(source));
    }
    return merged;
  }

  function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => self.setTimeout(resolve, ms));
  }

  async function waitForReplayContext(rawUrl: string, timeoutMs = 1200): Promise<{
    matchedResource: CapturedResource | null;
    headerSnapshot: BridgeHeaderSnapshot | null;
  }> {
    const deadline = Date.now() + timeoutMs;
    let matchedResource = findBestResourceForDownload(rawUrl);
    let headerSnapshot = resolveHeaderSnapshotLoosely(rawUrl);

    while (!matchedResource && !headerSnapshot && Date.now() < deadline) {
      await sleep(100);
      matchedResource = findBestResourceForDownload(rawUrl);
      headerSnapshot = resolveHeaderSnapshotLoosely(rawUrl);
    }

    return { matchedResource, headerSnapshot };
  }

  function shouldHandoffBrowserDownload(downloadItem: chrome.downloads.DownloadItem, interceptDownloads: boolean): boolean {
    const finalUrl = String(downloadItem.finalUrl || downloadItem.url || "");
    if (!interceptDownloads) {
      return false;
    }
    if (!isCapturableUrl(finalUrl)) {
      return false;
    }
    return true;
  }

  async function prepareBrowserDownloadHandoff(
    downloadItem: chrome.downloads.DownloadItem,
  ): Promise<PreparedDownloadHandoff | null> {
    const finalUrl = String(downloadItem.finalUrl || downloadItem.url || "");
    if (!isCapturableUrl(finalUrl)) {
      return null;
    }

    const { matchedResource, headerSnapshot } = await waitForReplayContext(finalUrl, 1200);
    if (!matchedResource && !headerSnapshot) {
      return null;
    }

    const fileSize = Number((downloadItem as chrome.downloads.DownloadItem & { fileSize?: number }).fileSize ?? 0);
    const filename =
      trimFilename(matchedResource?.filename ?? "")
      || trimFilename(downloadItem.filename)
      || trimFilename(filenameFromUrl(finalUrl))
      || "resource";
    const mime = String(matchedResource?.mime ?? "").toLowerCase();
    const headers = mergeReplayHeaders(
      matchedResource?.requestHeaders,
      headerSnapshot?.headers,
      downloadItem.referrer ? { referer: downloadItem.referrer } : undefined,
      matchedResource?.referer ? { referer: matchedResource.referer } : undefined,
    );
    const size =
      matchedResource?.size && matchedResource.size > 0
        ? matchedResource.size
        : typeof downloadItem.totalBytes === "number" && downloadItem.totalBytes > 0
          ? downloadItem.totalBytes
          : Number.isFinite(fileSize) && fileSize > 0
            ? fileSize
            : 0;
    const supportsRange = Boolean(
      matchedResource?.supportsRange
      || headerSnapshot?.supportsRange
      || downloadItem.canResume === true,
    );

    return {
      finalUrl,
      filename,
      mime,
      headers,
      size,
      supportsRange,
      matchedResource,
      source: "download",
    };
  }

  async function handoffPreparedDownload(
    prepared: PreparedDownloadHandoff,
  ): Promise<DesktopRequestResult> {
    if (shouldBlockPreparedDownload(prepared)) {
      return {
        ok: false,
        message: "下载已被黑名单规则忽略",
      };
    }

    try {
      const result = await options.sendDesktopRequest<DesktopRequestResult>({
        type: "create_task",
        source: "download",
        title: prepared.filename,
        payload: {
          url: prepared.finalUrl,
          headers: prepared.headers,
          filename: prepared.filename,
          size: prepared.size,
          supportsRange: prepared.supportsRange,
        },
      });

      if (result.ok) {
        if (prepared.matchedResource) {
          markResourceSent(prepared.matchedResource.id);
        }

        const message = result.message || `已拦截下载并加入任务：${prepared.filename}`;
        await options.onTaskCreated?.(message);
        await openActionPopup();

        return {
          ...result,
          message,
        };
      }

      return result;
    } catch (error) {
      return {
        ok: false,
        message: error instanceof Error ? error.message : "下载接管失败",
      };
    }
  }

  async function handoffBrowserDownload(downloadItem: chrome.downloads.DownloadItem) {
    const prepared = await prepareBrowserDownloadHandoff(downloadItem);
    if (!prepared) {
      return;
    }
    await handoffPreparedDownload(prepared);
  }

  async function sendHttpResourceToDesktop(resource: CapturedResource): Promise<DesktopRequestResult> {
    const filename = filenameForDesktop(resource);
    try {
      const result = await options.sendDesktopRequest<DesktopRequestResult>({
        type: "create_task",
        source: "resource",
        title: filename,
        payload: {
          url: resource.url,
          headers: resource.requestHeaders,
          filename,
          size: resource.size,
          supportsRange: resource.supportsRange,
        },
      });

      if (result.ok) {
        markResourceSent(resource.id);
        return {
          ...result,
          message: result.message || "资源已发送到 Ghost Downloader",
        };
      }
      return result;
    } catch (error) {
      return {
        ok: false,
        message: error instanceof Error ? error.message : "发送资源失败",
      };
    }
  }

  async function sendResource(resourceId: string): Promise<DesktopRequestResult> {
    const resource = resourcesById.get(resourceId) ?? null;
    if (!resource) {
      return { ok: false, message: "资源不存在" };
    }

    try {
      if (resource.url.startsWith("blob:")) {
        await downloadResourceViaBrowser(resource);
        markResourceSent(resource.id);
        return {
          ok: true,
          message: "资源已交给浏览器下载",
        };
      }

      return await sendHttpResourceToDesktop(resource);
    } catch (error) {
      return {
        ok: false,
        message: error instanceof Error ? error.message : "发送资源失败",
      };
    }
  }

  async function downloadPageMedia(sender: chrome.runtime.MessageSender, payload: BridgeResourcePayload): Promise<DesktopRequestResult> {
    const tabId = await resolveBridgeResourceTabId(sender, payload.href);
    if (!tabId) {
      return { ok: false, message: "当前没有可操作的标签页" };
    }

    const downloadableResources = sortResources(resourceCache.get(tabId)?.values() ?? [])
      .filter((resource) => /^https?:/i.test(resource.url) && canSendOneClickResource(resource));
    const candidates = downloadableResources.filter(canUseOnlineMerge);
    const siteSelection = pickSiteMediaResources(downloadableResources, payload);
    if (siteSelection?.resources.length === 1) {
      return sendResource(siteSelection.resources[0].id);
    }
    if (siteSelection?.resources.length === 2) {
      return mergeResources(siteSelection.resources.map((resource) => resource.id));
    }
    if (siteSelection?.exclusive) {
      await openActionPopup();
      return {
        ok: false,
        message: siteSelection.message || "请在资源嗅探页选择当前媒体资源",
      };
    }

    const exactResource = payload.url ? findResourceByUrl(payload.url, tabId) : null;
    if (exactResource && canSendOneClickResource(exactResource)) {
      return sendResource(exactResource.id);
    }

    const streamResource = candidates.find((resource) => {
      const hint = describeResource(resource).parserHint;
      return hint === "m3u8" || hint === "mpd";
    });
    if (streamResource) {
      return sendResource(streamResource.id);
    }

    const pair = recentAudioVideoPair(candidates);
    if (pair.length === 2) {
      return mergeResources(pair.map((resource) => resource.id));
    }

    if (candidates.length === 1) {
      return sendResource(candidates[0].id);
    }

    await openActionPopup();
    return {
      ok: false,
      message: candidates.length > 1 ? "找到多个媒体资源，请在资源嗅探页选择" : "尚未捕获到可下载媒体资源",
    };
  }

  async function mergeResources(resourceIds: string[]): Promise<DesktopRequestResult> {
    const ids = [...new Set(resourceIds.filter(Boolean))];
    const resources = ids
      .map((resourceId) => resourcesById.get(resourceId) ?? null)
      .filter((resource): resource is CapturedResource => resource != null);

    if (resources.length !== 2) {
      return {
        ok: false,
        message: "在线合并暂时只支持选中 2 个资源",
      };
    }

    if (!canUseOnlineMergeSelection(resources)) {
      return {
        ok: false,
        message: "当前选中的资源不符合在线合并条件",
      };
    }

    const orderedResources = sortResourcesForOnlineMerge(resources);

    try {
      const result = await options.sendDesktopRequest<DesktopRequestResult>({
        type: "create_task",
        source: "resource_merge",
        title: deriveMergeOutputTitle(orderedResources),
        payload: {
          resources: orderedResources.map((resource) => ({
            url: resource.url,
            filename: filenameForDesktop(resource),
            mime: resource.mime,
            size: resource.size,
            headers: resource.requestHeaders,
            pageTitle: resource.pageTitle,
            supportsRange: resource.supportsRange,
          })),
        },
      });

      if (result.ok) {
        orderedResources.forEach((resource) => markResourceSent(resource.id));
        return {
          ...result,
          message: result.message || "在线合并任务已发送到 Ghost Downloader",
        };
      }
      return result;
    } catch (error) {
      return {
        ok: false,
        message: error instanceof Error ? error.message : "在线合并失败",
      };
    }
  }

  function buildPopupStateData(resolvedTabId: number | null, activeTab: chrome.tabs.Tab | null): Pick<
    PopupStatePayload,
    "resourceState" | "resourceStateMessage" | "currentResources" | "otherResources" | "activePageDomain"
  > {
    const canCaptureCurrentTab = Boolean(activeTab?.url && isCapturableUrl(activeTab.url));
    let resourceState: PopupStatePayload["resourceState"] = "ready";
    let resourceStateMessage = "等待 cat-catch 捕获资源";
    if (!bridgeStateReady) {
      resourceState = "restoring";
      resourceStateMessage = "正在恢复 cat-catch 已捕获的资源";
    } else if (!canCaptureCurrentTab) {
      resourceState = "unavailable";
      resourceStateMessage = "当前标签页不支持 cat-catch 资源桥接";
    }

    return {
      resourceState,
      resourceStateMessage,
      currentResources: resolvedTabId == null ? [] : sortResources(resourceCache.get(resolvedTabId)?.values() ?? []),
      otherResources: otherResourcesForTab(resolvedTabId),
      activePageDomain: domainFromUrl(activeTab?.url ?? ""),
    };
  }

  function handleTabRemoved(tabId: number) {
    clearResourcesForTab(tabId);
    clearHeaderSnapshotsForTab(tabId);
    if (lastActiveTabId === tabId) {
      void setLastActiveTab(null);
    }
  }

  function handleNavigationCommitted(details: chrome.webNavigation.WebNavigationTransitionCallbackDetails) {
    if (details.tabId <= 0 || details.frameId !== 0) {
      return;
    }
    clearResourcesForTab(details.tabId);
    clearHeaderSnapshotsForTab(details.tabId);
  }

  function handleRequestHeaders(details: chrome.webRequest.OnSendHeadersDetails) {
    const headers = normalizeHeaders(Object.fromEntries((details.requestHeaders ?? []).map((header) => [header.name ?? "", header.value ?? ""])));
    const supportsRange = (details.requestHeaders ?? []).some((header) => header.name?.toLowerCase() === "range" && String(header.value ?? "").toLowerCase().startsWith("bytes="));
    rememberHeaderSnapshot(details.url, headers, details.tabId > 0 ? details.tabId : lastActiveTabId, supportsRange);
  }

  return {
    buildPopupStateData,
    captureNetworkResource,
    capturePageResource,
    captureRequestResource,
    downloadPageMedia,
    handoffBrowserDownload,
    handoffPreparedDownload,
    prepareBrowserDownloadHandoff,
    shouldHandoffBrowserDownload,
    handleNavigationCommitted,
    handleRequestHeaders,
    handleTabRemoved,
    loadPersistentState,
    refreshActiveTabFromBrowser,
    resolveActiveTabId,
    mergeResources,
    sendResource,
    setLastActiveTab,
    tryInterceptFirefoxDownload,
  };
}
