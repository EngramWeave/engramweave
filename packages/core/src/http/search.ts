import type { FastifyInstance } from 'fastify';
import { API, type SearchQuery } from '@engramweave/contracts';
import { searchDocuments } from '../search/query.js';
import type { CoreServices } from './context.js';

export function registerSearchRoute(server: FastifyInstance, services: () => CoreServices) {
  server.route({ ...API.search, handler(request) { return searchDocuments(services().db, request.query as SearchQuery); } });
}
