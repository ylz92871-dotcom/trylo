# Trylo production marketing source

The maintained source is src/, styles.css and build.mjs. Build with `node build.mjs` after installing desktop-services dependencies. It reads the same Trylo avatars from desktop source and the release manifest from ../desktop-release.json. Generated pages, app.js, licensed fonts and approved short brand videos are included. Existing font subsets are reused; TRYLO_CJK_FONT can explicitly point to an upstream Noto Sans SC font for resubsetting.

The full promotional film remains a separate release asset. Existing production film URLs and prior download versions are preserved during Desktop download updates. Deployment credentials and review captures are excluded from this source package.
