# Backdrop

Live background replacement for your camera. Choose any photo and Backdrop cuts you out of the camera feed and places you in front of it, in real time. It runs entirely in the browser on your device, so your video and photos are never uploaded.

Works in current Chrome, Edge, Safari and Firefox on Windows, macOS, Linux, Android, iPhone and iPad.

**Open it:** https://kckc101.github.io/gs/

## Run it on this computer

Double-click **Start Backdrop.cmd**. It starts a small local server and opens http://localhost:8080.

Or from a terminal in this folder:

```
node serve.mjs --open
```

Requires Node.js (any current version). There is nothing to install or build.

## Use it on a phone or tablet

Browsers only allow the camera on `https://` pages, so a phone needs an https address. You have two options.

**Same Wi-Fi, quick test.** Run `node serve.mjs --https` on this computer and open the `https://192.168.x.x:8443` address it prints on your phone. The phone will warn that the certificate isn't trusted. Choose Advanced › Proceed (on iPhone, Show details › visit this website).

**Any device, anywhere (recommended).** Put this folder on any static https host. There's no build step:

- **Netlify Drop:** drag the folder onto https://app.netlify.com/drop
- **GitHub Pages:** push the folder to a repository and turn on Pages
- **Cloudflare Pages:** upload the folder as a direct upload project

Then open the link on any device. On a phone, use Share › Add to Home Screen (iPhone) or Install app (Android, desktop Chrome and Edge) to get an app icon. After the first visit, it also works offline.

## Use it in Zoom, Teams, Meet and other call apps

Call apps can't use a browser tab as a camera, so use OBS Studio (free) as the bridge:

1. Install OBS Studio from https://obsproject.com and open it.
2. In Backdrop, press **Pop out** (top right of the preview) and keep that small window visible. In Firefox, use **Focus view** (press F) instead.
3. In OBS, add a **Window Capture** source and pick the pop-out window. If the capture is black, set Capture Method to "Windows 10 (1903 and up)".
4. Press **Start Virtual Camera** in OBS.
5. In your call app, pick **OBS Virtual Camera** as the camera.

To place yourself over slides or a game, choose the **Green screen** background in Backdrop and add a Chroma Key filter to the source in OBS.

## Controls

| Control | What it does |
| --- | --- |
| Background tiles | Off, Blur, built-in scenes, or your own photos (Add photo, drag and drop, or paste) |
| Drag / pinch / scroll on the preview | Move and zoom your photo; double-click resets |
| Depth blur | Defocuses the photo like a real lens |
| Edge position | Pulls the cutout in (hides halos) or out (keeps hair) |
| Edge softness | Softens the outline |
| Light wrap | Lets background light spill onto your edges |
| Match lighting | Tints you toward the background's colour and brightness |
| Steadiness | Calms edge flicker; lower it if fast moves trail |
| Cutout quality | **Best** (cleaner hair, 16 MB download, default) or **Fast** (lighter) |
| Space / R / F | Take a photo / start or stop recording / focus view |

## Troubleshooting

| Problem | Fix |
| --- | --- |
| "Camera access is blocked" | Allow the camera for this site in the browser's address bar. On Windows, also check Settings › Privacy & security › Camera. On iPhone, Settings › your browser › Camera. |
| "Your camera is busy" | Close the other app using the camera (Zoom, Teams, OBS's own camera source, Windows Camera). |
| The cutout looks wrong or blank | Camera tab › Processing › **Processor (CPU)**. Some graphics drivers misbehave. |
| Video is choppy | Choose 480p, or the Fast cutout. Backdrop also switches to Fast automatically when Best is too slow. |
| Cutout leaks into a busy background | Use the Best cutout and good front lighting. A plain wall behind you helps most. |
| Camera doesn't start inside Instagram, Facebook, TikTok, etc. | Those in-app browsers block cameras. Open the link in Safari or Chrome. |
| iPhone forgot my photos | Safari clears website data after 7 days without a visit. Add Backdrop to the Home Screen to keep it. |
| HEIC photo won't open | Backdrop converts HEIC automatically, but that needs an internet connection the first time. Otherwise export as JPG. |

## What's handled for you

- **Engine fallbacks:** the cutout falls back from the graphics chip to the processor, from the Best model to Fast, and from WebGL 2 to a basic renderer, so it runs even on old devices.
- **Camera quirks:** camera requests retry with looser settings, iPhones get inline video, the camera reconnects after the app is backgrounded, phone rotation is followed, and the screen is kept awake.
- **Photos:** EXIF rotation, HEIC conversion, and downscaling of huge photos to a size phone GPUs can handle. Transparent PNGs get a white backing.
- **Background tabs:** the pop-out window and recordings keep running when you switch tabs.
- **Recording:** MP4 where the browser supports it (WebM otherwise). The frame size is locked during a recording so rotating a phone doesn't corrupt the file.

## Files

```
index.html, styles.css      the app page
js/app.js                   camera, controls, capture, pop-out
js/segmenter.js             person segmentation (MediaPipe)
js/renderer-gl.js           WebGL 2 compositor: edge refine, light wrap, lighting match
js/renderer-2d.js           fallback compositor for browsers without WebGL 2
js/plates.js                built-in scenes and photo decoding
js/store.js                 saves your photos in the browser (IndexedDB)
sw.js, manifest.webmanifest offline support and install
vendor/mediapipe/           MediaPipe Tasks Vision 1.0.1 (Apache 2.0)
models/                     MediaPipe selfie segmentation models (Apache 2.0)
serve.mjs                   local http/https server, no dependencies
```

HEIC conversion uses heic2any (MIT), loaded from jsDelivr only when a HEIC photo needs converting.
