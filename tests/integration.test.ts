// Runs the real `curl` and `databricks` binaries through the processes the
// core manifest declares, as Buzz would. No Databricks profile is used.
import { describe, expect, it } from "vitest";
import { DatabricksCli } from "@dbx/core/cli";
import { curlTransport } from "@dbx/core/curl";
import { nodeHost } from "./node-host";

const host = nodeHost(new URL("../plugins/databricks/manifest.json", import.meta.url).pathname);

describe("curl transport (real curl)", () => {
  const transport = curlTransport(host);
  it("GETs with status and headers", async () => {
    const response = await transport({ url: "https://api.github.com/zen", headers: { "User-Agent": "dbx-buzz-test" } });
    expect(response.status).toBe(200);
    expect(response.headers["content-type"]).toMatch(/text\/plain/);
    expect(response.body.length).toBeGreaterThan(3);
  });
  it("POSTs a JSON body with quotes, backslashes and newlines intact", async () => {
    const body = JSON.stringify({ text: 'he said "hi"\\n\nnext line', emoji: "🧱" });
    const response = await transport({
      url: "https://postman-echo.com/post",
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body,
    });
    expect(response.status).toBe(200);
    expect(JSON.parse(response.body).json).toEqual(JSON.parse(body));
  });
  it("streams the body in chunks", async () => {
    const chunks: string[] = [];
    const response = await transport({ url: "https://postman-echo.com/stream/5", onBody: (chunk) => chunks.push(chunk) });
    expect(response.status).toBe(200);
    expect(chunks.join("")).toBe(response.body);
  });
  it("reports transport failures", async () => {
    await expect(transport({ url: "https://does-not-exist.invalid/" })).rejects.toThrow(/resolve/i);
  });
  it("refuses plain HTTP", async () => {
    await expect(transport({ url: "http://example.com" })).rejects.toThrow(/HTTPS/);
  });
});

describe("Databricks CLI (real binary)", () => {
  const cli = new DatabricksCli(host);
  it("reports its version", async () => {
    expect(await cli.version()).toMatch(/^\d+\.\d+\.\d+$/);
  });
  it("lists profiles without validating them", async () => {
    const profiles = await cli.profiles();
    expect(Array.isArray(profiles)).toBe(true);
    for (const profile of profiles) expect(profile.host).toMatch(/^https:\/\//);
  });
});
