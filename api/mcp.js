// Serverless entry point (e.g. Vercel) for the remote MCP connector.
// Deploy the repo and point your MCP client at https://<host>/api/mcp.
import { createHttpHandler } from '../src/mcp.js';

export default createHttpHandler();
