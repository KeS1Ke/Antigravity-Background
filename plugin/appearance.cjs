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

    const defaults = Object.fromEntries(Object.entries(controls).map(([key, option]) => [key, option.value]));
    const surfaceControls = {
        sidebarOpacity: { label: '底色不透明度', min: 0, max: 100, value: 100, unit: '%' },
        sidebarBlur: { label: '背景模糊', min: 0, max: 30, value: 0, unit: ' px' },
        composerOpacity: { label: '底色不透明度', min: 0, max: 100, value: 100, unit: '%' },
        composerBlur: { label: '背景模糊', min: 0, max: 30, value: 0, unit: ' px' },
        bubbleOpacity: { label: '底色不透明度', min: 0, max: 100, value: 100, unit: '%' },
        bubbleBlur: { label: '背景模糊', min: 0, max: 30, value: 0, unit: ' px' },
        overviewOpacity: { label: '底色不透明度', min: 0, max: 100, value: 100, unit: '%' },
        overviewBlur: { label: '背景模糊', min: 0, max: 30, value: 0, unit: ' px' },
    };
    const maximumImageLength = 10 * 1024 * 1024;
    const colorKeys = [
        'composerOuterColor', 'composerInnerColor',
        'bubbleOuterColor', 'bubbleInnerColor',
        'overviewOuterColor', 'overviewInnerColor',
    ];

    function normalize(input = {}) {
        if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('背景设置无效。');
        const options = Object.fromEntries(Object.entries({ ...controls, ...surfaceControls }).map(([key, { min, max, value }]) => [
            key,
            Number.isFinite(input[key]) ? Math.min(max, Math.max(min, Math.round(input[key]))) : value,
        ]));
        const image = input.image ?? '';
        if (typeof image !== 'string' || image.length > maximumImageLength ||
            (image !== '' && !/^data:image\/(?:webp|png|jpeg);base64,[A-Za-z0-9+/]+={0,2}$/.test(image))) {
            throw new Error('背景图片无效或压缩后仍过大。');
        }
        const mode = input.mode ?? 'fit';
        const theme = input.theme ?? 'system';
        if (!['fill', 'stretch', 'fit', 'tile'].includes(mode)) throw new Error('图片布局无效。');
        if (!['system', 'light', 'dark'].includes(theme)) throw new Error('界面主题无效。');
        const sidebarCover = typeof input.sidebarCover === 'boolean' ? input.sidebarCover : input.sidebarTransparent !== true;
        const bubbleCover = input.bubbleCover !== false;
        const overviewSync = input.overviewSync !== false;
        const overviewCover = overviewSync ? bubbleCover : input.overviewCover !== false;
        const colors = {};
        for (const key of colorKeys) {
            const color = input[key] ?? '';
            if (typeof color !== 'string' || (color !== '' && !/^#[0-9a-f]{6}$/i.test(color))) {
                throw new Error('表面颜色须为六位十六进制颜色。');
            }
            colors[key] = color.toLowerCase();
        }
        if (overviewSync) {
            options.overviewOpacity = options.bubbleOpacity;
            options.overviewBlur = options.bubbleBlur;
            colors.overviewOuterColor = colors.bubbleOuterColor;
            colors.overviewInnerColor = colors.bubbleInnerColor;
        }
        return {
            ...options, ...colors, image, mode, theme, enabled: input.enabled !== false,
            sidebarTransparent: !sidebarCover,
            sidebarCover,
            composerCover: input.composerCover !== false,
            bubbleCover,
            overviewSync,
            overviewCover,
            imageWidth: Number.isInteger(input.imageWidth) ? Math.min(2560, Math.max(1, input.imageWidth)) : 512,
            imageHeight: Number.isInteger(input.imageHeight) ? Math.min(2560, Math.max(1, input.imageHeight)) : 512,
        };
    }

    function wallpaperStyle({ x, y, scale, blur, opacity, brightness, fade, image, enabled, mode, imageWidth, imageHeight }, imageSource = 'url("' + image + '")') {
        if (!enabled || !image || opacity === 0) return '';
        const effectiveScale = mode === 'tile' ? scale : Math.max(100, scale);
        const backgroundSize = {
            fill: 'cover', stretch: '100% 100%', fit: 'contain',
            tile: (imageWidth * effectiveScale / 100) + 'px ' + (imageHeight * effectiveScale / 100) + 'px',
        }[mode];
        const fadeMask = fade > 0 ? `mask-image: linear-gradient(to right, transparent, black ${fade}%);` : '';
        // A full-width transparent canvas makes the fade independent of the image's width.
        return `
            content: "";
            position: fixed;
            inset: 0;
            z-index: 1000;
            pointer-events: none;
            background-image: ${imageSource};
            background-repeat: ${mode === 'tile' ? 'repeat' : 'no-repeat'};
            background-position: ${x}% ${y}%;
            background-size: ${backgroundSize};
            transform: scale(${mode === 'tile' ? 1 : effectiveScale / 100});
            transform-origin: ${x}% ${y}%;
            opacity: ${opacity / 100};
            filter: blur(${blur}px) brightness(${brightness}%);
            ${fadeMask}
        `;
    }

    const appearance = { controls, surfaceControls, defaults, normalize, wallpaperStyle };
    if (typeof module === 'object') module.exports = appearance;
    else window.wallpaperAppearance = appearance;
})();
