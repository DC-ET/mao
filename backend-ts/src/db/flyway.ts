import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import type { AppConfig } from '../config/app-config.js';
import { parseJdbcUrl } from '../config/app-config.js';

/**
 * Dual-run default is flyway.enabled=false so Java remains schema owner.
 * After cutover, enable and invoke the Flyway CLI against the shared SQL files.
 */
export function runFlywayIfEnabled(cfg: AppConfig, cwd = process.cwd()): void {
  if (!cfg.spring.flyway.enabled) {
    return;
  }
  const locations = resolve(cwd, 'db/migration');
  if (!existsSync(locations)) {
    throw new Error(`Flyway locations not found: ${locations}`);
  }
  const jdbc = parseJdbcUrl(cfg.spring.datasource.url);
  const url = `jdbc:mysql://${jdbc.host}:${jdbc.port}/${jdbc.database}`;
  const args = [
    `-url=${url}`,
    `-user=${cfg.spring.datasource.username}`,
    `-password=${cfg.spring.datasource.password}`,
    `-locations=filesystem:${locations}`,
    `-baselineOnMigrate=${cfg.spring.flyway.baselineOnMigrate}`,
    `-baselineVersion=${cfg.spring.flyway.baselineVersion}`,
    `-validateOnMigrate=${cfg.spring.flyway.validateOnMigrate}`,
    'migrate',
  ];
  const result = spawnSync('flyway', args, { stdio: 'inherit', cwd });
  if (result.error || result.status !== 0) {
    throw new Error(`Flyway migrate failed: ${result.error?.message ?? `exit ${result.status}`}`);
  }
}
