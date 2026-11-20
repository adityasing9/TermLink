import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  DEFAULT_CONFIG,
  TermLinkError,
  validateConfig,
  type TermLinkConfig,
} from '../../../packages/core/src/index';
import { getDefaultStorageDir } from '../../../packages/identity/src/index';

export class ConfigManager {
  private readonly dir: string;
  private readonly filePath: string;

  constructor(baseDir: string = getDefaultStorageDir()) {
    this.dir = baseDir;
    this.filePath = path.join(this.dir, 'config.json');
  }

  load(): TermLinkConfig {
    if (!fs.existsSync(this.filePath)) {
      const defaults: TermLinkConfig = {
        ...DEFAULT_CONFIG,
        deviceName: os.hostname() || DEFAULT_CONFIG.deviceName,
      };
      return defaults;
    }
    try {
      const parsed = JSON.parse(fs.readFileSync(this.filePath, 'utf8')) as Partial<TermLinkConfig>;
      const res = validateConfig(parsed);
      return res.config;
    } catch {
      return { ...DEFAULT_CONFIG, deviceName: os.hostname() || DEFAULT_CONFIG.deviceName };
    }
  }

  save(config: TermLinkConfig): void {
    const res = validateConfig(config);
    if (!res.valid) {
      throw new TermLinkError('INVALID_CONFIG', res.errors.join(' '));
    }
    fs.mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    fs.writeFileSync(this.filePath, JSON.stringify(res.config, null, 2), { mode: 0o600 });
  }

  setKey(key: string, rawValue: string): TermLinkConfig {
    const current = this.load();
    if (!(key in DEFAULT_CONFIG)) {
      throw new TermLinkError(
        'UNKNOWN_CONFIG_KEY',
        `Unknown config key "${key}". Valid keys: ${Object.keys(DEFAULT_CONFIG).join(', ')}`
      );
    }

    const updated: Record<string, unknown> = { ...current };
    const existing = (DEFAULT_CONFIG as unknown as Record<string, unknown>)[key];

    if (typeof existing === 'boolean') {
      if (rawValue !== 'true' && rawValue !== 'false') {
        throw new TermLinkError('INVALID_CONFIG', `Key "${key}" expects true or false.`);
      }
      updated[key] = rawValue === 'true';
    } else if (typeof existing === 'number') {
      const num = Number(rawValue);
      if (!Number.isFinite(num)) {
        throw new TermLinkError('INVALID_CONFIG', `Key "${key}" expects a valid number.`);
      }
      updated[key] = num;
    } else if (Array.isArray(existing)) {
      updated[key] = rawValue.split(',').map((s) => s.trim()).filter(Boolean);
    } else {
      updated[key] = rawValue;
    }

    const res = validateConfig(updated as Partial<TermLinkConfig>);
    if (!res.valid) {
      throw new TermLinkError('INVALID_CONFIG', res.errors.join(' '));
    }
    this.save(res.config);
    return res.config;
  }

  reset(): TermLinkConfig {
    const fresh: TermLinkConfig = {
      ...DEFAULT_CONFIG,
      deviceName: os.hostname() || DEFAULT_CONFIG.deviceName,
    };
    this.save(fresh);
    return fresh;
  }

  getPath(): string {
    return this.filePath;
  }
}
