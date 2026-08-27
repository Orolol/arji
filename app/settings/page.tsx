"use client";

import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import {
  DEFAULT_PIPELINE_MAX_ATTEMPTS,
  DEFAULT_PIPELINE_MAX_FIX_CYCLES,
  PIPELINE_ENABLED_SETTING_KEY,
  PIPELINE_GRADER_ENABLED_SETTING_KEY,
  PIPELINE_MAX_ATTEMPTS_RANGE,
  PIPELINE_MAX_ATTEMPTS_SETTING_KEY,
  PIPELINE_MAX_FIX_CYCLES_RANGE,
  PIPELINE_MAX_FIX_CYCLES_SETTING_KEY,
  parsePipelineEnabledSetting,
  parsePipelineMaxAttempts,
  parsePipelineMaxFixCycles,
} from "@/lib/pipeline/constants";
import {
  DEFAULT_NIGHT_CIRCUIT_BREAKER,
  NIGHT_CIRCUIT_BREAKER_RANGE,
  NIGHT_CIRCUIT_BREAKER_SETTING_KEY,
  NIGHT_COST_CAP_SETTING_KEY,
  parseNightCircuitBreaker,
  parseNightCostCap,
} from "@/lib/night/constants";
import {
  BUG_REGRESSION_CHECK_SETTING_KEY,
  BUG_REGRESSION_COMMAND_SETTING_KEY,
  TEST_FILE_PATTERNS_SETTING_KEY,
  REGRESSION_COMMAND_FILE_PLACEHOLDER,
  DEFAULT_BUG_REGRESSION_COMMAND,
  DEFAULT_TEST_FILE_PATTERNS,
  parseBugRegressionCommand,
  parseTestFilePatterns,
  parseBugRegressionSetting,
} from "@/lib/verify/regression-constants";
import {
  DEFAULT_VERIFY_TIMEOUT_MS,
  VERIFY_COMMANDS_SETTING_KEY,
  VERIFY_TIMEOUT_MS_SETTING_KEY,
  parseVerifyCommands,
  parseVerifyTimeoutMs,
  resolveVerifyConfig,
} from "@/lib/verify/verify-constants";
import {
  OPENAI_API_KEY_SETTING_KEY,
  OPENAI_BASE_URL_SETTING_KEY,
  OPENAI_MODEL_SETTING_KEY,
  OPENAI_REASONING_EFFORT_SETTING_KEY,
  parseOpenAiReasoningEffort,
  type OpenAiReasoningEffort,
} from "@/lib/openai/constants";
import {
  PROJECTS_ROOT_SETTING_KEY,
  parseProjectsRootSetting,
} from "@/lib/projects/workspace-constants";
import {
  DREAMING_AFTER_NIGHT_RUN_SETTING_KEY,
  parseDreamingAfterNightRunSetting,
} from "@/lib/workflow/dreaming-constants";
import {
  PROMPT_TOKEN_BUDGET_GLOBAL_SETTING_KEY,
  parsePromptTokenBudget,
} from "@/lib/tokens";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

interface GitHubPatSetting {
  hasToken?: boolean;
}

interface ProjectWebhook {
  projectId: string;
  projectName: string;
  url: string;
}

export default function SettingsPage() {
  const [globalPrompt, setGlobalPrompt] = useState("");
  const [savingPrompt, setSavingPrompt] = useState(false);
  const [githubPat, setGitHubPat] = useState("");
  const [hasSavedGitHubPat, setHasSavedGitHubPat] = useState(false);
  const [savingGitHubPat, setSavingGitHubPat] = useState(false);
  const [validatingGitHubPat, setValidatingGitHubPat] = useState(false);
  const [globalMessage, setGlobalMessage] = useState<string | null>(null);
  const [gitHubMessage, setGitHubMessage] = useState<string | null>(null);
  const [gitHubError, setGitHubError] = useState<string | null>(null);
  const [openAiBaseUrl, setOpenAiBaseUrl] = useState("");
  const [openAiApiKey, setOpenAiApiKey] = useState("");
  const [openAiModel, setOpenAiModel] = useState("");
  const [openAiReasoningEffort, setOpenAiReasoningEffort] =
    useState<OpenAiReasoningEffort>("off");
  const [hasSavedOpenAiKey, setHasSavedOpenAiKey] = useState(false);
  const [savingOpenAi, setSavingOpenAi] = useState(false);
  const [clearingOpenAiKey, setClearingOpenAiKey] = useState(false);
  const [testingOpenAi, setTestingOpenAi] = useState(false);
  const [openAiMessage, setOpenAiMessage] = useState<string | null>(null);
  const [openAiError, setOpenAiError] = useState<string | null>(null);
  const [webhooks, setWebhooks] = useState<ProjectWebhook[]>([]);
  const [savingWebhookId, setSavingWebhookId] = useState<string | null>(null);
  const [webhookMessage, setWebhookMessage] = useState<string | null>(null);
  const [webhookError, setWebhookError] = useState<string | null>(null);
  const [memoryAutoDistill, setMemoryAutoDistill] = useState(false);
  const [savingAutoDistill, setSavingAutoDistill] = useState(false);
  const [autoDistillMessage, setAutoDistillMessage] = useState<string | null>(
    null
  );
  const [dreamAfterNightRun, setDreamAfterNightRun] = useState(false);
  const [savingDream, setSavingDream] = useState(false);
  const [dreamMessage, setDreamMessage] = useState<string | null>(null);
  const [specAutoRewrite, setSpecAutoRewrite] = useState(false);
  const [savingSpecRewrite, setSavingSpecRewrite] = useState(false);
  const [specRewriteMessage, setSpecRewriteMessage] = useState<string | null>(
    null
  );
  const [mcpToolsEnabled, setMcpToolsEnabled] = useState(true);
  const [savingMcpTools, setSavingMcpTools] = useState(false);
  const [mcpToolsMessage, setMcpToolsMessage] = useState<string | null>(null);
  const [pipelineEnabled, setPipelineEnabled] = useState(false);
  const [pipelineGraderEnabled, setPipelineGraderEnabled] = useState(false);
  const [pipelineMaxAttempts, setPipelineMaxAttempts] = useState(
    DEFAULT_PIPELINE_MAX_ATTEMPTS
  );
  const [pipelineMaxFixCycles, setPipelineMaxFixCycles] = useState(
    DEFAULT_PIPELINE_MAX_FIX_CYCLES
  );
  const [bugRegressionCheck, setBugRegressionCheck] = useState(false);
  const [bugRegressionCommand, setBugRegressionCommand] = useState(
    DEFAULT_BUG_REGRESSION_COMMAND
  );
  const [testFilePatterns, setTestFilePatterns] = useState(
    DEFAULT_TEST_FILE_PATTERNS.join(", ")
  );
  const [verifyCommandsJson, setVerifyCommandsJson] = useState("[]");
  const [verifyTimeoutMs, setVerifyTimeoutMs] = useState(
    String(DEFAULT_VERIFY_TIMEOUT_MS)
  );
  const [savingPipeline, setSavingPipeline] = useState(false);
  const [pipelineMessage, setPipelineMessage] = useState<string | null>(null);
  // Night-run defaults. Kept as raw strings: an empty cost cap means
  // "unlimited", which no number state can express.
  const [nightCircuitBreaker, setNightCircuitBreaker] = useState("");
  const [nightCostCap, setNightCostCap] = useState("");
  const [savingNight, setSavingNight] = useState(false);
  const [nightMessage, setNightMessage] = useState<string | null>(null);
  // Optional weekly Claude budget, in USD, for the Usage page gauge. Raw
  // string: empty means "no budget", which no number state can express.
  const [usageBudget, setUsageBudget] = useState("");
  const [savingUsageBudget, setSavingUsageBudget] = useState(false);
  const [usageBudgetMessage, setUsageBudgetMessage] = useState<string | null>(
    null
  );
  // Optional prompt token budget threshold for dispatch warnings.
  const [promptTokenBudget, setPromptTokenBudget] = useState("");
  const [savingPromptTokenBudget, setSavingPromptTokenBudget] = useState(false);
  const [promptTokenBudgetMessage, setPromptTokenBudgetMessage] = useState<
    string | null
  >(null);
  // Clone root. Empty means "use the default", which only the server can
  // compute (process.cwd()); it arrives as `defaults.projects_root`.
  const [projectsRoot, setProjectsRoot] = useState("");
  const [projectsRootDefault, setProjectsRootDefault] = useState("");
  const [savingProjectsRoot, setSavingProjectsRoot] = useState(false);
  const [projectsRootMessage, setProjectsRootMessage] = useState<string | null>(
    null
  );

  useEffect(() => {
    fetch("/api/settings/webhooks")
      .then((r) => r.json())
      .then((d) => {
        const list = d?.data?.webhooks;
        if (Array.isArray(list)) {
          setWebhooks(list as ProjectWebhook[]);
        }
      })
      .catch(() => {});
  }, []);

  useEffect(() => {
    fetch("/api/settings")
      .then((r) => r.json())
      .then((d) => {
        if (d.data?.global_prompt) {
          setGlobalPrompt(d.data.global_prompt);
        }
        const githubSetting = d.data?.github_pat as GitHubPatSetting | undefined;
        setHasSavedGitHubPat(Boolean(githubSetting?.hasToken));
        const openAiKeySetting = d.data?.[OPENAI_API_KEY_SETTING_KEY] as
          | GitHubPatSetting
          | undefined;
        setHasSavedOpenAiKey(Boolean(openAiKeySetting?.hasToken));
        const savedBaseUrl = d.data?.[OPENAI_BASE_URL_SETTING_KEY];
        if (typeof savedBaseUrl === "string") setOpenAiBaseUrl(savedBaseUrl);
        const savedModel = d.data?.[OPENAI_MODEL_SETTING_KEY];
        if (typeof savedModel === "string") setOpenAiModel(savedModel);
        setOpenAiReasoningEffort(
          parseOpenAiReasoningEffort(d.data?.[OPENAI_REASONING_EFFORT_SETTING_KEY]),
        );
        const autoDistill = d.data?.memory_auto_distill;
        setMemoryAutoDistill(autoDistill === true || autoDistill === "true");
        // Dreaming after a night run: OFF unless explicitly enabled globally
        // (a per-project override still wins at run time).
        setDreamAfterNightRun(
          parseDreamingAfterNightRunSetting(
            d.data?.[DREAMING_AFTER_NIGHT_RUN_SETTING_KEY]
          ) ?? false
        );
        const specRewrite = d.data?.spec_auto_rewrite;
        setSpecAutoRewrite(specRewrite === true || specRewrite === "true");
        // Default ON: only an explicitly-false value disables the MCP tools.
        const mcpTools = d.data?.mcp_tools_enabled;
        setMcpToolsEnabled(!(mcpTools === false || mcpTools === "false"));
        // Autonomous pipeline: OFF unless explicitly enabled globally.
        setPipelineEnabled(
          parsePipelineEnabledSetting(d.data?.[PIPELINE_ENABLED_SETTING_KEY]) ??
            false
        );
        // Acceptance grading is independently opt-in and tri-state. An
        // absent key preserves the existing verify → review pipeline.
        setPipelineGraderEnabled(
          parsePipelineEnabledSetting(
            d.data?.[PIPELINE_GRADER_ENABLED_SETTING_KEY]
          ) ?? false
        );
        setPipelineMaxAttempts(
          parsePipelineMaxAttempts(d.data?.[PIPELINE_MAX_ATTEMPTS_SETTING_KEY]) ??
            DEFAULT_PIPELINE_MAX_ATTEMPTS
        );
        setPipelineMaxFixCycles(
          parsePipelineMaxFixCycles(
            d.data?.[PIPELINE_MAX_FIX_CYCLES_SETTING_KEY]
          ) ?? DEFAULT_PIPELINE_MAX_FIX_CYCLES
        );
        const verifyConfig = resolveVerifyConfig(d.data);
        setVerifyCommandsJson(JSON.stringify(verifyConfig.commands, null, 2));
        setVerifyTimeoutMs(String(verifyConfig.timeoutMs));
        // Bug regression gate: tri-state, default OFF — absent key means
        // every existing ticket behaves as before.
        setBugRegressionCheck(
          parseBugRegressionSetting(
            d.data?.[BUG_REGRESSION_CHECK_SETTING_KEY]
          ) ?? false
        );
        // Command and patterns show the effective value: an absent or
        // unusable key renders the built-in default rather than an empty
        // box that would read as "nothing configured".
        setBugRegressionCommand(
          parseBugRegressionCommand(
            d.data?.[BUG_REGRESSION_COMMAND_SETTING_KEY]
          ) ?? DEFAULT_BUG_REGRESSION_COMMAND
        );
        setTestFilePatterns(
          (
            parseTestFilePatterns(d.data?.[TEST_FILE_PATTERNS_SETTING_KEY]) ??
            DEFAULT_TEST_FILE_PATTERNS
          ).join(", ")
        );
        // Night defaults: absent keys stay empty, meaning "engine default"
        // for the breaker and "unlimited" for the cost cap.
        const breaker = parseNightCircuitBreaker(
          d.data?.[NIGHT_CIRCUIT_BREAKER_SETTING_KEY]
        );
        setNightCircuitBreaker(breaker == null ? "" : String(breaker));
        const cap = parseNightCostCap(d.data?.[NIGHT_COST_CAP_SETTING_KEY]);
        setNightCostCap(cap == null ? "" : String(cap));
        // Usage budget: only a positive number is a budget. Anything else
        // (absent, null, 0, garbage) means "no budget", shown as empty.
        const budget = d.data?.["usage_budget_usd_7d_claude"];
        setUsageBudget(
          typeof budget === "number" && Number.isFinite(budget) && budget > 0
            ? String(budget)
            : ""
        );
        const ptb = parsePromptTokenBudget(
          d.data?.[PROMPT_TOKEN_BUDGET_GLOBAL_SETTING_KEY]
        );
        setPromptTokenBudget(ptb != null ? String(ptb) : "");
        // Clone root: absent key means "no override", shown as an empty input
        // with the server-resolved default as placeholder.
        setProjectsRoot(
          parseProjectsRootSetting(d.data?.[PROJECTS_ROOT_SETTING_KEY]) ?? ""
        );
        const rootDefault = d.defaults?.[PROJECTS_ROOT_SETTING_KEY];
        if (typeof rootDefault === "string") {
          setProjectsRootDefault(rootDefault);
        }
      })
      .catch(() => {});
  }, []);

  /** PATCHes one or more pipeline settings, reverting local state on failure. */
  async function savePipelineSettings(
    patch: Record<string, unknown>,
    revert: () => void,
    successMessage: string
  ) {
    setSavingPipeline(true);
    setPipelineMessage(null);
    try {
      const response = await fetch("/api/settings", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(patch),
      });
      if (!response.ok) {
        revert();
        setPipelineMessage("Failed to save the pipeline settings.");
        return;
      }
      setPipelineMessage(successMessage);
    } catch {
      revert();
      setPipelineMessage("Failed to save the pipeline settings.");
    } finally {
      setSavingPipeline(false);
    }
  }

  async function handleTogglePipeline(next: boolean) {
    setPipelineEnabled(next);
    await savePipelineSettings(
      { [PIPELINE_ENABLED_SETTING_KEY]: next },
      () => setPipelineEnabled(!next),
      next
        ? "Autonomous pipeline enabled by default for new single-ticket builds."
        : "Autonomous pipeline disabled by default."
    );
  }

  async function handleTogglePipelineGrader(next: boolean) {
    setPipelineGraderEnabled(next);
    await savePipelineSettings(
      { [PIPELINE_GRADER_ENABLED_SETTING_KEY]: next },
      () => setPipelineGraderEnabled(!next),
      next
        ? "Acceptance grading enabled between verify and review."
        : "Acceptance grading disabled for autonomous pipelines."
    );
  }

  async function handleChangeMaxAttempts(raw: string) {
    const next = parsePipelineMaxAttempts(raw);
    if (next === null) return;
    const previous = pipelineMaxAttempts;
    setPipelineMaxAttempts(next);
    await savePipelineSettings(
      { [PIPELINE_MAX_ATTEMPTS_SETTING_KEY]: next },
      () => setPipelineMaxAttempts(previous),
      `Each pipeline stage now retries up to ${next} time${next === 1 ? "" : "s"}.`
    );
  }

  async function handleChangeMaxFixCycles(raw: string) {
    const next = parsePipelineMaxFixCycles(raw);
    if (next === null) return;
    const previous = pipelineMaxFixCycles;
    setPipelineMaxFixCycles(next);
    await savePipelineSettings(
      { [PIPELINE_MAX_FIX_CYCLES_SETTING_KEY]: next },
      () => setPipelineMaxFixCycles(previous),
      next === 0
        ? "Fix cycles disabled: blocking findings end the run immediately."
        : `Pipelines now run up to ${next} review → fix cycle${next === 1 ? "" : "s"}.`
    );
  }

  async function handleSaveVerifySettings() {
    const commands = parseVerifyCommands(verifyCommandsJson);
    if (commands === null) {
      setPipelineMessage(
        "Verification commands must be a JSON array of objects with non-empty name and command fields."
      );
      return;
    }

    const timeoutMs = parseVerifyTimeoutMs(verifyTimeoutMs);
    if (timeoutMs === null) {
      setPipelineMessage(
        "Verification timeout must be a positive number of milliseconds."
      );
      return;
    }

    // Show the normalised value immediately, but keep what the user typed so
    // a failed PATCH can put it back: reformatted JSON left on screen next to
    // "Failed to save" would imply a value that was never persisted.
    const previousCommands = verifyCommandsJson;
    const previousTimeout = verifyTimeoutMs;
    setVerifyCommandsJson(JSON.stringify(commands, null, 2));
    setVerifyTimeoutMs(String(timeoutMs));
    await savePipelineSettings(
      {
        [VERIFY_COMMANDS_SETTING_KEY]: commands,
        [VERIFY_TIMEOUT_MS_SETTING_KEY]: timeoutMs,
      },
      () => {
        setVerifyCommandsJson(previousCommands);
        setVerifyTimeoutMs(previousTimeout);
      },
      commands.length === 0
        ? "Deterministic verification disabled."
        : `${commands.length} verification command${commands.length === 1 ? "" : "s"} saved.`
    );
  }

  async function handleToggleBugRegression(next: boolean) {
    setBugRegressionCheck(next);
    await savePipelineSettings(
      { [BUG_REGRESSION_CHECK_SETTING_KEY]: next },
      () => setBugRegressionCheck(!next),
      next
        ? "Mandatory red → green regression test enforced on bug tickets."
        : "Mandatory bug regression test disabled."
    );
  }

  /**
   * Saves the regression command template. A template without `{files}`
   * would run the whole suite on every check, so it is refused here rather
   * than silently falling back at gate time.
   */
  async function handleSaveBugRegressionCommand() {
    const parsed = parseBugRegressionCommand(bugRegressionCommand);
    if (!parsed) {
      setPipelineMessage(
        `The command must contain ${REGRESSION_COMMAND_FILE_PLACEHOLDER} — it is replaced with the detected test files.`
      );
      return;
    }
    await savePipelineSettings(
      { [BUG_REGRESSION_COMMAND_SETTING_KEY]: parsed },
      () => {},
      `Regression command set to \`${parsed}\`.`
    );
  }

  /** Saves the test-file globs used to pick test files out of the branch diff. */
  async function handleSaveTestFilePatterns() {
    const parsed = parseTestFilePatterns(testFilePatterns);
    if (!parsed) {
      setPipelineMessage("Enter at least one glob pattern.");
      return;
    }
    setTestFilePatterns(parsed.join(", "));
    await savePipelineSettings(
      { [TEST_FILE_PATTERNS_SETTING_KEY]: parsed },
      () => {},
      `Test files detected with ${parsed.join(", ")}.`
    );
  }

  /**
   * Saves the two night-run defaults. Empty inputs are stored as null: the
   * breaker falls back to the engine default, the cost cap to unlimited.
   */
  async function handleSaveNightDefaults() {
    setSavingNight(true);
    setNightMessage(null);

    const breaker =
      nightCircuitBreaker.trim() === ""
        ? null
        : parseNightCircuitBreaker(nightCircuitBreaker);
    const cap =
      nightCostCap.trim() === "" ? null : parseNightCostCap(nightCostCap);

    if (nightCircuitBreaker.trim() !== "" && breaker === null) {
      setNightMessage("Circuit breaker must be a whole number between 0 and 10.");
      setSavingNight(false);
      return;
    }
    if (nightCostCap.trim() !== "" && cap === null) {
      setNightMessage("Cost cap must be a positive dollar amount.");
      setSavingNight(false);
      return;
    }

    try {
      const response = await fetch("/api/settings", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          [NIGHT_CIRCUIT_BREAKER_SETTING_KEY]: breaker,
          [NIGHT_COST_CAP_SETTING_KEY]: cap,
        }),
      });
      if (!response.ok) {
        setNightMessage("Failed to save the night run defaults.");
        return;
      }
      // Reflect what was actually stored (clamped / normalized).
      setNightCircuitBreaker(breaker == null ? "" : String(breaker));
      setNightCostCap(cap == null ? "" : String(cap));
      setNightMessage("Night run defaults saved.");
    } catch {
      setNightMessage("Failed to save the night run defaults.");
    } finally {
      setSavingNight(false);
    }
  }

  /**
   * Saves the optional weekly Claude budget. An empty input clears it
   * (stored as null): no budget means the Usage page shows no budget gauge
   * rather than a zero one.
   */
  async function handleSaveUsageBudget() {
    setSavingUsageBudget(true);
    setUsageBudgetMessage(null);

    const raw = usageBudget.trim();
    let budget: number | null = null;
    if (raw !== "") {
      const parsed = Number(raw);
      if (!Number.isFinite(parsed) || parsed <= 0) {
        setUsageBudgetMessage("Budget must be a positive dollar amount.");
        setSavingUsageBudget(false);
        return;
      }
      budget = parsed;
    }

    try {
      const response = await fetch("/api/settings", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ usage_budget_usd_7d_claude: budget }),
      });
      if (!response.ok) {
        setUsageBudgetMessage("Failed to save the usage budget.");
        return;
      }
      setUsageBudget(budget === null ? "" : String(budget));
      setUsageBudgetMessage("Saved");
    } catch {
      setUsageBudgetMessage("Failed to save the usage budget.");
    } finally {
      setSavingUsageBudget(false);
    }
  }
  async function handleSavePromptTokenBudget() {
    setSavingPromptTokenBudget(true);
    setPromptTokenBudgetMessage(null);

    const raw = promptTokenBudget.trim();
    let budget: number | null = null;
    if (raw !== "") {
      const parsed = parsePromptTokenBudget(raw);
      if (parsed === null || parsed <= 0) {
        setPromptTokenBudgetMessage(
          "Budget must be a positive integer token count (e.g. 50000 or 50k)."
        );
        setSavingPromptTokenBudget(false);
        return;
      }
      budget = parsed;
    }

    try {
      const response = await fetch("/api/settings", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          [PROMPT_TOKEN_BUDGET_GLOBAL_SETTING_KEY]: budget,
        }),
      });
      if (!response.ok) {
        setPromptTokenBudgetMessage("Failed to save the prompt token budget.");
        return;
      }
      setPromptTokenBudget(budget === null ? "" : String(budget));
      setPromptTokenBudgetMessage("Saved");
    } catch {
      setPromptTokenBudgetMessage("Failed to save the prompt token budget.");
    } finally {
      setSavingPromptTokenBudget(false);
    }
  }


  async function handleSaveProjectsRoot() {
    setProjectsRootMessage(null);
    setSavingProjectsRoot(true);

    const trimmed = projectsRoot.trim();
    try {
      const response = await fetch("/api/settings", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ [PROJECTS_ROOT_SETTING_KEY]: trimmed }),
      });
      const payload = await response.json().catch(() => ({}));

      if (!response.ok) {
        setProjectsRootMessage(
          payload?.error ??
            "Failed to save the projects directory. Check the path and retry."
        );
        return;
      }

      setProjectsRoot(trimmed);
      setProjectsRootMessage(
        trimmed
          ? "Projects directory saved."
          : "Projects directory reset to the default."
      );
    } catch {
      setProjectsRootMessage(
        "Failed to save the projects directory. Check your connection and retry."
      );
    } finally {
      setSavingProjectsRoot(false);
    }
  }

  async function handleToggleMcpTools(next: boolean) {
    setMcpToolsEnabled(next);
    setSavingMcpTools(true);
    setMcpToolsMessage(null);
    try {
      const response = await fetch("/api/settings", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ mcp_tools_enabled: next }),
      });
      if (!response.ok) {
        setMcpToolsEnabled(!next);
        setMcpToolsMessage("Failed to save the MCP tools setting.");
        return;
      }
      setMcpToolsMessage(
        next
          ? "Arij MCP tools enabled: new agent sessions get the structured tool channel."
          : "Arij MCP tools disabled: new agent sessions spawn without the tool channel."
      );
    } catch {
      setMcpToolsEnabled(!next);
      setMcpToolsMessage("Failed to save the MCP tools setting.");
    } finally {
      setSavingMcpTools(false);
    }
  }

  async function handleToggleAutoDistill(next: boolean) {
    setMemoryAutoDistill(next);
    setSavingAutoDistill(true);
    setAutoDistillMessage(null);
    try {
      const response = await fetch("/api/settings", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ memory_auto_distill: next }),
      });
      if (!response.ok) {
        setMemoryAutoDistill(!next);
        setAutoDistillMessage("Failed to save the auto-distill setting.");
        return;
      }
      setAutoDistillMessage(
        next
          ? "Auto-distillation enabled: successful builds will refresh each project's memory."
          : "Auto-distillation disabled."
      );
    } catch {
      setMemoryAutoDistill(!next);
      setAutoDistillMessage("Failed to save the auto-distill setting.");
    } finally {
      setSavingAutoDistill(false);
    }
  }

  async function handleToggleDreamAfterNightRun(next: boolean) {
    setDreamAfterNightRun(next);
    setSavingDream(true);
    setDreamMessage(null);
    try {
      const response = await fetch("/api/settings", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ [DREAMING_AFTER_NIGHT_RUN_SETTING_KEY]: next }),
      });
      if (!response.ok) {
        setDreamAfterNightRun(!next);
        setDreamMessage("Failed to save the dreaming setting.");
        return;
      }
      setDreamMessage(
        next
          ? "Dreaming enabled: each night run ends with a cross-session memory pass."
          : "Dreaming after night runs disabled."
      );
    } catch {
      setDreamAfterNightRun(!next);
      setDreamMessage("Failed to save the dreaming setting.");
    } finally {
      setSavingDream(false);
    }
  }

  async function handleToggleSpecRewrite(next: boolean) {
    setSpecAutoRewrite(next);
    setSavingSpecRewrite(true);
    setSpecRewriteMessage(null);
    try {
      const response = await fetch("/api/settings", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ spec_auto_rewrite: next }),
      });
      if (!response.ok) {
        setSpecAutoRewrite(!next);
        setSpecRewriteMessage("Failed to save the spec auto-rewrite setting.");
        return;
      }
      setSpecRewriteMessage(
        next
          ? "Spec auto-rewrite enabled: publishing a release will refresh each project's specification."
          : "Spec auto-rewrite disabled."
      );
    } catch {
      setSpecAutoRewrite(!next);
      setSpecRewriteMessage("Failed to save the spec auto-rewrite setting.");
    } finally {
      setSavingSpecRewrite(false);
    }
  }

  async function handleSaveGlobalPrompt() {
    setSavingPrompt(true);
    setGlobalMessage(null);

    try {
      const response = await fetch("/api/settings", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          global_prompt: globalPrompt,
        }),
      });

      const payload = await response.json().catch(() => ({}));
      if (!response.ok) {
        setGlobalMessage(
          payload?.error ??
            "Failed to save global prompt. Check the server response and try again."
        );
        return;
      }

      setGlobalMessage("Global prompt saved.");
    } catch {
      setGlobalMessage(
        "Failed to save global prompt. Check your connection and try again."
      );
    } finally {
      setSavingPrompt(false);
    }
  }

  function handleWebhookChange(projectId: string, url: string) {
    setWebhooks((current) =>
      current.map((entry) =>
        entry.projectId === projectId ? { ...entry, url } : entry
      )
    );
  }

  async function handleSaveWebhook(projectId: string) {
    const entry = webhooks.find((w) => w.projectId === projectId);
    if (!entry) return;

    setWebhookMessage(null);
    setWebhookError(null);
    setSavingWebhookId(projectId);

    try {
      const response = await fetch("/api/settings/webhooks", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ projectId, url: entry.url.trim() }),
      });
      const payload = await response.json().catch(() => ({}));

      if (!response.ok) {
        setWebhookError(
          payload?.error ??
            "Failed to save webhook URL. Check the error details and retry."
        );
        return;
      }

      setWebhookMessage(
        entry.url.trim()
          ? `Webhook saved for ${entry.projectName}.`
          : `Webhook cleared for ${entry.projectName}.`
      );
    } catch {
      setWebhookError(
        "Failed to save webhook URL. Check your connection and retry."
      );
    } finally {
      setSavingWebhookId(null);
    }
  }

  async function handleValidateGitHubPat() {
    setGitHubMessage(null);
    setGitHubError(null);

    if (!githubPat.trim()) {
      setGitHubError("Enter a GitHub personal access token before validating.");
      return;
    }

    setValidatingGitHubPat(true);
    try {
      const response = await fetch("/api/settings/github/validate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token: githubPat }),
      });
      const payload = await response.json().catch(() => ({}));

      if (!response.ok || !payload?.data?.valid) {
        setGitHubError(
          payload?.error ??
            "Token validation failed. Verify the token and retry."
        );
        return;
      }

      const login = payload?.data?.login;
      setGitHubMessage(
        login
          ? `Token is valid for GitHub account: ${login}.`
          : "Token is valid."
      );
    } catch {
      setGitHubError(
        "Could not validate token right now. Check your network and try again."
      );
    } finally {
      setValidatingGitHubPat(false);
    }
  }

  async function handleSaveGitHubPat() {
    setGitHubMessage(null);
    setGitHubError(null);

    if (!githubPat.trim()) {
      setGitHubError("Enter a GitHub personal access token before saving.");
      return;
    }

    setSavingGitHubPat(true);
    try {
      const response = await fetch("/api/settings", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          github_pat: githubPat.trim(),
        }),
      });
      const payload = await response.json().catch(() => ({}));

      if (!response.ok) {
        setGitHubError(
          payload?.error ??
            "Failed to save GitHub token. Check the error details and retry."
        );
        return;
      }

      setHasSavedGitHubPat(true);
      setGitHubPat("");
      setGitHubMessage("GitHub token saved.");
    } catch {
      setGitHubError(
        "Failed to save GitHub token. Check your connection and retry."
      );
    } finally {
      setSavingGitHubPat(false);
    }
  }

  async function handleSaveOpenAi() {
    setSavingOpenAi(true);
    setOpenAiMessage(null);
    setOpenAiError(null);

    const baseUrl = openAiBaseUrl.trim();
    const model = openAiModel.trim();
    if (!baseUrl) {
      setOpenAiError("Base URL is required.");
      setSavingOpenAi(false);
      return;
    }
    if (!model) {
      setOpenAiError("Model is required.");
      setSavingOpenAi(false);
      return;
    }

    const patchBody: Record<string, unknown> = {
      [OPENAI_BASE_URL_SETTING_KEY]: baseUrl,
      [OPENAI_MODEL_SETTING_KEY]: model,
      [OPENAI_REASONING_EFFORT_SETTING_KEY]: openAiReasoningEffort,
    };
    if (openAiApiKey.trim().length > 0) {
      patchBody[OPENAI_API_KEY_SETTING_KEY] = openAiApiKey.trim();
    }

    try {
      const response = await fetch("/api/settings", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(patchBody),
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) {
        setOpenAiError(
          payload?.error ?? "Failed to save the OpenAI-compatible settings."
        );
        return;
      }

      if (openAiApiKey.trim().length > 0) {
        setHasSavedOpenAiKey(true);
      }
      setOpenAiApiKey("");
      setOpenAiMessage("OpenAI-compatible settings saved.");
    } catch {
      setOpenAiError(
        "Failed to save the OpenAI-compatible settings. Check your connection and retry."
      );
    } finally {
      setSavingOpenAi(false);
    }
  }
  async function handleClearOpenAiKey() {
    setClearingOpenAiKey(true);
    setOpenAiMessage(null);
    setOpenAiError(null);

    try {
      const response = await fetch("/api/settings", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          [OPENAI_API_KEY_SETTING_KEY]: "",
        }),
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) {
        setOpenAiError(
          payload?.error ?? "Failed to clear the saved API key."
        );
        return;
      }

      setHasSavedOpenAiKey(false);
      setOpenAiApiKey("");
      setOpenAiMessage("Saved API key cleared.");
    } catch {
      setOpenAiError(
        "Failed to clear the saved API key. Check your connection and retry."
      );
    } finally {
      setClearingOpenAiKey(false);
    }
  }

  async function handleTestOpenAi() {
    setTestingOpenAi(true);
    setOpenAiMessage(null);
    setOpenAiError(null);

    try {
      const response = await fetch("/api/settings/openai/test", {
        method: "POST",
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok || !payload?.data?.valid) {
        setOpenAiError(
          payload?.error ??
            "Connection test failed. Check the Base URL, Model, and API key."
        );
        return;
      }

      const model = payload?.data?.model;
      setOpenAiMessage(
        model
          ? `Connection successful — model: ${model}.`
          : "Connection successful."
      );
    } catch {
      setOpenAiError(
        "Could not reach the OpenAI-compatible endpoint. Check your network and try again."
      );
    } finally {
      setTestingOpenAi(false);
    }
  }

  return (
    <div className="p-6 max-w-2xl space-y-8">
      <h1 className="text-2xl font-bold mb-6">Settings</h1>
      <section className="space-y-6">
        <div>
          <label htmlFor="global-prompt" className="block text-sm font-medium mb-2">
            Global Prompt
          </label>
          <p className="text-sm text-muted-foreground mb-2">
            This prompt is injected into all Claude Code sessions across all projects.
          </p>
          <Textarea
            id="global-prompt"
            value={globalPrompt}
            onChange={(e) => setGlobalPrompt(e.target.value)}
            rows={10}
            placeholder="Enter global instructions for Claude Code..."
          />
          {globalMessage && <p className="mt-2 text-sm text-muted-foreground">{globalMessage}</p>}
        </div>

        <Button onClick={handleSaveGlobalPrompt} disabled={savingPrompt}>
          {savingPrompt ? "Saving..." : "Save Settings"}
        </Button>
      </section>

      <section className="space-y-3 rounded-md border border-border p-4">
        <div>
          <h2 className="text-lg font-semibold">Project Memory</h2>
          <p className="text-sm text-muted-foreground">
            Each project can maintain a learned-memory document that is
            injected into every agent prompt (editable in the project&apos;s
            Spec &amp; Memory tab).
          </p>
        </div>
        <label className="flex items-start gap-2 text-sm cursor-pointer">
          <input
            type="checkbox"
            className="mt-0.5"
            checked={memoryAutoDistill}
            disabled={savingAutoDistill}
            onChange={(e) => handleToggleAutoDistill(e.target.checked)}
          />
          <span>
            <span className="font-medium">Auto-distill after builds</span>
            <span className="block text-muted-foreground">
              After a successful build session, automatically run a memory
              distillation agent to merge new conventions into the project
              memory. Off by default.
            </span>
          </span>
        </label>
        {autoDistillMessage && (
          <p className="text-xs text-muted-foreground">{autoDistillMessage}</p>
        )}
        <label className="flex items-start gap-2 text-sm cursor-pointer">
          <input
            type="checkbox"
            className="mt-0.5"
            checked={dreamAfterNightRun}
            disabled={savingDream}
            onChange={(e) => handleToggleDreamAfterNightRun(e.target.checked)}
          />
          <span>
            <span className="font-medium">Dream after each night run</span>
            <span className="block text-muted-foreground">
              When a night run finishes, run a plan-mode agent that reads the
              project&apos;s recent sessions since the last dream — successes
              and failures alike — and rewrites the project memory around
              recurring mistakes, codebase traps and strategies that worked.
              The run only decides WHEN it fires and pays for it (its cost
              counts against the run&apos;s cap); the sessions it reads are
              project-wide, not limited to that run. Off by default.
            </span>
          </span>
        </label>
        {dreamMessage && (
          <p className="text-xs text-muted-foreground">{dreamMessage}</p>
        )}
      </section>

      <section className="space-y-3 rounded-md border border-border p-4">
        <div>
          <h2 className="text-lg font-semibold">Specification</h2>
          <p className="text-sm text-muted-foreground">
            Each project&apos;s specification is injected into every agent
            prompt (editable in the project&apos;s Spec view).
          </p>
        </div>
        <label className="flex items-start gap-2 text-sm cursor-pointer">
          <input
            type="checkbox"
            className="mt-0.5"
            checked={specAutoRewrite}
            disabled={savingSpecRewrite}
            onChange={(e) => handleToggleSpecRewrite(e.target.checked)}
          />
          <span>
            <span className="font-medium">Auto-rewrite the spec after each release</span>
            <span className="block text-muted-foreground">
              When a release is published, automatically run a plan-mode agent
              that rewrites the project specification to match what has
              actually shipped. Skipped while a manual spec update is running.
              Off by default.
            </span>
          </span>
        </label>
        {specRewriteMessage && (
          <p className="text-xs text-muted-foreground">{specRewriteMessage}</p>
        )}
      </section>

      <section className="space-y-3 rounded-md border border-border p-4">
        <div>
          <h2 className="text-lg font-semibold">Agent Tools (MCP)</h2>
          <p className="text-sm text-muted-foreground">
            Agent sessions launched by Arij (Claude Code and Codex) get
            structured MCP tools to read their ticket, post comments, update
            the board status, ask blocking questions, and file review
            findings — instead of relying on prose conventions.
          </p>
        </div>
        <label className="flex items-start gap-2 text-sm cursor-pointer">
          <input
            type="checkbox"
            className="mt-0.5"
            checked={mcpToolsEnabled}
            disabled={savingMcpTools}
            onChange={(e) => handleToggleMcpTools(e.target.checked)}
          />
          <span>
            <span className="font-medium">Enable Arij MCP tools</span>
            <span className="block text-muted-foreground">
              On by default. Turning this off makes new agent sessions spawn
              without the tool channel; running sessions are unaffected.
            </span>
          </span>
        </label>
        {mcpToolsMessage && (
          <p className="text-xs text-muted-foreground">{mcpToolsMessage}</p>
        )}
      </section>

      <section
        className="space-y-3 rounded-md border border-border p-4"
        data-testid="pipeline-settings"
      >
        <div>
          <h2 className="text-lg font-semibold">Autonomous Pipeline</h2>
          <p className="text-sm text-muted-foreground">
            Chains a code review onto every single-ticket build and dispatches
            fix agents until the review is clean. The pipeline never approves a
            ticket — a green run leaves it in Review awaiting your sign-off.
          </p>
        </div>
        <label className="flex items-start gap-2 text-sm cursor-pointer">
          <input
            type="checkbox"
            className="mt-0.5"
            data-testid="pipeline-enabled-toggle"
            checked={pipelineEnabled}
            disabled={savingPipeline}
            onChange={(e) => handleTogglePipeline(e.target.checked)}
          />
          <span>
            <span className="font-medium">Run the pipeline by default</span>
            <span className="block text-muted-foreground">
              Pre-checks the &quot;Run full pipeline&quot; box in the Send to Dev
              dialog. Off by default; each dispatch can still override it.
            </span>
          </span>
        </label>

        <label className="flex items-start gap-2 text-sm cursor-pointer">
          <input
            type="checkbox"
            className="mt-0.5"
            data-testid="pipeline-grader-toggle"
            checked={pipelineGraderEnabled}
            disabled={savingPipeline}
            onChange={(e) => handleTogglePipelineGrader(e.target.checked)}
          />
          <span>
            <span className="font-medium">Grade acceptance criteria</span>
            <span className="block text-muted-foreground">
              Runs an acceptance grader after verification and before code
              review. Missed criteria consume the same fix-cycle budget. Off
              by default.
            </span>
          </span>
        </label>

        <div className="grid gap-4 sm:grid-cols-2">
          <div className="space-y-1">
            <label
              htmlFor="pipeline-max-attempts"
              className="block text-sm font-medium"
            >
              Attempts per stage
            </label>
            <Input
              id="pipeline-max-attempts"
              type="number"
              min={PIPELINE_MAX_ATTEMPTS_RANGE.min}
              max={PIPELINE_MAX_ATTEMPTS_RANGE.max}
              value={pipelineMaxAttempts}
              disabled={savingPipeline}
              onChange={(e) => handleChangeMaxAttempts(e.target.value)}
            />
            <p className="text-xs text-muted-foreground">
              How many times a failed build, fix or review stage is retried
              before the run gives up ({PIPELINE_MAX_ATTEMPTS_RANGE.min}–
              {PIPELINE_MAX_ATTEMPTS_RANGE.max}).
            </p>
          </div>

          <div className="space-y-1">
            <label
              htmlFor="pipeline-max-fix-cycles"
              className="block text-sm font-medium"
            >
              Review → fix cycles
            </label>
            <Input
              id="pipeline-max-fix-cycles"
              type="number"
              min={PIPELINE_MAX_FIX_CYCLES_RANGE.min}
              max={PIPELINE_MAX_FIX_CYCLES_RANGE.max}
              value={pipelineMaxFixCycles}
              disabled={savingPipeline}
              onChange={(e) => handleChangeMaxFixCycles(e.target.value)}
            />
            <p className="text-xs text-muted-foreground">
              How many times blocking findings may send the ticket back to a fix
              agent ({PIPELINE_MAX_FIX_CYCLES_RANGE.min}–
              {PIPELINE_MAX_FIX_CYCLES_RANGE.max}; 0 reports findings without
              fixing them).
            </p>
          </div>
        </div>

        <div
          className="space-y-3 border-t border-border pt-3"
          data-testid="verify-settings"
        >
          <div>
            <h3 className="text-sm font-medium">Deterministic verification</h3>
            <p className="text-xs text-muted-foreground">
              Arij runs these human-configured commands sequentially in the
              epic worktree after a successful build. An empty array keeps the
              stage disabled.
            </p>
          </div>
          <div className="space-y-1">
            <label
              htmlFor="verify-commands"
              className="block text-sm font-medium"
            >
              Verification commands (JSON)
            </label>
            <Textarea
              id="verify-commands"
              data-testid="verify-commands"
              className="font-mono text-xs"
              rows={6}
              value={verifyCommandsJson}
              disabled={savingPipeline}
              onChange={(event) => setVerifyCommandsJson(event.target.value)}
              spellCheck={false}
            />
            <p className="text-xs text-muted-foreground">
              Example: [{`{"name":"test","command":"npm test"}`}]
            </p>
          </div>
          <div className="space-y-1 sm:max-w-xs">
            <label
              htmlFor="verify-timeout-ms"
              className="block text-sm font-medium"
            >
              Timeout per command (ms)
            </label>
            <Input
              id="verify-timeout-ms"
              data-testid="verify-timeout-ms"
              type="number"
              min={1}
              value={verifyTimeoutMs}
              disabled={savingPipeline}
              onChange={(event) => setVerifyTimeoutMs(event.target.value)}
            />
          </div>
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={savingPipeline}
            onClick={handleSaveVerifySettings}
          >
            Save verification settings
          </Button>
        </div>

        <label className="flex items-start gap-2 text-sm cursor-pointer">
          <input
            type="checkbox"
            className="mt-0.5"
            data-testid="bug-regression-toggle"
            checked={bugRegressionCheck}
            disabled={savingPipeline}
            onChange={(e) => handleToggleBugRegression(e.target.checked)}
          />
          <span>
            <span className="font-medium">
              Mandatory regression test on bug tickets
            </span>
            <span className="block text-muted-foreground">
              RoboBun rule: a bug fix only passes the verify stage when its
              branch carries a test that fails without the fix (red) and
              passes with it (green). Off by default.
            </span>
          </span>
        </label>

        {bugRegressionCheck && (
          <div className="ml-6 space-y-3 border-l border-border pl-4">
            <div className="space-y-1">
              <label
                className="text-sm font-medium"
                htmlFor="bug-regression-command"
              >
                Regression test command
              </label>
              <div className="flex gap-2">
                <input
                  id="bug-regression-command"
                  data-testid="bug-regression-command"
                  className="flex-1 rounded-md border border-border bg-background px-2 py-1 text-sm font-mono"
                  value={bugRegressionCommand}
                  disabled={savingPipeline}
                  onChange={(e) => setBugRegressionCommand(e.target.value)}
                  onBlur={handleSaveBugRegressionCommand}
                />
              </div>
              <p className="text-xs text-muted-foreground">
                Run once on the branch and once on the merge-base.{" "}
                <code>{REGRESSION_COMMAND_FILE_PLACEHOLDER}</code> is replaced
                with the detected test files. Change it for any project that
                does not use vitest (default{" "}
                <code>{DEFAULT_BUG_REGRESSION_COMMAND}</code>).
              </p>
            </div>

            <div className="space-y-1">
              <label
                className="text-sm font-medium"
                htmlFor="test-file-patterns"
              >
                Test file patterns
              </label>
              <input
                id="test-file-patterns"
                data-testid="test-file-patterns"
                className="w-full rounded-md border border-border bg-background px-2 py-1 text-sm font-mono"
                value={testFilePatterns}
                disabled={savingPipeline}
                onChange={(e) => setTestFilePatterns(e.target.value)}
                onBlur={handleSaveTestFilePatterns}
              />
              <p className="text-xs text-muted-foreground">
                Comma-separated globs selecting the test files in the branch
                diff (default {DEFAULT_TEST_FILE_PATTERNS.join(", ")}).
              </p>
            </div>
          </div>
        )}

        {pipelineMessage && (
          <p className="text-xs text-muted-foreground">{pipelineMessage}</p>
        )}
      </section>

      <section
        className="space-y-3 rounded-md border border-border p-4"
        data-testid="night-settings"
      >
        <div>
          <h2 className="text-lg font-semibold">Night Runs</h2>
          <p className="text-sm text-muted-foreground">
            Defaults for unattended overnight runs (the &quot;Night run&quot;
            button on a project board). Each run can override them.
          </p>
        </div>

        <div className="grid gap-4 sm:grid-cols-2">
          <div className="space-y-1">
            <label
              htmlFor="night-circuit-breaker-setting"
              className="block text-sm font-medium"
            >
              Circuit breaker
            </label>
            <Input
              id="night-circuit-breaker-setting"
              data-testid="night-circuit-breaker-setting"
              type="number"
              min={NIGHT_CIRCUIT_BREAKER_RANGE.min}
              max={NIGHT_CIRCUIT_BREAKER_RANGE.max}
              value={nightCircuitBreaker}
              disabled={savingNight}
              placeholder={String(DEFAULT_NIGHT_CIRCUIT_BREAKER)}
              onChange={(e) => setNightCircuitBreaker(e.target.value)}
            />
            <p className="text-xs text-muted-foreground">
              Abort the run after this many consecutive epic failures (
              {NIGHT_CIRCUIT_BREAKER_RANGE.min}–{NIGHT_CIRCUIT_BREAKER_RANGE.max};
              0 disables it, empty keeps the default of{" "}
              {DEFAULT_NIGHT_CIRCUIT_BREAKER}).
            </p>
          </div>

          <div className="space-y-1">
            <label
              htmlFor="night-cost-cap-setting"
              className="block text-sm font-medium"
            >
              Cost cap (USD)
            </label>
            <Input
              id="night-cost-cap-setting"
              data-testid="night-cost-cap-setting"
              type="number"
              min={0}
              step="0.5"
              value={nightCostCap}
              disabled={savingNight}
              placeholder="Unlimited"
              onChange={(e) => setNightCostCap(e.target.value)}
            />
            <p className="text-xs text-muted-foreground">
              Stop launching new waves once the run has spent this much. Only
              Claude-reported costs are counted — other providers are
              invisible, so the real spend can be higher.
            </p>
          </div>
        </div>

        <Button
          type="button"
          onClick={handleSaveNightDefaults}
          disabled={savingNight}
          data-testid="night-settings-save"
        >
          {savingNight ? "Saving..." : "Save Night Defaults"}
        </Button>

        {nightMessage && (
          <p className="text-xs text-muted-foreground" data-testid="night-settings-message">
            {nightMessage}
          </p>
        )}
      </section>

      <section
        className="space-y-3 rounded-md border border-border p-4"
        data-testid="usage-settings"
      >
        <div>
          <h2 className="text-lg font-semibold">Usage</h2>
        </div>

        <div className="space-y-1">
          <label
            htmlFor="usage-budget-setting"
            className="block text-sm font-medium"
          >
            Claude weekly budget (USD)
          </label>
          <Input
            id="usage-budget-setting"
            data-testid="usage-budget-setting"
            type="number"
            min={0}
            step="1"
            value={usageBudget}
            disabled={savingUsageBudget}
            placeholder="No budget"
            onChange={(e) => setUsageBudget(e.target.value)}
          />
          <p className="text-xs text-muted-foreground">
            Optional. Shown as a budget gauge on the Usage page — Arij-metered
            sessions only, not an account quota. Leave empty for no budget.
          </p>
        </div>

        {/* Visible label stays "Save"; the accessible name is scoped so the
            webhook section's own "Save" buttons stay unambiguous. */}
        <Button
          type="button"
          onClick={handleSaveUsageBudget}
          disabled={savingUsageBudget}
          aria-label="Save usage budget"
          data-testid="usage-settings-save"
        >
          {savingUsageBudget ? "Saving..." : "Save"}
        </Button>

        {usageBudgetMessage && (
          <p
            className="text-xs text-muted-foreground"
            data-testid="usage-settings-message"
          >
            {usageBudgetMessage}
          </p>
        )}
      </section>
      <section
        className="space-y-3 rounded-md border border-border p-4"
        data-testid="prompt-budget-settings"
      >
        <div>
          <h2 className="text-lg font-semibold">Prompt Token Budget</h2>
        </div>

        <div className="space-y-1">
          <label
            htmlFor="prompt-token-budget-setting"
            className="block text-sm font-medium"
          >
            Max prompt tokens warning threshold
          </label>
          <Input
            id="prompt-token-budget-setting"
            data-testid="prompt-token-budget-setting"
            type="text"
            value={promptTokenBudget}
            disabled={savingPromptTokenBudget}
            placeholder="e.g. 50000 or 50k (no threshold by default)"
            onChange={(e) => setPromptTokenBudget(e.target.value)}
          />
          <p className="text-xs text-muted-foreground">
            Optional absolute token count warning threshold (e.g. 50000 or 50k). When a build or review dispatch estimation exceeds this threshold,
            a non-blocking warning is shown highlighting the largest context section. Leave empty for no warning.
          </p>
        </div>

        <Button
          type="button"
          onClick={handleSavePromptTokenBudget}
          disabled={savingPromptTokenBudget}
          aria-label="Save prompt token budget"
          data-testid="prompt-token-budget-save"
        >
          {savingPromptTokenBudget ? "Saving..." : "Save"}
        </Button>

        {promptTokenBudgetMessage && (
          <p
            className="text-xs text-muted-foreground"
            data-testid="prompt-token-budget-message"
          >
            {promptTokenBudgetMessage}
          </p>
        )}
      </section>


      <section className="space-y-4 rounded-md border border-border p-4">
        <div>
          <h2 className="text-lg font-semibold">GitHub</h2>
          <p className="text-sm text-muted-foreground">
            Configure a personal access token for pull requests and release APIs.
          </p>
          {hasSavedGitHubPat && (
            <p className="mt-2 text-xs text-muted-foreground">
              A GitHub token is already saved for this workspace.
            </p>
          )}
        </div>

        <div className="space-y-2">
          <label htmlFor="github-pat" className="block text-sm font-medium">
            GitHub PAT
          </label>
          <Input
            id="github-pat"
            type="password"
            value={githubPat}
            onChange={(e) => setGitHubPat(e.target.value)}
            placeholder="ghp_..."
          />
        </div>

        <div className="flex items-center gap-2">
          <Button
            type="button"
            variant="outline"
            onClick={handleValidateGitHubPat}
            disabled={validatingGitHubPat}
          >
            {validatingGitHubPat ? "Validating..." : "Validate Token"}
          </Button>
          <Button
            type="button"
            onClick={handleSaveGitHubPat}
            disabled={savingGitHubPat}
          >
            {savingGitHubPat ? "Saving..." : "Save Token"}
          </Button>
        </div>

        {gitHubMessage && <p className="text-sm text-muted-foreground">{gitHubMessage}</p>}
        {gitHubError && <p className="text-sm text-destructive">{gitHubError}</p>}
      </section>

      <section
        className="space-y-4 rounded-md border border-border p-4"
        data-testid="projects-root-settings"
      >
        <div>
          <h2 className="text-lg font-semibold">Projects Directory</h2>
          <p className="text-sm text-muted-foreground">
            Where Arij clones repositories imported from a GitHub URL. Each
            clone lands in <code>&lt;directory&gt;/owner-repo</code>. Leave
            empty to use the default. Changing it only affects future clones —
            existing projects keep the path they were created with.
          </p>
        </div>

        <div className="space-y-2">
          <label htmlFor="projects-root" className="block text-sm font-medium">
            Directory
          </label>
          <div className="flex items-center gap-2">
            <Input
              id="projects-root"
              data-testid="projects-root-setting"
              value={projectsRoot}
              onChange={(e) => setProjectsRoot(e.target.value)}
              placeholder={projectsRootDefault}
              disabled={savingProjectsRoot}
            />
            <Button
              type="button"
              onClick={handleSaveProjectsRoot}
              disabled={savingProjectsRoot}
            >
              {savingProjectsRoot ? "Saving..." : "Save Directory"}
            </Button>
          </div>
        </div>

        {projectsRootMessage && (
          <p
            className="text-xs text-muted-foreground"
            data-testid="projects-root-message"
          >
            {projectsRootMessage}
          </p>
        )}
      </section>

      <section
        className="space-y-4 rounded-md border border-border p-4"
        data-testid="openai-settings"
      >
        <div>
          <h2 className="text-lg font-semibold">OpenAI-compatible API</h2>
          <p className="text-sm text-muted-foreground">
            Answer chat messages directly from an OpenAI-compatible endpoint
            (local or hosted) with token-by-token streaming, bypassing the CLI
            agents.
          </p>
          {hasSavedOpenAiKey && (
            <div className="mt-2 flex items-center gap-2 text-xs text-muted-foreground">
              <span>An API key is already saved for this workspace.</span>
              <button
                type="button"
                className="text-xs text-destructive hover:underline cursor-pointer bg-transparent border-0 p-0 disabled:opacity-50"
                onClick={handleClearOpenAiKey}
                disabled={clearingOpenAiKey || savingOpenAi}
                data-testid="openai-clear-key-button"
              >
                {clearingOpenAiKey ? "Clearing..." : "Clear key"}
              </button>
            </div>
          )}
        </div>

        <div className="space-y-2">
          <label htmlFor="openai-base-url" className="block text-sm font-medium">
            Base URL
          </label>
          <Input
            id="openai-base-url"
            data-testid="openai-base-url"
            type="url"
            value={openAiBaseUrl}
            onChange={(e) => setOpenAiBaseUrl(e.target.value)}
            placeholder="http://localhost:11434/v1"
          />
        </div>

        <div className="space-y-2">
          <label htmlFor="openai-api-key" className="block text-sm font-medium">
            API key
          </label>
          <Input
            id="openai-api-key"
            data-testid="openai-api-key"
            type="password"
            value={openAiApiKey}
            onChange={(e) => setOpenAiApiKey(e.target.value)}
            placeholder="Optional for local servers"
          />
          <p className="text-xs text-muted-foreground">
            Optional. When empty, no Authorization header is sent, so keyless
            local servers work.
          </p>
        </div>

        <div className="space-y-2">
          <label htmlFor="openai-model" className="block text-sm font-medium">
            Model
          </label>
          <Input
            id="openai-model"
            data-testid="openai-model"
            value={openAiModel}
            onChange={(e) => setOpenAiModel(e.target.value)}
            placeholder="gpt-4o-mini"
          />
        </div>

        <div className="space-y-2">
          <label
            htmlFor="openai-reasoning-effort"
            className="block text-sm font-medium"
          >
            Reasoning
          </label>
          <Select
            value={openAiReasoningEffort}
            onValueChange={(value) =>
              setOpenAiReasoningEffort(value as OpenAiReasoningEffort)
            }
          >
            <SelectTrigger
              id="openai-reasoning-effort"
              data-testid="openai-reasoning-effort"
              className="w-full"
            >
              <SelectValue placeholder="off" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="off">Off</SelectItem>
              <SelectItem value="low">Low</SelectItem>
              <SelectItem value="medium">Medium</SelectItem>
              <SelectItem value="high">High</SelectItem>
            </SelectContent>
          </Select>
        </div>

        <div className="flex items-center gap-2">
          <Button
            type="button"
            variant="outline"
            onClick={handleTestOpenAi}
            disabled={testingOpenAi}
          >
            {testingOpenAi ? "Testing..." : "Test connection"}
          </Button>
          <Button type="button" onClick={handleSaveOpenAi} disabled={savingOpenAi || clearingOpenAiKey}>
            {savingOpenAi ? "Saving..." : "Save"}
          </Button>
        </div>

        {openAiMessage && (
          <p className="text-sm text-muted-foreground" data-testid="openai-settings-message">
            {openAiMessage}
          </p>
        )}
        {openAiError && (
          <p className="text-sm text-destructive" data-testid="openai-settings-error">
            {openAiError}
          </p>
        )}
      </section>

      <section
        className="space-y-4 rounded-md border border-border p-4"
        data-testid="webhooks-settings"
      >
        <div>
          <h2 className="text-lg font-semibold">Webhooks</h2>
          <p className="text-sm text-muted-foreground">
            Post a JSON notification when an agent session finishes or a release
            is created. Works with ntfy.sh, Discord and Slack-compatible
            endpoints. Leave a field empty to disable it.
          </p>
        </div>

        {webhooks.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No projects yet. Create a project to configure a webhook.
          </p>
        ) : (
          <div className="space-y-4">
            {webhooks.map((entry) => (
              <div key={entry.projectId} className="space-y-2">
                <label
                  htmlFor={`webhook-${entry.projectId}`}
                  className="block text-sm font-medium"
                >
                  {entry.projectName}
                </label>
                <div className="flex items-center gap-2">
                  <Input
                    id={`webhook-${entry.projectId}`}
                    type="url"
                    value={entry.url}
                    onChange={(e) =>
                      handleWebhookChange(entry.projectId, e.target.value)
                    }
                    placeholder="https://ntfy.sh/my-topic"
                  />
                  <Button
                    type="button"
                    variant="outline"
                    onClick={() => handleSaveWebhook(entry.projectId)}
                    disabled={savingWebhookId === entry.projectId}
                  >
                    {savingWebhookId === entry.projectId ? "Saving..." : "Save"}
                  </Button>
                </div>
              </div>
            ))}
          </div>
        )}

        {webhookMessage && (
          <p className="text-sm text-muted-foreground">{webhookMessage}</p>
        )}
        {webhookError && <p className="text-sm text-destructive">{webhookError}</p>}
      </section>
    </div>
  );
}
