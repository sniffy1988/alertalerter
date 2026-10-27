import { shareReplay, switchMap, timer } from 'rxjs';
import prisma from './db';

export type FilterRules = {
    include: string[];
    exclude: string[];
};

export function normalizePhrase(s: string): string {
    return s.toLowerCase().replace(/[’ʼ]/g, "'").trim();
}

async function loadRules(): Promise<FilterRules> {
    const rows = await prisma.filterPhrase.findMany();
    const include: string[] = [];
    const exclude: string[] = [];
    for (const r of rows) {
        const phrase = normalizePhrase(r.phrase);
        if (r.exclude) exclude.push(phrase);
        else include.push(phrase);
    }
    return { include, exclude };
}

export const rules$ = timer(0, 60_000).pipe(
    switchMap(() => loadRules()),
    shareReplay({ bufferSize: 1, refCount: true })
);

export function passesFilter(normalizedText: string, rules: FilterRules): boolean {
    if (rules.include.length === 0) return false;
    return (
        !rules.exclude.some(p => normalizedText.includes(p)) &&
        rules.include.some(p => normalizedText.includes(p))
    );
}
