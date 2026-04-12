import { vi, describe, it, expect, beforeEach } from "vitest";

// Must be declared before importing the module under test so vi hoists the mocks
vi.mock("node:os", () => ({ homedir: () => "/home/testuser" }));
vi.mock("node:fs");
vi.mock("node:child_process");

import { existsSync } from "node:fs";
import { execSync } from "node:child_process";

import {
  isKeycloakImageBuilt,
  cloneKeycloakRepo,
  buildKeycloakImage,
  ensureKeycloakImage,
  getKeycloakComposeService,
} from "./keycloak.js";

const mockExistsSync = vi.mocked(existsSync);
const mockExecSync = vi.mocked(execSync);

const DEFAULT_CLONE_PATH = "/home/testuser/code/threatzero/tz-keycloak";

beforeEach(() => {
  vi.resetAllMocks();
});

// ---------------------------------------------------------------------------
// isKeycloakImageBuilt
// ---------------------------------------------------------------------------

describe("isKeycloakImageBuilt", () => {
  it("returns true when docker image inspect succeeds", () => {
    mockExecSync.mockReturnValue(Buffer.from(""));
    expect(isKeycloakImageBuilt()).toBe(true);
  });

  it("returns false when docker image inspect throws", () => {
    mockExecSync.mockImplementation(() => {
      throw new Error("Error: No such image: tz-keycloak:local");
    });
    expect(isKeycloakImageBuilt()).toBe(false);
  });

  it("calls docker image inspect with the correct image name and tag", () => {
    mockExecSync.mockReturnValue(Buffer.from(""));
    isKeycloakImageBuilt();
    expect(mockExecSync).toHaveBeenCalledWith(
      "docker image inspect tz-keycloak:local",
      { stdio: "pipe" }
    );
  });
});

// ---------------------------------------------------------------------------
// cloneKeycloakRepo
// ---------------------------------------------------------------------------

describe("cloneKeycloakRepo", () => {
  it("returns the path immediately when it already exists", () => {
    mockExistsSync.mockReturnValue(true);
    const result = cloneKeycloakRepo();
    expect(result).toBe(DEFAULT_CLONE_PATH);
    expect(mockExecSync).not.toHaveBeenCalled();
  });

  it("uses the default clone path when no argument is provided", () => {
    mockExistsSync.mockReturnValue(true);
    const result = cloneKeycloakRepo();
    expect(result).toBe(DEFAULT_CLONE_PATH);
  });

  it("uses the provided clone path instead of the default", () => {
    mockExistsSync.mockReturnValue(true);
    const customPath = "/tmp/my-keycloak";
    const result = cloneKeycloakRepo(customPath);
    expect(result).toBe(customPath);
  });

  it("checks existsSync against the correct path", () => {
    mockExistsSync.mockReturnValue(true);
    cloneKeycloakRepo();
    expect(mockExistsSync).toHaveBeenCalledWith(DEFAULT_CLONE_PATH);
  });

  it("clones the repo with gh when the path does not exist", () => {
    mockExistsSync.mockReturnValue(false);
    mockExecSync.mockReturnValue(Buffer.from(""));
    cloneKeycloakRepo();
    expect(mockExecSync).toHaveBeenCalledWith(
      expect.stringContaining("gh repo clone threatzero-solutions/tz-keycloak"),
      expect.objectContaining({ stdio: "pipe" })
    );
  });

  it("includes the target path in the gh clone command", () => {
    mockExistsSync.mockReturnValue(false);
    mockExecSync.mockReturnValue(Buffer.from(""));
    cloneKeycloakRepo();
    expect(mockExecSync).toHaveBeenCalledWith(
      expect.stringContaining(`"${DEFAULT_CLONE_PATH}"`),
      expect.objectContaining({ stdio: "pipe" })
    );
  });

  it("returns the default path after a successful clone", () => {
    mockExistsSync.mockReturnValue(false);
    mockExecSync.mockReturnValue(Buffer.from(""));
    const result = cloneKeycloakRepo();
    expect(result).toBe(DEFAULT_CLONE_PATH);
  });

  it("returns a custom path after cloning to it", () => {
    const customPath = "/tmp/my-keycloak";
    mockExistsSync.mockReturnValue(false);
    mockExecSync.mockReturnValue(Buffer.from(""));
    const result = cloneKeycloakRepo(customPath);
    expect(result).toBe(customPath);
  });
});

// ---------------------------------------------------------------------------
// buildKeycloakImage
// ---------------------------------------------------------------------------

describe("buildKeycloakImage", () => {
  it("returns { success: true } when docker build succeeds", () => {
    mockExistsSync.mockReturnValue(true); // repo exists, skip clone
    mockExecSync.mockReturnValue(Buffer.from(""));
    const result = buildKeycloakImage();
    expect(result).toEqual({ success: true });
  });

  it("calls docker build with the correct image name and tag", () => {
    mockExistsSync.mockReturnValue(true);
    mockExecSync.mockReturnValue(Buffer.from(""));
    buildKeycloakImage();
    expect(mockExecSync).toHaveBeenCalledWith(
      "docker build -t tz-keycloak:local .",
      expect.objectContaining({ cwd: DEFAULT_CLONE_PATH })
    );
  });

  it("runs docker build with stdio:pipe and a 300s timeout", () => {
    mockExistsSync.mockReturnValue(true);
    mockExecSync.mockReturnValue(Buffer.from(""));
    buildKeycloakImage();
    expect(mockExecSync).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ stdio: "pipe", timeout: 300_000 })
    );
  });

  it("uses the custom repoPath as the cwd for docker build", () => {
    const customPath = "/tmp/my-keycloak";
    mockExistsSync.mockReturnValue(true);
    mockExecSync.mockReturnValue(Buffer.from(""));
    buildKeycloakImage(customPath);
    expect(mockExecSync).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ cwd: customPath })
    );
  });

  it("returns { success: false, error } when docker build throws an Error", () => {
    mockExistsSync.mockReturnValue(true);
    // First call is the docker image inspect (via cloneKeycloakRepo path), but here
    // existsSync returns true so only one execSync call happens (docker build).
    mockExecSync.mockImplementation(() => {
      throw new Error("build failed: exit status 1");
    });
    const result = buildKeycloakImage();
    expect(result.success).toBe(false);
    expect(result.error).toBe("build failed: exit status 1");
  });

  it("returns 'Unknown error' when docker build throws a non-Error", () => {
    mockExistsSync.mockReturnValue(true);
    mockExecSync.mockImplementation(() => {
      // eslint-disable-next-line @typescript-eslint/only-throw-error
      throw "string error";
    });
    const result = buildKeycloakImage();
    expect(result.success).toBe(false);
    expect(result.error).toBe("Unknown error");
  });

  it("clones the repo first if path does not exist, then builds", () => {
    mockExistsSync.mockReturnValue(false);
    mockExecSync.mockReturnValue(Buffer.from(""));
    buildKeycloakImage();
    // First call: gh repo clone, Second call: docker build
    expect(mockExecSync).toHaveBeenCalledTimes(2);
    expect(mockExecSync.mock.calls[0][0]).toContain("gh repo clone");
    expect(mockExecSync.mock.calls[1][0]).toContain("docker build");
  });
});

// ---------------------------------------------------------------------------
// ensureKeycloakImage
// ---------------------------------------------------------------------------

describe("ensureKeycloakImage", () => {
  it("returns { ready: true } immediately when the image is already built", () => {
    // isKeycloakImageBuilt -> execSync succeeds
    mockExecSync.mockReturnValue(Buffer.from(""));
    const result = ensureKeycloakImage();
    expect(result).toEqual({ ready: true });
  });

  it("does not attempt to build when the image already exists", () => {
    mockExecSync.mockReturnValue(Buffer.from(""));
    ensureKeycloakImage();
    // Only one execSync call: the docker image inspect
    expect(mockExecSync).toHaveBeenCalledTimes(1);
    expect(mockExecSync.mock.calls[0][0]).toContain("docker image inspect");
  });

  it("attempts to build when the image is not found", () => {
    // First call (image inspect) throws; subsequent calls succeed
    mockExistsSync.mockReturnValue(true);
    mockExecSync
      .mockImplementationOnce(() => { throw new Error("No such image"); })
      .mockReturnValue(Buffer.from(""));
    ensureKeycloakImage();
    expect(mockExecSync).toHaveBeenCalledWith(
      "docker build -t tz-keycloak:local .",
      expect.any(Object)
    );
  });

  it("returns { ready: true } when image was not built but build succeeds", () => {
    mockExistsSync.mockReturnValue(true);
    mockExecSync
      .mockImplementationOnce(() => { throw new Error("No such image"); })
      .mockReturnValue(Buffer.from(""));
    const result = ensureKeycloakImage();
    expect(result.ready).toBe(true);
  });

  it("returns { ready: false, error } when image is missing and build fails", () => {
    mockExistsSync.mockReturnValue(true);
    mockExecSync.mockImplementation(() => {
      throw new Error("build failed");
    });
    const result = ensureKeycloakImage();
    expect(result.ready).toBe(false);
    expect(result.error).toBe("build failed");
  });

  it("passes the clonePath through to buildKeycloakImage", () => {
    const customPath = "/tmp/kc";
    mockExistsSync.mockReturnValue(true);
    mockExecSync
      .mockImplementationOnce(() => { throw new Error("No such image"); })
      .mockReturnValue(Buffer.from(""));
    ensureKeycloakImage(customPath);
    expect(mockExecSync).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ cwd: customPath })
    );
  });
});

// ---------------------------------------------------------------------------
// getKeycloakComposeService
// ---------------------------------------------------------------------------

describe("getKeycloakComposeService", () => {
  it("uses tz-keycloak:local as the image", () => {
    const svc = getKeycloakComposeService("jdbc:postgresql://localhost/kc");
    expect(svc.image).toBe("tz-keycloak:local");
  });

  it("uses the default host port 18080 when not specified", () => {
    const svc = getKeycloakComposeService("jdbc:postgresql://localhost/kc");
    expect(svc.ports).toEqual(["18080:8080"]);
  });

  it("uses the provided host port", () => {
    const svc = getKeycloakComposeService("jdbc:postgresql://localhost/kc", 9080);
    expect(svc.ports).toEqual(["9080:8080"]);
  });

  it("sets KC_DB_URL to the provided JDBC URL", () => {
    const jdbcUrl = "jdbc:postgresql://db-host:5432/keycloak";
    const svc = getKeycloakComposeService(jdbcUrl);
    const env = svc.environment as Record<string, string>;
    expect(env.KC_DB_URL).toBe(jdbcUrl);
  });

  it("sets KC_DB to postgres", () => {
    const svc = getKeycloakComposeService("jdbc:postgresql://localhost/kc");
    const env = svc.environment as Record<string, string>;
    expect(env.KC_DB).toBe("postgres");
  });

  it("sets KC_HOSTNAME_STRICT to false", () => {
    const svc = getKeycloakComposeService("jdbc:postgresql://localhost/kc");
    const env = svc.environment as Record<string, string>;
    expect(env.KC_HOSTNAME_STRICT).toBe("false");
  });

  it("sets KC_HTTP_ENABLED to true", () => {
    const svc = getKeycloakComposeService("jdbc:postgresql://localhost/kc");
    const env = svc.environment as Record<string, string>;
    expect(env.KC_HTTP_ENABLED).toBe("true");
  });

  it("sets KC_PROXY_HEADERS to xforwarded", () => {
    const svc = getKeycloakComposeService("jdbc:postgresql://localhost/kc");
    const env = svc.environment as Record<string, string>;
    expect(env.KC_PROXY_HEADERS).toBe("xforwarded");
  });

  it("sets KEYCLOAK_ADMIN to admin", () => {
    const svc = getKeycloakComposeService("jdbc:postgresql://localhost/kc");
    const env = svc.environment as Record<string, string>;
    expect(env.KEYCLOAK_ADMIN).toBe("admin");
  });

  it("sets KEYCLOAK_ADMIN_PASSWORD to admin", () => {
    const svc = getKeycloakComposeService("jdbc:postgresql://localhost/kc");
    const env = svc.environment as Record<string, string>;
    expect(env.KEYCLOAK_ADMIN_PASSWORD).toBe("admin");
  });

  it("includes a healthcheck using tcp socket test on port 8080", () => {
    const svc = getKeycloakComposeService("jdbc:postgresql://localhost/kc");
    const hc = svc.healthcheck as Record<string, unknown>;
    expect(hc.test).toEqual(["CMD-SHELL", "exec 3<>/dev/tcp/localhost/8080"]);
  });

  it("sets healthcheck interval to 5s", () => {
    const svc = getKeycloakComposeService("jdbc:postgresql://localhost/kc");
    const hc = svc.healthcheck as Record<string, unknown>;
    expect(hc.interval).toBe("5s");
  });

  it("sets healthcheck retries to 30", () => {
    const svc = getKeycloakComposeService("jdbc:postgresql://localhost/kc");
    const hc = svc.healthcheck as Record<string, unknown>;
    expect(hc.retries).toBe(30);
  });

  it("sets healthcheck start_period to 30s", () => {
    const svc = getKeycloakComposeService("jdbc:postgresql://localhost/kc");
    const hc = svc.healthcheck as Record<string, unknown>;
    expect(hc.start_period).toBe("30s");
  });

  it("includes the start-dev command", () => {
    const svc = getKeycloakComposeService("jdbc:postgresql://localhost/kc");
    expect(svc.command).toEqual(["start-dev"]);
  });
});
