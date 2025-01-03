require('dotenv').config(); 
const express = require('express');
const multer = require('multer');
const cors = require('cors');
const path = require('path');
const { Pool } = require('pg');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const admin = require('firebase-admin');

const serviceAccount = {
  type: process.env.FIREBASE_TYPE,
  project_id: process.env.FIREBASE_PROJECT_ID,
  private_key_id: process.env.FIREBASE_PRIVATE_KEY_ID,
  private_key: process.env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, '\n'), // Replace escaped newlines
  client_email: process.env.FIREBASE_CLIENT_EMAIL,
  client_id: process.env.FIREBASE_CLIENT_ID,
  auth_uri: process.env.FIREBASE_AUTH_URI,
  token_uri: process.env.FIREBASE_TOKEN_URI,
  auth_provider_x509_cert_url: process.env.FIREBASE_AUTH_PROVIDER_CERT_URL,
  client_x509_cert_url: process.env.FIREBASE_CLIENT_CERT_URL,
};

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
  storageBucket: 'twitter-app-90521.appspot.com',
});

const app = express();
const upload = multer({ storage: multer.memoryStorage() });
const bucket = admin.storage().bucket();

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

// Create pet
app.post('/upload', upload.single('image'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ success: false, message: 'No file uploaded' });
    }

    const file = req.file; // Multer provides the file in `req.file`
    const blob = bucket.file(`uploads/${Date.now()}_${file.originalname}`); // Unique filename
    const blobStream = blob.createWriteStream({
      metadata: {
        contentType: file.mimetype, // Set the MIME type for the file
      },
    });

    // Pipe the file buffer to Firebase Storage
    blobStream.end(file.buffer);

    blobStream.on('finish', async () => {
      // Generate a public URL
      const publicUrl = `https://storage.googleapis.com/${bucket.name}/${blob.name}`;
      console.log(`File uploaded to ${publicUrl}`);

      return res.status(200).json({
        success: true,
        message: 'File uploaded successfully',
        url: publicUrl,
      });
    });

    blobStream.on('error', (err) => {
      console.error('Upload error:', err);
      res.status(500).json({ success: false, message: 'File upload failed', error: err.message });
    });
  } catch (err) {
    console.error('Unexpected error:', err);
    res.status(500).json({ success: false, message: 'Unexpected error occurred', error: err.message });
  }
});

app.get('/', (req, res) => {
  res.sendFile(path.resolve(__dirname, 'index.html'));
});

const PORT = process.env.PORT || 3010;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
