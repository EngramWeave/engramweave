import { serveTaskTools } from '../execution/mcp.js';
import { plannerTools } from './tools.js';
await serveTaskTools('engramweave-planning', plannerTools);
