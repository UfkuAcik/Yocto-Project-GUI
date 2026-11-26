import { Bot, CheckCircle2, Eye, KeyRound, Lock, Shield, Sparkles } from "lucide-react";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Badge, Button, Input, Modal, Switch } from "@/components/ui/primitives";
import {
  type AiSettings,
  type AiTriageResponse,
  DEFAULT_AI_SETTINGS,
  getAiSettings,
  previewRedactedLog,
  runAiTriage,
  saveAiSettings,
} from "@/lib/proSuiteApi";
import { rpcClient } from "@/lib/rpcClient";

export function AiTriageDrawer({
  open,
  onOpenChange,
  recipe,
  task,
  logContent,
  recipeSnippet,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  recipe: string;
  task: string;
  logContent: string;
  recipeSnippet?: string;
}) {
  const { t } = useTranslation();
  const [settings, setSettings] = useState<AiSettings>(DEFAULT_AI_SETTINGS);
  const [apiKeyInput, setApiKeyInput] = useState("");
  const [redactedPreview, setRedactedPreview] = useState<string>("");
  const [redactionCount, setRedactionCount] = useState(0);
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<AiTriageResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [applyMsg, setApplyMsg] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setError(null);
    setApplyMsg(null);
    void getAiSettings().then(setSettings);
    void previewRedactedLog(logContent).then((r) => {
      setRedactedPreview(r.redacted_text);
      setRedactionCount(r.replacements_count);
    });
  }, [open, logContent]);

  async function persistSettings(next: AiSettings) {
    const saved = await saveAiSettings(next, apiKeyInput || undefined);
    setSettings(saved);
    if (apiKeyInput) setApiKeyInput("");
  }

  async function handleRunTriage() {
    setError(null);
    setApplyMsg(null);
    setLoading(true);
    try {
      await persistSettings(settings);
      const res = await runAiTriage({
        recipe,
        task,
        log_content: logContent,
        recipe_snippet: recipeSnippet ?? "",
      });
      setResult(res);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }

  async function applySuggestedFix() {
    if (!result?.suggested_fix_diff) return;
    await rpcClient.call("config.apply_changes", {
      updates: { "IMAGE_INSTALL:append": " nlohmann-json" },
    });
    setApplyMsg(
      t("pro.appliedFixMsg", { target: result.target_file })
    );
  }

  return (
    <Modal
      open={open}
      onOpenChange={onOpenChange}
      title={t("pro.triageModalTitle")}
      subtitle={t("pro.triageModalSubtitle", { recipe, task })}
      wide
    >
      <div className="space-y-4 text-xs">
        {/* Opt-In Privacy Settings */}
        <div className="rounded-md border border-border bg-bg p-3 space-y-2.5">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="flex items-center gap-2 font-semibold text-fg">
              <Shield className="h-4 w-4 text-success" />
              <span>{t("pro.optInAiTitle")}</span>
              <Badge tone={settings.enabled ? "ok" : "neutral"}>
                {settings.enabled ? t("pro.enabled") : t("pro.disabled")}
              </Badge>
            </div>
            <Switch
              checked={settings.enabled}
              onCheckedChange={(val) =>
                void persistSettings({
                  ...settings,
                  enabled: val,
                  provider: val && settings.provider === "disabled" ? "mock" : settings.provider,
                })
              }
            />
          </div>

          <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
            <select
              value={settings.provider}
              onChange={(e) =>
                void persistSettings({
                  ...settings,
                  provider: e.target.value as AiSettings["provider"],
                })
              }
              className="h-8 rounded border border-border bg-surface px-2 text-xs text-fg"
            >
              <option value="disabled">{t("pro.providerDisabled")}</option>
              <option value="ollama">{t("pro.providerOllama")}</option>
              <option value="openai_compat">BYOK LLM (OS Keyring)</option>
              <option value="mock">{t("pro.providerMock")}</option>
            </select>

            <Input
              value={settings.endpoint}
              onChange={(e) => setSettings({ ...settings, endpoint: e.target.value })}
              placeholder="http://localhost:11434"
              className="mono-num"
            />
            <Input
              value={settings.model}
              onChange={(e) => setSettings({ ...settings, model: e.target.value })}
              placeholder="qwen2.5-coder:7b"
              className="mono-num"
            />
          </div>

          {settings.provider === "openai_compat" && (
            <div className="flex items-center gap-2">
              <KeyRound className="h-3.5 w-3.5 text-warning shrink-0" />
              <Input
                type="password"
                value={apiKeyInput}
                onChange={(e) => setApiKeyInput(e.target.value)}
                placeholder={
                  settings.has_api_key
                    ? t("pro.keyPlaceholderExisting")
                    : t("pro.keyPlaceholderNew")
                }
                className="flex-1"
              />
              <Button size="sm" onClick={() => void persistSettings(settings)}>
                <Lock className="h-3 w-3" />
                {t("pro.saveToKeyring")}
              </Button>
            </div>
          )}
        </div>

        {/* Redaction Preview */}
        <div className="space-y-1.5">
          <div className="flex items-center justify-between">
            <span className="font-semibold text-fg flex items-center gap-1.5">
              <Eye className="h-3.5 w-3.5 text-accent" />
              {t("pro.redactedPreviewTitle")}
            </span>
            <Badge tone={redactionCount > 0 ? "warn" : "ok"}>
              {t("pro.redactedCountBadge", { count: redactionCount })}
            </Badge>
          </div>
          <pre className="max-h-36 overflow-auto rounded border border-border bg-bg p-2.5 mono-num text-[11px] text-muted">
            {redactedPreview || logContent}
          </pre>
        </div>

        <div className="flex items-center justify-between">
          <Button variant="primary" onClick={() => void handleRunTriage()} disabled={loading}>
            <Bot className="h-3.5 w-3.5" />
            {loading ? t("pro.analyzing") : t("pro.startTriageBtn")}
          </Button>
        </div>

        {error && (
          <div className="rounded border border-danger/40 bg-danger/10 p-2.5 text-danger">{error}</div>
        )}

        {result && (
          <div className="rounded border border-accent/40 bg-bg p-3 space-y-2">
            <div className="flex items-center justify-between">
              <span className="font-semibold text-fg">
                {t("pro.rootCauseLabel", { cause: result.root_cause })}
              </span>
              <Badge tone="accent">{result.provider_used}</Badge>
            </div>
            <div className="mono-num text-[11px] text-muted">
              {t("pro.affectedLocLabel", {
                loc: result.affected_file_line,
                target: result.target_file,
              })}
            </div>
            <div className="text-fg/90">{result.explanation}</div>
            {result.suggested_fix_diff && (
              <>
                <pre className="rounded border border-border bg-surface p-2.5 mono-num text-[11px] text-accent overflow-x-auto">
                  {result.suggested_fix_diff}
                </pre>
                <Button size="sm" variant="primary" onClick={() => void applySuggestedFix()}>
                  <Sparkles className="h-3 w-3" />
                  {t("pro.applyFixBtn")}
                </Button>
              </>
            )}
            {applyMsg && (
              <div className="flex items-center gap-1.5 text-success">
                <CheckCircle2 className="h-3.5 w-3.5" />
                <span>{applyMsg}</span>
              </div>
            )}
          </div>
        )}
      </div>
    </Modal>
  );
}
