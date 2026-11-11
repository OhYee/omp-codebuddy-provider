import { closeSync, fstatSync, lstatSync, openSync, readFileSync, readdirSync } from "node:fs";
import { constants as fsConstants } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { streamSimple as piStreamSimple } from "@oh-my-pi/pi-ai";
import type { Context, Model, SimpleStreamOptions } from "@oh-my-pi/pi-ai";
import type { ExtensionAPI, ProviderModelConfig } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/types";

type ModelCost = ProviderModelConfig["cost"];
type ModelCostOverride = Partial<ModelCost>;
type ModelOverride = {
  contextWindow?: number;
  maxTokens?: number;
  cost?: ModelCostOverride;
};
type ProviderSettings = {
  authFile?: string;
  models: Record<string, ModelOverride>;
};
type RuntimeModel = {
  id: string;
  name?: string;
  contextWindow?: number;
  maxTokens?: number;
  credits?: string;
  supportsImages: boolean;
  reasoning: boolean;
};

type RuntimeModelRecord = {
  timestamp: number;
  mtime: number;
  fileName: string;
  models: Map<string, RuntimeModel>;
};

const PROVIDER = "codebuddy-direct";
const API = "codebuddy-direct-chat";
const TRANSPORT_API = "openai-completions";
const BASE_URL = "https://copilot.tencent.com/v2";
const DEFAULT_CONTEXT_WINDOW = 128_000;
const DEFAULT_MAX_TOKENS = 16_384;
const MAX_AUTH_FILE_BYTES = 128 * 1024;
const MAX_SETTINGS_FILE_BYTES = 1024 * 1024;
const MAX_MODEL_CACHE_FILE_BYTES = 2 * 1024 * 1024;
const MAX_TOKEN_LENGTH = 16_384;
const COST_KEYS = ["input", "output", "cacheRead", "cacheWrite"] as const;
// ProviderModelConfig requires numeric rates but has no pricingStatus field; OMP's picker treats zero rates as free.
// Keep these as schema placeholders and visibly mark USD pricing unknown until all four rates are configured.
const ZERO_COST: ModelCost = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
const FALLBACK_MODEL_IDS = [
  "hy4free",
  "hy4std",
  "hy3",
  "hy3-x",
  "deepseek-v4.1-flash",
  "glm-5.3",
  "glm-5.3-flash",
  "glm-5.2",
  "space-bunny",
  "minimax-m3.1-flash",
  "minimax-m2.7",
  "kimi-k3.1-pro",
  "kimi-k3-1",
  "kimi-k2.8-preview",
  "deepseek-v4-pro",
  "step-5-preview",
  "mimo-v2.6-pro",
] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function errorCode(error: unknown): string | undefined {
  return isRecord(error) && typeof error.code === "string" ? error.code : undefined;
}

function optionalPositiveInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : undefined;
}

function safeDisplayText(value: unknown, maxLength = 120): string | undefined {
  if (typeof value !== "string") return undefined;
  const text = value.replace(/[\u0000-\u001f\u007f-\u009f]/g, "").trim().slice(0, maxLength);
  return text || undefined;
}

function normalizeModelId(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  let id = value.trim();
  if (id.startsWith("codebuddy/")) id = id.slice("codebuddy/".length);
  return /^[A-Za-z0-9][A-Za-z0-9._:/@+-]*$/.test(id) ? id : undefined;
}

function expandPath(value: string): string {
  if (value === "~") return homedir();
  if (value.startsWith("~/")) return resolve(homedir(), value.slice(2));
  return resolve(value);
}

function settingsFilePath(env: NodeJS.ProcessEnv = process.env): string {
  const directory = env.PI_CODING_AGENT_DIR?.trim() || resolve(homedir(), ".omp", "agent");
  return resolve(directory, "codebuddy-provider.json");
}

function codeBuddyLocalStorageDirectory(env: NodeJS.ProcessEnv = process.env): string {
  const configDirectory = env.CODEBUDDY_CONFIG_DIR?.trim() || resolve(homedir(), ".codebuddy");
  return resolve(configDirectory, "local_storage");
}

function readProviderSettings(path = settingsFilePath()): ProviderSettings {
  let rawText: string;
  try {
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.size > MAX_SETTINGS_FILE_BYTES) {
      throw new Error("invalid settings file");
    }
    rawText = readFileSync(path, "utf8");
  } catch (error) {
    if (errorCode(error) === "ENOENT") return { models: {} };
    throw new Error("Could not read codebuddy-provider.json; check that it is valid JSON and under 1 MiB.");
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(rawText);
  } catch {
    throw new Error("Could not read codebuddy-provider.json; check that it is valid JSON and under 1 MiB.");
  }
  if (!isRecord(parsed)) throw new Error("codebuddy-provider.json must contain a JSON object.");

  const authFile = typeof parsed.authFile === "string" && parsed.authFile.trim()
    ? parsed.authFile.trim()
    : undefined;
  const models: Record<string, ModelOverride> = {};
  if (parsed.models !== undefined && !isRecord(parsed.models)) {
    throw new Error('The "models" setting in codebuddy-provider.json must be an object.');
  }

  for (const [rawId, rawOverride] of Object.entries(isRecord(parsed.models) ? parsed.models : {})) {
    const id = normalizeModelId(rawId);
    if (!id || !isRecord(rawOverride)) throw new Error("Invalid model override in codebuddy-provider.json.");
    const override: ModelOverride = {};
    for (const field of ["contextWindow", "maxTokens"] as const) {
      const value = rawOverride[field];
      if (value === undefined) continue;
      const parsedValue = optionalPositiveInteger(value);
      if (parsedValue === undefined) throw new Error(`Invalid ${field} override for model ${id}.`);
      override[field] = parsedValue;
    }
    if (rawOverride.cost !== undefined) {
      if (!isRecord(rawOverride.cost)) throw new Error(`Invalid cost override for model ${id}.`);
      const cost: ModelCostOverride = {};
      for (const key of COST_KEYS) {
        const value = rawOverride.cost[key];
        if (value === undefined) continue;
        if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
          throw new Error(`Invalid cost override for model ${id}.`);
        }
        cost[key] = value;
      }
      override.cost = cost;
    }
    models[id] = override;
  }

  return { ...(authFile ? { authFile } : {}), models };
}

function readRuntimeModels(directory = codeBuddyLocalStorageDirectory()): Map<string, RuntimeModel> {
  const snapshots: RuntimeModelRecord[] = [];
  let fileNames: string[];
  try {
    fileNames = readdirSync(directory);
  } catch {
    return new Map();
  }

  for (const fileName of fileNames) {
    if (!fileName.startsWith("entry_") || !fileName.endsWith(".info")) continue;
    try {
      const path = resolve(directory, fileName);
      const stat = lstatSync(path);
      if (!stat.isFile() || stat.size > MAX_MODEL_CACHE_FILE_BYTES) continue;
      const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
      const records = Array.isArray(parsed) ? parsed : [parsed];
      for (const record of records) {
        if (!isRecord(record) || !isRecord(record.data) || !Array.isArray(record.data.models)) continue;
        const models = new Map<string, RuntimeModel>();
        for (const rawModel of record.data.models) {
          if (!isRecord(rawModel)) continue;
          const id = normalizeModelId(rawModel.id);
          if (!id) continue;
          const contextWindow = optionalPositiveInteger(rawModel.maxInputTokens)
            ?? optionalPositiveInteger(rawModel.maxAllowedSize);
          const maxTokens = optionalPositiveInteger(rawModel.maxOutputTokens);
          // Entries without token limits are image/video tools, not chat models.
          if (contextWindow === undefined && maxTokens === undefined) continue;
          const creditsValue = safeDisplayText(rawModel.credits, 64);
          const credits = creditsValue && /^x\d+(?:\.\d+)? credits$/.test(creditsValue) ? creditsValue : undefined;
          const name = safeDisplayText(rawModel.name);
          models.set(id, {
            id,
            ...(name ? { name } : {}),
            ...(contextWindow === undefined ? {} : { contextWindow }),
            ...(maxTokens === undefined ? {} : { maxTokens }),
            ...(credits ? { credits } : {}),
            supportsImages: rawModel.supportsImages === true,
            reasoning: rawModel.supportsReasoning === true || rawModel.onlyReasoning === true,
          });
        }
        const timestamp = typeof record.ts === "number" && Number.isFinite(record.ts) ? record.ts : stat.mtimeMs;
        snapshots.push({ timestamp, mtime: stat.mtimeMs, fileName, models });
      }
    } catch {
      // CodeBuddy may rewrite the cache while the extension is loading.
    }
  }

  snapshots.sort((a, b) => b.timestamp - a.timestamp || b.mtime - a.mtime || a.fileName.localeCompare(b.fileName));
  return snapshots[0]?.models ?? new Map();
}

function buildModels(options: { runtimeDirectory?: string; settingsPath?: string } = {}): ProviderModelConfig[] {
  const settings = readProviderSettings(options.settingsPath ?? settingsFilePath());
  const runtimeModels = readRuntimeModels(options.runtimeDirectory ?? codeBuddyLocalStorageDirectory());
  const baseModels: RuntimeModel[] = runtimeModels.size > 0
    ? [...runtimeModels.values()]
    : FALLBACK_MODEL_IDS.map(id => ({ id, name: id, supportsImages: false, reasoning: false }));
  const models = new Map(baseModels.map(model => [model.id, model]));

  for (const id of Object.keys(settings.models)) {
    if (!models.has(id)) models.set(id, { id, name: id, supportsImages: false, reasoning: false });
  }

  return [...models.values()].map(model => {
    const override = settings.models[model.id];
    const label = model.name ?? model.id;
    const hasCompleteUsdCost = COST_KEYS.every(key => override?.cost?.[key] !== undefined);
    const annotations = [
      ...(hasCompleteUsdCost ? [] : ["USD price unknown"]),
      ...(model.credits ? [model.credits] : []),
    ];
    return {
      id: model.id,
      name: annotations.length > 0 ? `${label} (${annotations.join("; ")})` : label,
      api: API,
      reasoning: model.reasoning,
      input: model.supportsImages ? ["text", "image"] : ["text"],
      cost: { ...ZERO_COST, ...override?.cost },
      contextWindow: override?.contextWindow ?? model.contextWindow ?? DEFAULT_CONTEXT_WINDOW,
      maxTokens: override?.maxTokens ?? model.maxTokens ?? DEFAULT_MAX_TOKENS,
    };
  });
}

function resolveAuthFilePath(settings?: ProviderSettings, env: NodeJS.ProcessEnv = process.env): string {
  const configured = env.CODEBUDDY_AUTH_FILE?.trim() || settings?.authFile || readProviderSettings().authFile;
  if (configured) return expandPath(configured);
  return join(homedir(), "Library", "Application Support", "CodeBuddyExtension", "Data", "Public", "auth", "Tencent-Cloud.coding-copilot.info");
}

function readCodeBuddyAccessToken(path = resolveAuthFilePath()): string {
  let fileDescriptor: number;
  try {
    const flags = fsConstants.O_RDONLY | (typeof fsConstants.O_NOFOLLOW === "number" ? fsConstants.O_NOFOLLOW : 0);
    fileDescriptor = openSync(path, flags);
  } catch {
    throw new Error("CodeBuddy access token is unavailable. Sign in to CodeBuddy or set CODEBUDDY_AUTH_FILE.");
  }

  let contents: string;
  try {
    const stat = fstatSync(fileDescriptor);
    if (!stat.isFile() || stat.size > MAX_AUTH_FILE_BYTES) {
      throw new Error("CodeBuddy auth file must be a regular file no larger than 128 KiB.");
    }
    if (process.platform !== "win32" && (stat.mode & 0o077) !== 0) {
      throw new Error("CodeBuddy auth file must be owner-only (for example, chmod 600).");
    }
    contents = readFileSync(fileDescriptor, "utf8");
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("CodeBuddy auth file")) throw error;
    throw new Error("Could not read the configured CodeBuddy auth file.");
  } finally {
    closeSync(fileDescriptor);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(contents);
  } catch {
    throw new Error("The configured CodeBuddy auth file is not valid JSON.");
  }
  const auth = isRecord(parsed) && isRecord(parsed.auth) ? parsed.auth : undefined;
  const token = auth?.accessToken;
  if (typeof token !== "string" || !token.trim() || token.length > MAX_TOKEN_LENGTH) {
    throw new Error("CodeBuddy access token is missing or invalid. Sign in to CodeBuddy again.");
  }
  return token.trim();
}

function streamCodeBuddy(model: Model, context: Context, options: SimpleStreamOptions = {}) {
  const transportModel = { ...model, api: TRANSPORT_API } as Model<typeof TRANSPORT_API>;
  return piStreamSimple(transportModel, context, {
    ...options,
    // Resolve the local credential for every request/retry; never persist it in OMP provider settings.
    apiKey: () => readCodeBuddyAccessToken(),
  });
}

export default function codeBuddyProvider(pi: ExtensionAPI): void {
  pi.registerProvider(PROVIDER, {
    api: API,
    baseUrl: BASE_URL,
    // Pi treats this marker as keyless; streamCodeBuddy supplies the token from the local auth file.
    apiKey: "N/A",
    models: buildModels(),
    async fetchDynamicModels() {
      return buildModels();
    },
    streamSimple: streamCodeBuddy,
  });
}

export const __testing = {
  buildModels,
  codeBuddyLocalStorageDirectory,
  readCodeBuddyAccessToken,
  readProviderSettings,
  readRuntimeModels,
  resolveAuthFilePath,
  settingsFilePath,
  streamCodeBuddy,
};
