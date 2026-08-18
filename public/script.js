const cameraView = document.querySelector('.camera-view');
const infoTitle = document.querySelector('.info-box h1');
const infoText = document.querySelector('.info-box p');

let video = null;
let recognitionStarted = false;
let isSearching = false; // Prevents commands during simulation / active search
let detectionRunning = false;
let targetObject = null;
let objectFound = false;
let isSpeaking = false;

// ---- NEW: registered custom objects ----
// targetObject stays a COCO class name (e.g. "bottle") since that's what
// the detection block matches against — it is not touched. displayName
// is purely cosmetic: what gets spoken/shown instead of the raw class
// name, when the user's spoken command matched something they registered.
let cachedRegisteredObjects = [];
let targetDisplayName = null;

async function loadRegisteredObjects() {
    try {
        const res = await fetch("/api/objects");
        const data = await res.json();
        cachedRegisteredObjects = data.objects || [];
    } catch (e) {
        console.warn("Could not load registered objects:", e);
    }
}
loadRegisteredObjects();

// ============================================================
// Simple candidate resolver — picks the single most confident box
// matching the target class this frame. Replaces the earlier MobileNet
// similarity-matching version: no specific-instance matching for now,
// just reliable class-based detection + collinear alignment.
// ============================================================
function resolveTargetCandidate(candidates) {
    if (candidates.length === 0) return null;
    return candidates.reduce((a, b) => (a.score > b.score ? a : b));
}

// ---- NEW: real native recognizer state tracking ----
// recognitionStarted = user's intent ("mic should be on").
// recognitionActive  = what the browser's SpeechRecognition object is
// ACTUALLY doing right now. These can drift apart (e.g. a start() call
// silently throws InvalidStateError) — tracking both lets us avoid
// calling start()/stop() when it's already in that state, which is what
// was causing "find bottle" to sometimes never reach onresult.
let recognitionActive = false;
let restartTimeout = null;

// ---- NEW: multi-frame confirmation state ----
// A single lucky frame at low confidence should not be enough to declare
// "found". We require several consecutive/cumulative frames above the
// threshold before we trust the detection.
let candidateFrames = 0;
const REQUIRED_FRAMES = 2; // lowered for demo reliability (was 4)

// ---- NEW: collinear alignment state ----
// Tracks whether the target object is centered in frame (left/right of
// canvas center), independent of the detection/parsing logic itself.
let lastAlignState = null;
let alignStableCount = 0;
const ALIGN_TOLERANCE_RATIO = 0.08; // ~8% of canvas width counts as centered
const ALIGN_STABLE_FRAMES = 3;

/**
 * Pure alignment/navigation logic — takes a box center X (in the same
 * 640-wide canvas coordinate space YOLO already outputs) and the canvas
 * width, and speaks a turn-left/turn-right/aligned instruction.
 * Does NOT touch detection/parsing — only consumes the x,y,w,h that the
 * detection block already computed for the matched target.
 */
function handleAlignment(boxCenterX, canvasWidth) {
    const frameCenterX = canvasWidth / 2;
    const offsetRatio = (boxCenterX - frameCenterX) / canvasWidth;

    let state;
    let message = null;

    if (Math.abs(offsetRatio) <= ALIGN_TOLERANCE_RATIO) {
        state = "ALIGNED";
        alignStableCount++;
        if (alignStableCount >= ALIGN_STABLE_FRAMES) {
            if (lastAlignState !== "ALIGNED_CONFIRMED") {
                message = "Aligned, object straight ahead.";
                lastAlignState = "ALIGNED_CONFIRMED";
            }
        }
    } else if (offsetRatio < 0) {
        state = "TURN_LEFT";
        alignStableCount = 0;
        if (lastAlignState !== "TURN_LEFT") {
            message = Math.abs(offsetRatio) > ALIGN_TOLERANCE_RATIO * 3
                ? "Turn left"
                : "Turn slightly left";
            lastAlignState = "TURN_LEFT";
        }
    } else {
        state = "TURN_RIGHT";
        alignStableCount = 0;
        if (lastAlignState !== "TURN_RIGHT") {
            message = Math.abs(offsetRatio) > ALIGN_TOLERANCE_RATIO * 3
                ? "Turn right"
                : "Turn slightly right";
            lastAlignState = "TURN_RIGHT";
        }
    }

    if (message && !isSpeaking) {
        speak(message);
    }
}

function resetAlignmentState() {
    lastAlignState = null;
    alignStableCount = 0;
}


const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
const recognition = new SpeechRecognition();
recognition.lang = 'en-US';
recognition.continuous = false;
recognition.interimResults = false;

// Helper to update screen flow UI texts
function updateUI(title, text) {
    infoTitle.textContent = title;
    infoText.textContent = text;
}

function safeStartRecognition() {
    // NEW: also bail if we already believe recognition is active, instead
    // of relying purely on try/catch to discover that.
    if (isSpeaking || !recognitionStarted || recognitionActive) return;
    try {
        recognition.start();
    } catch (e) {
        // Recognition is already starting or active according to the
        // browser even though our flag disagreed (rare race). Instead of
        // silently swallowing this and leaving the mic dead, retry shortly.
        scheduleRestart(300);
    }
}

function safeStopRecognition() {
    // NEW: skip the call entirely if we don't think it's running — avoids
    // redundant stop() calls that can themselves throw.
    if (!recognitionActive) return;
    try {
        recognition.stop();
    } catch (e) {}
}

// NEW: debounced restart. Browsers sometimes need a short gap after a
// stop()/natural end before start() is valid again — calling it in the
// same tick (as the old onend handler did) could itself throw and get
// silently swallowed. This also prevents multiple overlapping restart
// requests from stacking up.
function scheduleRestart(delay = 250) {
    if (restartTimeout) return;
    restartTimeout = setTimeout(() => {
        restartTimeout = null;
        safeStartRecognition();
    }, delay);
}

function speak(text, callback) {
    safeStopRecognition();
    speechSynthesis.cancel();
    isSpeaking = true;
    console.log("🔊 Speaking:", text); // NEW: matches expected console trace

    const utterance = new SpeechSynthesisUtterance(text);

    utterance.onend = () => {
        isSpeaking = false;
        console.log("🔊 Speech finished."); // NEW
        if (callback) callback();
        // Automatically resume listening only if we aren't in the middle of a search simulation
        if (recognitionStarted) {
            // NEW: debounced instead of immediate — gives the browser a
            // beat to fully release the mic from the stop() above.
            scheduleRestart(150);
        }
    };

    utterance.onerror = () => {
        isSpeaking = false;
        if (recognitionStarted) {
            scheduleRestart(150);
        }
    };

    speechSynthesis.speak(utterance);
}

// ============================================================
// Canvas reference
// ============================================================
// NEW: canvas now lives permanently inside .camera-view in index.html,
// and its overlay positioning (position/inset/size/z-index/pointer-events)
// is handled entirely in style.css (#yoloCanvas rule). No inline styling
// or DOM-relocation needed here anymore — just grab the reference once.
const canvas = document.getElementById("yoloCanvas");
const ctx = canvas.getContext("2d", { willReadFrequently: true });

async function openCamera() {

    if (video) return;

    try {

        const stream = await navigator.mediaDevices.getUserMedia({

            video: {
                facingMode: {
                    ideal: "environment"
                }
            }

        });

        video = document.createElement("video");

        video.srcObject = stream;

        video.autoplay = true;
        video.playsInline = true;
        video.muted = true;

        video.style.width = "100%";
        video.style.height = "100%";
        video.style.objectFit = "cover";
        video.style.position = "absolute";
        video.style.inset = "0";

        // FIX: previously "cameraView.innerHTML = \"\"" wiped out every
        // child of .camera-view, including the yoloCanvas element — the
        // `canvas` variable would then point to a detached node, so every
        // strokeRect()/fillText() call after this succeeded silently but
        // never appeared on screen. Canvas now lives in the HTML markup
        // itself (see index.html) and is never removed, so we only need
        // to insert the video BEHIND it — using insertBefore instead of
        // innerHTML-wiping the container keeps the canvas exactly where
        // it already is in the DOM.
        const oldVideo = cameraView.querySelector("video");
        if (oldVideo) oldVideo.remove();
        cameraView.insertBefore(video, canvas);

        // NEW: hide the "Camera Off / Tap to activate" placeholder text
        // now that the live feed is showing underneath it — same markup,
        // just no longer visible once the camera is actually on.
        const statusEl = cameraView.querySelector(".camera-status");
        const actionEl = cameraView.querySelector(".camera-action");
        if (statusEl) statusEl.style.display = "none";
        if (actionEl) actionEl.style.display = "none";

        await video.play();

        await new Promise(resolve => {

            if (video.readyState >= 2) {

                resolve();

            } else {

                video.onloadeddata = resolve;

            }

        });

        console.log("📷 Camera opened successfully."); // NEW

        // UX Change 3: Update screen and short, natural voice prompt

        updateUI("Camera Active", "Ready to find objects.");

        recognitionStarted = true;
        speak("Camera is ready. What would you like to find?");

        if (!detectionRunning) {

            detectionRunning = true;

            detectObjects();

        }

    }

    catch (err) {

        console.error("Camera Error:", err);

        updateUI("Camera Error", "Permission denied.");

        speak("Unable to open the camera.");

    }

}

// UX Change 6: Simulates object search logic
// NOTE: kept as-is (dead code) per original file — no longer called,
// startObjectSearch() replaced it. Left untouched intentionally.
function simulateObjectSearch(objectName) {

    isSearching = true;

    safeStopRecognition(); // Stop listening during simulation

    // UX Change 5 & 9: Update screen flow status to "Searching"

    updateUI("Searching", `Looking for ${objectName}...`);

    setTimeout(() => {

        // UX Change 6 & 9: Screen flow updates to "Object Found" after 2.5 seconds

        updateUI(
            "Object Found",
            `${objectName.charAt(0).toUpperCase() + objectName.slice(1)} detected.`
        );

        speak(`${objectName} detected.`, () => {

            isSearching = false; // Reset flag after speaking finishes

        });

    }, 2500);

}

// Start universal object search
function startObjectSearch(objectName) {
    let spoken = objectName.toLowerCase().trim();
    // Clean common leading articles
    spoken = spoken.replace(/^(a|an|the)\s+/, "").trim();

    // NEW: check if the spoken phrase matches a registered custom object
    // (e.g. "my bottle"). If so, detection still targets the COCO class
    // it was registered under (e.g. "bottle" — unchanged detection math),
    // but we remember the friendly name to speak/display instead.
    const registeredMatch = cachedRegisteredObjects.find(obj => spoken.includes(obj.name));

    if (registeredMatch) {
        targetObject = registeredMatch.type;      // what detection matches against
        targetDisplayName = registeredMatch.name; // what gets spoken/shown
    } else {
        targetObject = spoken;
        targetDisplayName = spoken;
    }

    objectFound = false;
    isSearching = true;

    // NEW: reset the frame-confirmation counter every time a new search
    // starts, so a stale count from a previous target can't carry over.
    candidateFrames = 0;
    resetAlignmentState(); // NEW: also reset alignment so old left/right state doesn't carry over

    updateUI(
        "Finding Object",
        `Looking for ${targetDisplayName}...`
    );

    speak(`Looking for ${targetDisplayName}.`);
}

recognition.onresult = (e) => {

    const text = e.results[e.results.length - 1][0].transcript
        .toLowerCase()
        .trim();

    console.log("🎤 Heard:", text);

    if (!video) {

        // Camera Phase Commands

        if (
            text.includes("open camera") ||
            text.includes("start camera") ||
            text.includes("camera")
        ) {

            console.log("📷 Camera command recognized."); // NEW
            console.log("📷 Opening camera..."); // NEW
            openCamera();

        } else {

            // UX Change 2 & 10: Show text hint, do not repeat spoken failure prompt

            updateUI(
                "Listening",
                "Command not recognized. Try saying: Open Camera."
            );

        }

    } else {

        // Object Finding Phase Commands

        if (
            text.includes("find") ||
            text.includes("search for") ||
            text.includes("look for")
        ) {

            let target = text.replace(/^(find|search for|look for)\s+/, "").trim();

            if (target) {

                // simulateObjectSearch(target);
                startObjectSearch(target);

            } else {

                updateUI(
                    "Camera Active",
                    "Please specify an object. Try: Find bottle."
                );

            }

        } else {

            updateUI(
                "Camera Active",
                "Command not recognized. Try saying: Find [object]."
            );

        }

    }

};

// NEW: onstart is the actual confirmation the native recognizer is
// running — this is what recognitionActive is keyed off of.
recognition.onstart = () => {
    recognitionActive = true;
    console.log("🎤 Speech recognition started.");
    console.log("🎤 Microphone is listening.");
};

recognition.onend = () => {

    recognitionActive = false; // NEW
    console.log("🎤 Speech recognition ended."); // NEW

    // Keep mic alive unless a search simulation turns it off deliberately
    if (recognitionStarted && !isSpeaking) {
        // NEW: debounced restart instead of immediate, see scheduleRestart()
        scheduleRestart();
    }

};

recognition.onerror = (e) => {
    if (e.error !== 'no-speech') {
        console.warn("🎤 Speech recognition error:", e.error);
    } else {
        console.log("🎤 No speech detected."); // NEW
        // NEW: no restart triggered here directly — onend fires right
        // after onerror in every browser tested, and handles the
        // (debounced) restart. Restarting from both places was a source
        // of the double-start races.
    }
};

cameraView.addEventListener("click", () => {

    // UX Change 7: Ignore additional taps if already active

    if (recognitionStarted) return;

    recognitionStarted = true;

    // UX Change 4 & 9: Screen flow updates to "Listening" status

    updateUI("Listening", "Speak your command");

    // UX Change 1: Updated entry voice prompt

    speak("Visionaire is listening.");

});

//checking yolo

let yolo = null;

async function loadYOLO() {
    console.log("🤖 Loading YOLO...");
    try {
        // FIX: path corrected to match the actual folder structure
        // (public/models/yolov8n.onnx — confirmed plural "models" folder).
        // FIX: executionProviders pinned to ["wasm"] explicitly — without
        // this, onnxruntime-web probes for a WebGPU adapter first by
        // default, which is what produced the harmless-but-noisy
        // "No available adapters" console error on devices/browsers
        // without WebGPU support, and wastes a bit of startup time on
        // every load.
        yolo = await ort.InferenceSession.create(
            "models/yolov8n.onnx",
            { executionProviders: ["wasm"] }
        );
        console.log("🤖 YOLO model loaded successfully.");

        // NEW: log the model's real input/output names so we stop assuming
        // "images" / "output0" are correct. If these don't match what the
        // rest of the code references, detection will silently fail.
        console.log("🤖 YOLO input names:", yolo.inputNames);
        console.log("🤖 YOLO output names:", yolo.outputNames);

    } catch (e) {
        console.error("🤖 YOLO load failed:", e);
    }
}

loadYOLO();

// //canvas
// const canvas = document.getElementById("yoloCanvas");
// const ctx = canvas.getContext("2d");


// //detection loop

// function startDetection() {
//     if (!video || !yolo) return;

//     setInterval(() => {

//         canvas.width = video.videoWidth;
//         canvas.height = video.videoHeight;

//         ctx.drawImage(
//             video,
//             0,
//             0,
//             canvas.width,
//             canvas.height
//         );

//         console.log("Frame captured");

//     }, 1000);
// }

// startDetection();         The frame capture test was only for checking the connection between your camera and the AI pipeline.


//main workflow of detection

// NOTE: willReadFrequently added — we call getImageData() every frame,
// and Chrome otherwise warns/deoptimizes for that access pattern.
// FIX: canvas/ctx are now declared once, near the top of the file (see
// the "FIX: canvas overlay setup" block above), so openCamera() can
// re-attach the SAME element on every camera start. Re-declaring them
// here with const would also throw a duplicate-declaration error, so
// those two lines are removed — everything below still uses the same
// `canvas` / `ctx` references as before.

const classes = [
    "person", "bicycle", "car", "motorcycle", "airplane", "bus", "train", "truck", "boat", "traffic light",
    "fire hydrant", "stop sign", "parking meter", "bench", "bird", "cat", "dog", "horse", "sheep", "cow",
    "elephant", "bear", "zebra", "giraffe", "backpack", "umbrella", "handbag", "tie", "suitcase", "frisbee",
    "skis", "snowboard", "sports ball", "kite", "baseball bat", "baseball glove", "skateboard", "surfboard",
    "tennis racket", "bottle", "wine glass", "cup", "fork", "knife", "spoon", "bowl", "banana", "apple",
    "sandwich", "orange", "broccoli", "carrot", "hot dog", "pizza", "donut", "cake", "chair", "couch",
    "potted plant", "bed", "dining table", "toilet", "tv", "laptop", "mouse", "remote", "keyboard", "cell phone",
    "microwave", "oven", "toaster", "sink", "refrigerator", "book", "clock", "vase", "scissors", "teddy bear",
    "hair drier", "toothbrush"
];

let lastDetectTime = 0;
const DETECT_INTERVAL = 250; // MobileNet similarity checks were removed, so plain YOLO inference is lighter — 250ms (~4 checks/sec) balances responsiveness against camera lag.

// NOTE: threshold left moderate (not cranked to 0.45) because raw
// confidence was already topping out around 0.20 on the stretched image.
// The real fix for low confidence is (a) letterboxing below, instead of
// stretching the frame, and (b) requiring REQUIRED_FRAMES consistent hits
// instead of trusting one frame. Raising this too high would just mean
// "never fires" rather than "fires reliably".
const CONFIDENCE_THRESHOLD = 0.25;

async function detectObjects() {

    if (!video || !yolo || video.readyState < 2) {
        requestAnimationFrame(detectObjects);
        return;
    }

    const now = performance.now();
    if (now - lastDetectTime < DETECT_INTERVAL) {
        requestAnimationFrame(detectObjects);
        return;
    }
    lastDetectTime = now;

    // NEW: skip the expensive inference entirely when nobody asked to find
    // anything. Previously YOLO ran continuously (even before "find bottle"
    // was ever said), burning CPU/GPU for no reason. We still keep the
    // requestAnimationFrame loop alive so detection resumes instantly the
    // moment isSearching flips true.
    if (!isSearching) {
        requestAnimationFrame(detectObjects);
        return;
    }

    canvas.width = 640;
    canvas.height = 640;

    // ---- NEW: letterbox instead of stretch ----
    // Directly drawing the video into a 640x640 square distorts the aspect
    // ratio (a typical webcam is ~16:9), which warps object proportions
    // before YOLO ever sees them. Instead we scale the frame to fit inside
    // 640x640 while preserving its aspect ratio, and pad the rest with
    // black bars. Because the canvas itself is the model's input AND what
    // we draw boxes on, box coordinates from the model line up correctly
    // with this padded canvas with no extra remapping needed.
    const vw = video.videoWidth;
    const vh = video.videoHeight;
    const scale = Math.min(640 / vw, 640 / vh);
    const drawW = vw * scale;
    const drawH = vh * scale;
    const offsetX = (640 - drawW) / 2;
    const offsetY = (640 - drawH) / 2;

    ctx.fillStyle = "black";
    ctx.fillRect(0, 0, 640, 640);
    ctx.drawImage(
        video,
        0, 0, vw, vh,               // source: full video frame
        offsetX, offsetY, drawW, drawH // destination: centered, aspect-preserved
    );

    const imageData = ctx.getImageData(0, 0, 640, 640);
    const data = imageData.data;

    // High-performance CHW conversion directly from typed arrays
    const chw = new Float32Array(3 * 640 * 640);
    const pixels = 640 * 640;

    for (let i = 0; i < pixels; i++) {
        chw[i] = data[i * 4] / 255.0;              // Red
        chw[i + pixels] = data[i * 4 + 1] / 255.0;  // Green
        chw[i + (2 * pixels)] = data[i * 4 + 2] / 255.0; // Blue
    }

    //creating tensor for yolo model
    const tensor = new ort.Tensor(
        "float32",
        chw,
        [1, 3, 640, 640]
    );

    //creating input for yolo
    const feeds = {
        images: tensor
    };

    //running yolo model
    try {

        const results = await yolo.run(feeds);
        const output = results.output0.cpuData;

        // NEW: one-time-ish sanity check on the actual output length.
        // YOLOv8n's default export is 84 x 8400 = 705600. If this number
        // doesn't match, the parsing loop below (which assumes 84 x 8400)
        // will read garbage and confidences will look artificially low.
        if (output.length !== 84 * 8400) {
            console.warn(
                "⚠️ Unexpected YOLO output length:", output.length,
                "expected", 84 * 8400, "— parsing below may be wrong."
            );
        }

        // Clear overlay before rendering current frame detections
        ctx.clearRect(0, 0, 640, 640);
        ctx.fillStyle = "black";
        ctx.fillRect(0, 0, 640, 640);
        ctx.drawImage(
            video,
            0, 0, vw, vh,
            offsetX, offsetY, drawW, drawH
        );

        // Track whether the target was seen at all in this frame, so we
        // can decay the candidateFrames counter when it's briefly lost.
        let seenThisFrame = false;

        // FIX: this was referenced below (.push, then passed to the
        // resolver) but never declared — every frame that found a match
        // threw "ReferenceError: matchingCandidates is not defined",
        // which the catch block below logged as "YOLO Error:". This was
        // the actual cause of the recurring YOLO error.
        let matchingCandidates = [];

        // Loop through all 8400 predictions
        for (let i = 0; i < 8400; i++) {

            let bestClass = -1;
            let bestScore = 0;

            // Check all 80 classes
            for (let c = 0; c < 80; c++) {

                const score = output[(4 + c) * 8400 + i];

                if (score > bestScore) {

                    bestScore = score;
                    bestClass = c;

                }

            }

            // Ignore weak detections
            if (bestScore < CONFIDENCE_THRESHOLD) continue;

            const detectedClassName = classes[bestClass].toLowerCase();
  if (detectedClassName === "bottle" && bestScore >= 0.15) {
    console.log(
        "🍾 BOTTLE CANDIDATE:",
        "confidence =", bestScore,
        "x =", output[i],
        "y =", output[8400 + i],
        "w =", output[8400 * 2 + i],
        "h =", output[8400 * 3 + i]
    );
}

            // Collect every box matching the target CLASS instead of
            // acting on it immediately — with multiple matching objects in
            // frame, this loop can hit more than one. We resolve down to a
            // single winner (highest confidence) right after the loop.
            // Class/score extraction above this point is unchanged.
            if (
    isSearching &&
    targetObject &&
    detectedClassName === targetObject &&
    bestScore >= CONFIDENCE_THRESHOLD
) {
                matchingCandidates.push({
                    x: output[i],
                    y: output[8400 + i],
                    w: output[8400 * 2 + i],
                    h: output[8400 * 3 + i],
                    score: bestScore,
                    classIndex: bestClass
                });
            }

        }

        // Resolve the single correct box out of every candidate that
        // matched the target class this frame — the most confident
        // detection wins. Only this one box gets drawn/aligned/confirmed,
        // so multiple objects of the same class in frame don't all light
        // up at once.
        const winner = resolveTargetCandidate(matchingCandidates);

        if (winner) {

            seenThisFrame = true;

            const { x, y, w, h, classIndex, score } = winner;

            ctx.strokeStyle = "lime";
            ctx.lineWidth = 5;

            ctx.strokeRect(
                x - w / 2,
                y - h / 2,
                w,
                h
            );

            ctx.fillStyle = "#00ff66";
            ctx.font = "22px Arial";

            ctx.fillText(
                `${classes[classIndex]} ${(score * 100).toFixed(0)}%`,
                x - w / 2,
                y - h / 2 - 8
            );

            // NEW: collinear alignment — uses the same x/canvas width
            // already computed above, doesn't touch detection/parsing.
            handleAlignment(x, canvas.width);

            // NEW: require REQUIRED_FRAMES consistent hits above
            // threshold before trusting the detection, instead of
            // declaring "found" off a single frame.
            if (!objectFound) {
                candidateFrames++;

                if (candidateFrames >= REQUIRED_FRAMES) {
                    objectFound = true;
                    console.log("TARGET FOUND:", classes[classIndex]);

                    // NEW: speak the registered friendly name (e.g. "my bottle")
                    // if this search came from a registered object match,
                    // otherwise fall back to the raw detected class name.
                    // The detection/scoring logic above this line is unchanged.
                    const announceName = targetDisplayName || classes[classIndex];

                    updateUI(
                        "Object Found",
                        `${announceName.charAt(0).toUpperCase() + announceName.slice(1)} detected.`
                    );

                    speak(`${announceName} detected.`);
                }
            }

        }

        // NEW: if the target wasn't seen this frame, decay the counter
        // instead of leaving it stuck at a high value from noise. This
        // stops one-off flickers from carrying over across frames.
        if (!seenThisFrame && !objectFound) {
            candidateFrames = Math.max(0, candidateFrames - 1);
        }

    } catch (error) {

        console.error("YOLO Error:", error);

    }

    requestAnimationFrame(detectObjects);

}
