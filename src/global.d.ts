// Build-time flag injected by esbuild (`--define:__DEV__=…`). false in the production
// bundle (`make build:ext`, minified so dead branches are stripped); true only in the
// sandbox checkout-simulator build (`make build:ext:dev`). Never ship a build where this
// is true — it enables a session-token bypass meant for the admin QA sandbox.
declare const __DEV__: boolean;
