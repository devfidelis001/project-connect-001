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

        // Automatically patch schema for existing "users" tables that predate
        // newer profile columns (this is what the admin dashboard's
        // "Total Registered Users" query selects, so a missing column here
        // makes GET /users throw and the count silently stays at 0)
        await pool.query(`
            ALTER TABLE users
            ADD COLUMN IF NOT EXISTS phone TEXT,
            ADD COLUMN IF NOT EXISTS accounttype TEXT,
            ADD COLUMN IF NOT EXISTS location TEXT,
            ADD COLUMN IF NOT EXISTS profession TEXT,
            ADD COLUMN IF NOT EXISTS skills TEXT,
            ADD COLUMN IF NOT EXISTS avatar TEXT,
            ADD COLUMN IF NOT EXISTS createdat TEXT,
            ADD COLUMN IF NOT EXISTS suspended BOOLEAN DEFAULT FALSE;
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
            job_id TEXT,
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

        // ==========================
        // Conversations used to be keyed by (job_id, seeker_id), which meant a
        // recruiter and a job seeker got a brand new, empty thread for every
        // single job post they messaged about. A conversation is really
        // between two PEOPLE, so it's now keyed by (recruiter_id, seeker_id)
        // instead - recruiter_id is whoever owned the job at the time the
        // message was sent. job_id is kept on each message only as optional
        // context (which job the message was about / for the "View Tagged
        // Job" link), not as part of the thread's identity.
        // ==========================
        await pool.query(`
            ALTER TABLE chat_messages
            ADD COLUMN IF NOT EXISTS recruiter_id TEXT;
        `);
        await pool.query(`ALTER TABLE chat_messages ALTER COLUMN job_id DROP NOT NULL;`);

        // Backfill recruiter_id for any pre-existing rows from the job they
        // were sent about, so old conversations keep working under the new
        // (recruiter_id, seeker_id) key instead of disappearing.
        await pool.query(`
            UPDATE chat_messages cm
            SET recruiter_id = j.user_id
            FROM jobs j
            WHERE cm.job_id = j.id AND cm.recruiter_id IS NULL
        `);

        await pool.query(`CREATE INDEX IF NOT EXISTS idx_chat_messages_thread ON chat_messages (recruiter_id, seeker_id);`);

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
        // 1. Update the REAL user record for this account. The frontend's
        // account id is either "acct-<email>" (the normal case for anyone who
        // signed up through index.html) or a plain numeric users.id - so we
        // have to resolve it the same way resolveUserRow() does, rather than
        // parseInt-ing an "acct-..." string (which is always NaN and used to
        // silently fall back to writing over users.id = 1 for everyone).
        const idStr = String(userId);
        let updateResult;

        if (idStr.startsWith("acct-")) {
            const email = idStr.slice(5).trim().toLowerCase();
            updateResult = await pool.query(
                `
                UPDATE users SET
                    fullname = $1,
                    phone = $2,
                    location = $3,
                    skills = $4,
                    accounttype = $5,
                    avatar = $6
                WHERE LOWER(email) = $7
                `,
                [name || "Anonymous", phone || "", location || "", skills || "", role || "Jobseeker", avatar || "", email]
            );
            if (updateResult.rowCount === 0 && email) {
                // No signup row exists for this email yet (shouldn't normally
                // happen) - create one so the profile has somewhere to live.
                await pool.query(
                    `
                    INSERT INTO users (fullname, email, phone, location, skills, accounttype, avatar, createdat)
                    VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
                    ON CONFLICT (email) DO UPDATE SET
                        fullname = EXCLUDED.fullname,
                        phone = EXCLUDED.phone,
                        location = EXCLUDED.location,
                        skills = EXCLUDED.skills,
                        accounttype = EXCLUDED.accounttype,
                        avatar = EXCLUDED.avatar
                    `,
                    [name || "Anonymous", email, phone || "", location || "", skills || "", role || "Jobseeker", avatar || "", new Date().toISOString()]
                );
            }
        } else if (!isNaN(parseInt(idStr, 10))) {
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
                [parseInt(idStr, 10), name || "Anonymous", phone || "", location || "", skills || "", role || "Jobseeker", avatar || "", new Date().toISOString()]
            );
        }
        // Any other id shape (e.g. a special built-in account with no real
        // signup row) has nothing in `users` to update - the jobs cascade
        // below still applies to it via the raw userId, which is all that
        // kind of account actually needs.

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
        const result = await pool.query(
            "SELECT id, fullname, email, phone, accounttype, location, profession, skills, avatar, createdat, suspended FROM users ORDER BY id DESC"
        );
        // Map raw DB columns to the field names the admin dashboard expects,
        // and never send the password column back to the client.
        const users = result.rows.map((row) => ({
            id: row.id,
            name: row.fullname,
            email: row.email,
            phone: row.phone,
            role: row.accounttype,
            location: row.location,
            profession: row.profession,
            skills: row.skills,
            avatar: row.avatar,
            createdAt: row.createdat,
            suspended: !!row.suspended
        }));
        res.json(users);
    } catch (error) {
        console.log("Fetch users error:", error.message);
        res.status(500).json({ message: "Could not fetch users" });
    }
});

// ==========================
// USER SEARCH (find people, not just job posts)
// ==========================
// Lets the app search for a person by name, profession/role, skills, or
// location - even if they've never posted a job. Only public-safe fields are
// returned (no email, no password).
app.get("/users/search", async (req, res) => {
    const q = (req.query.q || "").trim();
    if (!q) return res.json([]);

    try {
        const like = "%" + q + "%";
        const result = await pool.query(
            `
            SELECT id, fullname, email, phone, accounttype, location, profession, skills, avatar
            FROM users
            WHERE fullname ILIKE $1
               OR profession ILIKE $1
               OR skills ILIKE $1
               OR location ILIKE $1
               OR accounttype ILIKE $1
            ORDER BY fullname ASC
            LIMIT 30
            `,
            [like]
        );

        // IMPORTANT: every other part of the app (jobs, likes, applications,
        // chat messages) identifies a person by "acct-<email>", not by the
        // numeric users.id primary key. Returning row.id here used to hand
        // the frontend a completely different id space, so messaging or
        // viewing a profile from search results never matched that same
        // person's real posts/likes/applications/chats. Build the id the
        // same way the rest of the app does.
        const people = result.rows.map((row) => ({
            id: row.email ? ("acct-" + row.email.trim().toLowerCase()) : row.id,
            name: row.fullname,
            phone: row.phone,
            role: row.accounttype,
            location: row.location,
            profession: row.profession,
            skills: row.skills,
            avatar: row.avatar
        }));

        res.json(people);
    } catch (error) {
        console.log("User search error:", error.message);
        res.status(500).json({ message: "Could not search users" });
    }
});

// ==========================
// PUBLIC PROFILE (single user, live data)
// ==========================
// Used when a profile picture/name is clicked anywhere in the app, so what's
// shown always reflects the person's CURRENT profile rather than whatever
// was copied onto a post the last time they published it.
app.get("/users/:userId/public-profile", async (req, res) => {
    const userId = req.params.userId;
    try {
        const userRow = await resolveUserRow(userId);
        if (userRow) {
            return res.json({
                id: userId,
                name: userRow.fullname,
                phone: userRow.phone,
                location: userRow.location,
                role: userRow.accounttype,
                profession: userRow.profession,
                skills: userRow.skills,
                avatar: userRow.avatar,
                source: "profile"
            });
        }

        // No formal account row (e.g. this device never called /users/profile) -
        // fall back to the most recent job they posted so we still show
        // something sensible instead of an empty profile.
        const jobResult = await pool.query(
            "SELECT * FROM jobs WHERE user_id=$1 ORDER BY createdat DESC LIMIT 1",
            [userId]
        );
        const job = jobResult.rows[0];
        if (!job) {
            return res.status(404).json({ message: "User not found" });
        }
        res.json({
            id: userId,
            name: job.author_name || job.company,
            phone: job.author_phone,
            location: job.author_location || job.location,
            role: job.author_role,
            profession: "",
            skills: job.author_skills,
            avatar: job.author_avatar,
            source: "job"
        });
    } catch (error) {
        console.log("Fetch public profile error:", error.message);
        res.status(500).json({ message: "Could not fetch profile" });
    }
});

// All jobs a user has POSTED (their real post history, not a DOM guess by name)
app.get("/users/:userId/posts", async (req, res) => {
    const userId = req.params.userId;
    const viewerId = req.query.viewerId || "";
    try {
        const result = await pool.query(
            `
            SELECT j.*,
                (SELECT COUNT(*)::int FROM job_likes l WHERE l.job_id = j.id) AS like_count,
                EXISTS(SELECT 1 FROM job_likes l WHERE l.job_id = j.id AND l.user_id = $2) AS liked_by_me,
                (SELECT COUNT(*)::int FROM job_comments c WHERE c.job_id = j.id) AS comment_count,
                EXISTS(SELECT 1 FROM job_saves s WHERE s.job_id = j.id AND s.user_id = $2) AS saved_by_me,
                EXISTS(SELECT 1 FROM job_applications a WHERE a.job_id = j.id AND a.user_id = $2) AS applied_by_me
            FROM jobs j
            WHERE j.user_id = $1
            ORDER BY j.createdat DESC
            `,
            [userId, viewerId]
        );
        res.json(result.rows.map((row) => ({
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
        })));
    } catch (error) {
        console.log("Fetch user posts error:", error.message);
        res.status(500).json({ message: "Could not fetch user's posts" });
    }
});

// All jobs a user has LIKED
app.get("/users/:userId/liked", async (req, res) => {
    const userId = req.params.userId;
    const viewerId = req.query.viewerId || "";
    try {
        const result = await pool.query(
            `
            SELECT j.*,
                (SELECT COUNT(*)::int FROM job_likes l2 WHERE l2.job_id = j.id) AS like_count,
                EXISTS(SELECT 1 FROM job_likes l2 WHERE l2.job_id = j.id AND l2.user_id = $2) AS liked_by_me,
                (SELECT COUNT(*)::int FROM job_comments c WHERE c.job_id = j.id) AS comment_count,
                EXISTS(SELECT 1 FROM job_saves s WHERE s.job_id = j.id AND s.user_id = $2) AS saved_by_me,
                EXISTS(SELECT 1 FROM job_applications a WHERE a.job_id = j.id AND a.user_id = $2) AS applied_by_me
            FROM jobs j
            JOIN job_likes l ON l.job_id = j.id
            WHERE l.user_id = $1
            ORDER BY l.createdat DESC
            `,
            [userId, viewerId]
        );
        res.json(result.rows.map((row) => Object.assign(mapJobRow(row), {
            likeCount: row.like_count,
            likedByMe: row.liked_by_me,
            commentCount: row.comment_count,
            savedByMe: row.saved_by_me,
            appliedByMe: row.applied_by_me
        })));
    } catch (error) {
        console.log("Fetch liked error:", error.message);
        res.status(500).json({ message: "Could not fetch liked jobs" });
    }
});

// ==========================
// ADMIN - DELETE USER (cascades related data + owned jobs)
// ==========================
app.delete("/users/:id", async (req, res) => {
    const userId = req.params.id;

    try {
        const userRow = await resolveUserRow(userId);
        if (!userRow) {
            return res.status(404).json({ message: "User not found" });
        }

        // The frontend tags likes/saves/applications/comments/jobs/chats with
        // whichever id format it was using at the time ("acct-<email>" from
        // home.html, or the raw numeric id), so we clean up every format that
        // could point at this same account - otherwise deleted users leave
        // orphaned posts/comments/likes behind.
        const keys = deviceKeysForUser(userRow);

        await pool.query("DELETE FROM job_likes WHERE user_id = ANY($1)", [keys]);
        await pool.query("DELETE FROM job_saves WHERE user_id = ANY($1)", [keys]);
        await pool.query("DELETE FROM job_applications WHERE user_id = ANY($1)", [keys]);
        await pool.query("DELETE FROM job_comments WHERE user_id = ANY($1)", [keys]);
        await pool.query(
            "DELETE FROM chat_messages WHERE seeker_id = ANY($1) OR sender_id = ANY($1) OR recruiter_id = ANY($1)",
            [keys]
        );

        // Remove any jobs this user posted, along with engagement/chat tied to those jobs
        const ownedJobs = await pool.query("SELECT id FROM jobs WHERE user_id = ANY($1)", [keys]);
        for (const row of ownedJobs.rows) {
            const jobId = row.id;
            await pool.query("DELETE FROM job_likes WHERE job_id=$1", [jobId]);
            await pool.query("DELETE FROM job_saves WHERE job_id=$1", [jobId]);
            await pool.query("DELETE FROM job_applications WHERE job_id=$1", [jobId]);
            await pool.query("DELETE FROM job_comments WHERE job_id=$1", [jobId]);
            await pool.query("UPDATE chat_messages SET job_id=NULL WHERE job_id=$1", [jobId]);
        }
        await pool.query("DELETE FROM jobs WHERE user_id = ANY($1)", [keys]);

        // Finally remove the user record itself
        await pool.query("DELETE FROM users WHERE id=$1", [userRow.id]);

        res.json({ message: "User deleted successfully" });
    } catch (error) {
        console.log("Delete user error:", error.message);
        res.status(500).json({ message: "Could not delete user" });
    }
});

// ==========================
// ADMIN - SUSPEND / UNSUSPEND USER
// ==========================
// A suspended user stays logged in and can still browse, like posts, and
// receive messages, but is blocked (both here on the server and in the
// frontend UI) from posting jobs, commenting, applying, and sending chat
// messages. See the suspension checks on those routes below.
app.patch("/users/:id/suspend", async (req, res) => {
    const userId = req.params.id;
    const { suspended } = req.body;

    if (typeof suspended !== "boolean") {
        return res.status(400).json({ message: "suspended (true/false) is required" });
    }

    try {
        const userRow = await resolveUserRow(userId);
        if (!userRow) {
            return res.status(404).json({ message: "User not found" });
        }

        const result = await pool.query(
            "UPDATE users SET suspended=$1 WHERE id=$2 RETURNING id, suspended",
            [suspended, userRow.id]
        );

        res.json({
            message: suspended ? "User suspended successfully" : "User unsuspended successfully",
            id: result.rows[0].id,
            suspended: result.rows[0].suspended
        });
    } catch (error) {
        console.log("Suspend user error:", error.message);
        res.status(500).json({ message: "Could not update suspension status" });
    }
});

// ==========================
// SESSION STATUS CHECK
// ==========================
// Polled periodically by the frontend so a deleted account is logged off
// immediately, and a suspended account gets its restrictions applied, without
// waiting for the person to refresh or re-login. Accepts either an email or
// the "acct-<email>" id the frontend keeps in localStorage.
app.get("/session-status/:userKey", async (req, res) => {
    try {
        const userRow = await resolveUserRow(req.params.userKey);
        if (!userRow) {
            return res.json({ exists: false, suspended: false });
        }
        res.json({
            exists: true,
            suspended: !!userRow.suspended,
            id: userRow.id,
            name: userRow.fullname,
            email: userRow.email
        });
    } catch (error) {
        console.log("Session status error:", error.message);
        // Fail open on server errors so a transient DB hiccup can't log
        // everyone out - only an explicit "exists: false" forces a logout.
        res.status(500).json({ message: "Could not check session status" });
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
        const authorRow = await resolveUserRow(job.userId);
        if (authorRow && authorRow.suspended) {
            return res.status(403).json({ message: "Your account is suspended. You can't post jobs right now." });
        }

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
        // A conversation now belongs to the two people, not to one job post, so
        // deleting the job shouldn't wipe out the chat history between them -
        // just clear the reference to this job on any message that tagged it.
        await pool.query("UPDATE chat_messages SET job_id=NULL WHERE job_id=$1", [id]);
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
        const applicantRow = await resolveUserRow(userId);
        if (applicantRow && applicantRow.suspended) {
            return res.status(403).json({ message: "Your account is suspended. You can't apply to jobs right now." });
        }

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
    const viewerId = req.query.viewerId || "";
    try {
        const result = await pool.query(
            `
            SELECT j.*, a.createdat AS applied_at,
                (SELECT COUNT(*)::int FROM job_likes l WHERE l.job_id = j.id) AS like_count,
                EXISTS(SELECT 1 FROM job_likes l WHERE l.job_id = j.id AND l.user_id = $2) AS liked_by_me,
                (SELECT COUNT(*)::int FROM job_comments c WHERE c.job_id = j.id) AS comment_count,
                EXISTS(SELECT 1 FROM job_saves s WHERE s.job_id = j.id AND s.user_id = $2) AS saved_by_me,
                EXISTS(SELECT 1 FROM job_applications a2 WHERE a2.job_id = j.id AND a2.user_id = $2) AS applied_by_me
            FROM jobs j
            JOIN job_applications a ON a.job_id = j.id
            WHERE a.user_id = $1
            ORDER BY a.createdat DESC
            `,
            [userId, viewerId]
        );
        res.json(result.rows.map((row) => Object.assign(mapJobRow(row), {
            appliedAt: row.applied_at,
            likeCount: row.like_count,
            likedByMe: row.liked_by_me,
            commentCount: row.comment_count,
            savedByMe: row.saved_by_me,
            appliedByMe: row.applied_by_me
        })));
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
        const commenterRow = await resolveUserRow(userId);
        if (commenterRow && commenterRow.suspended) {
            return res.status(403).json({ message: "Your account is suspended. You can't comment right now." });
        }

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
// A conversation is uniquely identified by (recruiterId, seekerId) - the two
// PEOPLE talking - not by which job post they happened to be discussing. So
// if a seeker messages the same recruiter about three different job posts,
// it's the same thread with the full history, not three separate empty
// chats. Each message can still optionally carry a jobId, purely as context
// for what was being discussed / for the "View Tagged Job" link - it no
// longer decides which thread the message belongs to.

app.get("/chats/:recruiterId/:seekerId/messages", async (req, res) => {
    const { recruiterId, seekerId } = req.params;
    try {
        const result = await pool.query(
            "SELECT * FROM chat_messages WHERE recruiter_id=$1 AND seeker_id=$2 ORDER BY id ASC",
            [recruiterId, seekerId]
        );
        res.json(result.rows.map(mapMessageRow));
    } catch (error) {
        console.log("Fetch chat messages error:", error.message);
        res.status(500).json({ message: "Could not fetch messages" });
    }
});

app.post("/chats/:recruiterId/:seekerId/messages", async (req, res) => {
    const { recruiterId, seekerId } = req.params;
    const { senderId, senderRole, senderName, senderAvatar, text, jobId } = req.body;

    if (!senderId || !senderRole || !text || !text.trim()) {
        return res.status(400).json({ message: "senderId, senderRole and text are required" });
    }
    if (senderRole !== "seeker" && senderRole !== "recruiter") {
        return res.status(400).json({ message: "senderRole must be 'seeker' or 'recruiter'" });
    }

    try {
        const senderRow = await resolveUserRow(senderId);
        if (senderRow && senderRow.suspended) {
            return res.status(403).json({ message: "Your account is suspended. You can't send messages right now." });
        }

        const createdAt = new Date().toISOString();
        const readBySeeker = senderRole === "seeker";
        const readByRecruiter = senderRole === "recruiter";

        const result = await pool.query(
            `
            INSERT INTO chat_messages
            (job_id, recruiter_id, seeker_id, sender_id, sender_role, sender_name, sender_avatar, text, createdat, read_by_seeker, read_by_recruiter)
            VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
            RETURNING *
            `,
            [jobId || null, recruiterId, seekerId, senderId, senderRole, senderName || "", senderAvatar || "", text.trim(), createdAt, readBySeeker, readByRecruiter]
        );

        res.status(201).json(mapMessageRow(result.rows[0]));
    } catch (error) {
        console.log("Send chat message error:", error.message);
        res.status(500).json({ message: "Could not send message" });
    }
});

// Mark a conversation as read for whichever side is viewing it
app.post("/chats/:recruiterId/:seekerId/read", async (req, res) => {
    const { recruiterId, seekerId } = req.params;
    const { role } = req.body;
    if (role !== "seeker" && role !== "recruiter") {
        return res.status(400).json({ message: "role must be 'seeker' or 'recruiter'" });
    }
    try {
        const column = role === "seeker" ? "read_by_seeker" : "read_by_recruiter";
        await pool.query(
            `UPDATE chat_messages SET ${column} = TRUE WHERE recruiter_id=$1 AND seeker_id=$2`,
            [recruiterId, seekerId]
        );
        res.json({ message: "Marked as read" });
    } catch (error) {
        console.log("Mark read error:", error.message);
        res.status(500).json({ message: "Could not mark as read" });
    }
});

// Delete an entire conversation between two people
app.delete("/chats/:recruiterId/:seekerId", async (req, res) => {
    const { recruiterId, seekerId } = req.params;
    try {
        await pool.query(
            "DELETE FROM chat_messages WHERE recruiter_id=$1 AND seeker_id=$2",
            [recruiterId, seekerId]
        );
        res.json({ message: "Conversation deleted successfully" });
    } catch (error) {
        console.log("Delete conversation error:", error.message);
        res.status(500).json({ message: "Could not delete conversation" });
    }
});

// List every conversation a user is part of, whether they are the job seeker
// or the recruiter side of that thread. One row per (recruiter, seeker) pair,
// however many job posts they've discussed together.
app.get("/users/:userId/conversations", async (req, res) => {
    const userId = req.params.userId;
    try {
        const result = await pool.query(
            `
            SELECT DISTINCT recruiter_id, seeker_id
            FROM chat_messages
            WHERE seeker_id = $1 OR recruiter_id = $1
            `,
            [userId]
        );

        const conversations = await Promise.all(result.rows.map(async (row) => {
            const recruiterId = row.recruiter_id;
            const seekerId = row.seeker_id;
            if (!recruiterId || !seekerId) return null;

            const isRecruiter = recruiterId === userId;
            const myRole = isRecruiter ? "recruiter" : "seeker";

            const lastMsgResult = await pool.query(
                "SELECT * FROM chat_messages WHERE recruiter_id=$1 AND seeker_id=$2 ORDER BY id DESC LIMIT 1",
                [recruiterId, seekerId]
            );
            const lastMsg = lastMsgResult.rows[0];

            // Most recently referenced job, just to show a label like "Applied
            // for: X" - the thread itself isn't scoped to it.
            const lastJobResult = await pool.query(
                `SELECT j.* FROM chat_messages cm JOIN jobs j ON j.id = cm.job_id
                 WHERE cm.recruiter_id=$1 AND cm.seeker_id=$2 AND cm.job_id IS NOT NULL
                 ORDER BY cm.id DESC LIMIT 1`,
                [recruiterId, seekerId]
            );
            const lastJob = lastJobResult.rows[0];

            const distinctJobsResult = await pool.query(
                `SELECT COUNT(DISTINCT job_id)::int AS count FROM chat_messages
                 WHERE recruiter_id=$1 AND seeker_id=$2 AND job_id IS NOT NULL`,
                [recruiterId, seekerId]
            );
            const distinctJobCount = distinctJobsResult.rows[0].count;

            const unreadColumn = isRecruiter ? "read_by_recruiter" : "read_by_seeker";
            const unreadResult = await pool.query(
                `SELECT COUNT(*)::int AS count FROM chat_messages WHERE recruiter_id=$1 AND seeker_id=$2 AND ${unreadColumn} = FALSE AND sender_role != $3`,
                [recruiterId, seekerId, myRole]
            );

            let counterpartName, counterpartAvatar;
            if (isRecruiter) {
                const seekerMsgResult = await pool.query(
                    "SELECT sender_name, sender_avatar FROM chat_messages WHERE recruiter_id=$1 AND seeker_id=$2 AND sender_role='seeker' ORDER BY id DESC LIMIT 1",
                    [recruiterId, seekerId]
                );
                counterpartName = (seekerMsgResult.rows[0] && seekerMsgResult.rows[0].sender_name) || "Applicant";
                counterpartAvatar = (seekerMsgResult.rows[0] && seekerMsgResult.rows[0].sender_avatar) || "";
            } else {
                const recruiterProfile = await resolveUserRow(recruiterId);
                if (recruiterProfile) {
                    counterpartName = recruiterProfile.fullname;
                    counterpartAvatar = recruiterProfile.avatar || "";
                } else {
                    counterpartName = (lastJob && (lastJob.author_name || lastJob.company)) || "Recruiter";
                    counterpartAvatar = (lastJob && lastJob.author_avatar) || "";
                }
            }

            return {
                recruiterId: recruiterId,
                seekerId: seekerId,
                jobId: lastJob ? lastJob.id : "",
                jobTitle: lastJob ? (distinctJobCount > 1 ? lastJob.title + " (+" + (distinctJobCount - 1) + " more)" : lastJob.title) : "",
                company: lastJob ? lastJob.company : "",
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

// The frontend sends two different shapes of "user id" depending on where the
// request comes from:
//   - the admin dashboard user list uses the numeric `users.id` primary key
//   - the main app (home.html) uses a string like "acct-<email>" for every
//     like/comment/application/job/chat message it sends
// This resolves either shape back to the real row in `users`, so suspension
// checks and account deletion work no matter which id format was sent.
async function resolveUserRow(rawId) {
    if (!rawId) return null;
    const idStr = String(rawId);
    if (idStr.startsWith("acct-")) {
        const email = idStr.slice(5).trim().toLowerCase();
        if (!email) return null;
        const result = await pool.query("SELECT * FROM users WHERE LOWER(email)=$1", [email]);
        return result.rows[0] || null;
    }
    if (!isNaN(parseInt(idStr, 10))) {
        const result = await pool.query("SELECT * FROM users WHERE id=$1", [idStr]);
        return result.rows[0] || null;
    }
    // Fall back to treating it as an email
    const result = await pool.query("SELECT * FROM users WHERE LOWER(email)=$1", [idStr.trim().toLowerCase()]);
    return result.rows[0] || null;
}

// Every "acct-<email>" style id that the frontend could have used for this
// specific user, so cascading deletes/suspension checks catch rows saved
// under that format even though the users table itself is keyed by numeric id.
function deviceKeysForUser(userRow) {
    const keys = [];
    if (!userRow) return keys;
    keys.push(String(userRow.id));
    if (userRow.email) keys.push("acct-" + String(userRow.email).trim().toLowerCase());
    return keys;
}

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
        recruiterId: row.recruiter_id,
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