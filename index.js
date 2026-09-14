(() => {
    const { patcher, metro, storage: storageApi, ui, logger } = vendetta;
    const { React, ReactNative, clipboard } = metro.common;
    const { StyleSheet, ScrollView } = ReactNative;
    const { showToast } = ui.toasts;
    const store = vendetta.plugin.storage;

    const P5 = {
        red: '#CC0001',
        redMain: '#A50001',
        redDark: '#720001',
        redDeep: '#4A0001',
        black: '#000000',
        panel: '#0B0B0D',
        panel2: '#151518',
        white: '#F7F7F4',
        grey: '#B7B7B1',
        muted: '#777773',
        cyan: '#40C1FB',
        green: '#00DDB2',
        pink: '#FF66ED',
        yellow: '#F0D34D',
    };

    const STYLE_PROPS = [
        'style',
        'containerStyle',
        'contentContainerStyle',
        'imageStyle',
        'wrapperStyle',
        'inputStyle',
        'textStyle',
        'labelStyle',
    ];
    const RADIUS_KEYS = [
        'borderRadius',
        'borderTopLeftRadius',
        'borderTopRightRadius',
        'borderBottomLeftRadius',
        'borderBottomRightRadius',
        'borderTopStartRadius',
        'borderTopEndRadius',
        'borderBottomStartRadius',
        'borderBottomEndRadius',
        'borderStartStartRadius',
        'borderStartEndRadius',
        'borderEndStartRadius',
        'borderEndEndRadius',
    ];
    const DIRECT_RADIUS_PROPS = ['borderRadius', 'cornerRadius', 'sheetCornerRadius'];
    const CIRCLE_THRESHOLD = 90;
    const MAX_DEPTH = 6;
    const MAX_VISITS = 220000;
    const MAX_UNDO = 60000;

    if (store.configVersion !== 4) {
        store.colors = store.colors !== false;
        store.redScreens = store.redScreens !== false;
        store.angular = store.angular !== false;
        store.outlines = store.outlines !== false;
        store.keepCircles = store.keepCircles !== false;
        store.nativeHook = store.nativeHook !== false;
        store.configVersion = 4;
    }

    let unpatches = [];
    let undoLog = [];
    let visits = 0;
    let styleCache = new WeakMap();
    const stats = {
        modules: 0,
        styles: 0,
        colors: 0,
        radii: 0,
        outlines: 0,
        tokenValues: 0,
        elements: 0,
        jsxModules: 0,
        payloadModules: 0,
        hooks: [],
    };

    function remember(obj, key, oldValue) {
        if (undoLog.length < MAX_UNDO) undoLog.push([obj, key, oldValue]);
    }

    function write(obj, key, value, counter) {
        let oldValue;
        try {
            oldValue = obj[key];
            if (oldValue === value) return false;
            obj[key] = value;
        } catch {
            return false;
        }
        remember(obj, key, oldValue);
        if (counter) stats[counter]++;
        return true;
    }

    function parseColor(value) {
        if (typeof value !== 'string') return null;
        const s = value.trim();
        let m;
        if ((m = /^#([0-9a-f]{3})$/i.exec(s))) {
            const h = m[1];
            return [
                parseInt(h[0] + h[0], 16),
                parseInt(h[1] + h[1], 16),
                parseInt(h[2] + h[2], 16),
                1,
            ];
        }
        if ((m = /^#([0-9a-f]{6})([0-9a-f]{2})?$/i.exec(s))) {
            const h = m[1];
            return [
                parseInt(h.slice(0, 2), 16),
                parseInt(h.slice(2, 4), 16),
                parseInt(h.slice(4, 6), 16),
                m[2] ? parseInt(m[2], 16) / 255 : 1,
            ];
        }
        if ((m = /^rgba?\(\s*(\d+(?:\.\d+)?)\s*,\s*(\d+(?:\.\d+)?)\s*,\s*(\d+(?:\.\d+)?)(?:\s*,\s*(\d+(?:\.\d+)?))?\s*\)$/i.exec(s))) {
            return [Number(m[1]), Number(m[2]), Number(m[3]), m[4] === undefined ? 1 : Number(m[4])];
        }
        return null;
    }

    function neutral(rgb, tolerance = 15) {
        const [r, g, b] = rgb;
        return Math.max(r, g, b) - Math.min(r, g, b) <= tolerance;
    }

    function brightness(rgb) {
        return (rgb[0] + rgb[1] + rgb[2]) / 3;
    }

    function brandish(rgb) {
        const [r, g, b, a] = rgb;
        if (a < 0.8) return false;
        return (b > 145 && b > r * 1.22 && b > g * 1.12) ||
            (r > 90 && b > 120 && b > g * 1.15);
    }

    function reddish(rgb) {
        const [r, g, b, a] = rgb;
        return a >= 0.8 && r > 120 && r > g * 1.45 && r > b * 1.35;
    }

    function fullScreenish(style) {
        if (!style || typeof style !== 'object') return false;
        if (style.flex === 1 || style.flexGrow === 1) return true;
        const fills = style.position === 'absolute' &&
            (style.top === 0 || style.inset === 0) &&
            (style.left === 0 || style.inset === 0) &&
            (style.right === 0 || style.inset === 0) &&
            (style.bottom === 0 || style.inset === 0);
        return fills || style.height === '100%' || style.minHeight === '100%';
    }

    function roundedish(style) {
        if (!style || typeof style !== 'object') return false;
        for (const key of RADIUS_KEYS) {
            const v = style[key];
            if (typeof v === 'number' && v > 0 && v < CIRCLE_THRESHOLD) return true;
        }
        return false;
    }

    function mapBackground(value, style) {
        if (!store.colors) return value;
        const rgb = parseColor(value);
        if (!rgb || rgb[3] < 0.82) return value;
        if (brandish(rgb) || reddish(rgb)) return P5.red;
        if (!neutral(rgb)) return value;
        const v = brightness(rgb);
        if (v > 82) return value;
        if (store.redScreens && fullScreenish(style) && !roundedish(style)) return P5.redMain;
        if (v <= 12) return P5.black;
        if (v <= 30) return P5.panel;
        return P5.panel2;
    }

    function mapBorder(value) {
        if (!store.colors) return value;
        const rgb = parseColor(value);
        if (!rgb || rgb[3] < 0.7) return value;
        if (brandish(rgb) || reddish(rgb)) return P5.red;
        if (neutral(rgb)) {
            const v = brightness(rgb);
            if (v < 85) return P5.black;
            if (v > 180) return P5.white;
        }
        return value;
    }

    function mapText(value) {
        if (!store.colors) return value;
        const rgb = parseColor(value);
        if (!rgb || rgb[3] < 0.75) return value;
        if (brandish(rgb)) return P5.cyan;
        if (neutral(rgb)) {
            const v = brightness(rgb);
            if (v >= 205) return P5.white;
            if (v >= 130) return P5.grey;
        }
        return value;
    }

    function applyAngular(style, inPlace) {
        if (!store.angular || !style || typeof style !== 'object') return false;
        let radius = null;
        for (const key of RADIUS_KEYS) {
            const value = style[key];
            if (typeof value !== 'number' || value <= 0) continue;
            radius = Math.max(radius || 0, value);
        }
        if (radius === null) return false;
        if (store.keepCircles && radius >= CIRCLE_THRESHOLD) return false;

        const set = (key, value) => {
            if (inPlace) return write(style, key, value, 'radii');
            style[key] = value;
            stats.radii++;
            return true;
        };

        let changed = false;
        changed = set('borderRadius', 0) || changed;
        changed = set('borderTopLeftRadius', 0) || changed;
        changed = set('borderTopRightRadius', 3) || changed;
        changed = set('borderBottomRightRadius', 0) || changed;
        changed = set('borderBottomLeftRadius', 9) || changed;
        changed = set('borderTopStartRadius', 0) || changed;
        changed = set('borderTopEndRadius', 3) || changed;
        changed = set('borderBottomEndRadius', 0) || changed;
        changed = set('borderBottomStartRadius', 9) || changed;

        if (store.outlines && style.backgroundColor !== undefined) {
            if (style.borderWidth === undefined) {
                if (inPlace) write(style, 'borderWidth', 1, 'outlines');
                else {
                    style.borderWidth = 1;
                    stats.outlines++;
                }
            }
            if (style.borderColor === undefined) {
                if (inPlace) write(style, 'borderColor', P5.white, 'outlines');
                else {
                    style.borderColor = P5.white;
                    stats.outlines++;
                }
            }
        }
        return changed;
    }

    function transformPlainStyle(style, inPlace = false) {
        if (!style || typeof style !== 'object' || Array.isArray(style)) return style;
        const target = inPlace ? style : Object.assign({}, style);
        let changed = false;

        if (typeof target.backgroundColor === 'string') {
            const mapped = mapBackground(target.backgroundColor, target);
            if (mapped !== target.backgroundColor) {
                if (inPlace) write(target, 'backgroundColor', mapped, 'colors');
                else {
                    target.backgroundColor = mapped;
                    stats.colors++;
                }
                changed = true;
            }
        }
        if (typeof target.borderColor === 'string') {
            const mapped = mapBorder(target.borderColor);
            if (mapped !== target.borderColor) {
                if (inPlace) write(target, 'borderColor', mapped, 'colors');
                else {
                    target.borderColor = mapped;
                    stats.colors++;
                }
                changed = true;
            }
        }
        if (typeof target.color === 'string') {
            const mapped = mapText(target.color);
            if (mapped !== target.color) {
                if (inPlace) write(target, 'color', mapped, 'colors');
                else {
                    target.color = mapped;
                    stats.colors++;
                }
                changed = true;
            }
        }
        if (applyAngular(target, inPlace)) changed = true;
        return inPlace ? target : (changed ? target : style);
    }

    function transformStyle(style) {
        if (!style || typeof style !== 'object') return style;
        const cached = styleCache.get(style);
        if (cached !== undefined) return cached;
        let result = style;
        if (Array.isArray(style)) {
            let changed = false;
            const next = style.map((entry) => {
                const mapped = transformStyle(entry);
                if (mapped !== entry) changed = true;
                return mapped;
            });
            if (changed) result = next;
        } else {
            result = transformPlainStyle(style, false);
        }
        styleCache.set(style, result);
        return result;
    }

    function looksLikeStyle(obj) {
        if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return false;
        return 'backgroundColor' in obj || 'borderColor' in obj || 'borderRadius' in obj ||
            'borderTopLeftRadius' in obj || 'color' in obj;
    }

    function sweep(node, depth, seen) {
        if (!node || typeof node !== 'object' || depth > MAX_DEPTH || visits > MAX_VISITS) return;
        if (seen.has(node)) return;
        seen.add(node);
        visits++;
        if (Array.isArray(node)) {
            for (const item of node) sweep(item, depth + 1, seen);
            return;
        }
        if (looksLikeStyle(node)) {
            transformPlainStyle(node, true);
            stats.styles++;
        }
        let keys;
        try { keys = Object.keys(node); } catch { return; }
        for (const key of keys) {
            let value;
            try { value = node[key]; } catch { continue; }
            if (value && typeof value === 'object') sweep(value, depth + 1, seen);
        }
    }

    function sweepRegistry() {
        const seen = new WeakSet();
        visits = 0;
        for (const id in metro.modules) {
            const module = metro.modules[id];
            if (!module || !module.isInitialized || module.hasError) continue;
            let exp;
            try { exp = module.publicModule && module.publicModule.exports; } catch { continue; }
            if (!exp || exp === globalThis) continue;
            sweep(exp, 0, seen);
            stats.modules++;
        }
    }

    function tokenColorForKey(key, oldValue) {
        if (!store.colors || typeof oldValue !== 'string') return null;
        const k = String(key).toUpperCase();
        if (k.includes('TRANSPARENT')) return null;
        if (k.includes('BACKGROUND_PRIMARY') || k.includes('MOBILE_PRIMARY') || k === 'CHAT_BACKGROUND' || k.includes('BG_BASE_PRIMARY')) return P5.redMain;
        if (k.includes('BACKGROUND_SECONDARY') || k.includes('BACKGROUND_TERTIARY') || k.includes('FLOATING') || k.includes('CARD') || k.includes('INPUT_BACKGROUND') || k.includes('BG_BASE_SECONDARY') || k.includes('BG_BASE_TERTIARY')) return P5.panel;
        if (k.includes('TEXT_LINK') || k.includes('LINK_LOW') || k.startsWith('BLUE_')) return P5.cyan;
        if (k.startsWith('GREEN_') || k.includes('POSITIVE')) return P5.green;
        if (k.startsWith('YELLOW_') || k.includes('WARNING')) return P5.yellow;
        if (k.startsWith('PURPLE_') || k.includes('PINK') || k.includes('STREAMING')) return P5.pink;
        if (k.startsWith('BRAND_') || k.startsWith('RED_') || k.includes('DANGER') || k.includes('CONTROL_BRAND')) return P5.red;
        if (k.includes('TEXT_PRIMARY') || k.includes('TEXT_NORMAL') || k.includes('HEADER_PRIMARY') || k.includes('INTERACTIVE_ACTIVE')) return P5.white;
        if (k.includes('TEXT_MUTED') || k.includes('HEADER_SECONDARY') || k.includes('INTERACTIVE_MUTED')) return P5.grey;
        const pm = /^(?:PRIMARY|PRIMARY_DARK)_(\d+)$/.exec(k);
        if (pm) {
            const n = Number(pm[1]);
            if (n >= 800) return P5.redMain;
            if (n >= 700) return P5.redDark;
            if (n >= 600) return P5.panel2;
        }
        return null;
    }

    function mutateTokenTree(node, depth, seen) {
        if (!node || typeof node !== 'object' || depth > 5 || seen.has(node)) return;
        seen.add(node);
        let keys;
        try { keys = Object.keys(node); } catch { return; }
        for (const key of keys) {
            let value;
            try { value = node[key]; } catch { continue; }
            if (typeof value === 'string') {
                const mapped = tokenColorForKey(key, value);
                if (mapped && mapped !== value && write(node, key, mapped, 'tokenValues')) continue;
            }
            if (value && typeof value === 'object') mutateTokenTree(value, depth + 1, seen);
        }
    }

    function patchThemeTokens() {
        const attempts = [];
        try {
            const one = metro.findByProps('unsafe_rawColors', 'colors');
            if (one) attempts.push(one);
        } catch {}
        try {
            const many = metro.findByPropsAll('unsafe_rawColors') || [];
            for (const mod of many) attempts.push(mod);
        } catch {}
        const seenModules = new Set();
        for (const mod of attempts) {
            if (!mod || seenModules.has(mod)) continue;
            seenModules.add(mod);
            mutateTokenTree(mod, 0, new WeakSet());
        }
        if (seenModules.size) stats.hooks.push(`themeTokens:${seenModules.size}`);
    }

    function transformProps(type, props) {
        if (!props || typeof props !== 'object') return props;
        stats.elements++;
        let next = props;
        const edit = () => {
            if (next === props) next = Object.assign({}, props);
            return next;
        };
        for (const key of STYLE_PROPS) {
            const value = props[key];
            if (!value || typeof value !== 'object') continue;
            const mapped = transformStyle(value);
            if (mapped !== value) edit()[key] = mapped;
        }
        if (typeof props.backgroundColor === 'string') {
            const mapped = mapBackground(props.backgroundColor, props);
            if (mapped !== props.backgroundColor) edit().backgroundColor = mapped;
        }
        if (typeof props.borderColor === 'string') {
            const mapped = mapBorder(props.borderColor);
            if (mapped !== props.borderColor) edit().borderColor = mapped;
        }
        if (typeof props.color === 'string') {
            const mapped = mapText(props.color);
            if (mapped !== props.color) edit().color = mapped;
        }
        if (store.angular) {
            for (const key of DIRECT_RADIUS_PROPS) {
                const value = props[key];
                if (typeof value !== 'number' || value <= 0) continue;
                if (store.keepCircles && value >= CIRCLE_THRESHOLD) continue;
                edit()[key] = key === 'sheetCornerRadius' ? 3 : 0;
            }
        }
        return next;
    }

    function patchElementCreation() {
        const rewrite = (args) => {
            const props = transformProps(args[0], args[1]);
            if (props !== args[1]) args[1] = props;
            return args;
        };
        const patched = new Map();
        const runtimeSet = new Set();
        for (const name of ['jsx', 'jsxs', 'jsxDEV']) {
            let modules = [];
            try { modules = metro.findByPropsAll(name) || []; } catch {}
            for (const mod of modules) {
                if (!mod || typeof mod[name] !== 'function') continue;
                let names = patched.get(mod);
                if (!names) { names = new Set(); patched.set(mod, names); }
                if (names.has(name)) continue;
                names.add(name);
                unpatches.push(patcher.instead(name, mod, (args, original) => original(...rewrite(args))));
                runtimeSet.add(mod);
            }
        }
        stats.jsxModules = runtimeSet.size;
        if (React && typeof React.createElement === 'function') {
            unpatches.push(patcher.instead('createElement', React, (args, original) => original(...rewrite(args))));
            stats.hooks.push('createElement');
        }
        stats.hooks.push(`jsx:${runtimeSet.size}`);
    }

    function patchNativePayload() {
        if (!store.nativeHook) return;
        let candidates = [];
        try { candidates = metro.findByPropsAll('create', 'diff') || []; } catch { return; }
        const seen = new Set();
        for (const mod of candidates) {
            if (seen.has(mod)) continue;
            seen.add(mod);
            if (!mod || typeof mod.create !== 'function' || typeof mod.diff !== 'function') continue;
            if (mod.create.length !== 2 || mod.diff.length !== 3) continue;
            const sanitize = (props) => {
                try { return transformProps('nativeProps', props); } catch { return props; }
            };
            unpatches.push(patcher.instead('create', mod, (args, original) => {
                args[0] = sanitize(args[0]);
                return original(...args);
            }));
            unpatches.push(patcher.instead('diff', mod, (args, original) => {
                args[0] = sanitize(args[0]);
                args[1] = sanitize(args[1]);
                return original(...args);
            }));
            stats.payloadModules++;
        }
        stats.hooks.push(`native:${stats.payloadModules}`);
    }

    function apply() {
        styleCache = new WeakMap();
        stats.modules = stats.styles = stats.colors = stats.radii = stats.outlines = 0;
        stats.tokenValues = stats.elements = stats.jsxModules = stats.payloadModules = 0;
        stats.hooks = [];
        patchThemeTokens();
        sweepRegistry();
        try {
            unpatches.push(patcher.after('create', StyleSheet, (_args, styles) => {
                try {
                    visits = 0;
                    sweep(styles, 0, new WeakSet());
                } catch (e) {
                    logger.error('[P5 Mobile] StyleSheet hook failed', e);
                }
                return styles;
            }));
            stats.hooks.push('StyleSheet.create');
        } catch (e) {
            logger.warn('[P5 Mobile] StyleSheet.create hook unavailable', e);
        }
        patchElementCreation();
        patchNativePayload();
        logger.log(`[P5 Mobile] applied: ${stats.colors} colors, ${stats.radii} radius edits, ${stats.tokenValues} token edits; ${stats.hooks.join(', ')}`);
    }

    function revert() {
        for (const unpatch of unpatches) {
            try { unpatch(); } catch {}
        }
        unpatches = [];
        styleCache = new WeakMap();
        for (let i = undoLog.length - 1; i >= 0; i--) {
            const [obj, key, value] = undoLog[i];
            try { obj[key] = value; } catch {}
        }
        undoLog = [];
    }

    function reapply() {
        revert();
        apply();
    }

    function report() {
        return [
            'Persona 5 Mobile UI diagnostics',
            `settings: colors=${store.colors} redScreens=${store.redScreens} angular=${store.angular} outlines=${store.outlines} keepCircles=${store.keepCircles} nativeHook=${store.nativeHook}`,
            `hooks: ${stats.hooks.join(', ') || 'none'}`,
            `jsx modules=${stats.jsxModules} native payload modules=${stats.payloadModules}`,
            `elements seen=${stats.elements}`,
            `modules swept=${stats.modules} style objects=${stats.styles}`,
            `edits: colors=${stats.colors} radii=${stats.radii} outlines=${stats.outlines} themeTokens=${stats.tokenValues}`,
            `undo entries=${undoLog.length}`,
        ].join('\n');
    }

    function Settings() {
        const { FormSwitchRow, FormRow, FormDivider } = ui.components.Forms;
        storageApi.useProxy(store);
        const toggle = (key, label) => (value) => {
            store[key] = value;
            reapply();
            showToast(label);
        };
        return React.createElement(
            ScrollView,
            null,
            React.createElement(FormSwitchRow, {
                label: 'Persona 5 colors',
                subLabel: 'Recolors Discord surfaces directly instead of relying only on theme JSON tokens.',
                value: store.colors,
                onValueChange: toggle('colors', 'P5 colors updated'),
            }),
            React.createElement(FormDivider, null),
            React.createElement(FormSwitchRow, {
                label: 'Crimson main screens',
                subLabel: 'Makes full-screen dark surfaces Persona crimson while cards and controls stay black.',
                value: store.redScreens,
                onValueChange: toggle('redScreens', 'Main surfaces updated'),
            }),
            React.createElement(FormDivider, null),
            React.createElement(FormSwitchRow, {
                label: 'Angular P5 panels',
                subLabel: 'Replaces ordinary rounded cards, buttons and inputs with asymmetric hard corners.',
                value: store.angular,
                onValueChange: toggle('angular', 'Panel shapes updated'),
            }),
            React.createElement(FormDivider, null),
            React.createElement(FormSwitchRow, {
                label: 'Comic white outlines',
                subLabel: 'Adds thin white outlines to styled cards and controls for more P5 contrast.',
                value: store.outlines,
                onValueChange: toggle('outlines', 'Outlines updated'),
            }),
            React.createElement(FormDivider, null),
            React.createElement(FormSwitchRow, {
                label: 'Keep avatars circular',
                subLabel: 'Preserves very large radii so avatars and status circles do not become squares.',
                value: store.keepCircles,
                onValueChange: toggle('keepCircles', 'Circle handling updated'),
            }),
            React.createElement(FormDivider, null),
            React.createElement(FormSwitchRow, {
                label: 'Native-view hook',
                subLabel: 'Needed for newer Discord Android screens. Disable only if this plugin causes rendering issues.',
                value: store.nativeHook,
                onValueChange: toggle('nativeHook', 'Native hook updated'),
            }),
            React.createElement(FormDivider, null),
            React.createElement(FormRow, {
                label: 'Reapply Persona 5 UI now',
                subLabel: 'Re-scans screens and styles created since Discord started.',
                onPress: () => {
                    reapply();
                    showToast('Persona 5 UI reapplied');
                },
            }),
            React.createElement(FormDivider, null),
            React.createElement(FormRow, {
                label: 'Copy diagnostics',
                subLabel: 'Copies hook and edit counts so the plugin can be tuned for your Discord build.',
                onPress: () => {
                    const text = report();
                    logger.log(text);
                    try {
                        clipboard.setString(text);
                        showToast('Diagnostics copied');
                    } catch {
                        showToast('Diagnostics written to debug log');
                    }
                },
            })
        );
    }

    return {
        onLoad() {
            try {
                apply();
                showToast('Persona 5 Mobile UI loaded');
            } catch (error) {
                logger.error('[P5 Mobile] load failed', error);
                showToast('P5 UI load failed — check debug logs');
            }
        },
        onUnload() {
            revert();
        },
        settings: Settings,
    };
})()
