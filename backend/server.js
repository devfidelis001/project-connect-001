require("dotenv").config();

const express = require("express");
const cors = require("cors");
const { Pool } = require("pg");

const app = express();
const PORT = process.env.PORT || 3000;

// ==========================
// Middleware
// ==========================
// Increased body limit to support base64 images and avatar syncs
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
// Create & Migrate Database Tables
// ==========================
async function createTables() {
    try {
        await pool.query(`
        CREATE TABLE IF NOT EXISTS users(
            id SERIAL PRIMARY KEY,
            fullname TEXT NOT NULL,
            email TEXT UNIQUE,
            phone TEXT,
            password TEXT,
            accounttype TEXT,
            location TEXT,
            profession TEXT,
            skills TEXT,
            avatar TEXT,
            createdat TEXT
        )
        `);

        await pool.query(`
        CREATE TABLE IF NOT EXISTS jobs(
            id TEXT PRIMARY KEY,
            user_id TEXT,
            company TEXT,
            title TEXT,
            location TEXT,
            salary TEXT,
            description TEXT,
            attachment JSONB,
            createdat TEXT,
            isnew BOOLEAN,
            author_name TEXT,
            author_phone TEXT,
            author_location TEXT,
            author_avatar TEXT,
            author_role TEXT,
            author_skills TEXT
        )
        `);

        // Automatically patch schema for existing databases missing profile columns
        await pool.query(`
            ALTER TABLE jobs 
            ADD COLUMN IF NOT EXISTS user_id TEXT,
            ADD COLUMN IF NOT EXISTS author_name TEXT,
            ADD COLUMN IF NOT EXISTS author_phone TEXT,
            ADD COLUMN IF NOT EXISTS author_location TEXT,
            ADD COLUMN IF NOT EXISTS author_avatar TEXT,
            ADD COLUMN IF NOT EXISTS author_role TEXT,
            ADD COLUMN IF NOT EXISTS author_skills TEXT;
        `);

        // ==========================
        // Likes / Saves / Applications / Comments
        // ==========================
        await pool.query(`
        CREATE TABLE IF NOT EXISTS job_likes(
            job_id TEXT NOT NULL,
            user_id TEXT NOT NULL,
            createdat TEXT,
            PRIMARY KEY (job_id, user_id)
        )
        `);

        await pool.query(`
        CREATE TABLE IF NOT EXISTS job_saves(
            job_id TEXT NOT NULL,
            user_id TEXT NOT NULL,
            createdat TEXT,
            PRIMARY KEY (job_id, user_id)
        )
        `);

        await pool.query(`
        CREATE TABLE IF NOT EXISTS job_applications(
            job_id TEXT NOT NULL,
            user_id TEXT NOT NULL,
            createdat TEXT,
            PRIMARY KEY (job_id, user_id)
        )
        `);

        await pool.query(`
        CREATE TABLE IF NOT EXISTS job_comments(
            id SERIAL PRIMARY KEY,
            job_id TEXT NOT NULL,
            user_id TEXT,
            author_name TEXT,
            author_avatar TEXT,
            text TEXT NOT NULL,
            createdat TEXT
        )
        `);

        // ==========================
        // Real Chat (Job Seeker <-> Recruiter)
        // ==========================
        await pool.query(`
        CREATE TABLE IF NOT EXISTS chat_messages(
            id SERIAL PRIMARY KEY,
            job_id TEXT NOT NULL,
            seeker_id TEXT NOT NULL,
            sender_id TEXT NOT NULL,
            sender_role TEXT NOT NULL,
            sender_name TEXT,
            sender_avatar TEXT,
            text TEXT NOT NULL,
            createdat TEXT,
            read_by_seeker BOOLEAN DEFAULT FALSE,
            read_by_recruiter BOOLEAN DEFAULT FALSE
        )
        `);

        console.log("Database tables and migration scripts ready.");
    } catch (error) {
        console.log("Database setup error:", error.message);
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
// USER PROFILE SYNC
// ==========================
// Updates user profile and propagates updates to all previously posted content across all devices
app.post("/users/profile", async (req, res) => {
    const { userId, name, phone, location, skills, role, avatar } = req.body;

    if (!userId) {
        return res.status(400).json({ message: "userId is required for profile sync" });
    }

    try {
        // 1. Update or create user record
        await pool.query(
            `
            INSERT INTO users (id, fullname, phone, location, skills, accounttype, avatar, createdat)
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
            ON CONFLICT (id) DO UPDATE SET
                fullname = EXCLUDED.fullname,
                phone = EXCLUDED.phone,
                location = EXCLUDED.location,
                skills = EXCLUDED.skills,
                accounttype = EXCLUDED.accounttype,
                avatar = EXCLUDED.avatar
            `,
            [
                isNaN(parseInt(userId)) ? 1 : parseInt(userId),
                name || "Anonymous",
                phone || "",
                location || "",
                skills || "",
                role || "Jobseeker",
                avatar || "",
                new Date().toISOString()
            ]
        );

        // 2. Cascade update all existing job posts tied to this user/author name
        await pool.query(
            `
            UPDATE jobs
            SET 
                company = $1,
                author_name = $1,
                author_phone = $2,
                author_location = $3,
                author_avatar = $4,
                author_role = $5,
                author_skills = $6
            WHERE user_id = $7 OR author_name = $1 OR company = $1
            `,
            [name, phone, location, avatar, role, skills, userId]
        );

        res.json({
            message: "Profile updated successfully and propagated to all existing posts across all devices."
        });
    } catch (error) {
        console.error("Profile sync error:", error.message);
        res.status(500).json({ message: "Could not sync profile" });
    }
});

// ==========================
// ADMIN - GET ALL USERS
// ==========================
app.get("/users", async (req, res) => {
    try {
        const result = await pool.query("SELECT * FROM users ORDER BY id DESC");
        res.json(result.rows);
    } catch (error) {
        res.status(500).json({ message: "Could not fetch users" });
    }
});

// ==========================
// SIGN UP & LOGIN
// ==========================
app.post("/signup", async (req, res) => {
    const user = req.body;
    try {
        await pool.query(
            `
            INSERT INTO users
            (fullname, email, phone, password, accounttype, location, profession, createdat)
            VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
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
        res.status(201).json({ message: "Account created successfully" });
    } catch (error) {
        console.log(error.message);
        res.status(400).json({ message: "Signup failed. Email may already exist." });
    }
});

app.post("/login", async (req, res) => {
    const { email, password } = req.body;
    try {
        const result = await pool.query("SELECT * FROM users WHERE email=$1", [email]);
        if (result.rows.length === 0) {
            return res.status(404).json({ message: "Account not found" });
        }
        const user = result.rows[0];
        if (user.password !== password) {
            return res.status(401).json({ message: "Incorrect password" });
        }
        res.json({ message: "Login successful", user: user });
    } catch (error) {
        res.status(500).json({ message: "Login error" });
    }
});

// ==========================
// JOB SYSTEM
// ==========================

// CREATE OR UPDATE JOB
app.post("/jobs", async (req, res) => {
    const job = req.body;

    if (!job || !job.id || !job.title) {
        return res.status(400).json({
            message: "Missing required job fields (id, title)"
        });
    }

    try {
        await pool.query(
            `
            INSERT INTO jobs
            (id, user_id, company, title, location, salary, description, attachment, createdat, isnew,
             author_name, author_phone, author_location, author_avatar, author_role, author_skills)
            VALUES
            ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)
            ON CONFLICT (id) DO UPDATE SET
                company = EXCLUDED.company,
                title = EXCLUDED.title,
                location = EXCLUDED.location,
                salary = EXCLUDED.salary,
                description = EXCLUDED.description,
                attachment = EXCLUDED.attachment,
                author_name = EXCLUDED.author_name,
                author_phone = EXCLUDED.author_phone,
                author_location = EXCLUDED.author_location,
                author_avatar = EXCLUDED.author_avatar,
                author_role = EXCLUDED.author_role,
                author_skills = EXCLUDED.author_skills
            `,
            [
                job.id,
                job.userId || job.authorName || job.company || "1",
                job.company || job.authorName || "Anonymous",
                job.title,
                job.location || "",
                job.salary || "",
                job.description || "",
                JSON.stringify(job.attachment || null),
                job.createdAt || new Date().toISOString(),
                !!job.isNew,
                job.authorName || job.company || "Anonymous",
                job.authorPhone || job.phone || "",
                job.authorLocation || job.location || "",
                job.authorAvatar || job.avatar || "",
                job.authorRole || "Jobseeker",
                job.authorSkills || ""
            ]
        );

        res.status(201).json({
            message: "Job saved successfully",
            job: job
        });
    } catch (error) {
        console.log("Job posting error:", error.message);
        res.status(500).json({ message: "Job posting failed" });
    }
});

// GET ALL JOBS (includes like/save/apply/comment state for the requesting user)
app.get("/jobs", async (req, res) => {
    const userId = req.query.userId || "";
    try {
        const result = await pool.query(
            `
            SELECT j.*,
                (SELECT COUNT(*)::int FROM job_likes l WHERE l.job_id = j.id) AS like_count,
                EXISTS(SELECT 1 FROM job_likes l WHERE l.job_id = j.id AND l.user_id = $1) AS liked_by_me,
                (SELECT COUNT(*)::int FROM job_comments c WHERE c.job_id = j.id) AS comment_count,
                EXISTS(SELECT 1 FROM job_saves s WHERE s.job_id = j.id AND s.user_id = $1) AS saved_by_me,
                EXISTS(SELECT 1 FROM job_applications a WHERE a.job_id = j.id AND a.user_id = $1) AS applied_by_me
            FROM jobs j
            ORDER BY j.createdat DESC
            `,
            [userId]
        );

        const jobs = result.rows.map((row) => ({
            id: row.id,
            userId: row.user_id,
            company: row.company,
            title: row.title,
            location: row.location,
            salary: row.salary,
            description: row.description,
            attachment: row.attachment,
            createdAt: row.createdat,
            isNew: row.isnew,
            authorName: row.author_name || row.company,
            authorPhone: row.author_phone,
            authorLocation: row.author_location || row.location,
            authorAvatar: row.author_avatar,
            authorRole: row.author_role,
            authorSkills: row.author_skills,
            likeCount: row.like_count,
            likedByMe: row.liked_by_me,
            commentCount: row.comment_count,
            savedByMe: row.saved_by_me,
            appliedByMe: row.applied_by_me
        }));

        res.json(jobs);
    } catch (error) {
        console.log("Error fetching jobs:", error.message);
        res.status(500).json({ message: "Could not fetch jobs" });
    }
});

// DELETE JOB (cascades related engagement + chat data)
app.delete("/jobs/:id", async (req, res) => {
    const id = req.params.id;
    try {
        await pool.query("DELETE FROM job_likes WHERE job_id=$1", [id]);
        await pool.query("DELETE FROM job_saves WHERE job_id=$1", [id]);
        await pool.query("DELETE FROM job_applications WHERE job_id=$1", [id]);
        await pool.query("DELETE FROM job_comments WHERE job_id=$1", [id]);
        await pool.query("DELETE FROM chat_messages WHERE job_id=$1", [id]);
        await pool.query("DELETE FROM jobs WHERE id=$1", [id]);
        res.json({ message: "Job deleted successfully" });
    } catch (error) {
        res.status(500).json({ message: "Could not delete job" });
    }
});

// ==========================
// LIKES
// ==========================
app.post("/jobs/:id/like", async (req, res) => {
    const jobId = req.params.id;
    const { userId } = req.body;
    if (!userId) return res.status(400).json({ message: "userId is required" });

    try {
        const existing = await pool.query(
            "SELECT 1 FROM job_likes WHERE job_id=$1 AND user_id=$2",
            [jobId, userId]
        );

        let liked;
        if (existing.rows.length > 0) {
            await pool.query("DELETE FROM job_likes WHERE job_id=$1 AND user_id=$2", [jobId, userId]);
            liked = false;
        } else {
            await pool.query(
                "INSERT INTO job_likes (job_id, user_id, createdat) VALUES ($1,$2,$3)",
                [jobId, userId, new Date().toISOString()]
            );
            liked = true;
        }

        const countResult = await pool.query(
            "SELECT COUNT(*)::int AS count FROM job_likes WHERE job_id=$1",
            [jobId]
        );

        res.json({ liked: liked, likeCount: countResult.rows[0].count });
    } catch (error) {
        console.log("Like error:", error.message);
        res.status(500).json({ message: "Could not update like" });
    }
});

// ==========================
// SAVES
// ==========================
app.post("/jobs/:id/save", async (req, res) => {
    const jobId = req.params.id;
    const { userId } = req.body;
    if (!userId) return res.status(400).json({ message: "userId is required" });

    try {
        const existing = await pool.query(
            "SELECT 1 FROM job_saves WHERE job_id=$1 AND user_id=$2",
            [jobId, userId]
        );

        let saved;
        if (existing.rows.length > 0) {
            await pool.query("DELETE FROM job_saves WHERE job_id=$1 AND user_id=$2", [jobId, userId]);
            saved = false;
        } else {
            await pool.query(
                "INSERT INTO job_saves (job_id, user_id, createdat) VALUES ($1,$2,$3)",
                [jobId, userId, new Date().toISOString()]
            );
            saved = true;
        }

        res.json({ saved: saved });
    } catch (error) {
        console.log("Save error:", error.message);
        res.status(500).json({ message: "Could not update save" });
    }
});

app.get("/users/:userId/saved", async (req, res) => {
    const userId = req.params.userId;
    try {
        const result = await pool.query(
            `
            SELECT j.* FROM jobs j
            JOIN job_saves s ON s.job_id = j.id
            WHERE s.user_id = $1
            ORDER BY s.createdat DESC
            `,
            [userId]
        );
        res.json(result.rows.map(mapJobRow));
    } catch (error) {
        console.log("Fetch saved error:", error.message);
        res.status(500).json({ message: "Could not fetch saved jobs" });
    }
});

// ==========================
// APPLICATIONS
// ==========================
app.post("/jobs/:id/apply", async (req, res) => {
    const jobId = req.params.id;
    const { userId } = req.body;
    if (!userId) return res.status(400).json({ message: "userId is required" });

    try {
        const existing = await pool.query(
            "SELECT 1 FROM job_applications WHERE job_id=$1 AND user_id=$2",
            [jobId, userId]
        );

        let applied;
        if (existing.rows.length > 0) {
            await pool.query("DELETE FROM job_applications WHERE job_id=$1 AND user_id=$2", [jobId, userId]);
            applied = false;
        } else {
            await pool.query(
                "INSERT INTO job_applications (job_id, user_id, createdat) VALUES ($1,$2,$3)",
                [jobId, userId, new Date().toISOString()]
            );
            applied = true;
        }

        res.json({ applied: applied });
    } catch (error) {
        console.log("Apply error:", error.message);
        res.status(500).json({ message: "Could not update application" });
    }
});

app.get("/users/:userId/applications", async (req, res) => {
    const userId = req.params.userId;
    try {
        const result = await pool.query(
            `
            SELECT j.*, a.createdat AS applied_at FROM jobs j
            JOIN job_applications a ON a.job_id = j.id
            WHERE a.user_id = $1
            ORDER BY a.createdat DESC
            `,
            [userId]
        );
        res.json(result.rows.map((row) => Object.assign(mapJobRow(row), { appliedAt: row.applied_at })));
    } catch (error) {
        console.log("Fetch applications error:", error.message);
        res.status(500).json({ message: "Could not fetch applications" });
    }
});

// ==========================
// COMMENTS
// ==========================
app.get("/jobs/:id/comments", async (req, res) => {
    const jobId = req.params.id;
    try {
        const result = await pool.query(
            "SELECT * FROM job_comments WHERE job_id=$1 ORDER BY id ASC",
            [jobId]
        );
        res.json(result.rows.map((row) => ({
            id: row.id,
            jobId: row.job_id,
            userId: row.user_id,
            author: row.author_name,
            authorAvatar: row.author_avatar,
            text: row.text,
            createdAt: row.createdat
        })));
    } catch (error) {
        console.log("Fetch comments error:", error.message);
        res.status(500).json({ message: "Could not fetch comments" });
    }
});

app.post("/jobs/:id/comments", async (req, res) => {
    const jobId = req.params.id;
    const { userId, author, authorAvatar, text } = req.body;
    if (!text || !text.trim()) return res.status(400).json({ message: "Comment text is required" });

    try {
        const createdAt = new Date().toISOString();
        const result = await pool.query(
            `
            INSERT INTO job_comments (job_id, user_id, author_name, author_avatar, text, createdat)
            VALUES ($1,$2,$3,$4,$5,$6)
            RETURNING *
            `,
            [jobId, userId || "", author || "Anonymous", authorAvatar || "", text.trim(), createdAt]
        );
        const row = result.rows[0];
        res.status(201).json({
            id: row.id,
            jobId: row.job_id,
            userId: row.user_id,
            author: row.author_name,
            authorAvatar: row.author_avatar,
            text: row.text,
            createdAt: row.createdat
        });
    } catch (error) {
        console.log("Post comment error:", error.message);
        res.status(500).json({ message: "Could not post comment" });
    }
});

// ==========================
// REAL CHAT (Job Seeker <-> Recruiter)
// ==========================
// A conversation is uniquely identified by (jobId, seekerId).
// The recruiter is whoever owns the job (jobs.user_id). Either side can send
// messages into the same thread and both sides poll for new messages.

app.get("/chats/:jobId/:seekerId/messages", async (req, res) => {
    const { jobId, seekerId } = req.params;
    try {
        const result = await pool.query(
            "SELECT * FROM chat_messages WHERE job_id=$1 AND seeker_id=$2 ORDER BY id ASC",
            [jobId, seekerId]
        );
        res.json(result.rows.map(mapMessageRow));
    } catch (error) {
        console.log("Fetch chat messages error:", error.message);
        res.status(500).json({ message: "Could not fetch messages" });
    }
});

app.post("/chats/:jobId/:seekerId/messages", async (req, res) => {
    const { jobId, seekerId } = req.params;
    const { senderId, senderRole, senderName, senderAvatar, text } = req.body;

    if (!senderId || !senderRole || !text || !text.trim()) {
        return res.status(400).json({ message: "senderId, senderRole and text are required" });
    }
    if (senderRole !== "seeker" && senderRole !== "recruiter") {
        return res.status(400).json({ message: "senderRole must be 'seeker' or 'recruiter'" });
    }

    try {
        const createdAt = new Date().toISOString();
        const readBySeeker = senderRole === "seeker";
        const readByRecruiter = senderRole === "recruiter";

        const result = await pool.query(
            `
            INSERT INTO chat_messages
            (job_id, seeker_id, sender_id, sender_role, sender_name, sender_avatar, text, createdat, read_by_seeker, read_by_recruiter)
            VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
            RETURNING *
            `,
            [jobId, seekerId, senderId, senderRole, senderName || "", senderAvatar || "", text.trim(), createdAt, readBySeeker, readByRecruiter]
        );

        res.status(201).json(mapMessageRow(result.rows[0]));
    } catch (error) {
        console.log("Send chat message error:", error.message);
        res.status(500).json({ message: "Could not send message" });
    }
});

// Mark a conversation as read for whichever side is viewing it
app.post("/chats/:jobId/:seekerId/read", async (req, res) => {
    const { jobId, seekerId } = req.params;
    const { role } = req.body;
    if (role !== "seeker" && role !== "recruiter") {
        return res.status(400).json({ message: "role must be 'seeker' or 'recruiter'" });
    }
    try {
        const column = role === "seeker" ? "read_by_seeker" : "read_by_recruiter";
        await pool.query(
            `UPDATE chat_messages SET ${column} = TRUE WHERE job_id=$1 AND seeker_id=$2`,
            [jobId, seekerId]
        );
        res.json({ message: "Marked as read" });
    } catch (error) {
        console.log("Mark read error:", error.message);
        res.status(500).json({ message: "Could not mark as read" });
    }
});

// List every conversation a user is part of, whether they are the job seeker
// or the recruiter (job owner) side of that thread.
app.get("/users/:userId/conversations", async (req, res) => {
    const userId = req.params.userId;
    try {
        const result = await pool.query(
            `
            SELECT DISTINCT cm.job_id, cm.seeker_id
            FROM chat_messages cm
            JOIN jobs j ON j.id = cm.job_id
            WHERE cm.seeker_id = $1 OR j.user_id = $1
            `,
            [userId]
        );

        const conversations = await Promise.all(result.rows.map(async (row) => {
            const jobId = row.job_id;
            const seekerId = row.seeker_id;

            const jobResult = await pool.query("SELECT * FROM jobs WHERE id=$1", [jobId]);
            const job = jobResult.rows[0];
            if (!job) return null;

            const isRecruiter = job.user_id === userId;
            const myRole = isRecruiter ? "recruiter" : "seeker";

            const lastMsgResult = await pool.query(
                "SELECT * FROM chat_messages WHERE job_id=$1 AND seeker_id=$2 ORDER BY id DESC LIMIT 1",
                [jobId, seekerId]
            );
            const lastMsg = lastMsgResult.rows[0];

            const unreadColumn = isRecruiter ? "read_by_recruiter" : "read_by_seeker";
            const unreadResult = await pool.query(
                `SELECT COUNT(*)::int AS count FROM chat_messages WHERE job_id=$1 AND seeker_id=$2 AND ${unreadColumn} = FALSE AND sender_role != $3`,
                [jobId, seekerId, myRole]
            );

            let counterpartName, counterpartAvatar;
            if (isRecruiter) {
                const seekerMsgResult = await pool.query(
                    "SELECT sender_name, sender_avatar FROM chat_messages WHERE job_id=$1 AND seeker_id=$2 AND sender_role='seeker' ORDER BY id DESC LIMIT 1",
                    [jobId, seekerId]
                );
                counterpartName = (seekerMsgResult.rows[0] && seekerMsgResult.rows[0].sender_name) || "Applicant";
                counterpartAvatar = (seekerMsgResult.rows[0] && seekerMsgResult.rows[0].sender_avatar) || "";
            } else {
                counterpartName = job.author_name || job.company;
                counterpartAvatar = job.author_avatar || "";
            }

            return {
                jobId: jobId,
                seekerId: seekerId,
                jobTitle: job.title,
                company: job.company,
                myRole: myRole,
                counterpartName: counterpartName,
                counterpartAvatar: counterpartAvatar,
                lastMessage: lastMsg ? lastMsg.text : "",
                lastSenderRole: lastMsg ? lastMsg.sender_role : "",
                lastAt: lastMsg ? lastMsg.createdat : "",
                unreadCount: unreadResult.rows[0].count
            };
        }));

        const cleaned = conversations.filter(Boolean).sort(function (a, b) {
            return new Date(b.lastAt) - new Date(a.lastAt);
        });

        res.json(cleaned);
    } catch (error) {
        console.log("Fetch conversations error:", error.message);
        res.status(500).json({ message: "Could not fetch conversations" });
    }
});

// ==========================
// Helpers
// ==========================
function mapJobRow(row) {
    return {
        id: row.id,
        userId: row.user_id,
        company: row.company,
        title: row.title,
        location: row.location,
        salary: row.salary,
        description: row.description,
        attachment: row.attachment,
        createdAt: row.createdat,
        isNew: row.isnew,
        authorName: row.author_name || row.company,
        authorPhone: row.author_phone,
        authorLocation: row.author_location || row.location,
        authorAvatar: row.author_avatar,
        authorRole: row.author_role,
        authorSkills: row.author_skills
    };
}

function mapMessageRow(row) {
    return {
        id: row.id,
        jobId: row.job_id,
        seekerId: row.seeker_id,
        senderId: row.sender_id,
        senderRole: row.sender_role,
        senderName: row.sender_name,
        senderAvatar: row.sender_avatar,
        text: row.text,
        createdAt: row.createdat,
        readBySeeker: row.read_by_seeker,
        readByRecruiter: row.read_by_recruiter
    };
}

// ==========================
// START SERVER
// ==========================
app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});