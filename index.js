require('dotenv').config(); 
const express = require('express');
const cors = require('cors');
const path = require('path');
const { Pool } = require('pg');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');

const app = express();

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
  const { firstName, lastName, phoneNumber, email, password } = req.body;

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
      'INSERT INTO users (first_name, last_name, phone_number, email, password) VALUES ($1, $2, $3, $4, $5) RETURNING id',
      [firstName, lastName, phoneNumber, email, hashedPassword]
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

app.get('/', (req, res) => {
  res.sendFile(path.resolve(__dirname, 'index.html'));
});

const PORT = process.env.PORT || 3010;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
