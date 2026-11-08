# Three.js runtime acceptance fixture

This synthetic scene is exercised by `node scripts/verify-three-runtime.mjs` from `desktop/`. It is not a shipped scene, reference artwork, editor implementation or claim about achievable final visual quality.

The script copies these fixed inputs into a unique repository `_workspace/tmp/` project, starts the existing Vite package with the existing Three package, and starts an owned headless browser. The production `native-browser-service` and `--native-browser-mcp` relay target that owned page. The actual bundled Playwright MCP performs navigation, evaluation, screenshot, console inspection and viewport changes.

Covered behavior:

- Geometry, local SVG texture, lighting, animated rain/water and a moving object render in WebGL.
- Saving a settings module changes scene geometry/materials through Vite HMR while retaining the same running document, camera position and camera target.
- Browser screenshot calls return image content and changed rendered pixels. The pinned MCP returns an image block only when `filename` is omitted; specifying a name instead requests file output.
- An intentional runtime exception is visible through `browser_console_messages`. Saving a corrected module recovers the same scene without replacing the document or camera.
- The native browser service reports the original scope, active target and whole-tool in-flight activity, and the returned screenshot reflects the requested viewport.

All output, screenshots and expected error logs are placed in a fresh `_workspace/tasks/3d-preview-implementation-20261108/three-runtime/run-*/` directory. The script only controls its owned headless process; it does not start Trylo, connect to a user browser, invoke desktop-control tools, change application permissions or call a model provider. A green run is real local WebGL/browser-MCP evidence, not native WebView2, interactive Desktop, installer or real-provider acceptance.
