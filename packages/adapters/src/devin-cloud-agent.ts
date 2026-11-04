import { createHash, randomUUID } from "node:crypto";
import type {
  AdapterContext,
  CloudAgentConversation,
  CloudAgentHandle,
  CloudAgentLaunchRequest,
  CloudAgentProvider,
  CloudAgentReplyRequest,
  CloudAgentSnapshot,
  CloudAgentStatus,
} from "@rakazo/adapter-kit";
import { CloudAgentRequestRejected, CloudAgentRetryLater } from "@rakazo/adapter-kit";
import { z } from "zod";
import { readBodyCapped } from "./web-ssrf.js";

const sessionSchema = z.object({
  session_id: z.string().min(1),
  url: z.string(),
  title: z.string().nullish(),
  status: z.string(),
  status_detail: z.string().nullish(),
  is_archived: z.boolean().optional(),
  tags: z.array(z.string()),
  pull_requests: z.array(z.object({ pr_url: z.string() })).default([]),
});
const messagesSchema = z.object({
  items: z.array(z.object({ source: z.string(), message: z.string(), event_id: z.string() })),
  has_next_page: z.boolean().default(false),
  end_cursor: z.string().nullish(),
});
const sessionsSchema = z.object({
  items: z.array(sessionSchema),
  has_next_page: z.boolean().default(false),
  end_cursor: z.string().nullish(),
});

export interface DevinCloudAgentOptions {
  apiKey: string;
  organizationId: string;
  maxAcuLimit: number;
  fetch?: typeof fetch;
  timeoutMs?: number;
}

/** Scoped launch tags and user-message markers reconcile retries without starting duplicate work. */
export class DevinCloudAgentProvider implements CloudAgentProvider {
  private readonly apiKey: string;
  private readonly organizationId: string;
  private readonly maxAcuLimit: number;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;

  constructor(options: DevinCloudAgentOptions) {
    this.apiKey = options.apiKey.trim();
    this.organizationId = options.organizationId.trim();
    this.maxAcuLimit = options.maxAcuLimit;
    if (!this.apiKey || !/^org-[a-zA-Z0-9-]+$/.test(this.organizationId))
      throw new Error("Cloud agent credentials and organization are required");
    if (!Number.isSafeInteger(this.maxAcuLimit) || this.maxAcuLimit < 1)
      throw new Error("Cloud agent usage limit must be a positive integer");
    this.fetchImpl = options.fetch ?? fetch;
    this.timeoutMs = options.timeoutMs ?? 30_000;
  }

  describe() {
    return {
      id: "devin",
      contractVersion: "1",
      adapterVersion: "0.1.0",
      capabilities: { launch: true, reply: true, cancel: true, offline: false },
    };
  }

  async launch(
    request: CloudAgentLaunchRequest,
    context: AdapterContext,
  ): Promise<CloudAgentHandle> {
    rejectImages(request);
    const signal = request.signal ?? context.signal;
    const existing = await this.findLaunch(request, context, signal);
    if (existing) return { ...this.snapshot(existing), latestRunId: launchToken(request) };
    const token = launchToken(request);
    const prompt = [
      request.repository ? `Work only in this repository: ${request.repository}` : undefined,
      request.openPr === false
        ? "Do not open a pull request."
        : request.openPr === true
          ? "Open a pull request for the changes."
          : undefined,
      "Never merge a pull request.",
      request.prompt,
    ]
      .filter(Boolean)
      .join("\n\n");
    try {
      const session = this.parseSession(
        await this.request(
          "POST",
          "",
          {
            prompt: withRunMarker(prompt, token),
            title: request.prompt.split(/\r?\n/, 1)[0]!.slice(0, 80),
            tags: ["rakazo", scope(context), launchTag(request, context, this.organizationId)],
            max_acu_limit: this.maxAcuLimit,
            secret_ids: [],
            knowledge_ids: [],
            repos: request.repository ? [request.repository] : [],
          },
          signal,
        ),
        undefined,
        context,
      );
      return { ...this.snapshot(session), latestRunId: token };
    } catch (error) {
      if (!(error instanceof DevinConflict)) throw error;
      return this.reconcileLaunch(request, { ...context, signal });
    }
  }

  async reconcileLaunch(request: CloudAgentLaunchRequest, context: AdapterContext) {
    const existing = await this.findLaunch(request, context, request.signal ?? context.signal);
    if (!existing) throw new CloudAgentRetryLater("unavailable");
    return { ...this.snapshot(existing), latestRunId: launchToken(request) };
  }

  private async findLaunch(
    request: CloudAgentLaunchRequest,
    context: AdapterContext,
    signal: AbortSignal,
  ) {
    const tag = launchTag(request, context, this.organizationId);
    const query = new URLSearchParams({ tags: tag, first: "2" });
    const parsed = sessionsSchema.safeParse(
      await this.request("GET", `?${query}`, undefined, signal),
    );
    if (!parsed.success || parsed.data.has_next_page || parsed.data.items.length > 1)
      throw new Error("Invalid cloud agent launch history");
    const [session] = parsed.data.items;
    if (!session) return undefined;
    if (!session.tags.includes(tag)) throw new Error("Invalid cloud agent launch history");
    return this.parseSession(session, undefined, context);
  }

  async get(id: string, context: AdapterContext, runId?: string): Promise<CloudAgentSnapshot> {
    const session = await this.session(id, context);
    const { latestRunId } = await this.messageHistory(id, context.signal);
    // A newly accepted message may not be visible yet. Never finish its run using old metadata.
    if (runId && runId !== latestRunId)
      return { ...this.snapshot(session), status: "running", latestRunId: runId };
    return { ...this.snapshot(session), latestRunId };
  }

  async getConversation(id: string, context: AdapterContext): Promise<CloudAgentConversation> {
    await this.session(id, context);
    return this.messageHistory(id, context.signal);
  }

  async reply(
    id: string,
    request: CloudAgentReplyRequest,
    context: AdapterContext,
  ): Promise<CloudAgentHandle> {
    rejectImages(request);
    const signal = request.signal ?? context.signal;
    const scoped = { ...context, signal };
    const before = await this.session(id, scoped).catch((error) => {
      if (error instanceof CloudAgentRequestRejected || error instanceof CloudAgentRetryLater)
        throw error;
      throw new CloudAgentRetryLater("unavailable");
    });
    if (status(before) === "expired" || status(before) === "cancelled")
      throw new CloudAgentRequestRejected("expired");
    if (status(before) === "running") throw new CloudAgentRetryLater("unavailable");
    const token = randomUUID().replaceAll("-", "");
    const session = this.parseSession(
      await this.request(
        "POST",
        `/${encodeURIComponent(id)}/messages`,
        {
          message: withRunMarker(request.prompt, token),
        },
        signal,
      ),
      id,
      context,
    );
    return { ...this.snapshot(session), status: "running", latestRunId: token };
  }

  async cancel(id: string, context: AdapterContext, runId?: string): Promise<CloudAgentSnapshot> {
    const before = await this.get(id, context);
    if (runId && before.latestRunId !== runId) throw new CloudAgentRetryLater("unavailable");
    if (before.status !== "running") return before;
    await this.request("DELETE", `/${encodeURIComponent(id)}`, undefined, context.signal).catch(
      (error) => {
        if (!(error instanceof DevinConflict)) throw error;
      },
    );
    return this.get(id, context, before.latestRunId);
  }

  private async session(id: string, context: AdapterContext) {
    return this.parseSession(
      await this.request("GET", `/${encodeURIComponent(id)}`, undefined, context.signal),
      id,
      context,
    );
  }

  private parseSession(data: unknown, id: string | undefined, context: AdapterContext) {
    const parsed = sessionSchema.safeParse(data);
    if (!parsed.success || (id && normalizedId(parsed.data.session_id) !== id))
      throw new Error("Invalid cloud agent response");
    if (!parsed.data.tags.includes("rakazo") || !parsed.data.tags.includes(scope(context)))
      throw new CloudAgentRequestRejected("not_found");
    return parsed.data;
  }

  private snapshot(session: z.infer<typeof sessionSchema>): CloudAgentSnapshot {
    const id = normalizedId(session.session_id);
    return {
      id,
      title: session.title || "Cloud agent",
      url: session.url,
      status: status(session),
      ...(session.pull_requests[0] ? { prUrl: session.pull_requests[0].pr_url } : {}),
    };
  }

  private async messageHistory(id: string, signal: AbortSignal): Promise<CloudAgentConversation> {
    let cursor: string | undefined;
    let latest: string | undefined;
    const messages: CloudAgentConversation["messages"] = [];
    let characters = 0;
    let truncated = false;
    for (let page = 0; page < 100; page++) {
      const query = new URLSearchParams({ first: "100" });
      if (cursor) query.set("after", cursor);
      const parsed = messagesSchema.safeParse(
        await this.request(
          "GET",
          `/${encodeURIComponent(id)}/messages?${query}`,
          undefined,
          signal,
        ),
      );
      if (!parsed.success) throw new Error("Invalid cloud agent messages response");
      for (const message of parsed.data.items) {
        if (message.source === "user")
          latest =
            /\n\n\[rakazo-run:([a-f0-9]{32})\]$/.exec(message.message)?.[1] ?? message.event_id;
        if (message.source !== "user" && message.source !== "devin") continue;
        const text =
          message.source === "user"
            ? message.message.replace(/\n\n\[rakazo-run:[a-f0-9]{32}\]$/, "")
            : message.message;
        if (text.length > 40_000) truncated = true;
        const bounded = text.slice(-40_000);
        messages.push({
          id: message.event_id,
          role: message.source === "user" ? "user" : "assistant",
          text: bounded,
        });
        characters += bounded.length;
        while (messages.length > 20 || characters > 40_000) {
          characters -= messages.shift()!.text.length;
          truncated = true;
        }
      }
      if (!parsed.data.has_next_page) {
        if (!latest) throw new Error("Cloud agent message is not visible yet");
        return { messages, latestRunId: latest, truncated };
      }
      if (!parsed.data.end_cursor || parsed.data.end_cursor === cursor)
        throw new Error("Invalid cloud agent messages cursor");
      cursor = parsed.data.end_cursor;
    }
    throw new Error("Cloud agent message history exceeds the inspection limit");
  }

  private async request(
    method: string,
    path: string,
    body: unknown,
    signal: AbortSignal,
  ): Promise<unknown> {
    const boundedSignal = AbortSignal.any([signal, AbortSignal.timeout(this.timeoutMs)]);
    const response = await this.fetchImpl(
      `https://api.devin.ai/v3/organizations/${this.organizationId}/sessions${path}`,
      {
        method,
        redirect: "error",
        signal: boundedSignal,
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          Accept: "application/json",
          ...(body === undefined ? {} : { "Content-Type": "application/json" }),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      },
    );
    if (!response.ok) {
      void response.body?.cancel().catch(() => undefined);
      if (response.status === 404) throw new CloudAgentRequestRejected("not_found");
      if (response.status === 410) throw new CloudAgentRequestRejected("expired");
      if (response.status === 409) throw new DevinConflict();
      if ([400, 422].includes(response.status)) throw new CloudAgentRequestRejected();
      if (response.status === 401 || response.status === 403)
        throw new CloudAgentRetryLater("credential");
      if (response.status === 429) {
        const value = response.headers.get("retry-after");
        const delay = value && /^\d+$/.test(value) ? Number(value) * 1_000 : undefined;
        throw new CloudAgentRetryLater("rate_limited", delay);
      }
      throw new Error(`Cloud agent request failed (${response.status})`);
    }
    const bytes = await readBodyCapped(response, 1_000_000, boundedSignal);
    try {
      return JSON.parse(new TextDecoder().decode(bytes));
    } catch {
      throw new Error("Invalid cloud agent response");
    }
  }
}

class DevinConflict extends Error {}

function status(session: z.infer<typeof sessionSchema>): CloudAgentStatus {
  if (session.is_archived) return "expired";
  if (session.status === "error") return "failed";
  if (session.status_detail === "finished" || session.status_detail === "waiting_for_user")
    return "finished";
  if (session.status === "exit" || session.status_detail === "user_request") return "cancelled";
  if (session.status === "suspended") return "expired";
  return "running";
}

function digest(value: string) {
  return createHash("sha256").update(value).digest("hex");
}
function scope(context: AdapterContext) {
  return `rakazo-scope-${digest(JSON.stringify([context.spaceId, context.userId]))}`;
}
function launchTag(request: CloudAgentLaunchRequest, context: AdapterContext, org: string) {
  return `rakazo-launch-${digest(`${org}:${scope(context)}:${request.idempotencyKey}`).slice(0, 32)}`;
}
function launchToken(request: CloudAgentLaunchRequest) {
  return digest(request.idempotencyKey).slice(0, 32);
}
function normalizedId(value: string) {
  return value.startsWith("devin-") ? value : `devin-${value}`;
}
function withRunMarker(prompt: string, token: string) {
  return `${prompt}\n\n[rakazo-run:${token}]`;
}
function rejectImages(request: { images?: unknown[] }) {
  if (request.images?.length) throw new CloudAgentRequestRejected();
}
