const { describe, it } = require('node:test');
const assert = require('node:assert');

describe('CLI Player Core Logic', () => {
    describe('renderBar', () => {
        function renderBar(percentagePlayed, columns = 80) {
            percentagePlayed = Number.isFinite(percentagePlayed) ? Math.max(0, Math.min(100, percentagePlayed)) : 0;
            const barWidth = Math.max(10, Math.min(50, columns - 10));
            const playedCharC = Math.round(barWidth * (percentagePlayed) / 100);
            return 'X'.repeat(playedCharC) + '.'.repeat(barWidth - playedCharC);
        }

        it('renders 0% correctly with all dots', () => {
            const bar = renderBar(0, 60);
            assert.strictEqual(bar.length, 50);
            assert.strictEqual(bar, '.'.repeat(50));
        });

        it('renders 100% correctly with all Xs', () => {
            const bar = renderBar(100, 60);
            assert.strictEqual(bar.length, 50);
            assert.strictEqual(bar, 'X'.repeat(50));
        });

        it('renders 50% correctly with half Xs and half dots', () => {
            const bar = renderBar(50, 60);
            assert.strictEqual(bar.length, 50);
            assert.strictEqual(bar, 'X'.repeat(25) + '.'.repeat(25));
        });

        it('clamps negative values to 0%', () => {
            const bar = renderBar(-20, 60);
            assert.strictEqual(bar, '.'.repeat(50));
        });

        it('clamps overflow values (>100) to 100%', () => {
            const bar = renderBar(150, 60);
            assert.strictEqual(bar, 'X'.repeat(50));
        });

        it('falls back to 0% on NaN or non-finite values', () => {
            assert.strictEqual(renderBar(NaN, 60), '.'.repeat(50));
            assert.strictEqual(renderBar(Infinity, 60), '.'.repeat(50));
        });

        it('adapts width dynamically to narrow terminals', () => {
            const bar = renderBar(50, 30);
            assert.strictEqual(bar.length, 20); // 30 - 10
            assert.strictEqual(bar, 'X'.repeat(10) + '.'.repeat(10));
        });
    });

    describe('Duration parsing', () => {
        function parseDuration(output) {
            if (output && output.includes('estimated duration: ')) {
                const raw = output.split('estimated duration: ')[1].split(' sec')[0];
                const num = Number(raw);
                return Number.isFinite(num) ? num : 0;
            }
            return 0;
        }

        it('parses standard fractional afinfo output', () => {
            const out = 'File: song.mp3\n estimated duration: 184.234000 sec\n';
            assert.strictEqual(parseDuration(out), 184.234);
        });

        it('parses integer-only afinfo output without off-by-one', () => {
            const out = 'File: song.wav\n estimated duration: 2.000000 sec\n';
            assert.strictEqual(parseDuration(out), 2);
        });

        it('returns 0 for empty or invalid output', () => {
            assert.strictEqual(parseDuration(''), 0);
            assert.strictEqual(parseDuration('unknown error'), 0);
        });
    });

    describe('Viewport Windowing', () => {
        function getViewport(totalSongs, cursor, maxMenuRows) {
            let start = 0;
            let end = totalSongs;
            if (totalSongs > maxMenuRows) {
                const half = Math.floor(maxMenuRows / 2);
                start = Math.max(0, Math.min(cursor - half, totalSongs - maxMenuRows));
                end = Math.min(totalSongs, start + maxMenuRows);
            }
            return { start, end };
        }

        it('displays full library when under maxMenuRows', () => {
            const { start, end } = getViewport(5, 2, 10);
            assert.strictEqual(start, 0);
            assert.strictEqual(end, 5);
        });

        it('scrolls window to keep cursor centered when library is large', () => {
            const { start, end } = getViewport(50, 25, 10);
            assert.strictEqual(end - start, 10);
            assert.ok(start <= 25 && 25 < end);
        });

        it('clamps start to 0 when near the top of large library', () => {
            const { start, end } = getViewport(50, 1, 10);
            assert.strictEqual(start, 0);
            assert.strictEqual(end, 10);
        });

        it('clamps end to totalSongs when near the bottom of large library', () => {
            const { start, end } = getViewport(50, 48, 10);
            assert.strictEqual(start, 40);
            assert.strictEqual(end, 50);
        });
    });

    describe('Seek Boundaries', () => {
        function calculateSeek(timeElapsed, seconds, totalDuration) {
            const maxLimit = Number.isFinite(totalDuration) && totalDuration > 0 ? totalDuration : Infinity;
            return Math.max(0, Math.min(maxLimit, timeElapsed + seconds));
        }

        it('seeks forward within bounds', () => {
            assert.strictEqual(calculateSeek(10, 5, 100), 15);
        });

        it('seeks backward within bounds', () => {
            assert.strictEqual(calculateSeek(10, -5, 100), 5);
        });

        it('clamps backward seek to zero', () => {
            assert.strictEqual(calculateSeek(3, -5, 100), 0);
        });

        it('clamps forward seek to total duration', () => {
            assert.strictEqual(calculateSeek(98, 5, 100), 100);
        });

        it('handles unknown duration (Infinity) gracefully on forward seek', () => {
            assert.strictEqual(calculateSeek(10, 5, undefined), 15);
        });
    });

    describe('Audio Extension Allowlist', () => {
        const supported = new Set([
            '.mp3', '.m4a', '.aac', '.wav', '.aif', '.aiff',
            '.aifc', '.caf', '.flac', '.ogg', '.oga', '.opus'
        ]);

        function isSupported(ext) {
            return supported.has(ext.toLowerCase());
        }

        it('accepts all valid extensions in lowercase and uppercase', () => {
            for (const ext of supported) {
                assert.ok(isSupported(ext));
                assert.ok(isSupported(ext.toUpperCase()));
            }
        });

        it('rejects unsupported extensions', () => {
            assert.strictEqual(isSupported('.txt'), false);
            assert.strictEqual(isSupported('.mp4'), false);
            assert.strictEqual(isSupported('.json'), false);
            assert.strictEqual(isSupported('.js'), false);
        });
    });
});
