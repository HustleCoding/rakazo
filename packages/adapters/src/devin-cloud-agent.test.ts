import type { AdapterContext } from "@rakazo/adapter-kit";
import { CloudAgentRequestRejected, CloudAgentRetryLater } from "@rakazo/adapter-kit";
import { describe, expect, it, vi } from "vitest";
import { cloudAgentsEnabled, createCloudAgentConnection } from "./cloud-agent-factory.js";
import { resolveCloudAgentProvider } from "./cloud-agent-provider-env.js";
import { DevinCloudAgentProvider } from "./devin-cloud-agent.js";

const context: AdapterContext = {
  operationId: "operation",
  traceId: "trace",
  spaceId: "space",
  userId: "user",
  signal: new AbortController().signal,
};

function fixture() {
  let session: Record<string, unknown> | undefined;
  const messages: { source: string; message: string; event_id: string }[] = [];
  let loseCreate = false;
  let loseReply = false;
  let hideNewest = false;
  const writes: { method: string; body: Record<string, unknown> | undefined; url: URL }[] = [];
  const fetchImpl = vi.fn<typeof fetch>(async (input, init) => {
    init?.signal?.throwIfAborted();
    const url = new URL(String(input));
    expect(url.origin).toBe("https://api.devin.ai");
    expect(init?.redirect).toBe("error");
    expect(new Headers(init?.headers).get("authorization")).toBe("Bearer fixture-key");
    const method = init?.method ?? "GET";
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    if (method !== "GET") writes.push({ method, body, url });
    if (method === "GET" && url.pathname.endsWith("/sessions")) {
      const tag = url.searchParams.get("tags");
      return Response.json({
        items:
          session && session.tags instanceof Array && session.tags.includes(tag) ? [session] : [],
        has_next_page: false,
      });
    }
    if (method === "POST" && !url.pathname.endsWith("/messages")) {
      if (session) return Response.json({}, { status: 409 });
      session = {
        session_id: "devin-fixture-assigned-id",
        status: "running",
        status_detail: "working",
        title: body.title,
        tags: body.tags,
        url: "https://app.devin.ai/sessions/fixture",
        pull_requests: [],
      };
      messages.push({ source: "user", message: body.prompt, event_id: "initial" });
      if (loseCreate) throw new Error("Lost create response");
      return Response.json(session);
    }
    if (!session) return Response.json({}, { status: 403 });
    if (method === "GET" && url.pathname.endsWith("/messages")) {
      return Response.json({ items: hideNewest ? messages.slice(0, -1) : messages });
    }
    if (method === "POST") {
      messages.push({
        source: "user",
        message: body.message,
        event_id: `message-${messages.length}`,
      });
      session.status = "running";
      session.status_detail = "working";
      if (loseReply) throw new Error("Lost reply response");
    }
    if (method === "DELETE") {
      session.status = "exit";
      session.status_detail = null;
    }
    return Response.json(session);
  });
  const provider = new DevinCloudAgentProvider({
    apiKey: "fixture-key",
    organizationId: "org-fixture",
    maxAcuLimit: 2,
    fetch: fetchImpl,
  });
  const launch = () =>
    provider.launch({ idempotencyKey: "create", prompt: "Task", openPr: false }, context);
  return {
    provider,
    launch,
    fetchImpl,
    writes,
    messages,
    finish: () => {
      session!.status_detail = "finished";
    },
    change: (patch: Record<string, unknown>) => Object.assign(session!, patch),
    loseCreate: () => {
      loseCreate = true;
    },
    loseReply: () => {
      loseReply = true;
    },
    hideNewest: () => {
      hideNewest = true;
    },
  };
}

describe("cloud agent conformance over the Devin wire fixture (offline)", () => {
  it("replays a launch across adapter instances without duplicate work", async () => {
    const f = fixture();
    const first = await f.launch();
    expect(first.status).toBe("running");
    expect((await f.launch()).id).toBe(first.id);
    const restarted = new DevinCloudAgentProvider({
      apiKey: "fixture-key",
      organizationId: "org-fixture",
      maxAcuLimit: 2,
      fetch: f.fetchImpl,
    });
    expect((await restarted.launch({ idempotencyKey: "create", prompt: "Task" }, context)).id).toBe(
      first.id,
    );
    expect(f.writes).toHaveLength(1);
    expect(f.writes[0]!.body).toMatchObject({
      max_acu_limit: 2,
      secret_ids: [],
      knowledge_ids: [],
      repos: [],
    });
    expect(f.writes[0]!.url.search).toBe("");
    expect((await f.launch()).url).toBe("https://app.devin.ai/sessions/fixture");
    expect(String(f.writes[0]!.body!.prompt)).toContain("Do not open a pull request.");
    expect(JSON.stringify(f.writes[0]!.body)).not.toContain("fixture-key");
  });

  it("recovers an accepted launch whose response was lost", async () => {
    const f = fixture();
    f.loseCreate();
    await expect(f.launch()).rejects.toThrow();
    expect((await f.launch()).status).toBe("running");
    expect(f.writes).toHaveLength(1);
  });

  it("never creates another session while reconciling an ambiguous launch", async () => {
    const f = fixture();
    const request = { idempotencyKey: "create", prompt: "Task", openPr: false };
    await expect(f.provider.reconcileLaunch(request, context)).rejects.toBeInstanceOf(
      CloudAgentRetryLater,
    );
    expect(f.writes).toHaveLength(0);
    f.loseCreate();
    await expect(f.launch()).rejects.toThrow();
    expect((await f.provider.reconcileLaunch(request, context)).id).toBe(
      "devin-fixture-assigned-id",
    );
    expect(f.writes).toHaveLength(1);
  });

  it.each(["duplicate", "truncated", "unscoped", "malformed"])(
    "rejects %s launch history without creating another session",
    async (kind) => {
      const f = fixture();
      await f.launch();
      const tags = f.writes[0]!.body!.tags as string[];
      const session = {
        session_id: "fixture",
        url: "https://app.devin.ai/sessions/fixture",
        status: "running",
        tags: kind === "unscoped" ? tags.filter((tag) => tag.startsWith("rakazo-launch-")) : tags,
      };
      f.fetchImpl.mockResolvedValueOnce(
        Response.json({
          items:
            kind === "malformed" ? null : kind === "duplicate" ? [session, session] : [session],
          has_next_page: kind === "truncated",
        }),
      );
      await expect(f.launch()).rejects.toThrow();
      expect(f.writes).toHaveLength(1);
    },
  );

  it("tracks distinct follow-up runs and reconciles a lost follow-up response", async () => {
    const f = fixture();
    const first = await f.launch();
    f.finish();
    expect((await f.provider.get(first.id, context)).status).toBe("finished");
    const next = await f.provider.reply(first.id, { prompt: "Add tests" }, context);
    expect(next.latestRunId).not.toBe(first.latestRunId);
    expect(await f.provider.get(first.id, context, next.latestRunId)).toMatchObject({
      status: "running",
      latestRunId: next.latestRunId,
    });
    f.finish();
    f.loseReply();
    await expect(f.provider.reply(first.id, { prompt: "Add tests" }, context)).rejects.toThrow();
    const recovered = await f.provider.get(first.id, context);
    expect(recovered.latestRunId).not.toBe(next.latestRunId);
    expect(f.writes).toHaveLength(3);
  });

  it("does not finish a new follow-up from stale session metadata", async () => {
    const f = fixture();
    const first = await f.launch();
    f.finish();
    const next = await f.provider.reply(first.id, { prompt: "Add tests" }, context);
    f.finish();
    f.hideNewest();
    expect((await f.provider.get(first.id, context, next.latestRunId)).status).toBe("running");
    await expect(f.provider.cancel(first.id, context, next.latestRunId)).rejects.toBeInstanceOf(
      CloudAgentRetryLater,
    );
    expect(f.writes.some((write) => write.method === "DELETE")).toBe(false);
  });

  it("observes cancellation and does not cancel a completed turn", async () => {
    const f = fixture();
    const first = await f.launch();
    expect((await f.provider.cancel(first.id, context, first.latestRunId)).status).toBe(
      "cancelled",
    );
    expect((await f.provider.cancel(first.id, context)).status).toBe("cancelled");
    expect(f.writes.filter((write) => write.method === "DELETE")).toHaveLength(1);
  });

  it.each([
    [{ status: "error" }, "failed"],
    [{ is_archived: true }, "expired"],
    [{ status_detail: "waiting_for_user" }, "finished"],
    [{ status_detail: "waiting_for_approval" }, "running"],
    [{ status: "suspended", status_detail: "usage_limit_exceeded" }, "expired"],
    [{ status: "future-status" }, "running"],
  ])("maps provider state %j", async (patch, expected) => {
    const f = fixture();
    const first = await f.launch();
    f.change(patch);
    expect((await f.provider.get(first.id, context)).status).toBe(expected);
  });

  it("fails closed across users and rejects unsupported attachments before I/O", async () => {
    const f = fixture();
    const first = await f.launch();
    await expect(
      f.provider.cancel(first.id, { ...context, userId: "other" }),
    ).rejects.toBeInstanceOf(CloudAgentRequestRejected);
    await expect(
      f.provider.reply(
        first.id,
        { prompt: "Task", images: [{ url: "https://example.com/image.png" }] },
        context,
      ),
    ).rejects.toBeInstanceOf(CloudAgentRequestRejected);
    expect(f.writes).toHaveLength(1);
  });

  it("rejects busy follow-ups before sending a message", async () => {
    const f = fixture();
    const first = await f.launch();
    await expect(f.provider.reply(first.id, { prompt: "Task" }, context)).rejects.toBeInstanceOf(
      CloudAgentRetryLater,
    );
    expect(f.writes).toHaveLength(1);
  });

  it("honors an aborted launch", async () => {
    const f = fixture();
    await expect(
      f.provider.launch(
        { idempotencyKey: "aborted", prompt: "Task", signal: AbortSignal.abort() },
        context,
      ),
    ).rejects.toThrow();
    expect(f.writes).toHaveLength(0);
  });

  it.each([
    [401, CloudAgentRetryLater],
    [403, CloudAgentRetryLater],
    [429, CloudAgentRetryLater],
    [400, CloudAgentRequestRejected],
    [422, CloudAgentRequestRejected],
  ])("handles HTTP %i without exposing response bodies", async (code, ErrorType) => {
    const provider = new DevinCloudAgentProvider({
      apiKey: "fixture-key",
      organizationId: "org-fixture",
      maxAcuLimit: 1,
      fetch: async () =>
        new Response("secret-response", { status: code, headers: { "Retry-After": "7" } }),
    });
    const error = await provider.get("devin-fixture", context).catch((e) => e);
    expect(error).toBeInstanceOf(ErrorType);
    expect(error.message).not.toContain("secret-response");
    if (code === 429) expect(error.retryAfterMs).toBe(7000);
  });
});

describe("Devin cloud agent composition", () => {
  const configured = {
    CLOUD_AGENT_PROVIDER: "devin",
    DEVIN_API_KEY: "fixture-key",
    DEVIN_ORG_ID: "org-fixture",
    CLOUD_AGENT_SPACE_ID: "space",
    DEVIN_MAX_ACU_LIMIT: "2",
  };
  it.each(["DEVIN_API_KEY", "DEVIN_ORG_ID", "CLOUD_AGENT_SPACE_ID", "DEVIN_MAX_ACU_LIMIT"])(
    "fails closed without %s",
    (field) => {
      expect(resolveCloudAgentProvider({ ...configured, [field]: "" })).toBe("none");
    },
  );
  it.each(["-1", "0", "1.5", "NaN", "Infinity"])("rejects invalid limits %s", (limit) => {
    expect(createCloudAgentConnection({ ...configured, DEVIN_MAX_ACU_LIMIT: limit })).toBeNull();
  });
  it("binds the credential and organization and authorizes only one Space", () => {
    const connection = createCloudAgentConnection(configured)!;
    expect(cloudAgentsEnabled(connection, "space")).toBe(true);
    expect(cloudAgentsEnabled(connection, "other-space")).toBe(false);
    expect(connection.key).not.toContain("fixture-key");
    expect(createCloudAgentConnection({ ...configured, DEVIN_API_KEY: "rotated" })!.key).not.toBe(
      connection.key,
    );
    expect(createCloudAgentConnection({ ...configured, DEVIN_ORG_ID: "org-other" })!.key).not.toBe(
      connection.key,
    );
  });
});
