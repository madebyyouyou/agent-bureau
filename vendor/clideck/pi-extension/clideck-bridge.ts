// CliDeck bridge extension for Pi.
// Pi auto-loads this file from ~/.pi/agent/extensions/.

const env = globalThis.process?.env || {};
const baseUrl = env.CLIDECK_URL || `http://localhost:${env.CLIDECK_PORT || "4000"}`;
const endpoint = `${baseUrl.replace(/\/$/, "")}/hook/pi`;

function safeCall(fn: (() => string | undefined) | undefined): string | undefined {
  try { return fn?.(); } catch { return undefined; }
}

function post(event: any, ctx: any): void {
  const payload = {
    event: event?.type || "",
    reason: event?.reason || "",
    clideck_id: env.CLIDECK_SESSION_ID || "",
    session_id: safeCall(() => ctx.sessionManager.getSessionId()) || "",
    session_file: safeCall(() => ctx.sessionManager.getSessionFile()) || "",
    cwd: ctx?.cwd || "",
  };

  fetch(endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  }).catch(() => {});
}

export default function (pi: any): void {
  pi.on("session_start", (event: any, ctx: any) => post(event, ctx));
  pi.on("session_shutdown", (event: any, ctx: any) => post(event, ctx));
  pi.on("agent_start", (event: any, ctx: any) => post(event, ctx));
  pi.on("agent_end", (event: any, ctx: any) => post(event, ctx));
}
