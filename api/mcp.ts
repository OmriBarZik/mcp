import type { IncomingMessage, ServerResponse } from "node:http";
import { handleMcpHttp } from "../src/http/handler.js";

// Vercel Node.js function. `vercel.json` rewrites /mcp here.
// We deliberately never touch `req.body` (Vercel's lazy body parser) — the handler
// reads the raw stream itself so it can enforce the body-size limit.
export default function handler(req: IncomingMessage, res: ServerResponse): Promise<void> {
  return handleMcpHttp(req, res);
}
