import { vi, describe, it, expect, beforeEach, afterEach } from "vitest";
import { getOidcToken } from "./oidc-auth.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeResponse(
  ok: boolean,
  body: unknown,
  status = ok ? 200 : 400,
): Response {
  return {
    ok,
    status,
    json: async () => body,
    text: async () => (typeof body === "string" ? body : JSON.stringify(body)),
  } as unknown as Response;
}

const SUCCESS_BODY = {
  access_token: "at-abc123",
  refresh_token: "rt-xyz789",
  expires_in: 300,
  token_type: "Bearer",
};

const BASE_OPTS = {
  issuerUrl: "https://auth.example.com/realms/myrealm",
  clientId: "my-client",
  username: "alice",
  password: "s3cr3t",
};

// ---------------------------------------------------------------------------
// getOidcToken
// ---------------------------------------------------------------------------

describe("getOidcToken", () => {
  let fetchSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  // ---- URL construction ----

  it("sends the request to <issuerUrl>/protocol/openid-connect/token", async () => {
    fetchSpy.mockResolvedValue(makeResponse(true, SUCCESS_BODY));
    await getOidcToken(BASE_OPTS);
    expect(fetchSpy).toHaveBeenCalledWith(
      "https://auth.example.com/realms/myrealm/protocol/openid-connect/token",
      expect.any(Object),
    );
  });

  // ---- HTTP method & headers ----

  it("uses POST method", async () => {
    fetchSpy.mockResolvedValue(makeResponse(true, SUCCESS_BODY));
    await getOidcToken(BASE_OPTS);
    const [, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(init.method).toBe("POST");
  });

  it("sets Content-Type to application/x-www-form-urlencoded", async () => {
    fetchSpy.mockResolvedValue(makeResponse(true, SUCCESS_BODY));
    await getOidcToken(BASE_OPTS);
    const [, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect((init.headers as Record<string, string>)["Content-Type"]).toBe(
      "application/x-www-form-urlencoded",
    );
  });

  // ---- Request body params ----

  it("includes grant_type=password in the body", async () => {
    fetchSpy.mockResolvedValue(makeResponse(true, SUCCESS_BODY));
    await getOidcToken(BASE_OPTS);
    const [, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    const params = new URLSearchParams(init.body as string);
    expect(params.get("grant_type")).toBe("password");
  });

  it("includes scope=openid in the body", async () => {
    fetchSpy.mockResolvedValue(makeResponse(true, SUCCESS_BODY));
    await getOidcToken(BASE_OPTS);
    const [, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    const params = new URLSearchParams(init.body as string);
    expect(params.get("scope")).toBe("openid");
  });

  it("includes client_id in the body", async () => {
    fetchSpy.mockResolvedValue(makeResponse(true, SUCCESS_BODY));
    await getOidcToken(BASE_OPTS);
    const [, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    const params = new URLSearchParams(init.body as string);
    expect(params.get("client_id")).toBe("my-client");
  });

  it("includes username in the body", async () => {
    fetchSpy.mockResolvedValue(makeResponse(true, SUCCESS_BODY));
    await getOidcToken(BASE_OPTS);
    const [, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    const params = new URLSearchParams(init.body as string);
    expect(params.get("username")).toBe("alice");
  });

  it("includes password in the body", async () => {
    fetchSpy.mockResolvedValue(makeResponse(true, SUCCESS_BODY));
    await getOidcToken(BASE_OPTS);
    const [, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    const params = new URLSearchParams(init.body as string);
    expect(params.get("password")).toBe("s3cr3t");
  });

  it("omits client_secret when not provided", async () => {
    fetchSpy.mockResolvedValue(makeResponse(true, SUCCESS_BODY));
    await getOidcToken(BASE_OPTS);
    const [, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    const params = new URLSearchParams(init.body as string);
    expect(params.has("client_secret")).toBe(false);
  });

  it("includes client_secret in the body when provided", async () => {
    fetchSpy.mockResolvedValue(makeResponse(true, SUCCESS_BODY));
    await getOidcToken({ ...BASE_OPTS, clientSecret: "my-secret" });
    const [, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    const params = new URLSearchParams(init.body as string);
    expect(params.get("client_secret")).toBe("my-secret");
  });

  // ---- Successful response mapping ----

  it("maps snake_case token fields to camelCase on success", async () => {
    fetchSpy.mockResolvedValue(makeResponse(true, SUCCESS_BODY));
    const result = await getOidcToken(BASE_OPTS);
    expect(result).toEqual({
      accessToken: "at-abc123",
      refreshToken: "rt-xyz789",
      expiresIn: 300,
      tokenType: "Bearer",
    });
  });

  it("returns accessToken from the response", async () => {
    fetchSpy.mockResolvedValue(makeResponse(true, SUCCESS_BODY));
    const result = await getOidcToken(BASE_OPTS);
    expect(result.accessToken).toBe("at-abc123");
  });

  it("returns refreshToken from the response", async () => {
    fetchSpy.mockResolvedValue(makeResponse(true, SUCCESS_BODY));
    const result = await getOidcToken(BASE_OPTS);
    expect(result.refreshToken).toBe("rt-xyz789");
  });

  it("returns expiresIn from the response", async () => {
    fetchSpy.mockResolvedValue(makeResponse(true, SUCCESS_BODY));
    const result = await getOidcToken(BASE_OPTS);
    expect(result.expiresIn).toBe(300);
  });

  it("returns tokenType from the response", async () => {
    fetchSpy.mockResolvedValue(makeResponse(true, SUCCESS_BODY));
    const result = await getOidcToken(BASE_OPTS);
    expect(result.tokenType).toBe("Bearer");
  });

  // ---- Error handling ----

  it("throws when the response is not ok", async () => {
    fetchSpy.mockResolvedValue(
      makeResponse(false, "invalid_grant", 401),
    );
    await expect(getOidcToken(BASE_OPTS)).rejects.toThrow(
      "OIDC token request failed (401)",
    );
  });

  it("includes the HTTP status code in the error message", async () => {
    fetchSpy.mockResolvedValue(makeResponse(false, "server error", 500));
    await expect(getOidcToken(BASE_OPTS)).rejects.toThrow("500");
  });

  it("includes the error response body in the error message", async () => {
    fetchSpy.mockResolvedValue(
      makeResponse(false, "invalid_client", 400),
    );
    await expect(getOidcToken(BASE_OPTS)).rejects.toThrow("invalid_client");
  });

  it("propagates fetch network errors", async () => {
    fetchSpy.mockRejectedValue(new Error("fetch failed: ECONNREFUSED"));
    await expect(getOidcToken(BASE_OPTS)).rejects.toThrow(
      "fetch failed: ECONNREFUSED",
    );
  });
});
