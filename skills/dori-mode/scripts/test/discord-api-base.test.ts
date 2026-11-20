import { afterEach, expect, test } from "bun:test";
import { Discord, discordApiBase } from "../src/messenger/discord.ts";
import { fetchHttp, type HttpRequest, MessengerError } from "../src/messenger/http.ts";
import { fakeClock } from "./fakes.ts";

const original = process.env["DORI_DISCORD_API_BASE"];
afterEach(() => {
  if (original === undefined) delete process.env["DORI_DISCORD_API_BASE"];
  else process.env["DORI_DISCORD_API_BASE"] = original;
});

test("an unset override keeps the production endpoint byte for byte", async () => {
  delete process.env["DORI_DISCORD_API_BASE"];
  expect(discordApiBase(undefined)).toBe("https://discord.com/api/v10");
  expect(discordApiBase("")).toBe("https://discord.com/api/v10");
  const requests: HttpRequest[] = [];
  const client = new Discord(
    async (request) => {
      requests.push(request);
      return { status: 200, headers: {}, body: "{}" };
    },
    fakeClock(0),
    "synthetic-base-token",
  );
  await client.call("GET", "/users/@me");
  expect(requests).toHaveLength(1);
  expect(requests[0]?.url).toBe("https://discord.com/api/v10/users/@me");
  expect(requests[0]?.headers?.["Authorization"]).toBe("Bot synthetic-base-token");
});

test("only loopback http origins are accepted", () => {
  for (const value of [
    "http://127.0.0.1:49185",
    "http://localhost:49185",
    "http://[::1]:49185",
    "http://127.0.0.1:49185/v10",
  ]) {
    expect(discordApiBase(value)).toBe(value);
  }
});

test("any other host, scheme or credential is refused", () => {
  for (const value of [
    "https://discord.com/api/v10",
    "https://evil.example",
    "http://127.0.0.1.evil.example",
    "http://example.com:49185",
    "file:///etc/passwd",
    "ftp://127.0.0.1",
    "http://user:pw@127.0.0.1:49185",
    "http://user@127.0.0.1:49185",
    "not a url",
    "//127.0.0.1:49185",
  ]) {
    expect(() => discordApiBase(value)).toThrow(/loopback http origin|not a URL/);
  }
});

for (const value of ["http://fixture-private-marker:secret@127.0.0.1:49185", "not-a-url-fixture-private-marker"]) {
  test(`rejected API base never echoes configured private text (${value.startsWith("http") ? "credentials" : "invalid URL"})`, () => {
    let error: unknown;
    try {
      discordApiBase(value);
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(MessengerError);
    expect((error as Error).message).not.toContain("fixture-private-marker");
  });
}

for (const suffix of ["?query=fixture", "#fixture", "?", "#"]) {
  test(`a REST prefix cannot contain a query or fragment delimiter ${suffix}`, () => {
    expect(() => discordApiBase(`http://127.0.0.1:49185/api/v10${suffix}`)).toThrow(MessengerError);
  });
}

for (const [prefix, expectedPath] of [
  ["", "/users/@me"],
  ["/api/v10", "/api/v10/users/@me"],
  ["/api/v10/", "/api/v10/users/@me"],
] as const) {
  test(`environment API prefix ${prefix || "origin"} reaches the actual loopback HTTP client`, async () => {
    const requests: { path: string; authorization: string | null }[] = [];
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch(request) {
        requests.push({
          path: new URL(request.url).pathname,
          authorization: request.headers.get("Authorization"),
        });
        return Response.json({ ok: true });
      },
    });
    try {
      process.env["DORI_DISCORD_API_BASE"] = `http://127.0.0.1:${server.port}${prefix}`;
      const client = new Discord(fetchHttp, fakeClock(0), "synthetic-loopback-token");
      expect(await client.call("GET", "/users/@me")).toEqual({ ok: true });
      expect(requests).toEqual([{ path: expectedPath, authorization: "Bot synthetic-loopback-token" }]);
    } finally {
      server.stop(true);
    }
  });
}

test("an explicitly injected base remains independent of the environment default", async () => {
  process.env["DORI_DISCORD_API_BASE"] = "invalid-unused-environment";
  const requests: HttpRequest[] = [];
  const client = new Discord(
    async (request) => {
      requests.push(request);
      return { status: 200, headers: {}, body: "{}" };
    },
    fakeClock(0),
    "synthetic-injected-token",
    "http://injected.invalid/base",
  );
  await client.call("GET", "/probe");
  expect(requests[0]?.url).toBe("http://injected.invalid/base/probe");
});
