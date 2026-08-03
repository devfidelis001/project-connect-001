const express = require("express");
const cors = require("cors");

const app = express();

const PORT = 3000;

// Middleware
app.use(express.json());
app.use(cors());

// Temporary storage for jobs
let jobs = [];

// Home route
app.get("/", (req, res) => {
    res.send("THIS IS MY NEW BACKEND");
});

// Post a new job
app.post("/jobs", (req, res) => {
    const job = req.body;

    jobs.push(job);

    console.log("New Job Posted:", job);

    res.status(201).json({
        message: "Job posted successfully!",
        job: job
    });
});

// Get all jobs
app.get("/jobs", (req, res) => {
    res.json(jobs);
});

// Start server
app.listen(PORT, () => {
    console.log(`Server is running on http://localhost:${PORT}`);
});