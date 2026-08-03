const express = require("express");
const cors = require("cors");

const app = express();

// Render provides the PORT automatically
const PORT = process.env.PORT || 3000;

// Middleware
app.use(express.json());
app.use(cors());


// Temporary storage for jobs
let jobs = [];


// Home route - test backend
app.get("/", (req, res) => {
    res.send("THIS IS MY NEW BACKEND");
});


// Health check route
app.get("/api/status", (req, res) => {
    res.json({
        status: "Backend is running successfully",
        message: "Your Labour Market API is online"
    });
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


// Delete a job (temporary)
app.delete("/jobs/:id", (req, res) => {

    const id = req.params.id;

    jobs.splice(id, 1);

    res.json({
        message: "Job deleted successfully"
    });

});


// Start server
app.listen(PORT, () => {

    console.log(`Server is running on port ${PORT}`);

});