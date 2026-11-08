import { describe, expect, it } from "vitest";
import { identitiesOf, matchesAll, tagId, tagsFor } from "./entryTags";

const ref = (name) => btoa(`00000000-0000-0000-0000-000000000000@@@default@@@${name}`);
const ids = (tags) => tags.map(tagId);

describe("entry tags", () => {
  it("event type comes from the line text; a line can have several, and anything else is 'other'", () => {
    expect(ids(tagsFor('msg="mcpgw: workload token accepted for key lab-fed issuer=https://x.invalid subject=lab"'))).toContain("type:auth");
    expect(ids(tagsFor(`Principal {RefKind:NonHumanIdentity RefID:${ref("lab")}} has policy based capabilities for {RefKind:Application RefID:${ref("hostile-mcp")}}`))).toContain("type:policy");
    expect(ids(tagsFor("[mcpgw] resolved host for app hostile-mcp: h.invalid:8643"))).toContain("type:routing");
    expect(ids(tagsFor("[mcpfilter] running modifyMCPResponse ct=text/event-stream cl=114 app=hostile-mcp"))).toContain("type:response filter");
    expect(ids(tagsFor("aiguard: content_blocked"))).toContain("type:guardrail");
    expect(ids(tagsFor("something unrelated"))).toEqual(["type:other"]);
  });

  it("match and labels come from what the entry already knows", () => {
    const t = ids(tagsFor("x", { method: "marker", kind: "runtime", from: "Gateway pod log", fields: ["tool", "decision"] }));
    expect(t).toEqual(expect.arrayContaining(["match:this call", "label:from Gateway pod log", "label:runtime event", "label:has tool", "label:has decision"]));
    expect(ids(tagsFor("x", { method: "window" }))).toContain("match:nearby (time window)");
  });

  it("identities: key, subject, user, app and decoded Privilege RefIDs (last segment only)", () => {
    expect(identitiesOf('workload token accepted for key lab-fed issuer=https://x.invalid subject=lab-sub"')).toEqual(["key lab-fed", "subject lab-sub"]);
    expect(identitiesOf("Access token found for user: u-1, client: audit-test")).toEqual(["user u-1", "key audit-test"]);
    expect(identitiesOf(`Success: principal {RefKind:NonHumanIdentity RefID:${ref("privilege-logging-lab")}} has permission for {RefKind:Application RefID:${ref("hostile-mcp")}}`))
      .toEqual(["identity privilege-logging-lab", "app hostile-mcp"]);
    expect(identitiesOf('{"AgentKey":"audit-test","Target":"demo-mcp-app"}')).toEqual(["key audit-test", "app demo-mcp-app"]);
    expect(identitiesOf("RefKind:User RefID:not-base64!!")).toEqual([]);
  });

  it("filter: any selected tag within a group, every group with a selection", () => {
    const auth = tagsFor("Access token found for user: u, client: k", { method: "marker" });
    const pol = tagsFor("has permission for app", { method: "window" });
    expect(matchesAll(auth, new Set())).toBe(true);
    expect(matchesAll(auth, new Set(["type:auth", "type:policy"]))).toBe(true);
    expect(matchesAll(pol, new Set(["type:auth", "type:policy"]))).toBe(true);
    expect(matchesAll(pol, new Set(["type:policy", "match:this call"]))).toBe(false);
    expect(matchesAll(auth, new Set(["type:auth", "match:this call"]))).toBe(true);
  });
});
