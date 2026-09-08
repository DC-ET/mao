import type { FastifyRequest } from 'fastify';
import type { SystemSettingService } from '../settings/settings.service.js';
import type { CompanySsoConfig } from './company-sso.config.js';

export type CompanySsoSettings = Pick<SystemSettingService, 'getCompanySsoConfig'>;

// Share even a failed read across CORS and the route. Never reuse a snapshot across requests.
const snapshots = new WeakMap<FastifyRequest, Promise<CompanySsoConfig>>();

export function companySsoConfigForRequest(request: FastifyRequest, settings: CompanySsoSettings): Promise<CompanySsoConfig> {
  let snapshot = snapshots.get(request);
  if (!snapshot) {
    snapshot = settings.getCompanySsoConfig();
    snapshots.set(request, snapshot);
  }
  return snapshot;
}
