require("dotenv").config();

const express = require("express");
const cors = require("cors");
const { Pool } = require("pg");

const app = express();

const PORT = process.env.PORT || 3000;


// ==========================
// Middleware
// ==========================

// Default body limit is 100kb which is way too small once photos
// (sent as base64 data URLs) are involved. Raise it so job posts
// with a photo don't silently fail before they even reach your code.
app.use(express.json({ limit: "15mb" }));
app.use(cors());


// ==========================
// PostgreSQL Connection
// ==========================

const pool = new Pool({

    connectionString: process.env.DATABASE_URL,

    ssl: {
        rejectUnauthorized: false
    }

});


// ==========================
// Create Database Tables
// ==========================

async function createTables() {

    try {

        await pool.query(`
        CREATE TABLE IF NOT EXISTS users(
            id SERIAL PRIMARY KEY,
            fullname TEXT NOT NULL,
            email TEXT UNIQUE NOT NULL,
            phone TEXT,
            password TEXT,
            accounttype TEXT,
            location TEXT,
            profession TEXT,
            createdat TEXT
        )
        `);

        await pool.query(`
        CREATE TABLE IF NOT EXISTS jobs(
            id TEXT PRIMARY KEY,
            company TEXT,
            title TEXT,
            location TEXT,
            salary TEXT,
            description TEXT,
            attachment JSONB,
            createdat TEXT,
            isnew BOOLEAN
        )
        `);

        console.log("Database tables ready");

    } catch (error) {

        console.log("Database error:", error.message);

    }

}


createTables();

// ==========================
// BASIC ROUTES
// ==========================

app.get("/", (req, res) => {
    res.send("YOUR LABOUR MARKET BACKEND IS RUNNING");
});

app.get("/api/status", (req, res) => {
    res.json({
        status: "Online",
        message: "Your Labour Market API is working"
    });
});


// ==========================
// ADMIN - GET ALL USERS
// ==========================

app.get("/users", async (req, res) => {
    try {
        const result = await pool.query(
            "SELECT * FROM users ORDER BY id DESC"
        );
        res.json(result.rows);
    } catch (error) {
        res.status(500).json({
            message: "Could not fetch users"
        });
    }
});


// ==========================
// SIGN UP SYSTEM
// ==========================

app.post("/signup", async (req, res) => {

    const user = req.body;

    try {

        await pool.query(
            `
            INSERT INTO users
            (fullname, email, phone, password, accounttype, location, profession, createdat)
            VALUES
            ($1,$2,$3,$4,$5,$6,$7,$8)
            `,
            [
                user.fullname,
                user.email,
                user.phone,
                user.password,
                user.accountType,
                user.location,
                user.profession,
                new Date().toISOString()
            ]
        );

        res.status(201).json({
            message: "Account created successfully"
        });

    } catch (error) {

        console.log(error.message);

        res.status(400).json({
            message: "Signup failed. Email may already exist."
        });

    }

});


// ==========================
// LOGIN SYSTEM
// ==========================

app.post("/login", async (req, res) => {

    const { email, password } = req.body;

    try {

        const result = await pool.query(
            "SELECT * FROM users WHERE email=$1",
            [email]
        );

        if (result.rows.length === 0) {
            return res.status(404).json({
                message: "Account not found"
            });
        }

        const user = result.rows[0];

        if (user.password !== password) {
            return res.status(401).json({
                message: "Incorrect password"
            });
        }

        res.json({
            message: "Login successful",
            user: user
        });

    } catch (error) {

        res.status(500).json({
            message: "Login error"
        });

    }

});


// ==========================
// JOB SYSTEM
// ==========================

// CREATE JOB
app.post("/jobs", async (req, res) => {

    const job = req.body;

    if (!job || !job.id || !job.company || !job.title) {
        return res.status(400).json({
            message: "Missing required job fields (id, company, title)"
        });
    }

    try {

        await pool.query(
            `
            INSERT INTO jobs
            (id, company, title, location, salary, description, attachment, createdat, isnew)
            VALUES
            ($1,$2,$3,$4,$5,$6,$7,$8,$9)
            ON CONFLICT (id) DO NOTHING
            `,
            [
                job.id,
                job.company,
                job.title,
                job.location || "",
                job.salary || "",
                job.description || "",
                // jsonb columns need a JSON string, not a raw JS object
                JSON.stringify(job.attachment || null),
                job.createdAt || new Date().toISOString(),
                !!job.isNew
            ]
        );

        res.status(201).json({
            message: "Job posted successfully",
            job: job
        });

    } catch (error) {

        console.log(error.message);

        res.status(500).json({
            message: "Job posting failed"
        });

    }

});


// GET ALL JOBS
app.get("/jobs", async (req, res) => {

    try {

        const result = await pool.query(
            "SELECT * FROM jobs ORDER BY createdat DESC"
        );

        // Normalize field names back to what the frontend expects
        // (Postgres folds unquoted column names to lowercase).
        const jobs = result.rows.map(row => ({
            id: row.id,
            company: row.company,
            title: row.title,
            location: row.location,
            salary: row.salary,
            description: row.description,
            attachment: row.attachment, // pg already parses jsonb into an object
            createdAt: row.createdat,
            isNew: row.isnew
        }));

        res.json(jobs);

    } catch (error) {

        console.log(error.message);

        res.status(500).json({
            message: "Could not fetch jobs"
        });

    }

});


// DELETE JOB
app.delete("/jobs/:id", async (req, res) => {

    const id = req.params.id;

    try {

        await pool.query(
            "DELETE FROM jobs WHERE id=$1",
            [id]
        );

        res.json({
            message: "Job deleted successfully"
        });

    } catch (error) {

        res.status(500).json({
            message: "Could not delete job"
        });

    }

});


// ==========================
// START SERVER
// ==========================

app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});