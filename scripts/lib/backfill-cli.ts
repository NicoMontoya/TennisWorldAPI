// Shared CLI helpers for Sackmann backfill scripts.
// Worker target: --worker URL, else WORKER_URL / WORKER env, else localhost.
// Admin secret: ADMIN_SECRET env, else TennisWorldAPI/.dev.vars.

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export const DEFAULT_WORKER = 'http://127.0.0.1:8787';
export const PROD_WORKER = 'https://tennisworld-api.nicomontoya.workers.dev';
export const KV_FREE_WRITES_PER_DAY = 1000;

export function argFlag(argv: string[], flag: string): boolean {
    return argv.includes(flag);
}

export function argValue(argv: string[], flag: string): string | undefined {
    const i = argv.indexOf(flag);
    if (i < 0) return undefined;
    const v = argv[i + 1];
    if (!v || v.startsWith('--')) return undefined;
    return v;
}

export function resolveWorkerUrl(argv: string[] = process.argv.slice(2)): string {
    const raw = (argValue(argv, '--worker') || process.env.WORKER_URL || process.env.WORKER || DEFAULT_WORKER)
        .trim()
        .replace(/\/+$/, '');
    if (!/^https?:\/\//i.test(raw)) {
        console.error(`Invalid worker URL "${raw}". Use --worker https://… or WORKER_URL.`);
        process.exit(1);
    }
    return raw;
}

export function loadAdminSecret(repoDir: string, { required = true } = {}): string {
    const fromEnv = (process.env.ADMIN_SECRET || '').trim();
    if (fromEnv) return fromEnv;

    const varsPath = join(repoDir, '.dev.vars');
    if (existsSync(varsPath)) {
        const m = readFileSync(varsPath, 'utf8').match(/^ADMIN_SECRET\s*=\s*"?([^"\n]+)"?/m);
        if (m?.[1]?.trim()) return m[1].trim();
    }

    if (required) {
        console.error('ADMIN_SECRET not found. Export ADMIN_SECRET or add it to .dev.vars.');
        process.exit(1);
    }
    return '';
}

export function resolveDataDir(repoDir: string, tour: 'ATP' | 'WTA', argv: string[] = process.argv.slice(2)): string {
    const override = argValue(argv, '--data-dir');
    if (override) return override;
    return join(repoDir, '..', tour === 'ATP' ? 'tennis_atp' : 'tennis_wta');
}

export function kvWriteNote(writes: number): string {
    const warn = writes > KV_FREE_WRITES_PER_DAY
        ? `  EXCEEDS Free-tier ${KV_FREE_WRITES_PER_DAY}/day — split with --limit/--offset or wait for the next UTC day.`
        : writes > KV_FREE_WRITES_PER_DAY * 0.8
            ? `  Close to the Free-tier ${KV_FREE_WRITES_PER_DAY}/day ceiling — do not stack other backfills the same day.`
            : `  Free-tier ceiling is ${KV_FREE_WRITES_PER_DAY} writes/day.`;
    return `Estimated KV writes: ${writes}.${warn}`;
}
