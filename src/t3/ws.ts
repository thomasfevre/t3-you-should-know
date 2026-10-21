// Stub: reading through the T3 WebSocket RPC is not implemented.
//
// Why: /ws speaks Effect RPC (protocol 2) and needs a bearer/DPoP token or a `?wsTicket=` obtained
// from `POST /api/auth/websocket-ticket`. The sqlite poller (t3/sqlite.ts) gives the same data
// read-only with no credentials, so it is the default reader.
//
// Path to implement it later: issue a bearer with `t3 auth session issue --scope orchestration:read`,
// then use `subscribeThread` over /ws (needs the `ws` package) instead of polling.
export function connectWs(): never {
  throw new Error("WebSocket reader is not implemented; use the sqlite reader (see src/t3/ws.ts)");
}
