import {Config} from '@remotion/cli/config';

// Output as JPEG frames (faster than PNG for most cases)
Config.setVideoImageFormat('jpeg');

// Always overwrite existing output files
Config.setOverwriteOutput(true);

// Use software WebGL renderer — required for Docker/Linux headless rendering
// On macOS/Windows, comment this out and use 'angle' instead
Config.setChromiumOpenGlRenderer('swangle');

// Use system Chromium when CHROMIUM_PATH env var is set (Docker)
const chromiumPath = process.env.CHROMIUM_PATH;
if (chromiumPath) {
  Config.setBrowserExecutable(chromiumPath);
}

// Concurrency — number of browser tabs rendering in parallel
// Lower this if you see memory issues
Config.setConcurrency(2);
