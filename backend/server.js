const express = require("express");
const cors = require("cors");
const { Pool } = require("pg");

const app = express();

const PORT = process.env.PORT || 3000;


// Middleware
app.use(express.json());
app.use(cors());


// PostgreSQL connection
const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: {
        rejectUnauthorized: false
    }
});


// Create jobs table
async function createTable() {
    await pool.query(`
        CREATE TABLE IF NOT EXISTS jobs (
            id TEXT PRIMARY KEY,
            company TEXT,
            title TEXT,
            location TEXT,
            salary TEXT,
            description TEXT,
            attachment JSONB,
            createdAt TEXT,
            isNew BOOLEAN
        )
    `);

    console.log("Jobs table ready");
}

createTable();



// Home route
app.get("/", (req, res) => {
    res.send("THIS IS MY NEW BACKEND");
});



// Health check
app.get("/api/status", (req, res) => {

    res.json({
        status: "Backend is running successfully",
        message: "Your Labour Market API is online"
    });

});



// Post a new job
app.post("/jobs", async (req, res) => {

    const job = req.body;


    await pool.query(
        `
        INSERT INTO jobs
        (id, company, title, location, salary, description, attachment, createdAt, isNew)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
        `,
        [
            job.id,
            job.company,
            job.title,
            job.location,
            job.salary,
            job.description,
            job.attachment,
            job.createdAt,
            job.isNew
        ]
    );


    console.log("New Job Posted:", job);


    res.status(201).json({
        message: "Job posted successfully!",
        job: job
    });

});




// Get all jobs
app.get("/jobs", async (req, res) => {

    const result = await pool.query(
        "SELECT * FROM jobs ORDER BY createdAt DESC"
    );

    res.json(result.rows);

});





// Delete job
app.delete("/jobs/:id", async (req, res) => {


    const id = req.params.id;


    await pool.query(
        "DELETE FROM jobs WHERE id=$1",
        [id]
    );


    res.json({

        message: "Job deleted successfully"

    });


});





// Start server
app.listen(PORT, () => {

    console.log(`Server is running on port ${PORT}`);

});