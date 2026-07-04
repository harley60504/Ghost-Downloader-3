import {
    Body1Strong,
    Button,
    Card,
    Field,
    Input,
    makeStyles,
    MessageBar,
    MessageBarBody,
    Select,
    SpinButton,
    Switch,
    Textarea,
} from "@fluentui/react-components";
import type {SpinButtonOnChangeData, SwitchOnChangeData} from "@fluentui/react-components";
import {ArrowClockwiseRegular, ClipboardPasteRegular, PlugConnectedRegular,} from "@fluentui/react-icons";
import {useCallback, useEffect, useState} from "react";

import {DEFAULT_SERVER_URL, EXTENSION_VERSION} from "../../shared/constants";
import {
    BYPASS_MODIFIER_KEY,
    MIN_TAKE_SIZE_KB_KEY,
    SHOULD_TAKE_UNKNOWN_SIZE_KEY,
} from "../../background/constants";
import type {ThemePreference} from "../../shared/types";

const useStyles = makeStyles({
  root: {
    display: "flex",
    flexDirection: "column",
    gap: "16px",
    padding: "16px",
  },
  card: {
    gap: "16px",
    padding: "16px",
  },
  header: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    gap: "12px",
  },
  inputRow: {
    display: "flex",
    alignItems: "center",
    gap: "8px",
  },
  input: {
    flex: 1,
  },
});

export function SettingsPage({
  desktopVersion,
  token,
  serverUrl,
  savingToken,
  savingServerUrl,
  refreshingConnection,
  requestingPairing,
  onSaveToken,
  onSaveServerUrl,
  onRefreshConnection,
  onRequestPairing,
  themePreference,
  onThemePreferenceChange,
  domainBlacklist,
  typeBlacklist,
  sizeBlacklistMB,
  notifyOnTaskCreated,
  updatingNotifyOnTaskCreated,
  onSaveDomainBlacklist,
  onSaveTypeBlacklist,
  onSaveSizeBlacklist,
  onNotifyOnTaskCreatedChange,
}: {
  desktopVersion: string;
  token: string;
  serverUrl: string;
  savingToken?: boolean;
  savingServerUrl?: boolean;
  refreshingConnection?: boolean;
  requestingPairing?: boolean;
  onSaveToken: (value: string) => Promise<boolean>;
  onSaveServerUrl: (value: string) => Promise<boolean>;
  onRefreshConnection: () => Promise<boolean>;
  onRequestPairing: () => Promise<boolean>;
  themePreference: ThemePreference;
  onThemePreferenceChange: (nextPreference: ThemePreference) => void;
  domainBlacklist: string;
  typeBlacklist: string;
  sizeBlacklistMB: string;
  notifyOnTaskCreated: boolean;
  updatingNotifyOnTaskCreated?: boolean;
  onSaveDomainBlacklist: (value: string) => Promise<boolean>;
  onSaveTypeBlacklist: (value: string) => Promise<boolean>;
  onSaveSizeBlacklist: (value: string) => Promise<boolean>;
  onNotifyOnTaskCreatedChange: (next: boolean) => void;
}) {
  const styles = useStyles();
  const [tokenDraft, setTokenDraft] = useState(token);
  const [serverUrlDraft, setServerUrlDraft] = useState(serverUrl || DEFAULT_SERVER_URL);
  const [tokenDirty, setTokenDirty] = useState(false);
  const [serverDirty, setServerDirty] = useState(false);
  const [minSizeKB, setMinSizeKB] = useState(0);
  const [takeUnknownSize, setInterceptUnknown] = useState(true);
  const [bypassModifier, setBypassModifier] = useState("alt");
  const [installType, setInstallType] = useState("");
  const [domainBlacklistDraft, setDomainBlacklistDraft] = useState(domainBlacklist);
  const [typeBlacklistDraft, setTypeBlacklistDraft] = useState(typeBlacklist);
  const [sizeBlacklistDraft, setSizeBlacklistDraft] = useState(sizeBlacklistMB);

  const installLabel = useCallback(() => {
    switch (installType) {
      case "development": return chrome.i18n.getMessage("installTypeDevelopment");
      case "admin": case "normal": return chrome.i18n.getMessage("installTypeStore");
      case "sideload": return chrome.i18n.getMessage("installTypeSideload");
      default: return installType || chrome.i18n.getMessage("installTypeUnknown");
    }
  }, [installType]);

  useEffect(() => {
    chrome.management.getSelf((info) => setInstallType(info.installType));
  }, []);

  useEffect(() => {
    chrome.storage.local.get({
      [MIN_TAKE_SIZE_KB_KEY]: 0,
      [SHOULD_TAKE_UNKNOWN_SIZE_KEY]: true,
      [BYPASS_MODIFIER_KEY]: "alt",
    }, (result) => {
      setMinSizeKB(Number(result[MIN_TAKE_SIZE_KB_KEY]) || 0);
      setInterceptUnknown(Boolean(result[SHOULD_TAKE_UNKNOWN_SIZE_KEY] ?? true));
      setBypassModifier(String(result[BYPASS_MODIFIER_KEY] || "alt"));
    });
  }, []);

  useEffect(() => {
    if (!tokenDirty) {
      setTokenDraft(token);
    }
  }, [token, tokenDirty]);

  useEffect(() => {
    if (!serverDirty) {
      setServerUrlDraft(serverUrl || DEFAULT_SERVER_URL);
    }
  }, [serverDirty, serverUrl]);

  useEffect(() => setDomainBlacklistDraft(domainBlacklist), [domainBlacklist]);
  useEffect(() => setTypeBlacklistDraft(typeBlacklist), [typeBlacklist]);
  useEffect(() => setSizeBlacklistDraft(sizeBlacklistMB), [sizeBlacklistMB]);

  async function commitServerUrl() {
    const nextServerUrl = serverUrlDraft.trim() || DEFAULT_SERVER_URL;
    if (savingServerUrl || nextServerUrl === (serverUrl || DEFAULT_SERVER_URL)) {
      setServerDirty(false);
      return;
    }
    const ok = await onSaveServerUrl(nextServerUrl);
    if (ok) {
      setServerDirty(false);
    }
  }

  async function commitToken() {
    const nextToken = tokenDraft.trim();
    if (savingToken || nextToken === token) {
      setTokenDirty(false);
      return;
    }
    const ok = await onSaveToken(nextToken);
    if (ok) {
      setTokenDirty(false);
    }
  }

  async function pasteToken() {
    try {
      const text = await navigator.clipboard.readText();
      if (text) {
        const nextToken = text.trim();
        setTokenDraft(nextToken);
        setTokenDirty(true);
        const ok = await onSaveToken(nextToken);
        if (ok) {
          setTokenDirty(false);
        }
      }
    } catch {
      // Ignore clipboard permission failures.
    }
  }

  return (
    <div className={styles.root}>
      <Card appearance="filled-alternative" className={styles.card}>
        <div className={styles.header}>
          <Body1Strong>{chrome.i18n.getMessage("connectionConfig")}</Body1Strong>
          <Button
            appearance="primary"
            disabled={requestingPairing || savingToken || savingServerUrl}
            icon={<PlugConnectedRegular />}
            onClick={() => void onRequestPairing()}
          >
            {chrome.i18n.getMessage("autoPair")}
          </Button>
        </div>

        <Field label={chrome.i18n.getMessage("localServerAddress")}>
          <div className={styles.inputRow}>
            <Input
              className={styles.input}
              disabled={savingServerUrl}
              value={serverUrlDraft}
              onBlur={() => void commitServerUrl()}
              onChange={(_event, data) => {
                setServerUrlDraft(data.value);
                setServerDirty(true);
              }}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  void commitServerUrl();
                }
              }}
            />
            <Button
              disabled={refreshingConnection || savingServerUrl}
              icon={<ArrowClockwiseRegular />}
              aria-label={chrome.i18n.getMessage("reconnect")}
              onClick={() => void onRefreshConnection()}
            />
          </div>
        </Field>

        <Field label={chrome.i18n.getMessage("pairingToken")}>
          <div className={styles.inputRow}>
            <Input
              className={styles.input}
              disabled={savingToken}
              type="password"
              placeholder={chrome.i18n.getMessage("pairingTokenPlaceholder")}
              value={tokenDraft}
              onBlur={() => void commitToken()}
              onChange={(_event, data) => {
                setTokenDraft(data.value);
                setTokenDirty(true);
              }}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  void commitToken();
                }
              }}
            />
            <Button disabled={savingToken} icon={<ClipboardPasteRegular />} aria-label={chrome.i18n.getMessage("pasteToken")} onClick={() => void pasteToken()} />
          </div>
        </Field>
      </Card>

      <Card appearance="filled-alternative" className={styles.card}>
        <Body1Strong>下載黑名單</Body1Strong>

        <Field label="網域黑名單" hint="每行一個網域；只略過自動下載接管，不影響資源嗅探。">
          <Textarea
            resize="vertical"
            placeholder={"每行一個，例如：\ndrive.google.com\nexample.com"}
            value={domainBlacklistDraft}
            onBlur={() => void onSaveDomainBlacklist(domainBlacklistDraft)}
            onChange={(_event, data) => setDomainBlacklistDraft(data.value)}
          />
        </Field>

        <Field label="類型黑名單" hint="可輸入副檔名或 MIME 關鍵字。">
          <Textarea
            resize="vertical"
            placeholder={"每行一個，例如：\n.jpg\n.png\nimage/"}
            value={typeBlacklistDraft}
            onBlur={() => void onSaveTypeBlacklist(typeBlacklistDraft)}
            onChange={(_event, data) => setTypeBlacklistDraft(data.value)}
          />
        </Field>

        <Field label="略過小於此大小的下載" hint="預設單位 MB，也支援 KB、MiB、GB；留空表示停用。">
          <Input
            value={sizeBlacklistDraft}
            placeholder="例如：5 或 500 KB"
            onBlur={() => void onSaveSizeBlacklist(sizeBlacklistDraft)}
            onChange={(_event, data) => setSizeBlacklistDraft(data.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") { void onSaveSizeBlacklist(sizeBlacklistDraft); }
            }}
          />
        </Field>

        <Field label="加入任務時顯示通知">
          <Switch
            checked={notifyOnTaskCreated}
            disabled={updatingNotifyOnTaskCreated}
            onChange={(_event, data: SwitchOnChangeData) => onNotifyOnTaskCreatedChange(Boolean(data.checked))}
          />
        </Field>
      </Card>

      <Card appearance="filled-alternative" className={styles.card}>
        <Body1Strong>{chrome.i18n.getMessage("general")}</Body1Strong>

        <Field label={chrome.i18n.getMessage("minInterceptSize")} hint={chrome.i18n.getMessage("minInterceptSizeHint")}>
          <SpinButton
            min={0}
            max={1048576}
            step={100}
            value={minSizeKB}
            displayValue={`${minSizeKB} KB`}
            onChange={(_event, data: SpinButtonOnChangeData) => {
              const value = data.value ?? 0;
              setMinSizeKB(value);
              void chrome.storage.local.set({ [MIN_TAKE_SIZE_KB_KEY]: value });
            }}
          />
        </Field>

        <Field label={chrome.i18n.getMessage("interceptUnknownSize")}>
          <Switch
            checked={takeUnknownSize}
            onChange={(_event, data: SwitchOnChangeData) => {
              setInterceptUnknown(data.checked);
              void chrome.storage.local.set({ [SHOULD_TAKE_UNKNOWN_SIZE_KEY]: data.checked });
            }}
          />
        </Field>

        <Field label={chrome.i18n.getMessage("bypassShortcutKey")} hint={chrome.i18n.getMessage("bypassShortcutKeyHint")}>
          <Select
            value={bypassModifier}
            onChange={(_event, data) => {
              const value = data.value;
              setBypassModifier(value);
              void chrome.storage.local.set({ [BYPASS_MODIFIER_KEY]: value });
            }}
          >
            <option value="alt">Alt / Option</option>
            <option value="ctrl">Ctrl</option>
            <option value="shift">Shift</option>
          </Select>
        </Field>

        <Field label={chrome.i18n.getMessage("theme")}>
          <Select
            value={themePreference}
            onChange={(_event) => onThemePreferenceChange(_event.currentTarget.value as ThemePreference)}
          >
            <option value="system">{chrome.i18n.getMessage("followSystem")}</option>
            <option value="light">{chrome.i18n.getMessage("lightTheme")}</option>
            <option value="dark">{chrome.i18n.getMessage("darkTheme")}</option>
          </Select>
        </Field>
      </Card>

      <Card appearance="filled-alternative" className={styles.card}>
        <Body1Strong>{chrome.i18n.getMessage("about")}</Body1Strong>
        <MessageBar intent="info">
          <MessageBarBody>{chrome.i18n.getMessage("extensionVersionInfo", [EXTENSION_VERSION])}</MessageBarBody>
        </MessageBar>
        <MessageBar intent="info">
          <MessageBarBody>{chrome.i18n.getMessage("installMethodInfo", [installLabel()])}</MessageBarBody>
        </MessageBar>
        <MessageBar intent={desktopVersion ? "success" : "warning"}>
          <MessageBarBody>{chrome.i18n.getMessage("desktopVersionInfo", [desktopVersion || chrome.i18n.getMessage("notConnected")])}</MessageBarBody>
        </MessageBar>
      </Card>
    </div>
  );
}
