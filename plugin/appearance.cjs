(() => {
    const controls = {
        x: { label: '水平位置', min: 0, max: 100, value: 78, unit: '%' },
        y: { label: '垂直位置', min: 0, max: 100, value: 50, unit: '%' },
        scale: { label: '缩放', min: 20, max: 220, value: 100, unit: '%' },
        blur: { label: '模糊', min: 0, max: 30, value: 0, unit: ' px' },
        opacity: { label: '不透明度', min: 0, max: 100, value: 35, unit: '%' },
        brightness: { label: '亮度', min: 30, max: 140, value: 100, unit: '%' },
        fade: { label: '左侧渐隐', min: 0, max: 95, value: 38, unit: '%' },
    };

    const activeSurfaces = ['leftSidebar', 'sidebar', 'composer', 'overview'];
    const surfaceControls = Object.fromEntries(activeSurfaces.flatMap(prefix => [
        [prefix + 'Opacity', { label: '底色不透明度', min: 0, max: 100, value: 100, unit: '%' }],
        [prefix + 'Blur', { label: '背景模糊', min: 0, max: 30, value: 0, unit: ' px' }],
    ]));
    const maximumImageLength = 10 * 1024 * 1024;
    const maxDimension = 2560;
    const colorKeys = ['composerOuterColor', 'composerInnerColor', 'overviewOuterColor', 'overviewInnerColor'];
    const boundSuffixes = ['Cover', 'Layered', 'Opacity', 'Blur', 'OuterColor', 'InnerColor'];
    const surfaceKeys = [
        'leftSidebarCover', 'leftSidebarOpacity', 'leftSidebarBlur',
        'sidebarCover', 'sidebarOpacity', 'sidebarBlur',
        ...boundSuffixes.map(suffix => 'composer' + suffix),
        'overviewCover', 'overviewOpacity', 'overviewBlur', 'overviewOuterColor', 'overviewInnerColor',
    ];
    const DATA_IMAGE_RE = /^data:image\/(?:webp|png|jpeg);base64,[A-Za-z0-9+/]+={0,2}$/;
    const verifiedImages = new Set();
    const HEX_COLOR_RE = /^#[0-9a-f]{6}$/i;
    const CSS_VAR_RE = /^var\(--[a-z0-9-]+\)$/i;
    const CSS_DATA_URL_RE = /^url\("data:image\/(?:webp|png|jpeg);base64,[A-Za-z0-9+/]+={0,2}"\)$/;

    function minScale(mode) {
        return mode === 'tile' ? controls.scale.min : 100;
    }

    function clampDimensions(rawWidth, rawHeight, fallbackWidth, fallbackHeight) {
        const valid = value => Number.isInteger(value) && value > 0;
        let imageWidth = valid(rawWidth) ? rawWidth : fallbackWidth;
        let imageHeight = valid(rawHeight) ? rawHeight : fallbackHeight;
        const longest = Math.max(imageWidth, imageHeight);
        if (longest > maxDimension) {
            const ratio = maxDimension / longest;
            imageWidth = Math.max(1, Math.round(imageWidth * ratio));
            imageHeight = Math.max(1, Math.round(imageHeight * ratio));
        }
        return { imageWidth, imageHeight };
    }

    function normalize(input = {}) {
        if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('背景设置无效。');
        const options = Object.fromEntries(Object.entries({ ...controls, ...surfaceControls }).map(([key, { min, max, value }]) => {
            const raw = input[key] !== undefined
                ? input[key]
                : (key.startsWith('composer') ? input['bubble' + key.slice('composer'.length)] : undefined);
            return [key, Number.isFinite(raw) ? Math.min(max, Math.max(min, Math.round(raw))) : value];
        }));
        const image = input.image ?? '';
        if (typeof image !== 'string' || image.length > maximumImageLength) {
            throw new Error('背景图片无效或压缩后仍过大。');
        }
        if (image !== '' && !verifiedImages.has(image)) {
            if (!DATA_IMAGE_RE.test(image)) {
                throw new Error('背景图片无效或压缩后仍过大。');
            }
            if (verifiedImages.size >= 4) verifiedImages.clear();
            verifiedImages.add(image);
        }
        let imageColor = '';
        if (input.imageColor !== undefined) {
            const rawImageColor = input.imageColor ?? '';
            if (typeof rawImageColor !== 'string' || (rawImageColor !== '' && !HEX_COLOR_RE.test(rawImageColor))) {
                throw new Error('壁纸背景颜色须为六位十六进制颜色。');
            }
            imageColor = image ? rawImageColor.toLowerCase() : '';
        }
        const mode = input.mode ?? 'fit';
        const theme = input.theme ?? 'system';
        if (!['fill', 'stretch', 'fit', 'tile'].includes(mode)) throw new Error('图片布局无效。');
        if (!['system', 'light', 'dark'].includes(theme)) throw new Error('界面主题无效。');
        const sidebarCover = typeof input.sidebarCover === 'boolean' ? input.sidebarCover : input.sidebarTransparent !== true;
        const composerCover = typeof input.composerCover === 'boolean'
            ? input.composerCover
            : (typeof input.bubbleCover === 'boolean' ? input.bubbleCover : true);
        const composerLayered = typeof input.composerLayered === 'boolean'
            ? input.composerLayered
            : (typeof input.bubbleLayered === 'boolean' ? input.bubbleLayered : true);
        const colors = {};
        for (const key of colorKeys) {
            if (input[key] !== undefined) {
                const color = input[key] ?? '';
                if (typeof color !== 'string' || (color !== '' && !HEX_COLOR_RE.test(color))) {
                    throw new Error('表面颜色须为六位十六进制颜色。');
                }
                colors[key] = color.toLowerCase();
                continue;
            }
            const legacy = key.startsWith('composer') ? input['bubble' + key.slice('composer'.length)] : undefined;
            colors[key] = typeof legacy === 'string' && HEX_COLOR_RE.test(legacy) ? legacy.toLowerCase() : '';
        }
        const { imageWidth, imageHeight } = clampDimensions(input.imageWidth, input.imageHeight, 512, 512);
        return {
            ...options, ...colors, image, imageColor, mode, theme, enabled: input.enabled !== false,
            leftSidebarCover: input.leftSidebarCover !== false,
            sidebarCover,
            composerCover,
            composerLayered,
            overviewCover: input.overviewCover !== false,
            imageWidth,
            imageHeight,
        };
    }

    const defaults = Object.freeze(normalize({}));

    /** Extracts surface appearance settings sent to the host renderer. */
    function surfaceConfig(settings) {
        if (!settings || typeof settings !== 'object' || Array.isArray(settings)) throw new Error('背景设置无效。');
        return Object.fromEntries(surfaceKeys.map(key => [key, settings[key] ?? defaults[key]]));
    }

    function isSafeImageSource(source) {
        if (typeof source !== 'string' || source.length === 0) return false;
        if (CSS_VAR_RE.test(source)) return true;
        return source.length <= maximumImageLength + 7 && CSS_DATA_URL_RE.test(source);
    }

    function wallpaperStyle(input, imageSource) {
        const base = normalize(input);
        if (!base.enabled || !base.image || base.opacity === 0) return '';
        const source = imageSource === undefined ? 'url("' + base.image + '")' : imageSource;
        if (imageSource !== undefined && !isSafeImageSource(source)) {
            throw new Error('背景图片来源无效。');
        }
        const effectiveScale = Math.max(minScale(base.mode), base.scale);
        const scaleFactor = effectiveScale / 100;
        const fallbackAspect = Number((base.imageWidth / base.imageHeight).toFixed(6));
        const imageAspect = `var(--ag-ui-image-aspect, ${fallbackAspect})`;
        const containWidth = `min(100cqw, 100cqh * ${imageAspect})`;
        const coverWidth = `max(100cqw, 100cqh * ${imageAspect})`;
        const balancedWidth = `(50cqw + 50cqh * ${imageAspect})`;
        const backgroundSize = {
            fill: effectiveScale === 100 ? 'cover' : `calc(${coverWidth} * ${scaleFactor}) auto`,
            stretch: effectiveScale === 100 ? '100% 100%' : `${effectiveScale}% ${effectiveScale}%`,
            fit: effectiveScale === 100 ? 'contain' : `calc(${containWidth} * ${scaleFactor}) auto`,
            tile: `calc(${balancedWidth} * ${scaleFactor}) auto`,
        }[base.mode];
        const blurFilter = base.blur > 0
            ? `blur(calc(${base.blur} * min(100cqw, 100cqh * 16 / 9) / 1920))`
            : 'blur(0px)';
        const fadeMask = base.fade > 0 ? `mask-image: linear-gradient(to right, transparent, black ${base.fade}%);` : '';
        const tileBg = base.mode === 'tile' && base.imageColor
            ? `background-color: ${base.imageColor};`
            : '';
        // A full-width transparent canvas makes the fade and scale independent of viewport pixel density.
        return `
            position: absolute;
            inset: 0;
            z-index: 1000;
            pointer-events: none;
            background-image: ${source};
            background-repeat: no-repeat;
            background-position: ${base.x}% ${base.y}%;
            background-size: ${backgroundSize};
            ${tileBg}
            opacity: ${base.opacity / 100};
            filter: ${blurFilter} brightness(${base.brightness}%);
            ${fadeMask}
        `;
    }

    /** Extracts the dominant opaque edge color (#rrggbb) from border RGBA strips, or '' if transparent. */
    function extractBorderColor(strips) {
        let total = 0;
        const opaque = [];
        const buckets = new Map();
        for (const data of strips || []) {
            if (!data) continue;
            for (let i = 0; i + 3 < data.length; i += 4) {
                total++;
                if (data[i + 3] < 128) continue;
                const r = data[i];
                const g = data[i + 1];
                const b = data[i + 2];
                opaque.push(r, g, b);
                const qr = r >> 4;
                const qg = g >> 4;
                const qb = b >> 4;
                const key = (qr << 8) | (qg << 4) | qb;
                let bucket = buckets.get(key);
                if (!bucket) {
                    bucket = { count: 0, sumR: 0, sumG: 0, sumB: 0, qr, qg, qb };
                    buckets.set(key, bucket);
                }
                bucket.count++;
                bucket.sumR += r;
                bucket.sumG += g;
                bucket.sumB += b;
            }
        }
        const opaqueCount = opaque.length / 3;
        if (total === 0 || opaqueCount === 0 || opaqueCount * 4 < total) return '';

        let bestBucket = null;
        let bestScore = -1;
        for (const bucket of buckets.values()) {
            let score = 0;
            for (let dr = -1; dr <= 1; dr++) {
                const nr = bucket.qr + dr;
                if (nr < 0 || nr > 15) continue;
                for (let dg = -1; dg <= 1; dg++) {
                    const ng = bucket.qg + dg;
                    if (ng < 0 || ng > 15) continue;
                    for (let db = -1; db <= 1; db++) {
                        const nb = bucket.qb + db;
                        if (nb < 0 || nb > 15) continue;
                        const neighbor = buckets.get((nr << 8) | (ng << 4) | nb);
                        if (neighbor) score += neighbor.count;
                    }
                }
            }
            if (score > bestScore || (score === bestScore && bucket.count > bestBucket.count)) {
                bestScore = score;
                bestBucket = bucket;
            }
        }
        const centerR = bestBucket.sumR / bestBucket.count;
        const centerG = bestBucket.sumG / bestBucket.count;
        const centerB = bestBucket.sumB / bestBucket.count;
        let sumR = 0;
        let sumG = 0;
        let sumB = 0;
        let matchCount = 0;
        for (let i = 0; i < opaque.length; i += 3) {
            const r = opaque[i];
            const g = opaque[i + 1];
            const b = opaque[i + 2];
            if (Math.abs(r - centerR) <= 20 && Math.abs(g - centerG) <= 20 && Math.abs(b - centerB) <= 20) {
                sumR += r;
                sumG += g;
                sumB += b;
                matchCount++;
            }
        }
        const toHex = n => Math.min(255, Math.max(0, Math.round(n))).toString(16).padStart(2, '0');
        const finalR = matchCount ? sumR / matchCount : centerR;
        const finalG = matchCount ? sumG / matchCount : centerG;
        const finalB = matchCount ? sumB / matchCount : centerB;
        return '#' + toHex(finalR) + toHex(finalG) + toHex(finalB);
    }

    /** Samples the perimeter of a 2D canvas context and returns its dominant background color. */
    function extractCanvasBorderColor(ctx, width, height) {
        if (!ctx || !Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return '';
        const w = Math.floor(width);
        const h = Math.floor(height);
        const minSide = Math.min(w, h);
        const inset = minSide >= 16 ? Math.max(1, Math.round(minSide * 0.004)) : 0;
        const xLeft = inset;
        const xRight = w - 1 - inset;
        const yTop = inset;
        const yBottom = h - 1 - inset;
        const rowWidth = xRight - xLeft + 1;
        try {
            const strips = [ctx.getImageData(xLeft, yTop, rowWidth, 1).data];
            if (yBottom > yTop) strips.push(ctx.getImageData(xLeft, yBottom, rowWidth, 1).data);
            const midHeight = yBottom - yTop - 1;
            if (midHeight > 0) {
                strips.push(ctx.getImageData(xLeft, yTop + 1, 1, midHeight).data);
                if (xRight > xLeft) strips.push(ctx.getImageData(xRight, yTop + 1, 1, midHeight).data);
            }
            return extractBorderColor(strips);
        } catch {
            return '';
        }
    }

    const appearance = {
        controls,
        surfaceControls,
        defaults,
        minScale,
        normalize,
        surfaceConfig,
        wallpaperStyle,
        extractBorderColor,
        extractCanvasBorderColor,
    };
    if (typeof module === 'object' && module && module.exports) module.exports = appearance;
    else globalThis.wallpaperAppearance = appearance;
})();
