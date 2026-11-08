// Tags for one case card on the Run page, so the cards can be filtered like boxes on the Demo Shelf. Pure: case in, tags out.
//   area        the case's group (MCP, AI Guard, Keys, ...)
//   expect      what the gateway should do: allow or refuse
//   call        what is sent: tools/call, tools/list, A2A message, LLM call, console action, gateway setting
//   credential  who supplies the credential: agent key, you, the lab (made up or minted), none
//   status      measured (Mock can replay it) or not measured (Real only)
// Tags never depend on a run's result: a run must not change the filter panel, or the cards below it would jump.
// A tag is { group, value } and shares ids and matching with the Trace tags (lib/entryTags.js).

export const CASE_GROUPS = [["area", "Area"], ["expect", "Expected"], ["call", "Call"], ["credential", "Credential"], ["status", "Status"]];

const callOf = (m = "") => (m.startsWith("POST /llm") ? "LLM call" : m === "message/send" ? "A2A message" : m === "any" ? "gateway setting" : m);

function credentialOf(c) {
  if (c.consoleAction) return null;
  if (c.id === "no-credential") return "no credential";
  if (c.mintsToken) return "lab-minted token";
  if (c.generatedCredential) return "lab makes a bad one";
  if (c.needsBearer) return "you supply it";
  return "agent key";
}

export function caseTags(c) {
  const tags = [{ group: "area", value: c.group }, { group: "expect", value: c.path === "happy" ? "allowed" : "refused" }];
  const call = callOf(c.request?.method);
  if (call) tags.push({ group: "call", value: call });
  const cred = credentialOf(c);
  if (cred) tags.push({ group: "credential", value: cred });
  tags.push({ group: "status", value: c.realOnly ? "not measured" : "measured" });
  return tags;
}
