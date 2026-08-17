const express = require("express");
const multer = require("multer");
const path = require("path");
const fs = require("fs");
const app = express();

// ========================================
// PATHS — matches the project folder tree
// ========================================
const publicFolder = path.join(__dirname, "public");
const registeredImagesFolder = path.join(__dirname, "registered_images");
const dataFolder = path.join(__dirname, "data");
const DB_FILE = path.join(dataFolder, "objects.json");

if (!fs.existsSync(registeredImagesFolder)) fs.mkdirSync(registeredImagesFolder, { recursive: true });
if (!fs.existsSync(dataFolder)) fs.mkdirSync(dataFolder, { recursive: true });
if (!fs.existsSync(DB_FILE)) fs.writeFileSync(DB_FILE, "[]");

// ========================================
// STATIC SERVING
// ========================================
app.use(express.json());
app.use(express.static(publicFolder));
// registered_images lives outside /public, so it needs its own static
// route to be reachable by the browser (e.g. img.src = "/registered_images/xyz.jpg")
app.use("/registered_images", express.static(registeredImagesFolder));

// ========================================
// MULTER — image uploads go straight into registered_images/
// ========================================
const storage = multer.diskStorage({
    destination: (req, file, cb) => cb(null, registeredImagesFolder),
    filename: (req, file, cb) => {
        const unique = `${Date.now()}_${file.originalname.replace(/\s+/g, "_")}`;
        cb(null, unique);
    }
});
const upload = multer({ storage: storage });

// ========================================
// data/objects.json HELPERS
// ========================================
function loadObjects() {
    try {
        return JSON.parse(fs.readFileSync(DB_FILE, "utf-8"));
    } catch (e) {
        console.error("DB read error:", e);
        return [];
    }
}

function saveObjects(objects) {
    fs.writeFileSync(DB_FILE, JSON.stringify(objects, null, 2));
}

// ========================================
// REGISTER OBJECT / PERSON
// ========================================
app.post("/api/register-object", upload.single("image"), (req, res) => {
    try {
        if (!req.file) {
            return res.status(400).json({
                success: false,
                message: "No image uploaded."
            });
        }

        const name = req.body.name;
        const type = req.body.type; // e.g. "bottle" (COCO class) or "person"
        const faceDescriptor = req.body.faceDescriptor; // JSON string of 128 numbers, only for people

        if (!name || !type) {
            // Clean up the file multer already wrote, since we're rejecting this request
            fs.unlink(req.file.path, () => {});
            return res.status(400).json({
                success: false,
                message: "Object name and type are required."
            });
        }

        const newObject = {
            id: Date.now().toString(),
            name: name.toLowerCase().trim(),
            type: type.toLowerCase().trim(),
            imageUrl: `/registered_images/${req.file.filename}`,
            faceDescriptor: faceDescriptor ? JSON.parse(faceDescriptor) : null,
            createdAt: new Date().toISOString()
        };

        const objects = loadObjects();
        objects.push(newObject);
        saveObjects(objects);

        console.log("Registered:", newObject.name, `(${newObject.type})`);

        return res.json({
            success: true,
            message: "Registered successfully.",
            object: newObject
        });
    } catch (error) {
        console.error("REGISTER ERROR:", error);
        return res.status(500).json({
            success: false,
            message: "Server error while registering object."
        });
    }
});

// ========================================
// LIST REGISTERED OBJECTS/PEOPLE
// ========================================
app.get("/api/objects", (req, res) => {
    res.json({ success: true, objects: loadObjects() });
});

// ========================================
// DELETE (handy while testing)
// ========================================
app.delete("/api/objects/:id", (req, res) => {
    const objects = loadObjects();
    const target = objects.find(o => o.id === req.params.id);
    const remaining = objects.filter(o => o.id !== req.params.id);
    saveObjects(remaining);

    if (target) {
        const imgPath = path.join(registeredImagesFolder, path.basename(target.imageUrl));
        fs.unlink(imgPath, () => {});
    }

    res.json({ success: true });
});

// ========================================
// HEALTH CHECK
// ========================================
app.get("/api/test", (req, res) => {
    res.json({
        success: true,
        message: "Visionaire-AI API is working."
    });
});

// ========================================
// LOCAL SERVER
// ========================================
if (require.main === module) {
    const PORT = process.env.PORT || 3000;
    app.listen(PORT, () => {
        console.log(`Visionaire-AI server running at http://localhost:${PORT}`);
    });
}

module.exports = app;
