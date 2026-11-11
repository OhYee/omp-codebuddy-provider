import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { streamSimple as piStreamSimple } from "@oh-my-pi/pi-ai";
import { registerCustomApi, unregisterCustomApis } from "@oh-my-pi/pi-ai/api-registry";
import type { Context, Model } from "@oh-my-pi/pi-ai";
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/types";
import codeBuddyProvider, { __testing } from "../index";

const temporaryDirectories: string[] = [];
const previousAuthFile = process.env.CODEBUDDY_AUTH_FILE;
const previousAgentDirectory = process.env.PI_CODING_AGENT_DIR;
const previousCodeBuddyConfigDirectory = process.env.CODEBUDDY_CONFIG_DIR;

function temporaryDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), "codebuddy-provider-test-"));
  temporaryDirectories.push(directory);
  return directory;
}

function writeAuthFile(path: string, accessToken = "fixture-token-value"): void {
  writeFileSync(path, JSON.stringify({ auth: { accessToken, refreshToken: "fixture-refresh-value" } }), { mode: 0o600 });
  chmodSync(path, 0o600);
}

function writeModelSnapshot(directory: string, fileName: string, timestamp: number, models: unknown[]): void {
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, fileName), JSON.stringify({ ts: timestamp, data: { models } }));
}

afterEach(() => {
  if (previousAuthFile === undefined) delete process.env.CODEBUDDY_AUTH_FILE;
  else process.env.CODEBUDDY_AUTH_FILE = previousAuthFile;
  if (previousAgentDirectory === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = previousAgentDirectory;
  if (previousCodeBuddyConfigDirectory === undefined) delete process.env.CODEBUDDY_CONFIG_DIR;
  else process.env.CODEBUDDY_CONFIG_DIR = previousCodeBuddyConfigDirectory;
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });

});

describe("CodeBuddy credentials", () => {
  test("reads the access token from a private local auth file", () => {
    const path = join(temporaryDirectory(), "auth.info");
    writeAuthFile(path);

    expect(__testing.readCodeBuddyAccessToken(path)).toBe("fixture-token-value");
  });

  test("rejects a symlink instead of following it", () => {
    const directory = temporaryDirectory();
    const target = join(directory, "auth.info");
    const link = join(directory, "auth-link.info");
    writeAuthFile(target);
    symlinkSync(target, link);

    expect(() => __testing.readCodeBuddyAccessToken(link)).toThrow("CodeBuddy access token is unavailable");
  });

  test("resolves an environment override", () => {
    const path = join(temporaryDirectory(), "auth.info");
    writeAuthFile(path, "second-fixture-value");
    process.env.CODEBUDDY_AUTH_FILE = path;

    expect(__testing.resolveAuthFilePath()).toBe(path);
  });
  test("rejects a symlinked provider settings file", () => {
    const directory = temporaryDirectory();
    const target = join(directory, "settings.json");
    const link = join(directory, "settings-link.json");
    writeFileSync(target, JSON.stringify({ models: {} }));
    symlinkSync(target, link);

    expect(() => __testing.readProviderSettings(link)).toThrow("Could not read codebuddy-provider.json");
  });

});

describe("CodeBuddy model metadata", () => {
  test("uses the newest chat-model snapshot for windows and excludes non-chat entries", () => {
    const runtimeDirectory = join(temporaryDirectory(), "local_storage");
    writeModelSnapshot(runtimeDirectory, "entry_old.info", 1, [
      { id: "hy4free", name: "Hy4", maxInputTokens: 128000, maxOutputTokens: 16000 },
    ]);
    writeModelSnapshot(runtimeDirectory, "entry_new.info", 2, [
      { id: "hy4free", name: "Hy4", maxInputTokens: 960000, maxOutputTokens: 64000, credits: "x0.00 credits", supportsImages: true, supportsReasoning: true },
      { id: "hunyuan-image-alpha", name: "Image model" },
    ]);
    const settingsPath = join(temporaryDirectory(), "codebuddy-provider.json");

    const models = __testing.buildModels({ runtimeDirectory, settingsPath });
    const hy4free = models.find(model => model.id === "hy4free");

    expect(hy4free).toMatchObject({
      contextWindow: 960000,
      maxTokens: 64000,
      reasoning: true,
      input: ["text", "image"],
      name: "Hy4 (USD price unknown; x0.00 credits)",
    });
    expect(models.some(model => model.id === "hunyuan-image-alpha")).toBe(false);
    expect(models).toHaveLength(1);
  });

  test("applies manual model metadata over the CodeBuddy cache", () => {
    const runtimeDirectory = join(temporaryDirectory(), "local_storage");
    writeModelSnapshot(runtimeDirectory, "entry_models.info", 1, [
      { id: "hy4free", name: "Hy4", maxInputTokens: 960000, maxOutputTokens: 64000 },
    ]);
    const settingsPath = join(temporaryDirectory(), "codebuddy-provider.json");
    writeFileSync(settingsPath, JSON.stringify({
      models: {
        hy4free: {
          contextWindow: 800000,
          maxTokens: 32000,
          cost: { input: 1.5 },
        },
      },
    }));

    const [model] = __testing.buildModels({ runtimeDirectory, settingsPath });

    expect(model).toMatchObject({
      id: "hy4free",
      contextWindow: 800000,
      maxTokens: 32000,
      cost: { input: 1.5, output: 0, cacheRead: 0, cacheWrite: 0 },
    });
    expect(model.name).toBe("Hy4 (USD price unknown)");
    writeFileSync(settingsPath, JSON.stringify({
      models: {
        hy4free: {
          cost: { input: 1.5, output: 4, cacheRead: 0.25, cacheWrite: 0.5 },
        },
      },
    }));
    const [pricedModel] = __testing.buildModels({ runtimeDirectory, settingsPath });
    expect(pricedModel?.name).toBe("Hy4");
    expect(pricedModel?.cost).toEqual({ input: 1.5, output: 4, cacheRead: 0.25, cacheWrite: 0.5 });
  });
});

describe("direct Chat Completions transport", () => {
  test("streams through the CodeBuddy endpoint with a local bearer credential", async () => {
    const path = join(temporaryDirectory(), "auth.info");
    writeAuthFile(path);
    process.env.CODEBUDDY_AUTH_FILE = path;
    let requestUrl = "";
    let authorization = "";
    let requestBody: Record<string, unknown> | undefined;
    const fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      requestUrl = String(input);
      authorization = new Headers(init?.headers).get("authorization") ?? "";
      requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return new Response([
        'data: {"choices":[{"index":0,"delta":{"content":"done"}}]}',
        'data: {"choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}',
        "data: [DONE]",
        "",
      ].join("\n\n"), { headers: { "content-type": "text/event-stream" } });
    };
    const providerDataDirectory = temporaryDirectory();
    process.env.PI_CODING_AGENT_DIR = providerDataDirectory;
    process.env.CODEBUDDY_CONFIG_DIR = providerDataDirectory;
    const registrations: Array<{ name: string; config: Parameters<ExtensionAPI["registerProvider"]>[1] }> = [];
    codeBuddyProvider({
      registerProvider(name: string, config: Parameters<ExtensionAPI["registerProvider"]>[1]) {
        registrations.push({ name, config });
      },
    } as unknown as ExtensionAPI);
    const registration = registrations[0];
    if (!registration) throw new Error("CodeBuddy provider was not registered");
    expect(registration.name).toBe("codebuddy-direct");
    expect(registration.config.api).toBe("codebuddy-direct-chat");

    const model = {
      id: "hy4free",
      name: "Hy4",
      api: "codebuddy-direct-chat",
      provider: "codebuddy-direct",
      baseUrl: "https://copilot.tencent.com/v2",
      reasoning: false,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 960000,
      maxTokens: 64000,
    } as Model;
    const context = {
      messages: [{ role: "user", content: [{ type: "text", text: "Say done" }] }],
    } as Context;

    const events = [];
    const registeredStream = registration.config.streamSimple;
    if (!registeredStream) throw new Error("CodeBuddy provider stream handler was not registered");
    const api = registration.config.api;
    if (!api) throw new Error("CodeBuddy provider API was not registered");
    const sourceId = "codebuddy-provider-test";
    registerCustomApi(api, registeredStream, sourceId);
    try {
      for await (const event of piStreamSimple(model, context, { fetch })) events.push(event);
    } finally {
      unregisterCustomApis(sourceId);
    }

    expect(requestUrl).toBe("https://copilot.tencent.com/v2/chat/completions");
    expect(authorization).toBe(`Bearer ${__testing.readCodeBuddyAccessToken(path)}`);
    expect(requestBody).toMatchObject({ model: "hy4free", stream: true });
    expect(events.some(event => event.type === "text_delta" && event.delta === "done")).toBe(true);
  });
});
