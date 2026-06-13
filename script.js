/**
 * TRUEAUDIO DETECTOR — script.js v3.0
 *
 * What's new vs v2:
 *  ✦ Real Cooley-Tukey Radix-2 FFT (replaces broken OfflineAudioContext+Analyser)
 *  ✦ Multi-window averaged power spectrum with Hann windowing
 *  ✦ Built-in audio playback in every result card
 *  ✦ Waveform / Spectrum toggle per card
 *  ✦ Frequency labels & grid on spectrogram
 *  ✦ Fixed: modal uses .active class (not hidden attribute + inline style)
 *  ✦ Fixed: settings keys now map correctly
 *  ✦ Fixed: convertToMono memory leak eliminated (no stray AudioContext)
 *  ✦ Fixed: fa-average icon replaced
 *  ✦ Pause / Resume queue actually works
 *  ✦ Select All for comparison
 *  ✦ Export CSV + Export JSON
 *  ✦ Five sort modes (cycle)
 *  ✦ Live waveform visualization during recording
 *  ✦ Recording timer
 *  ✦ Hero bar animation
 *  ✦ Service Worker registration
 */

'use strict';

/* ═══════════════════════════════════════════════════════════════
   MAIN CLASS
════════════════════════════════════════════════════════════════ */
class TrueAudioDetector {

    constructor() {
        /* ── Data stores ─────────────────────────────────────── */
        this.queue          = new Map();
        this.processingQueue = new Map();
        this.results        = new Map();
        this.comparisonFiles = new Set();
        this.audioContexts  = new Map();

        /* ── State flags ─────────────────────────────────────── */
        this.isProcessing  = false;
        this.isPaused      = false;
        this.isRecording   = false;
        this.totalFiles    = 0;
        this.processedCount = 0;
        this._sortMode     = 0;

        /* ── Settings (defaults) ─────────────────────────────── */
        this.settings = {
            concurrentLimit: 2,
            fftSize:         4096,
            colorScheme:     'heat'
        };

        /* ── Hann window cache keyed by size ─────────────────── */
        this._hannCache = new Map();

        /* ── Quality tiers ───────────────────────────────────── */
        this.tiers = {
            lossless: { min: 20000, color: 'var(--color-excellent)', label: 'Lossless',      score: 100 },
            hq:       { min: 18500, color: 'var(--color-good)',      label: 'High Quality',  score: 85  },
            moderate: { min: 16000, color: 'var(--color-moderate)',  label: 'Moderate',      score: 60  },
            low:      { min: 14000, color: 'var(--color-bad)',       label: 'Low Quality',   score: 30  },
            fake:     { min: 0,     color: 'var(--color-bad)',       label: 'Fake/Upscaled', score: 10  }
        };

        /* ── Recording state ─────────────────────────────────── */
        this.mediaRecorder   = null;
        this.recordedChunks  = [];
        this.recStartTime    = null;
        this.recTimerInterv  = null;
        this.liveCtx         = null;
        this.liveAnalyser    = null;
        this.liveAnimId      = null;

        this.init();
    }

    /* ──────────────────────────────────────────────────────────
       1. INIT
    ─────────────────────────────────────────────────────────── */
    async init() {
        await this.loadSettings();
        this.initTheme();
        this.setupEventListeners();
        this.initHeroAnimation();
        this.registerServiceWorker();
        console.log('%cSoundnalyze v3.0', 'color:#6366f1;font-weight:bold;');
    }

    /* ──────────────────────────────────────────────────────────
       2. SETTINGS & THEME
    ─────────────────────────────────────────────────────────── */
    async loadSettings() {
        try {
            const s = localStorage.getItem('soundnalyze-v3');
            if (s) this.settings = { ...this.settings, ...JSON.parse(s) };
        } catch (_) {}
    }

    saveSettings() {
        try { localStorage.setItem('soundnalyze-v3', JSON.stringify(this.settings)); } catch (_) {}
    }

    initTheme() {
        const html   = document.documentElement;
        const saved  = localStorage.getItem('trueaudio-theme') || 'dark';
        html.setAttribute('data-theme', saved);
        this.setThemeIcon(saved);

        this.$('theme-toggle').addEventListener('click', () => {
            const next = html.getAttribute('data-theme') === 'dark' ? 'light' : 'dark';
            html.setAttribute('data-theme', next);
            localStorage.setItem('trueaudio-theme', next);
            this.setThemeIcon(next);
        });
    }

    setThemeIcon(theme) {
        const el = this.$('theme-icon');
        if (el) el.className = `fa-solid ${theme === 'dark' ? 'fa-sun' : 'fa-moon'}`;
    }

    /* ──────────────────────────────────────────────────────────
       3. EVENT LISTENERS
    ─────────────────────────────────────────────────────────── */
    setupEventListeners() {
        this.setupDragDrop();
        this.setupFileInput();
        this.setupButtons();
        this.setupModals();
        this.setupKeyboard();
        this.setupResizeObserver();
    }

    setupDragDrop() {
        const dz = this.$('drop-zone');
        if (!dz) return;

        ['dragenter','dragover'].forEach(e =>
            dz.addEventListener(e, ev => {
                ev.preventDefault(); ev.stopPropagation();
                dz.classList.add('drag-over');
            })
        );
        ['dragleave','drop'].forEach(e =>
            dz.addEventListener(e, ev => {
                ev.preventDefault(); ev.stopPropagation();
                dz.classList.remove('drag-over');
                if (e === 'drop') this.handleFiles(ev.dataTransfer.files);
            })
        );
        // Keyboard access for the drop zone
        dz.addEventListener('keydown', ev => {
            if (ev.key === 'Enter' || ev.key === ' ') {
                ev.preventDefault();
                this.$('audio-input').click();
            }
        });
    }

    setupFileInput() {
        const inp = this.$('audio-input');
        if (inp) inp.addEventListener('change', e => {
            this.handleFiles(e.target.files);
            inp.value = '';
        });
    }

    setupButtons() {
        const on = (id, fn) => { const el = this.$(id); if (el) el.addEventListener('click', fn.bind(this)); };
        on('clear-all-btn',   this.clearAllResults);
        on('export-btn',      () => this.exportResults('csv'));
        on('export-json-btn', () => this.exportResults('json'));
        on('sort-btn',        this.cycleSort);
        on('settings-btn',    this.openSettings);
        on('shortcuts-btn',   this.openShortcuts);
        on('record-btn',      this.toggleRecording);
        on('exit-comparison', this.exitComparisonMode);
        on('select-all',      this.selectAllForComparison);
        on('pause-resume',    this.togglePause);
        on('cancel-all',      this.cancelQueue);
    }

    setupModals() {
        /* Settings */
        const sm = this.$('settings-modal');
        if (sm) {
            sm.addEventListener('click', e => { if (e.target === sm) this.closeSettings(); });
            sm.querySelector('.close-modal')?.addEventListener('click', () => this.closeSettings());
        }

        /* Shortcuts */
        const km = this.$('shortcuts-modal');
        if (km) {
            km.addEventListener('click', e => { if (e.target === km) this.closeShortcuts(); });
            km.querySelector('.close-modal')?.addEventListener('click', () => this.closeShortcuts());
        }

        /* Settings selects — map HTML id → settings key, parser */
        const MAP = {
            'concurrent-processing': ['concurrentLimit', v => parseInt(v, 10)],
            'fft-size':              ['fftSize',         v => parseInt(v, 10)],
            'color-scheme':          ['colorScheme',     v => v]
        };
        Object.entries(MAP).forEach(([id, [key, parse]]) => {
            const el = this.$(id);
            if (!el) return;
            el.addEventListener('change', e => {
                this.settings[key] = parse(e.target.value);
                this.saveSettings();
                this.showToast('Setting saved', 'success');
            });
        });
    }

    setupKeyboard() {
        document.addEventListener('keydown', e => {
            if (['INPUT','SELECT','TEXTAREA'].includes(e.target.tagName)) return;

            if ((e.ctrlKey || e.metaKey) && e.key === 'o') { e.preventDefault(); this.$('audio-input')?.click(); }
            if ((e.ctrlKey || e.metaKey) && e.key === 'e') { e.preventDefault(); this.exportResults('csv'); }
            if ((e.ctrlKey || e.metaKey) && e.key === 'd') { e.preventDefault(); this.clearAllResults(); }
            if (e.key === 'Escape') { this.closeSettings(); this.closeShortcuts(); }
            if (e.key === '?')      { this.openShortcuts(); }
        });
    }

    setupResizeObserver() {
        const ro = new ResizeObserver(entries => {
            entries.forEach(entry => {
                if (entry.target.classList.contains('result-card')) {
                    this.redrawCardCanvas(entry.target);
                }
            });
        });
        document.addEventListener('cardAdded', e => {
            if (e.detail?.card) ro.observe(e.detail.card);
        });
    }

    /* ──────────────────────────────────────────────────────────
       4. HERO ANIMATION
    ─────────────────────────────────────────────────────────── */
    initHeroAnimation() {
        const container = document.getElementById('hero-bars');
        if (!container) return;

        const COUNT = 48;
        const baseHeights = [0.15,0.35,0.55,0.75,0.9,0.7,0.5,0.3,0.2,0.45,0.65,0.85];

        for (let i = 0; i < COUNT; i++) {
            const bar = document.createElement('div');
            bar.className = 'hero-bar';
            const lo = baseHeights[i % baseHeights.length];
            const hi = Math.min(1, lo + 0.4 + Math.random() * 0.25);
            bar.style.cssText = `
                --lo: ${lo.toFixed(2)};
                --hi: ${hi.toFixed(2)};
                --dur: ${(1.2 + (i % 7) * 0.18).toFixed(2)}s;
                --delay: ${((i % 12) * 0.09).toFixed(2)}s;
            `;
            container.appendChild(bar);
        }
    }

    /* ──────────────────────────────────────────────────────────
       5. FILE HANDLING & QUEUE
    ─────────────────────────────────────────────────────────── */
    handleFiles(files) {
        const audio = Array.from(files).filter(f => {
            const ok = f.type.startsWith('audio/') ||
                       /\.(mp3|wav|flac|m4a|aac|ogg|opus|webm)$/i.test(f.name);
            if (!ok) this.showToast(`Skipped: ${f.name} (unsupported format)`, 'warning');
            return ok;
        });

        if (!audio.length) return;

        this.totalFiles += audio.length;
        audio.forEach(file => {
            const id = this.uid();
            this.queue.set(id, { id, file, status: 'queued' });
        });

        this.showToast(`${audio.length} file${audio.length > 1 ? 's' : ''} queued`, 'success');
        this.updateResultsHeader();
        this.updateBatchControls();
        this.processQueue();
    }

    async processQueue() {
        if (this.isProcessing || !this.queue.size || this.isPaused) return;
        this.isProcessing = true;

        const batchSize = Math.min(this.settings.concurrentLimit, this.queue.size);
        const batch = Array.from(this.queue.entries())
            .slice(0, batchSize)
            .map(([id, data]) => ({ id, ...data }));

        batch.forEach(item => {
            this.queue.delete(item.id);
            this.processingQueue.set(item.id, item);
            item.card = this.createCardUI(item);
        });

        this.showGlobalLoader();

        await Promise.allSettled(batch.map(item => this.analyzeAudio(item)));

        this.isProcessing = false;

        if (this.queue.size > 0 && !this.isPaused) {
            setTimeout(() => this.processQueue(), 80);
        } else {
            this.updateStatistics();
            if (!this.queue.size && !this.processingQueue.size) this.hideGlobalLoader();
        }
    }

    /* ──────────────────────────────────────────────────────────
       6. AUDIO ANALYSIS PIPELINE
    ─────────────────────────────────────────────────────────── */
    async analyzeAudio(fileData) {
        const { id, file, card } = fileData;
        const t0 = performance.now();

        try {
            this.processingQueue.set(id, { ...fileData, status: 'processing', t0 });
            this.setCardStatus(card, 'processing');

            /* Step 1: Decode compressed audio → PCM
             * FIX: No forced sampleRate — a 48kHz FLAC stays 48kHz.
             * Forcing 44100 caused forced resampling which shifted the
             * spectral cutoff from 24kHz down to ~10.6kHz.               */
            this.addStep(card, 'Membaca file…');
            const arrayBuffer = await file.arrayBuffer();

            this.addStep(card, 'Mendekode audio…');
            const audioCtx = new (window.AudioContext || window.webkitAudioContext)();
            this.audioContexts.set(id, audioCtx);

            let audioBuffer;
            try {
                audioBuffer = await audioCtx.decodeAudioData(arrayBuffer);
            } catch (decErr) {
                throw new Error(`Decode failed: ${decErr.message}`);
            }

            await audioCtx.close();
            this.audioContexts.delete(id);

            const durStr = this.fmtTime(audioBuffer.duration);
            const srKhz  = (audioBuffer.sampleRate / 1000).toFixed(1);
            const chStr  = audioBuffer.numberOfChannels === 1 ? 'Mono' : 'Stereo';
            this.addStep(card, `Decoded: ${durStr} · ${srKhz} kHz · ${chStr}`, 'done');

            /* Step 2: Extract metadata */
            const meta = this.extractMetadata(file, audioBuffer);
            this.updateCardMeta(card, meta);

            /* Step 3: Spectral analysis (pure PCM, no AudioContext) */
            this.addStep(card, `FFT ${this.settings.fftSize}-point · 32 windows…`);
            const analysis = await this.spectralAnalysis(audioBuffer);

            const cutKhz  = (analysis.cutoff.frequency / 1000).toFixed(2);
            const nyqKhz  = (audioBuffer.sampleRate / 2 / 1000).toFixed(1);
            const pct     = ((analysis.cutoff.frequency / (audioBuffer.sampleRate / 2)) * 100).toFixed(1);
            this.addStep(card, `Cutoff spektral: ${cutKhz} kHz / ${nyqKhz} kHz (${pct}%)`, 'done');

            /* Step 4: Quality verdict */
            const verdict = this.evaluateQuality(analysis, audioBuffer.sampleRate);
            this.addStep(card, `Verdict: ${verdict.qualityLabel} — Skor ${verdict.qualityScore}`, 'done');

            const analysisTime = performance.now() - t0;

            const result = { id, fileName: file.name, file, ...meta, ...analysis, ...verdict, analysisTime };
            this.results.set(id, result);

            /* Update UI */
            this.updateCardResults(card, result);
            this.drawSpectrogram(card.querySelector('.mini-spectrogram'), analysis);
            this.attachAudioPlayer(card, file);
            this.attachVizToggle(card, analysis);
            this.setCardStatus(card, 'complete');

            this.processedCount++;
            this.updateGlobalLoader();
            this.processingQueue.delete(id);

        } catch (err) {
            console.error('Analysis failed:', file.name, err);
            this.setCardStatus(card, 'error', err.message);
            this.showToast(`Failed: ${file.name}`, 'error');
            this.processingQueue.delete(id);
            if (this.audioContexts.has(id)) {
                this.audioContexts.get(id).close().catch(() => {});
                this.audioContexts.delete(id);
            }
            this.processedCount++;
            this.updateGlobalLoader();
        }
    }

    extractMetadata(file, buf) {
        const bitrate = Math.round((file.size * 8) / buf.duration / 1000);
        return {
            fileSize:     this.fmtSize(file.size),
            fileSizeRaw:  file.size,
            duration:     this.fmtTime(buf.duration),
            durationRaw:  buf.duration,
            sampleRate:   `${(buf.sampleRate / 1000).toFixed(1)} kHz`,
            sampleRateHz: buf.sampleRate,
            channels:     buf.numberOfChannels,
            channelLabel: buf.numberOfChannels === 1 ? 'Mono' : 'Stereo',
            bitrate,
            format:       file.name.split('.').pop().toUpperCase()
        };
    }

    /* ──────────────────────────────────────────────────────────
       7. REAL FFT ENGINE
    ─────────────────────────────────────────────────────────── */

    /**
     * In-place Cooley-Tukey Radix-2 DIT FFT.
     * n must be a power of 2.
     */
    fft(re, im) {
        const n = re.length;

        /* Bit-reversal permutation */
        for (let i = 1, j = 0; i < n; i++) {
            let bit = n >> 1;
            for (; j & bit; bit >>= 1) j ^= bit;
            j ^= bit;
            if (i < j) {
                let t = re[i]; re[i] = re[j]; re[j] = t;
                    t = im[i]; im[i] = im[j]; im[j] = t;
            }
        }

        /* Butterfly stages */
        for (let len = 2; len <= n; len <<= 1) {
            const half  = len >> 1;
            const theta = -Math.PI / half;          // = -2π / len
            const cosT  = Math.cos(theta);
            const sinT  = Math.sin(theta);

            for (let i = 0; i < n; i += len) {
                let wr = 1.0, wi = 0.0;
                for (let k = 0; k < half; k++) {
                    const ur = re[i+k],      ui = im[i+k];
                    const vr = re[i+k+half]*wr - im[i+k+half]*wi;
                    const vi = re[i+k+half]*wi + im[i+k+half]*wr;
                    re[i+k]       = ur + vr;
                    im[i+k]       = ui + vi;
                    re[i+k+half]  = ur - vr;
                    im[i+k+half]  = ui - vi;
                    const nwr = wr*cosT - wi*sinT;
                    wi = wr*sinT + wi*cosT;
                    wr = nwr;
                }
            }
        }
    }

    hannWindow(n) {
        if (this._hannCache.has(n)) return this._hannCache.get(n);
        const w = new Float32Array(n);
        const k = (2 * Math.PI) / (n - 1);
        for (let i = 0; i < n; i++) w[i] = 0.5 * (1 - Math.cos(k * i));
        this._hannCache.set(n, w);
        return w;
    }

    /** Mix all channels to mono, returning a new Float32Array. */
    toMono(buf) {
        const ch  = buf.numberOfChannels;
        const len = buf.length;
        if (ch === 1) return new Float32Array(buf.getChannelData(0));

        const chans = [];
        for (let c = 0; c < Math.min(ch, 2); c++) chans.push(buf.getChannelData(c));
        const out = new Float32Array(len);
        const inv = 1.0 / chans.length;
        for (let i = 0; i < len; i++) {
            let s = 0;
            for (let c = 0; c < chans.length; c++) s += chans[c][i];
            out[i] = s * inv;
        }
        return out;
    }

    /** Extract a segment from the middle of the audio, skipping silence edges. */
    midSegment(data, sampleRate, maxSecs = 5.0) {
        const maxLen = Math.floor(sampleRate * maxSecs);
        if (data.length <= maxLen) return data;
        const skip   = Math.floor(data.length * 0.05);        // skip first/last 5%
        const usable = data.length - 2 * skip;
        const start  = skip + Math.max(0, Math.floor((usable - maxLen) / 2));
        return data.subarray(start, Math.min(data.length, start + maxLen));
    }

    /**
     * Compute an averaged power spectrum using overlapping Hann windows.
     * Returns dBFS values as Float32Array of length fftSize/2.
     */
    avgSpectrum(data, fftSize) {
        const hop      = fftSize >> 1;
        const binCount = fftSize >> 1;
        const hann     = this.hannWindow(fftSize);
        const accum    = new Float64Array(binCount);
        const re       = new Float32Array(fftSize);
        const im       = new Float32Array(fftSize);
        let   wins     = 0;

        for (let s = 0; s + fftSize <= data.length && wins < 32; s += hop) {
            for (let i = 0; i < fftSize; i++) re[i] = data[s + i] * hann[i];
            im.fill(0);
            this.fft(re, im);
            for (let i = 0; i < binCount; i++) accum[i] += re[i]*re[i] + im[i]*im[i];
            wins++;
        }

        if (!wins) return new Float32Array(binCount).fill(-100);

        const result  = new Float32Array(binCount);
        const norm    = 1.0 / (wins * fftSize * fftSize);
        for (let i = 0; i < binCount; i++) {
            result[i] = 10 * Math.log10(Math.max(1e-15, accum[i] * norm));
        }
        return result;
    }

    /** Downsample audio data to N peak-amplitude points for waveform display. */
    waveformData(data, N = 512) {
        const block = Math.max(1, Math.floor(data.length / N));
        const out   = new Float32Array(N);
        for (let i = 0; i < N; i++) {
            let peak = 0;
            const s  = i * block;
            for (let j = s; j < Math.min(s + block, data.length); j++) {
                const abs = Math.abs(data[j]);
                if (abs > peak) peak = abs;
            }
            out[i] = peak;
        }
        return out;
    }

    async spectralAnalysis(audioBuffer) {
        const { sampleRate } = audioBuffer;
        const fftSize = this.settings.fftSize;

        /* Mono PCM (no new AudioContext!) */
        const mono  = this.toMono(audioBuffer);
        const wform = this.waveformData(mono, 512);

        /* Yield to UI between heavy computation */
        await new Promise(r => setTimeout(r, 0));

        const seg  = this.midSegment(mono, sampleRate, 5.0);
        const freq = this.avgSpectrum(seg, fftSize);

        const cutoff     = this.findCutoff(freq, sampleRate);
        const dynRange   = this.dynRange(freq);
        const hfEnergy   = this.hfEnergy(freq, sampleRate);
        const flatness   = this.spectralFlatness(freq);
        const peaks      = this.spectralPeaks(freq, sampleRate);
        const confidence = this.confidence(freq, cutoff, sampleRate);

        return { cutoff, dynRange, hfEnergy, flatness, peaks, freq, wform, sampleRate, confidence };
    }

    /* ── Analysis primitives ─────────────────────────────────── */

    smooth(arr, r) {
        const out = new Float32Array(arr.length);
        for (let i = 0; i < arr.length; i++) {
            let s = 0, c = 0;
            for (let j = Math.max(0, i-r); j <= Math.min(arr.length-1, i+r); j++) { s += arr[j]; c++; }
            out[i] = s / c;
        }
        return out;
    }

    findCutoff(freq, sampleRate) {
        const nyquist  = sampleRate / 2;
        const totalBin = freq.length;
        const sm       = this.smooth(freq, 6);

        /* FIX: Relative threshold instead of absolute -65 dBFS.
         *
         * The old absolute threshold failed for lossless files because the
         * FFT normalization depressed signal levels by ~27 dB, causing
         * HF content in a 48kHz FLAC (which may be at -50...-80 dBFS
         * naturally) to fall BELOW the hard -65 threshold.
         *
         * Solution: find the peak level in the 200 Hz–10 kHz midrange and
         * set threshold 55 dB below it.
         *   • MP3 content above cutoff drops ≥ 60 dB → detected ✓
         *   • FLAC HF (even quiet) stays within 40 dB → not cut off ✓   */
        const refStart = Math.max(1,              Math.floor(totalBin * 200   / nyquist));
        const refEnd   = Math.min(totalBin - 1,   Math.floor(totalBin * 10000 / nyquist));
        let   refLevel = -Infinity;
        for (let i = refStart; i <= refEnd; i++) {
            if (sm[i] > refLevel) refLevel = sm[i];
        }

        const threshold = refLevel - 55; // relative: 55 dB below midrange peak
        let   last      = 0;
        for (let i = 0; i < totalBin; i++) {
            if (sm[i] > threshold) last = i;
        }

        const hz           = Math.round((last / totalBin) * nyquist);
        const isArtificial = this.detectArtificial(sm, last, totalBin);

        return { frequency: hz, bin: last, isArtificial };
    }

    detectArtificial(sm, cutBin, totalBins) {
        /* FIX: Content in top 14% of spectrum = natural anti-aliasing
         * filter near Nyquist — NOT an artificial upscale cutoff.
         * A 48kHz FLAC rolls off naturally at 22-24kHz; do NOT flag it. */
        if (cutBin > totalBins * 0.86) return false;

        const w = Math.min(50, sm.length - cutBin - 1);
        if (w < 8) return false;

        let slopeSum = 0;
        for (let i = 1; i <= w; i++) slopeSum += sm[cutBin+i] - sm[cutBin+i-1];
        // Very steep drop AND below the Nyquist band = artificial
        return (slopeSum / w) < -2.2;
    }

    dynRange(freq) {
        let max = -Infinity, min = Infinity;
        for (let i = 0; i < freq.length; i++) {
            if (freq[i] > max && freq[i] < 0) max = freq[i];
            if (freq[i] < min) min = freq[i];
        }
        return (isFinite(max) && isFinite(min)) ? Math.abs(max - min) : 0;
    }

    hfEnergy(freq, sampleRate) {
        const nyq   = sampleRate / 2;
        const hfBin = Math.floor((8000 / nyq) * freq.length);
        let total = 0, hf = 0;
        for (let i = 1; i < freq.length; i++) {
            const p = Math.pow(10, freq[i] / 10);
            total  += p;
            if (i >= hfBin) hf += p;
        }
        return total > 0 ? (hf / total) * 100 : 0;
    }

    spectralFlatness(freq) {
        let logS = 0, linS = 0;
        const n = freq.length, eps = 1e-15;
        for (let i = 0; i < n; i++) {
            const p  = Math.pow(10, freq[i] / 10) + eps;
            logS += Math.log(p);
            linS += p;
        }
        const gm = Math.exp(logS / n);
        const am = linS / n;
        return am > 0 ? gm / am : 0;
    }

    spectralPeaks(freq, sampleRate) {
        const nyq   = sampleRate / 2;
        const binHz = nyq / freq.length;
        const w     = 6;
        const peaks = [];

        for (let i = w; i < freq.length - w; i++) {
            let isMax = true;
            for (let j = 1; j <= w && isMax; j++) {
                if (freq[i] <= freq[i-j] || freq[i] <= freq[i+j]) isMax = false;
            }
            if (isMax && freq[i] > -55) {
                peaks.push({ bin: i, frequency: Math.round(i * binHz), magnitude: freq[i] });
            }
        }

        return peaks.sort((a, b) => b.magnitude - a.magnitude).slice(0, 8);
    }

    confidence(freq, cutoff, sampleRate) {
        const nyq   = (sampleRate || 44100) / 2;
        const ratio = cutoff.frequency / nyq;   // 0..1
        let   c     = 100;

        if (this.dynRange(freq) < 20)            c *= 0.80; // low DR → uncertain
        if (cutoff.isArtificial)                  c *= 0.60; // artificial flag
        if (ratio < 0.50)                         c *= 0.70; // very low cutoff
        // Near Nyquist with no artifact flag = high confidence lossless
        if (ratio >= 0.87 && !cutoff.isArtificial) c = Math.max(c, 92);

        return Math.round(Math.min(100, Math.max(0, c)));
    }

    evaluateQuality(analysis, sampleRate) {
        const { cutoff, hfEnergy, flatness, dynRange, confidence } = analysis;
        const hz    = cutoff.frequency;
        const nyq   = sampleRate / 2;

        /* FIX: Use ratio vs Nyquist, not absolute Hz.
         *
         * Old code:  if (hz >= 20000) → lossless
         *   Problem: a 48kHz FLAC has Nyquist = 24000 Hz. Its cutoff
         *            at 22-24kHz is > 20000 Hz BUT scores as lossless —
         *            however after Bug 1+2 destroyed the cutoff reading,
         *            the score became 10. Now we evaluate relative to the
         *            file's actual Nyquist so any sample rate is handled.
         *
         * Thresholds (as fraction of Nyquist):
         *   ≥ 0.90 → Lossless     (FLAC/WAV: 44.1k→≥19.8k, 48k→≥21.6k)
         *   ≥ 0.82 → High Quality (320kbps MP3 ~19k / 44.1k = 0.86)
         *   ≥ 0.70 → Moderate     (192kbps ~17k / 22.05k = 0.77)
         *   ≥ 0.60 → Low Quality  (128kbps ~16k / 22.05k = 0.73)
         *   < 0.60 → Fake/Upscaled                                      */
        const ratio = Math.min(1.0, hz / nyq);
        let tier, score;

        if      (ratio >= 0.90) { tier = this.tiers.lossless; score = 94 + ratio * 6; }
        else if (ratio >= 0.82) { tier = this.tiers.hq;       score = 80 + ((ratio - 0.82) / 0.08) * 14; }
        else if (ratio >= 0.70) { tier = this.tiers.moderate; score = 55 + ((ratio - 0.70) / 0.12) * 25; }
        else if (ratio >= 0.60) { tier = this.tiers.low;      score = 25 + ((ratio - 0.60) / 0.10) * 30; }
        else                    { tier = this.tiers.fake;     score = Math.max(4, (ratio / 0.60) * 25); }

        if (hfEnergy  > 5)             score += 3;
        if (flatness  > 0.8)           score += 2;
        if (dynRange  > 50)            score += 2;
        if (cutoff.isArtificial)       score -= 20; // penalti upscale
        if (ratio >= 0.90 && !cutoff.isArtificial) score = Math.max(score, 93); // floor lossless

        score = Math.min(100, Math.max(0, Math.round(score)));

        return {
            qualityLabel:   tier.label,
            qualityColor:   tier.color,
            qualityScore:   score,
            confidence,
            isUpscaled:     cutoff.isArtificial,
            normalizedFreq: (ratio * 100).toFixed(1)
        };
    }

    /* ──────────────────────────────────────────────────────────
       8. VISUALIZATION
    ─────────────────────────────────────────────────────────── */

    colorFn(scheme) {
        const fns = {
            heat: (pos, t) => {
                if (t < 0.25) {
                    const s = t * 4;
                    return `rgb(${~~(20*s)},0,${~~(50*s)})`;
                } else if (t < 0.5) {
                    const s = (t - 0.25) * 4;
                    return `rgb(${~~(20 + 200*s)},${~~(8*s)},${~~(50+20*s)})`;
                } else if (t < 0.75) {
                    const s = (t - 0.5) * 4;
                    return `rgb(220,${~~(8 + 110*s)},${~~(70-50*s)})`;
                } else {
                    const s = (t - 0.75) * 4;
                    return `rgb(255,${~~(118 + 137*s)},${~~(20 + 160*s)})`;
                }
            },
            rainbow: (pos, t) => `hsla(${(1-pos)*240},88%,${22+t*52}%,${0.15+t*0.85})`,
            ocean: (pos, t) => {
                return `rgb(${~~(t*12)},${~~(40+t*140)},${~~(90+t*165)})`;
            },
            greyscale: (pos, t) => { const v = ~~(255*t); return `rgb(${v},${v},${v})`; }
        };
        return fns[scheme] || fns.heat;
    }

    drawSpectrogram(canvas, analysis) {
        if (!canvas) return;
        const ctx  = canvas.getContext('2d');
        const W    = canvas.width  = canvas.offsetWidth  || canvas.width;
        const H    = canvas.height;
        const data = analysis.freq;
        const sr   = analysis.sampleRate || 44100;
        const nyq  = sr / 2;

        ctx.clearRect(0, 0, W, H);
        ctx.fillStyle = '#000';
        ctx.fillRect(0, 0, W, H);

        const fn   = this.colorFn(this.settings.colorScheme);
        const bw   = W / data.length;
        const dMin = -80, dMax = 0;

        for (let i = 0; i < data.length; i++) {
            const t  = Math.max(0, Math.min(1, (data[i] - dMin) / (dMax - dMin)));
            if (t < 0.012) continue;
            const bh = t * H;
            ctx.fillStyle = fn(i / data.length, t);
            ctx.fillRect(i * bw, H - bh, bw + 0.5, bh);
        }

        /* Frequency grid */
        const gridFreqs = [2000, 4000, 8000, 12000, 16000, 20000].filter(f => f <= nyq);
        ctx.setLineDash([2, 5]);
        ctx.strokeStyle = 'rgba(255,255,255,0.07)';
        ctx.lineWidth   = 1;

        gridFreqs.forEach(hz => {
            const x = (hz / nyq) * W;
            ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, H); ctx.stroke();
            if (H >= 60) {
                ctx.fillStyle   = 'rgba(255,255,255,0.22)';
                ctx.font        = '8px monospace';
                ctx.textAlign   = 'center';
                ctx.setLineDash([]);
                ctx.fillText(hz >= 1000 ? `${hz/1000}k` : hz, x, H - 2);
                ctx.setLineDash([2, 5]);
            }
        });
        ctx.setLineDash([]);

        /* Cutoff line */
        if (analysis.cutoff?.bin) {
            const cx       = (analysis.cutoff.bin / data.length) * W;
            const artif    = analysis.cutoff.isArtificial;
            ctx.strokeStyle = artif ? 'rgba(255,80,80,0.92)' : 'rgba(255,255,255,0.88)';
            ctx.lineWidth   = 1.5;
            ctx.setLineDash([3, 3]);
            ctx.beginPath(); ctx.moveTo(cx, 0); ctx.lineTo(cx, H); ctx.stroke();
            ctx.setLineDash([]);

            if (analysis.cutoff.frequency && H >= 55) {
                const khz    = (analysis.cutoff.frequency / 1000).toFixed(1);
                const labelX = Math.max(14, Math.min(cx, W - 14));
                ctx.fillStyle = artif ? 'rgba(255,120,120,1)' : 'rgba(255,255,255,0.92)';
                ctx.font      = 'bold 8px monospace';
                ctx.textAlign = 'center';
                ctx.fillText(`${khz}k`, labelX, 10);
            }
        }
    }

    drawWaveform(canvas, wform) {
        if (!canvas) return;
        const ctx = canvas.getContext('2d');
        const W   = canvas.width  = canvas.offsetWidth || canvas.width;
        const H   = canvas.height;
        const mid = H / 2;
        const n   = wform.length;

        ctx.clearRect(0, 0, W, H);
        ctx.fillStyle = '#000';
        ctx.fillRect(0, 0, W, H);

        /* Center line */
        ctx.strokeStyle = 'rgba(99,102,241,0.12)';
        ctx.lineWidth   = 1;
        ctx.beginPath(); ctx.moveTo(0, mid); ctx.lineTo(W, mid); ctx.stroke();

        /* Bars */
        const bw   = W / n;
        const grad = ctx.createLinearGradient(0, 0, 0, H);
        grad.addColorStop(0,   'rgba(139,92,246,0.8)');
        grad.addColorStop(0.5, 'rgba(99,102,241,1)');
        grad.addColorStop(1,   'rgba(139,92,246,0.8)');
        ctx.fillStyle = grad;

        for (let i = 0; i < n; i++) {
            const bh = Math.max(1, wform[i] * H * 0.88);
            ctx.fillRect(i * bw, mid - bh * 0.5, Math.max(1, bw - 0.5), bh);
        }
    }

    redrawCardCanvas(card) {
        const canvas  = card.querySelector('.mini-spectrogram');
        const id      = card.dataset.fileId;
        if (!canvas || !id || !this.results.has(id)) return;
        const r    = this.results.get(id);
        const mode = card.querySelector('.viz-btn.active')?.dataset.viz || 'spectrum';
        if (mode === 'waveform') this.drawWaveform(canvas, r.wform);
        else                     this.drawSpectrogram(canvas, r);
    }

    attachVizToggle(card, analysis) {
        card.querySelectorAll('.viz-btn').forEach(btn => {
            btn.addEventListener('click', e => {
                e.stopPropagation();
                card.querySelectorAll('.viz-btn').forEach(b => b.classList.remove('active'));
                btn.classList.add('active');
                const canvas = card.querySelector('.mini-spectrogram');
                if (btn.dataset.viz === 'waveform') this.drawWaveform(canvas, analysis.wform);
                else                                this.drawSpectrogram(canvas, analysis);
            });
        });
    }

    /* ──────────────────────────────────────────────────────────
       9. CARD MANAGEMENT
    ─────────────────────────────────────────────────────────── */
    createCardUI(fileData) {
        const tmpl = document.getElementById('result-card-template');
        const card = tmpl.content.cloneNode(true).querySelector('.result-card');
        card.dataset.fileId = fileData.id;

        const fn = card.querySelector('.filename');
        fn.textContent = fileData.file.name;
        fn.title       = fileData.file.name;
        card.querySelector('.format-tag').textContent = fileData.file.name.split('.').pop().toUpperCase();
        card.querySelector('.size').textContent       = this.fmtSize(fileData.file.size);

        card.querySelector('.remove-btn').onclick  = () => this.removeCard(card);
        card.querySelector('.expand-btn').onclick  = () => this.toggleExpand(card);
        card.querySelector('.compare-btn').onclick = () => this.toggleComparison(card);

        const grid = this.$('results-grid');
        grid.prepend(card);
        this.$('empty-state').style.display = 'none';
        document.dispatchEvent(new CustomEvent('cardAdded', { detail: { card } }));
        return card;
    }

    setCardStatus(card, status, msg = '') {
        const qt = card.querySelector('.quality-tag');
        card.classList.remove('processing', 'error', 'complete');

        if (status === 'processing') {
            qt.textContent = 'Analyzing…';
            qt.style.cssText = 'background:var(--primary);color:#fff;';
            card.classList.add('processing');
        } else if (status === 'error') {
            qt.textContent = 'Error';
            qt.style.cssText = 'background:var(--color-bad);color:#fff;';
            card.classList.add('error');
            if (msg) card.querySelector('.filename').title = msg;
        } else if (status === 'complete') {
            card.classList.add('complete');
        }
    }

    updateCardMeta(card, meta) {
        card.querySelector('.duration').textContent    = meta.duration;
        card.querySelector('.sample-rate').textContent = meta.sampleRate;
        card.querySelector('.bitrate').textContent     = `~${meta.bitrate} kbps`;
        card.querySelector('.bitrate-tag').textContent = `${meta.bitrate} kbps`;
    }

    updateCardResults(card, r) {
        /* Spectral data */
        card.querySelector('.cutoff-freq').textContent   = `${r.cutoff.frequency.toLocaleString()} Hz`;
        card.querySelector('.norm-cutoff').textContent   = `${r.normalizedFreq}%`;
        card.querySelector('.hf-energy').textContent     = `${r.hfEnergy.toFixed(1)}%`;
        card.querySelector('.dynamic-range').textContent = `${r.dynRange.toFixed(1)} dB`;

        /* Quality tag */
        const qt = card.querySelector('.quality-tag');
        qt.textContent = r.qualityLabel;
        qt.style.cssText = `background:${r.qualityColor};color:#fff;`;

        /* Quality bar */
        const fill = card.querySelector('.quality-fill');
        if (fill) { fill.style.width = `${r.qualityScore}%`; fill.style.background = r.qualityColor; }

        /* Score number */
        const sn = card.querySelector('.quality-score-num');
        if (sn) sn.textContent = r.qualityScore;

        /* Upscaled warning */
        if (r.isUpscaled) {
            card.classList.add('upscaled');
            const ub = card.querySelector('.upscaled-badge');
            if (ub) ub.hidden = false;
        }

        /* Color stripe */
        card.style.setProperty('--card-quality-color', r.qualityColor);

        /* Confidence */
        this.updateConfBars(card, r.confidence);

        /* Time */
        const tv = card.querySelector('.time-value');
        if (tv && r.analysisTime) tv.textContent = (r.analysisTime / 1000).toFixed(2);
    }

    updateConfBars(card, conf) {
        card.querySelectorAll('.confidence-bar').forEach((bar, i) => {
            const filled = conf >= (i + 1) * 33;
            bar.classList.toggle('filled', filled);
            bar.style.background = filled
                ? (conf >= 70 ? 'var(--color-good)' : 'var(--color-moderate)')
                : 'var(--bg-hover)';
        });
        const cv = card.querySelector('.conf-value');
        if (cv) cv.textContent = `${conf}%`;
    }

    toggleExpand(card) {
        const exp = card.querySelector('.card-expanded');
        if (!exp) return;
        const opening = exp.hidden;
        exp.hidden = !opening;

        const icon = card.querySelector('.expand-btn i');
        if (icon) icon.className = opening ? 'fa-solid fa-compress' : 'fa-solid fa-expand';

        if (opening) {
            const id = card.dataset.fileId;
            if (id && this.results.has(id)) {
                const result = this.results.get(id);
                const fc = card.querySelector('.full-spectrogram-canvas');
                if (fc) {
                    fc.width = fc.parentElement.clientWidth || 600;
                    this.drawSpectrogram(fc, result);
                }
                this.fillDetailedStats(card, result);
            }
        }
    }

    fillDetailedStats(card, r) {
        const c = card.querySelector('.detailed-stats');
        if (!c) return;
        const items = [
            ['Channels',        r.channelLabel || '—'],
            ['Spectral Flat.',  r.flatness?.toFixed(5) || '—'],
            ['Peak Count',      r.peaks?.length ?? 0],
            ['Upscaled?',       r.isUpscaled ? '⚠ Yes' : '✓ No'],
            ...(r.peaks?.length ? [['Top Peak', `${(r.peaks[0].frequency/1000).toFixed(2)} kHz`]] : [])
        ];
        c.innerHTML = items.map(([l, v]) =>
            `<div class="detail-stat"><span class="detail-label">${l}</span><span class="detail-value">${v}</span></div>`
        ).join('');
    }

    toggleComparison(card) {
        const id = card.dataset.fileId;
        if (!id) return;
        if (this.comparisonFiles.has(id)) {
            this.comparisonFiles.delete(id);
            card.classList.remove('in-comparison');
        } else {
            this.comparisonFiles.add(id);
            card.classList.add('in-comparison');
        }
        this.updateComparison();
    }

    selectAllForComparison() {
        const allSel = this.comparisonFiles.size >= this.results.size;
        this.comparisonFiles.clear();
        document.querySelectorAll('.result-card').forEach(c => c.classList.remove('in-comparison'));

        if (!allSel) {
            this.results.forEach((_, id) => this.comparisonFiles.add(id));
            document.querySelectorAll('.result-card[data-file-id]').forEach(c => {
                if (this.results.has(c.dataset.fileId)) c.classList.add('in-comparison');
            });
        }
        this.updateComparison();
    }

    /* ──────────────────────────────────────────────────────────
       10. AUDIO PLAYER
    ─────────────────────────────────────────────────────────── */
    attachAudioPlayer(card, file) {
        const playBtn  = card.querySelector('.player-play-btn');
        const track    = card.querySelector('.player-track');
        const progress = card.querySelector('.player-progress');
        const timeEl   = card.querySelector('.player-time');
        if (!playBtn) return;

        const audio    = new Audio(URL.createObjectURL(file));
        card._audio    = audio;
        card._audioURL = audio.src;

        playBtn.addEventListener('click', e => {
            e.stopPropagation();
            if (audio.paused) {
                /* Stop all other players */
                document.querySelectorAll('.result-card').forEach(c => {
                    if (c !== card && c._audio && !c._audio.paused) {
                        c._audio.pause();
                        const ic = c.querySelector('.player-play-btn i');
                        if (ic) ic.className = 'fa-solid fa-play';
                    }
                });
                audio.play().catch(() => this.showToast('Playback failed', 'error'));
                playBtn.querySelector('i').className = 'fa-solid fa-pause';
            } else {
                audio.pause();
                playBtn.querySelector('i').className = 'fa-solid fa-play';
            }
        });

        audio.addEventListener('timeupdate', () => {
            if (!audio.duration) return;
            const pct = (audio.currentTime / audio.duration) * 100;
            if (progress) progress.style.width = `${pct}%`;
            if (timeEl)   timeEl.textContent    = this.fmtTime(audio.currentTime);
        });

        audio.addEventListener('ended', () => {
            playBtn.querySelector('i').className = 'fa-solid fa-play';
            if (progress) progress.style.width   = '0%';
            if (timeEl)   timeEl.textContent      = '0:00';
        });

        if (track) {
            track.addEventListener('click', e => {
                if (!audio.duration) return;
                const rect  = track.getBoundingClientRect();
                audio.currentTime = ((e.clientX - rect.left) / rect.width) * audio.duration;
            });
        }
    }

    /* ──────────────────────────────────────────────────────────
       11. BATCH CONTROLS
    ─────────────────────────────────────────────────────────── */
    updateBatchControls() {
        const ctrl  = this.$('batch-controls');
        const cnt   = this.$('batch-count');
        const total = this.queue.size + this.processingQueue.size;
        if (ctrl) ctrl.style.display = total > 0 ? 'flex' : 'none';
        if (cnt)  cnt.textContent    = `${total} file${total !== 1 ? 's' : ''} in queue`;
    }

    updateResultsHeader() {
        const h   = this.$('results-header');
        const cnt = this.$('results-count');
        const n   = this.results.size;
        if (h)   h.style.display = n > 0 ? 'flex' : 'none';
        if (cnt) cnt.textContent = `(${n})`;
    }

    showGlobalLoader() {
        this.$('global-loader')?.classList.remove('hidden');
    }

    updateGlobalLoader() {
        const fill = this.$('global-progress-fill');
        const cnt  = this.$('loader-count');
        const cur  = this.$('current-file');
        const pct  = this.totalFiles > 0 ? (this.processedCount / this.totalFiles) * 100 : 0;

        if (fill) { fill.style.width = `${pct}%`; fill.setAttribute('aria-valuenow', pct); }
        if (cnt)  cnt.textContent = `${this.processedCount} / ${this.totalFiles}`;

        const inProc = Array.from(this.processingQueue.values());
        if (cur && inProc.length) cur.textContent = inProc[0].file?.name || '—';
    }

    hideGlobalLoader() {
        this.$('global-loader')?.classList.add('hidden');
        this.processedCount = 0;
        this.totalFiles     = 0;
    }

    togglePause() {
        this.isPaused = !this.isPaused;
        const btn = this.$('pause-resume');
        if (!btn) return;
        if (this.isPaused) {
            btn.innerHTML = '<i class="fa-solid fa-play"></i> Resume';
            this.showToast('Processing paused', 'info');
        } else {
            btn.innerHTML = '<i class="fa-solid fa-pause"></i> Pause';
            this.showToast('Processing resumed', 'success');
            this.processQueue();
        }
    }

    cancelQueue() {
        const n = this.queue.size;
        this.queue.clear();
        this.updateBatchControls();
        this.showToast(`${n} pending file${n !== 1 ? 's' : ''} cancelled`, 'warning');
    }

    /* ──────────────────────────────────────────────────────────
       12. COMPARISON
    ─────────────────────────────────────────────────────────── */
    updateComparison() {
        const sec   = this.$('comparison-mode');
        if (!sec) return;
        const n     = this.comparisonFiles.size;
        const badge = sec.querySelector('.badge');
        if (badge) badge.textContent = `${n} file${n !== 1 ? 's' : ''} selected`;

        if (n >= 2) {
            sec.style.display = 'block';
            this.drawComparisonChart();
        } else {
            sec.style.display = 'none';
        }
    }

    drawComparisonChart() {
        const canvas = this.$('comparison-chart');
        if (!canvas) return;

        const files = Array.from(this.comparisonFiles)
            .map(id => this.results.get(id)).filter(Boolean);
        if (!files.length) return;

        const ctx  = canvas.getContext('2d');
        const W    = canvas.width  = canvas.offsetWidth || 800;
        const H    = canvas.height;

        ctx.clearRect(0, 0, W, H);
        ctx.fillStyle = '#000';
        ctx.fillRect(0, 0, W, H);

        const cats   = ['Cutoff %', 'Dyn. Range', 'HF Energy', 'Quality'];
        const colors = ['#6366f1','#10b981','#f59e0b','#ef4444','#8b5cf6','#ec4899'];
        const padL   = 50, padB = 40, padT = 30, padR = 20;
        const chartW = W - padL - padR;
        const chartH = H - padT - padB;
        const groupW = chartW / cats.length;
        const barW   = Math.min(36, groupW / (files.length + 0.5));

        /* Axes */
        ctx.strokeStyle = 'rgba(255,255,255,0.15)';
        ctx.lineWidth   = 1;
        ctx.beginPath();
        ctx.moveTo(padL, padT); ctx.lineTo(padL, H - padB);
        ctx.lineTo(W - padR, H - padB);
        ctx.stroke();

        /* Y grid */
        [25, 50, 75, 100].forEach(pct => {
            const y = H - padB - (pct / 100) * chartH;
            ctx.strokeStyle = 'rgba(255,255,255,0.06)';
            ctx.setLineDash([3, 5]);
            ctx.beginPath(); ctx.moveTo(padL, y); ctx.lineTo(W - padR, y); ctx.stroke();
            ctx.setLineDash([]);
            ctx.fillStyle  = 'rgba(255,255,255,0.3)';
            ctx.font       = '9px monospace';
            ctx.textAlign  = 'right';
            ctx.fillText(`${pct}`, padL - 6, y + 3);
        });

        /* Category labels */
        ctx.fillStyle = 'rgba(255,255,255,0.5)';
        ctx.font      = '10px system-ui, sans-serif';
        ctx.textAlign = 'center';
        cats.forEach((cat, ci) => {
            ctx.fillText(cat, padL + ci * groupW + groupW / 2, H - padB + 16);
        });

        /* Bars */
        files.forEach((file, fi) => {
            const nyq    = file.sampleRateHz / 2 || 22050;
            const values = [
                Math.min(100, (file.cutoff.frequency / nyq) * 100),
                Math.min(100, file.dynRange || 0),
                Math.min(100, (file.hfEnergy || 0) * 3),
                file.qualityScore
            ];

            values.forEach((val, ci) => {
                const bh  = (val / 100) * chartH;
                const x   = padL + ci * groupW + (fi + 0.5) * barW + (groupW - files.length * barW) / 2;
                const y   = H - padB - bh;

                ctx.fillStyle   = colors[fi % colors.length];
                ctx.globalAlpha = 0.88;
                ctx.fillRect(x, y, barW - 2, bh);
                ctx.globalAlpha = 1;

                ctx.fillStyle = 'rgba(255,255,255,0.7)';
                ctx.font      = '8px monospace';
                ctx.textAlign = 'center';
                ctx.fillText(`${Math.round(val)}`, x + barW / 2 - 1, y - 3);
            });
        });

        /* Legend */
        files.forEach((file, fi) => {
            const lx = padL + fi * 150;
            if (lx < W - 40) {
                ctx.fillStyle = colors[fi % colors.length];
                ctx.fillRect(lx, 8, 11, 11);
                ctx.fillStyle = 'rgba(255,255,255,0.65)';
                ctx.font      = '10px system-ui';
                ctx.textAlign = 'left';
                const name    = file.fileName.length > 16 ? file.fileName.slice(0, 16) + '…' : file.fileName;
                ctx.fillText(name, lx + 15, 18);
            }
        });
    }

    exitComparisonMode() {
        this.comparisonFiles.clear();
        document.querySelectorAll('.in-comparison').forEach(c => c.classList.remove('in-comparison'));
        const sec = this.$('comparison-mode');
        if (sec) sec.style.display = 'none';
    }

    /* ──────────────────────────────────────────────────────────
       13. EXPORT & SORT
    ─────────────────────────────────────────────────────────── */
    exportResults(fmt = 'csv') {
        if (!this.results.size) { this.showToast('No results to export', 'warning'); return; }

        const content = fmt === 'json' ? this.toJSON() : this.toCSV();
        const mime    = fmt === 'json' ? 'application/json' : 'text/csv';
        const blob    = new Blob([content], { type: mime + ';charset=utf-8;' });
        const url     = URL.createObjectURL(blob);
        const a       = Object.assign(document.createElement('a'), {
            href:     url,
            download: `trueaudio-${new Date().toISOString().slice(0,10)}.${fmt}`
        });
        document.body.appendChild(a); a.click(); a.remove();
        URL.revokeObjectURL(url);
        this.showToast(`Exported as ${fmt.toUpperCase()}`, 'success');
    }

    toCSV() {
        const hdrs = ['Filename','Format','Size','Duration','Sample Rate (kHz)',
            'Bitrate (kbps)','Cutoff (Hz)','Spectrum (%)','HF Energy (%)','Dynamic Range (dB)',
            'Quality Score','Quality Label','Is Upscaled','Confidence (%)','Analysis Time (s)'];
        const rows = Array.from(this.results.values()).map(r => [
            `"${r.fileName}"`, r.format, r.fileSize, r.duration,
            r.sampleRateHz ? (r.sampleRateHz/1000).toFixed(1) : '—',
            r.bitrate, r.cutoff?.frequency || '—', r.normalizedFreq,
            r.hfEnergy?.toFixed(2) || '—', r.dynRange?.toFixed(2) || '—',
            r.qualityScore, `"${r.qualityLabel}"`,
            r.isUpscaled ? 'Yes' : 'No', r.confidence,
            (r.analysisTime / 1000).toFixed(2)
        ]);
        return [hdrs, ...rows].map(row => row.join(',')).join('\n');
    }

    toJSON() {
        const data = Array.from(this.results.values()).map(r => ({
            fileName:       r.fileName,
            format:         r.format,
            fileSize:       r.fileSize,
            duration:       r.duration,
            sampleRate:     r.sampleRate,
            channels:       r.channelLabel,
            bitrateKbps:    r.bitrate,
            cutoffHz:       r.cutoff?.frequency,
            spectrumPct:    parseFloat(r.normalizedFreq),
            hfEnergyPct:    parseFloat(r.hfEnergy?.toFixed(2)),
            dynamicRangeDb: parseFloat(r.dynRange?.toFixed(2)),
            spectralFlat:   parseFloat(r.flatness?.toFixed(6)),
            qualityScore:   r.qualityScore,
            qualityLabel:   r.qualityLabel,
            isUpscaled:     r.isUpscaled,
            confidence:     r.confidence,
            analysisMs:     parseFloat(r.analysisTime?.toFixed(1))
        }));
        return JSON.stringify({ exportedAt: new Date().toISOString(), count: data.length, files: data }, null, 2);
    }

    cycleSort() {
        const modes = [
            { label: 'Quality ↓',  fn: (a,b) => b.qualityScore  - a.qualityScore  },
            { label: 'Quality ↑',  fn: (a,b) => a.qualityScore  - b.qualityScore  },
            { label: 'Name A→Z',   fn: (a,b) => a.fileName.localeCompare(b.fileName) },
            { label: 'Size ↓',     fn: (a,b) => b.fileSizeRaw   - a.fileSizeRaw   },
            { label: 'Cutoff ↓',   fn: (a,b) => (b.cutoff?.frequency||0) - (a.cutoff?.frequency||0) }
        ];
        this._sortMode = (this._sortMode + 1) % modes.length;
        const mode = modes[this._sortMode];
        const grid = this.$('results-grid');
        Array.from(grid.children)
            .sort((a, b) => {
                const ra = this.results.get(a.dataset.fileId);
                const rb = this.results.get(b.dataset.fileId);
                return (ra && rb) ? mode.fn(ra, rb) : 0;
            })
            .forEach(c => grid.appendChild(c));

        const lbl = document.querySelector('.sort-label');
        if (lbl) lbl.textContent = mode.label;
        this.showToast(`Sorted: ${mode.label}`, 'info');
    }

    /* ──────────────────────────────────────────────────────────
       14. RECORDING
    ─────────────────────────────────────────────────────────── */
    async toggleRecording() {
        if (!this.isRecording) await this.startRecording();
        else                        this.stopRecording();
    }

    async startRecording() {
        try {
            const stream = await navigator.mediaDevices.getUserMedia({
                audio: { channelCount: 2, sampleRate: 44100, echoCancellation: false, noiseSuppression: false, autoGainControl: false }
            });

            const mime = MediaRecorder.isTypeSupported('audio/webm;codecs=opus')
                ? 'audio/webm;codecs=opus' : 'audio/webm';
            this.mediaRecorder   = new MediaRecorder(stream, { mimeType: mime });
            this.recordedChunks  = [];

            this.mediaRecorder.ondataavailable = e => { if (e.data.size > 0) this.recordedChunks.push(e.data); };
            this.mediaRecorder.onstop = () => {
                const blob = new Blob(this.recordedChunks, { type: 'audio/webm' });
                const file = new File([blob], `recording-${Date.now()}.webm`, { type: 'audio/webm' });
                this.handleFiles([file]);
                stream.getTracks().forEach(t => t.stop());
                this.stopLiveWaveform();
            };

            this.mediaRecorder.start(500);
            this.isRecording  = true;
            this.recStartTime = Date.now();

            this.setRecordBtnState(true);
            this.showRecordingOverlay(true);
            this.startRecordingTimer();
            this.startLiveWaveform(stream);
            this.showToast('Recording… tap Stop when done', 'info');

        } catch (err) {
            console.error('Recording error:', err);
            this.showToast('Microphone access denied', 'error');
        }
    }

    stopRecording() {
        if (this.mediaRecorder && this.isRecording) {
            this.mediaRecorder.stop();
            this.isRecording = false;
            this.setRecordBtnState(false);
            this.showRecordingOverlay(false);
            this.stopRecordingTimer();
            this.showToast('Recording stopped — analyzing…', 'success');
        }
    }

    setRecordBtnState(on) {
        const btn = this.$('record-btn');
        if (!btn) return;
        btn.innerHTML = on
            ? '<i class="fa-solid fa-stop"></i> Stop Recording'
            : '<i class="fa-solid fa-microphone"></i> Record Audio';
        btn.classList.toggle('recording', on);
    }

    showRecordingOverlay(show) {
        const idle = this.$('upload-idle');
        const overlay = this.$('recording-overlay');
        if (idle)    idle.hidden    = show;
        if (overlay) overlay.hidden = !show;
    }

    startRecordingTimer() {
        const el = this.$('recording-timer');
        this.recTimerInterv = setInterval(() => {
            if (el) el.textContent = this.fmtTime((Date.now() - this.recStartTime) / 1000);
        }, 1000);
    }

    stopRecordingTimer() {
        clearInterval(this.recTimerInterv);
        const el = this.$('recording-timer');
        if (el) el.textContent = '0:00';
    }

    startLiveWaveform(stream) {
        const canvas = this.$('recording-waveform');
        if (!canvas) return;

        const Ctx         = window.AudioContext || window.webkitAudioContext;
        this.liveCtx      = new Ctx();
        const src         = this.liveCtx.createMediaStreamSource(stream);
        this.liveAnalyser = this.liveCtx.createAnalyser();
        this.liveAnalyser.fftSize              = 1024;
        this.liveAnalyser.smoothingTimeConstant = 0.8;
        src.connect(this.liveAnalyser);

        const data = new Uint8Array(this.liveAnalyser.frequencyBinCount);

        const draw = () => {
            if (!this.isRecording) return;
            this.liveAnimId = requestAnimationFrame(draw);
            this.liveAnalyser.getByteTimeDomainData(data);

            const ctx = canvas.getContext('2d');
            const W   = canvas.width  = canvas.offsetWidth || 480;
            const H   = canvas.height;

            ctx.fillStyle = '#000';
            ctx.fillRect(0, 0, W, H);

            ctx.strokeStyle = '#6366f1';
            ctx.lineWidth   = 1.8;
            ctx.beginPath();

            const sw = W / data.length;
            for (let i = 0; i < data.length; i++) {
                const y = (data[i] / 128.0) * (H / 2);
                i === 0 ? ctx.moveTo(0, y) : ctx.lineTo(i * sw, y);
            }
            ctx.lineTo(W, H / 2);
            ctx.stroke();
        };
        draw();
    }

    stopLiveWaveform() {
        if (this.liveAnimId)  cancelAnimationFrame(this.liveAnimId);
        if (this.liveCtx)     this.liveCtx.close().catch(() => {});
        this.liveCtx      = null;
        this.liveAnalyser = null;
        this.liveAnimId   = null;
    }

    /* ──────────────────────────────────────────────────────────
       15. SETTINGS & SHORTCUTS MODALS
    ─────────────────────────────────────────────────────────── */
    openSettings() {
        const m = this.$('settings-modal');
        if (!m) return;
        m.classList.add('active');
        m.setAttribute('aria-hidden', 'false');
        const sel = (id, v) => { const el = this.$(id); if (el) el.value = v; };
        sel('concurrent-processing', this.settings.concurrentLimit);
        sel('fft-size',              this.settings.fftSize);
        sel('color-scheme',          this.settings.colorScheme);
    }

    closeSettings() {
        const m = this.$('settings-modal');
        if (m) { m.classList.remove('active'); m.setAttribute('aria-hidden', 'true'); }
    }

    openShortcuts() {
        const m = this.$('shortcuts-modal');
        if (m) { m.classList.add('active'); m.setAttribute('aria-hidden', 'false'); }
    }

    closeShortcuts() {
        const m = this.$('shortcuts-modal');
        if (m) { m.classList.remove('active'); m.setAttribute('aria-hidden', 'true'); }
    }

    /* ──────────────────────────────────────────────────────────
       16. STATISTICS
    ─────────────────────────────────────────────────────────── */
    updateStatistics() {
        const panel   = this.$('statistics-panel');
        const results = Array.from(this.results.values());

        if (!results.length) { if (panel) panel.style.display = 'none'; return; }
        if (panel) panel.style.display = 'block';

        const scores = results.map(r => r.qualityScore).filter(Number.isFinite);
        const best   = Math.max(...scores);
        const worst  = Math.min(...scores);
        const avg    = scores.reduce((a,b) => a+b, 0) / scores.length;

        const s = (id, t) => { const el = this.$(id); if (el) el.textContent = t; };
        s('stat-best',    `${best}%`);
        s('stat-worst',   `${worst}%`);
        s('stat-average', `${avg.toFixed(1)}%`);
        s('stat-total',   results.length);
    }

    /* ──────────────────────────────────────────────────────────
       17. CLEANUP
    ─────────────────────────────────────────────────────────── */
    removeCard(card) {
        const id = card.dataset.fileId;

        if (card._audio) {
            card._audio.pause();
            URL.revokeObjectURL(card._audioURL);
            card._audio = null;
        }
        if (this.audioContexts.has(id)) {
            this.audioContexts.get(id).close().catch(() => {});
            this.audioContexts.delete(id);
        }

        this.queue.delete(id);
        this.processingQueue.delete(id);
        this.results.delete(id);
        this.comparisonFiles.delete(id);

        card.style.cssText += 'transform:translateX(110%);opacity:0;transition:all .3s;';
        setTimeout(() => {
            card.remove();
            this.updateResultsHeader();
            this.updateStatistics();
            if (!this.results.size) {
                const es = this.$('empty-state');
                if (es) es.style.display = '';
            }
        }, 320);
    }

    clearAllResults() {
        if (!this.results.size && !this.queue.size) {
            this.showToast('Nothing to clear', 'warning'); return;
        }
        if (!confirm('Clear all analysis results? This cannot be undone.')) return;

        document.querySelectorAll('.result-card').forEach(c => {
            if (c._audio) { c._audio.pause(); URL.revokeObjectURL(c._audioURL); }
        });

        this.queue.clear();
        this.processingQueue.clear();
        this.results.clear();
        this.comparisonFiles.clear();
        this.audioContexts.forEach(c => c.close().catch(() => {}));
        this.audioContexts.clear();

        this.$('results-grid').innerHTML = '';
        const es = this.$('empty-state');
        if (es) es.style.display = '';
        this.processedCount = 0;
        this.totalFiles     = 0;

        this.updateResultsHeader();
        this.updateStatistics();
        this.hideGlobalLoader();
        this.exitComparisonMode();
        this.showToast('All results cleared', 'success');
    }

    /* ──────────────────────────────────────────────────────────
       18. TOAST
    ─────────────────────────────────────────────────────────── */
    showToast(msg, type = 'info') {
        const toast = this.$('toast');
        if (!toast) return;

        const icons = { success:'fa-circle-check', error:'fa-circle-xmark', warning:'fa-triangle-exclamation', info:'fa-circle-info' };
        const cols  = { success:'var(--color-good)', error:'var(--color-bad)', warning:'var(--color-moderate)', info:'var(--primary)' };

        const icon = toast.querySelector('.toast-icon');
        icon.className   = `toast-icon fa-solid ${icons[type] || icons.info}`;
        icon.style.color = cols[type] || cols.info;
        toast.querySelector('.toast-message').textContent = msg;

        toast.classList.add('show');
        clearTimeout(toast._t);
        toast._t = setTimeout(() => toast.classList.remove('show'), 3200);

        toast.querySelector('.toast-close').onclick = () => toast.classList.remove('show');
    }


    /* ──────────────────────────────────────────────────────────
       19. ANALYSIS STEPS (live log di dalam card saat proses)
    ─────────────────────────────────────────────────────────── */
    addStep(card, text, type = 'info') {
        if (!card) return;
        let box = card.querySelector('.analysis-steps');
        if (!box) return;

        const row = document.createElement('div');
        row.className = `step-row step-${type}`;

        const icon = type === 'done' ? 'fa-circle-check' : 'fa-bolt';
        row.innerHTML = `
            <i class="fa-solid ${icon} step-icon"></i>
            <span class="step-text">${text}</span>
        `;
        box.appendChild(row);
        box.hidden = false;

        // Auto-hide steps 1.8 s setelah step terakhir ditambahkan
        clearTimeout(card._stepTimer);
        card._stepTimer = setTimeout(() => {
            box.classList.add('steps-fade');
            setTimeout(() => { box.hidden = true; box.innerHTML = ''; box.classList.remove('steps-fade'); }, 600);
        }, 1800);
    }

    /* ──────────────────────────────────────────────────────────
       20. SERVICE WORKER (registration now in inline bootstrap)
    ─────────────────────────────────────────────────────────── */
    registerServiceWorker() {
        // SW is registered by the inline <script> in index.html
        // (before the app loads) for maximum reliability.
        // This method kept for compatibility.
    }

    /* ──────────────────────────────────────────────────────────
       20. UTILITIES
    ─────────────────────────────────────────────────────────── */
    $(id)     { return document.getElementById(id); }
    uid()     { return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2,7)}`; }

    fmtTime(s) {
        if (!isFinite(s) || s < 0) return '0:00';
        const h  = Math.floor(s / 3600);
        const m  = Math.floor((s % 3600) / 60);
        const sc = Math.floor(s % 60);
        if (h > 0) return `${h}:${String(m).padStart(2,'0')}:${String(sc).padStart(2,'0')}`;
        return `${m}:${String(sc).padStart(2,'0')}`;
    }

    fmtSize(bytes) {
        const u = ['B','KB','MB','GB'];
        let s = bytes, ui = 0;
        while (s >= 1024 && ui < u.length - 1) { s /= 1024; ui++; }
        return `${ui > 0 ? s.toFixed(2) : Math.round(s)} ${u[ui]}`;
    }
}

/* ═══════════════════════════════════════════════════════════════
   BOOTSTRAP
════════════════════════════════════════════════════════════════ */
document.addEventListener('DOMContentLoaded', () => {
    if (!window.AudioContext && !window.webkitAudioContext) {
        document.body.innerHTML = `
            <div style="display:grid;place-items:center;min-height:100vh;text-align:center;padding:2rem;font-family:system-ui;">
                <div>
                    <h2 style="margin-bottom:.5rem">Browser Not Supported</h2>
                    <p>Please use a modern browser — Chrome, Firefox, Safari or Edge.</p>
                </div>
            </div>`;
        return;
    }
    window.App = new TrueAudioDetector();
});
