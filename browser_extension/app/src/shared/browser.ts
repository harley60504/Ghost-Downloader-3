export type ExtensionBrowserTarget = "chromium" | "firefox";

let cachedIsAndroid: boolean | null = null;

const REQUEST_HEADERS = "requestHeaders" as chrome.webRequest.OnSendHeadersOptions;
const EXTRA_HEADERS = "extraHeaders" as chrome.webRequest.OnSendHeadersOptions;

let cachedBrowserTarget: ExtensionBrowserTarget | null = null;

export function getExtensionBrowserTarget(): ExtensionBrowserTarget {
  if (cachedBrowserTarget) {
    return cachedBrowserTarget;
  }

  try {
    const runtimeUrl = chrome.runtime.getURL("/");
    if (runtimeUrl.startsWith("moz-extension://")) {
      cachedBrowserTarget = "firefox";
      return cachedBrowserTarget;
    }
  } catch {
    // Fall through to the Chromium default when the runtime is not available.
  }

  cachedBrowserTarget = "chromium";
  return cachedBrowserTarget;
}

export function isFirefoxExtension(): boolean {
  return getExtensionBrowserTarget() === "firefox";
}

export function getInstallDirectory(): string {
  return isFirefoxExtension() ? "browser_extension/firefox" : "browser_extension/chromium";
}


export function isAndroidRuntime(): boolean {
  if (cachedIsAndroid !== null) {
    return cachedIsAndroid;
  }

  try {
    const ua = navigator.userAgent || "";
    cachedIsAndroid = /android/i.test(ua);
    return cachedIsAndroid;
  } catch {
    cachedIsAndroid = false;
    return cachedIsAndroid;
  }
}

export function isAndroidFirefoxLike(): boolean {
  return isFirefoxExtension() && isAndroidRuntime();
}

export function getOnSendHeadersExtraInfoSpec(): chrome.webRequest.OnSendHeadersOptions[] {
  return isFirefoxExtension()
    ? [REQUEST_HEADERS]
    : [REQUEST_HEADERS, EXTRA_HEADERS];
}

export function supportsDownloadDeterminingFilename(): boolean {
  return Boolean(chrome.downloads?.onDeterminingFilename?.addListener);
}
