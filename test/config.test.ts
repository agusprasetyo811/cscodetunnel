import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { DEFAULT_CONFIG, loadConfig, saveConfig } from '../src/config';

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cscodetunnel-test-'));
  process.env.CSCDETUNNEL_HOME = tmpDir;
});

afterEach(() => {
  delete process.env.CSCDETUNNEL_HOME;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('config', () => {
  it('returns defaults when no config file exists', () => {
    expect(loadConfig()).toEqual(DEFAULT_CONFIG);
  });

  it('round-trips a saved config', () => {
    saveConfig({ ...DEFAULT_CONFIG, dashboardPort: 5050, openBrowser: false });
    const loaded = loadConfig();
    expect(loaded.dashboardPort).toBe(5050);
    expect(loaded.openBrowser).toBe(false);
  });

  it('falls back to defaults on corrupt JSON', () => {
    fs.mkdirSync(path.join(tmpDir), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, 'config.json'), '{not json', 'utf8');
    expect(loadConfig()).toEqual(DEFAULT_CONFIG);
  });

  it('merges partial configs over defaults', () => {
    fs.mkdirSync(path.join(tmpDir), { recursive: true });
    fs.writeFileSync(
      path.join(tmpDir, 'config.json'),
      JSON.stringify({ dashboardPort: 6060 }),
      'utf8',
    );
    const loaded = loadConfig();
    expect(loaded.dashboardPort).toBe(6060);
    expect(loaded.openBrowser).toBe(DEFAULT_CONFIG.openBrowser);
  });
});
