import { homedir } from 'node:os';
import { join } from 'node:path';

export function configDir(): string {
  return process.env.TAIGA_LINK_CONFIG_DIR ?? join(homedir(), '.config', 'taiga-link');
}

export function cacheDir(): string {
  return process.env.TAIGA_LINK_CACHE_DIR ?? join(homedir(), '.cache', 'taiga-link');
}
