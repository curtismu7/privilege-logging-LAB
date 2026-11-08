import { describe, expect, it } from "vitest";
import { caseTags } from "./caseTags";

const base = { id: "x", group: "MCP", path: "happy", request: { method: "tools/call" }, realOnly: false };
const vals = (c) => caseTags(c).map((t) => `${t.group}:${t.value}`);

describe("caseTags", () => {
  it("tags area, expectation, call, credential and status", () => {
    expect(vals(base)).toEqual(["area:MCP", "expect:allowed", "call:tools/call", "credential:agent key", "status:measured"]);
  });
  it("names the credential source", () => {
    expect(vals({ ...base, id: "no-credential" })).toContain("credential:no credential");
    expect(vals({ ...base, mintsToken: true, needsBearer: true })).toContain("credential:lab-minted token");
    expect(vals({ ...base, generatedCredential: "a made-up key" })).toContain("credential:lab makes a bad one");
    expect(vals({ ...base, needsBearer: true })).toContain("credential:you supply it");
    expect(vals({ ...base, consoleAction: true, request: { method: "console action" } }).some((t) => t.startsWith("credential:"))).toBe(false);
  });
  it("maps LLM and A2A calls and the measured status", () => {
    expect(vals({ ...base, request: { method: "POST /llm/<provider>/v1/messages" } })).toContain("call:LLM call");
    expect(vals({ ...base, request: { method: "message/send" } })).toContain("call:A2A message");
    expect(vals({ ...base, path: "failure", realOnly: true })).toEqual(expect.arrayContaining(["expect:refused", "status:not measured"]));
  });
});
