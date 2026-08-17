const uploadArea = document.getElementById("uploadArea");
const objectImage = document.getElementById("objectImage");
const previewContainer = document.getElementById("previewContainer");
const imagePreview = document.getElementById("imagePreview");
const removeImage = document.getElementById("removeImage");
const objectName = document.getElementById("objectName");
const objectType = document.getElementById("objectType");
const saveObject = document.getElementById("saveObject");
const statusMessage = document.getElementById("statusMessage");

let selectedImage = null;

// ---- face-api model loading (only needed when registering a person) ----
const FACE_MODELS_URL = "https://cdn.jsdelivr.net/gh/justadudewhohacks/face-api.js@master/weights";
let faceModelsReady = false;

async function loadFaceModels() {
    try {
        await faceapi.nets.tinyFaceDetector.loadFromUri(FACE_MODELS_URL);
        await faceapi.nets.faceLandmark68Net.loadFromUri(FACE_MODELS_URL);
        await faceapi.nets.faceRecognitionNet.loadFromUri(FACE_MODELS_URL);
        faceModelsReady = true;
        console.log("🧠 Face models loaded (register page).");
    } catch (e) {
        console.warn("Face models failed to load — face registration will be skipped.", e);
    }
}
loadFaceModels();

// Tapping the upload tile opens the file picker
uploadArea.addEventListener("click", () => objectImage.click());

objectImage.addEventListener("change", function () {
    const file = this.files[0];
    if (!file) return;

    if (!file.type.startsWith("image/")) {
        statusMessage.textContent = "Please select an image.";
        return;
    }

    selectedImage = file;
    imagePreview.src = URL.createObjectURL(file);

    uploadArea.style.display = "none";
    previewContainer.style.display = "flex";
    removeImage.style.display = "inline-block";
    statusMessage.textContent = "";
});

removeImage.addEventListener("click", () => {
    selectedImage = null;
    objectImage.value = "";
    imagePreview.src = "";

    previewContainer.style.display = "none";
    removeImage.style.display = "none";
    uploadArea.style.display = "flex";
    statusMessage.textContent = "";
});

// Returns a 128-value face descriptor array, null if no face found, or
// undefined if the models aren't ready yet.
async function extractFaceDescriptor(imgEl) {
    if (!faceModelsReady) return undefined;

    const detection = await faceapi
        .detectSingleFace(imgEl, new faceapi.TinyFaceDetectorOptions())
        .withFaceLandmarks()
        .withFaceDescriptor();

    if (!detection) return null;
    return Array.from(detection.descriptor);
}

saveObject.addEventListener("click", async () => {
    const name = objectName.value.trim();
    const type = objectType.value.trim();

    if (!selectedImage) {
        statusMessage.textContent = "Please upload a photo first.";
        return;
    }
    if (!name) {
        statusMessage.textContent = "Please enter a name.";
        objectName.focus();
        return;
    }
    if (!type) {
        statusMessage.textContent = "Please enter a type.";
        objectType.focus();
        return;
    }

    const formData = new FormData();
    formData.append("image", selectedImage);
    formData.append("name", name);
    formData.append("type", type);

    // If registering a person, attach a face descriptor so the camera
    // page can recognize them later via "who is in front of me".
    if (type.toLowerCase().includes("person") || type.toLowerCase().includes("face")) {
        statusMessage.textContent = "Scanning face...";
        const descriptor = await extractFaceDescriptor(imagePreview);

        if (descriptor === undefined) {
            statusMessage.textContent = "Face models still loading — try again in a moment.";
            return;
        }
        if (descriptor === null) {
            statusMessage.textContent = "No face detected in that photo. Try a clearer, front-facing picture.";
            return;
        }
        formData.append("faceDescriptor", JSON.stringify(descriptor));
    }

    statusMessage.textContent = "Registering...";

    try {
        const res = await fetch("/api/register-object", {
            method: "POST",
            body: formData
        });
        const data = await res.json();

        if (!data.success) {
            statusMessage.textContent = data.message || "Something went wrong.";
            return;
        }

        statusMessage.textContent = `Saved. Say "${name}" from the camera screen to find it.`;

        // reset the form for the next registration
        objectName.value = "";
        objectType.value = "";
        selectedImage = null;
        objectImage.value = "";
        imagePreview.src = "";
        previewContainer.style.display = "none";
        removeImage.style.display = "none";
        uploadArea.style.display = "flex";
    } catch (err) {
        console.error("Registration error:", err);
        statusMessage.textContent = "Could not reach the server. Try again.";
    }
});
