require('dotenv').config(); 
const express = require('express');
const multer = require('multer');
const cors = require('cors');
const path = require('path');
const { Pool } = require('pg');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const admin = require('firebase-admin');

// Decode the Base64-encoded service account
const base64EncodedServiceAccount = process.env.BASE64_ENCODED_SERVICE_ACCOUNT;

if (!base64EncodedServiceAccount) {
  throw new Error('BASE64_ENCODED_SERVICE_ACCOUNT environment variable is missing');
}

const serviceAccount = JSON.parse(Buffer.from(base64EncodedServiceAccount, 'base64').toString('utf8'));

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
  storageBucket: 'twitter-app-90521.appspot.com',
});

const app = express();
const upload = multer({ storage: multer.memoryStorage() });

app.use(cors({
  origin: '*',
  methods: ['GET', 'POST', 'PUT', 'DELETE'],
  allowedHeaders: ['Content-Type', 'Authorization']
}));
app.use(express.json());

// Initialize Pool
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: {
    rejectUnauthorized: false,
  },
});

async function getPostgresVersion() {
  const client = await pool.connect();

  try {
    const res = await client.query('SELECT version()');
    console.log(res.rows[0]);
  } finally {
    client.release();
  }
};

getPostgresVersion();

// Signup
app.post('/signup', async (req, res) => {
  const client = await pool.connect();
  const { firstName, lastName, countryCode, phoneNumber, email, password } = req.body;

  try {
    const existingUser = await client.query(
      'SELECT id, email FROM users WHERE email = $1',
      [email]
    );

    if (existingUser.rows.length > 0) {
      return res.status(400).json('User already exists');
    }

    const saltRounds = 10;
    const hashedPassword = await bcrypt.hash(password, saltRounds);

    const result = await client.query(
      'INSERT INTO users (first_name, last_name, country_code, phone_number, email, password) VALUES ($1, $2, $3, $4, $5, $6) RETURNING id',
      [firstName, lastName, countryCode, phoneNumber, email, hashedPassword]
    );
    const user = result.rows[0];

    res.status(200).json({
      message: 'User created successfully',
      user: user,
    });
  } catch (error) {
    console.error('Error registering user:', error);
    res.status(500).json({ error: 'Registration failed', details: error.message });
  }
});

// Login
app.post('/login', async (req, res) => {
  const client = await pool.connect();
  const { email, password } = req.body;

  try {
    const result = await client.query(
      'SELECT id, email, password FROM users WHERE email = $1',
      [email]
    );
    const user = result.rows[0];

    if (!user) {
      return res.status(400).json({ error: 'User not found' });
    }

    const isMatch = await bcrypt.compare(password, user.password);

    if (!isMatch) {
      return res.status(400).json({ error: 'Wrong password' });
    }

    const token = jwt.sign({ id: user.id, email: user.email }, process.env.JWT_SECRET, {
      expiresIn: '1h',
    });

    res.json({ token, user: { id: user.id, email: user.email } });
  } catch (error) {
    console.error('Error logging in:', error);
    res.status(500).json({ error: 'Login failed', details: error.message });
  }
});

// CREATE a new pet
app.post('/pets', upload.single('image'), async (req, res) => {
  try {
    // File upload logic
    const file = req.file; 
    
    if (!file) {
      return res.status(400).json({ success: false, message: "No file uploaded" });
    }

    const bucket = admin.storage().bucket();
    const blob = bucket.file(`uploads/${Date.now()}_${file.originalname}`);
    const blobStream = blob.createWriteStream({
      resumable: true,
      metadata: {
        contentType: file.mimetype,
      },
    });

    blobStream.on("error", (err) => {
      console.error(err);
      res.status(500).json({ success: false, message: "File upload failed", error: err.message });
    });

    blobStream.on("finish", async () => {
      try {
        // Generate a public URL
        const [publicUrl] = await blob.getSignedUrl({
          action: "read",
          expires: "03-01-2500", // Long-term expiry date
        });

        const { name, age, breed, gender, description, status } = req.body;

        const query = `
          INSERT INTO pets (name, age, breed, gender, description, status, image_url)
          VALUES ($1, $2, $3, $4, $5, $6, $7)
          RETURNING *;
        `;
        const values = [name, age, breed, gender, description, status, publicUrl];

        const result = await pool.query(query, values);

        res.status(201).json({ success: true, data: result.rows[0] });
      } catch (error) {
        console.error(error);
        res.status(500).json({ success: false, message: "Error creating pet", error: error.message });
      }
    });

    // Start the upload
    blobStream.end(file.buffer);
  } catch (error) {
    console.error(error);
    res.status(500).json({ success: false, message: "Unexpected error", error: error.message });
  }
});

// READ a single pet by ID
app.get('/pets/:id', async (req, res) => {
  const { id } = req.params;

  try {
    const result = await pool.query('SELECT * FROM pets WHERE id = $1;', [id]);
    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, message: 'Pet not found' });
    }
    res.status(200).json({ success: true, data: result.rows[0] });
  } catch (error) {
    console.error(error);
    res.status(500).json({ success: false, message: 'Error fetching pet' });
  }
});

// UPDATE a pet by ID
app.put('/pets/:id', upload.single('image'), async (req, res) => {
  const { id } = req.params;
  const { name, age, breed, gender, description, status } = req.body;

  try {
    let imageUrl = req.body.image_url;

    if (req.file) {
      const file = req.file;

      const bucket = admin.storage().bucket();
      const blob = bucket.file(`uploads/${Date.now()}_${file.originalname}`);
      const blobStream = blob.createWriteStream({
        resumable: true,
        metadata: {
          contentType: file.mimetype,
        },
      });

      blobStream.on("error", (err) => {
        console.error(err);
        return res.status(500).json({ success: false, message: "File upload failed", error: err.message });
      });

      const uploadPromise = new Promise((resolve, reject) => {
        blobStream.on("finish", async () => {
          try {
            const [publicUrl] = await blob.getSignedUrl({
              action: "read",
              expires: "03-01-2500", // Long-term expiry date
            });
            resolve(publicUrl);
          } catch (error) {
            console.error(error);
            reject(error);
          }
        });
        blobStream.end(file.buffer);
      });

      imageUrl = await uploadPromise;
    }

    const query = `
      UPDATE pets
      SET name = $1, age = $2, breed = $3, gender = $4, description = $5, status = $6, image_url = $7
      WHERE id = $8
      RETURNING *;
    `;
    const values = [name, age, breed, gender, description, status, imageUrl, id];

    const result = await pool.query(query, values);

    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, message: 'Pet not found' });
    }
    
    res.status(200).json({ success: true, data: result.rows[0] });
  } catch (error) {
    console.error(error);
    res.status(500).json({ success: false, message: 'Error updating pet', error: error.message });
  }
});

// DELETE a pet by ID
app.delete('/pets/:id', async (req, res) => {
  const { id } = req.params;

  try {
    const result = await pool.query('DELETE FROM pets WHERE id = $1;', [id]);
    if (result.rowCount === 0) {
      return res.status(404).json({ success: false, message: 'Pet not found' });
    }
    res.status(200).json({ success: true, message: 'Pet deleted successfully' });
  } catch (error) {
    console.error(error);
    res.status(500).json({ success: false, message: 'Error deleting pet' });
  }
});

app.get('/', (req, res) => {
  res.sendFile(path.resolve(__dirname, 'index.html'));
});

const PORT = process.env.PORT || 3010;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
