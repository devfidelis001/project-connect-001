require("dotenv").config();

const express = require("express");
const cors = require("cors");
const { Pool } = require("pg");

const app = express();

const PORT = process.env.PORT || 3000;


// ==========================
// Middleware
// ==========================

app.use(express.json());
app.use(cors());


// ==========================
// PostgreSQL Connection
// ==========================

const pool = new Pool({

    connectionString: process.env.DATABASE_URL,

    ssl: {
        rejectUnauthorized:false
    }

});


// ==========================
// Create Database Tables
// ==========================

async function createTables(){

    try{


        await pool.query(`

        CREATE TABLE IF NOT EXISTS users(

            id SERIAL PRIMARY KEY,

            fullname TEXT NOT NULL,

            email TEXT UNIQUE NOT NULL,

            phone TEXT,

            password TEXT,

            accountType TEXT,

            location TEXT,

            profession TEXT,

            createdAt TEXT

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

            createdAt TEXT,

            isNew BOOLEAN

        )

        `);



        console.log("Database tables ready");


    }catch(error){

        console.log("Database error:",error.message);

    }

}


createTables();
// ==========================
// BASIC ROUTES
// ==========================


app.get("/", (req,res)=>{

    res.send("YOUR LABOUR MARKET BACKEND IS RUNNING");

});



app.get("/api/status",(req,res)=>{

    res.json({

        status:"Online",

        message:"Your Labour Market API is working"

    });

});



// ==========================
// ADMIN - GET ALL USERS
// ==========================


app.get("/users", async(req,res)=>{

    try{

        const result = await pool.query(
            "SELECT * FROM users ORDER BY id DESC"
        );


        res.json(result.rows);


    }catch(error){


        res.status(500).json({

            message:"Could not fetch users"

        });


    }

});
// ==========================
// SIGN UP SYSTEM
// ==========================


app.post("/signup", async(req,res)=>{

    const user = req.body;


    try{


        await pool.query(

        `

        INSERT INTO users

        (
            fullname,
            email,
            phone,
            password,
            accountType,
            location,
            profession,
            createdAt
        )


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

            message:"Account created successfully"

        });



    }catch(error){


        console.log(error.message);


        res.status(400).json({

            message:"Signup failed. Email may already exist."

        });


    }


});
// ==========================
// LOGIN SYSTEM
// ==========================


app.post("/login", async(req,res)=>{

    const {email,password} = req.body;


    try{


        const result = await pool.query(

            "SELECT * FROM users WHERE email=$1",

            [email]

        );



        if(result.rows.length === 0){

            return res.status(404).json({

                message:"Account not found"

            });

        }



        const user = result.rows[0];



        if(user.password !== password){

            return res.status(401).json({

                message:"Incorrect password"

            });

        }



        res.json({

            message:"Login successful",

            user:user

        });



    }catch(error){


        res.status(500).json({

            message:"Login error"

        });


    }


});
// ==========================
// JOB SYSTEM
// ==========================


// CREATE JOB

app.post("/jobs", async(req,res)=>{

    const job = req.body;


    try{


        await pool.query(

        `

        INSERT INTO jobs

        (
            id,
            company,
            title,
            location,
            salary,
            description,
            attachment,
            createdAt,
            isNew
        )


        VALUES

        ($1,$2,$3,$4,$5,$6,$7,$8,$9)

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



        res.status(201).json({

            message:"Job posted successfully",

            job:job

        });



    }catch(error){


        console.log(error.message);


        res.status(500).json({

            message:"Job posting failed"

        });


    }


});




// GET ALL JOBS

app.get("/jobs", async(req,res)=>{


    try{


        const result = await pool.query(

            "SELECT * FROM jobs ORDER BY createdAt DESC"

        );


        res.json(result.rows);



    }catch(error){


        res.status(500).json({

            message:"Could not fetch jobs"

        });


    }


});




// DELETE JOB

app.delete("/jobs/:id", async(req,res)=>{


    const id = req.params.id;


    await pool.query(

        "DELETE FROM jobs WHERE id=$1",

        [id]

    );



    res.json({

        message:"Job deleted successfully"

    });


});




// ==========================
// START SERVER
// ==========================

app.listen(PORT,()=>{

    console.log(`Server running on port ${PORT}`);

});

