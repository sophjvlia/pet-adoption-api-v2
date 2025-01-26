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

// Test Firestore
app.get('/verify-firestore', async (req, res) => {
  try {
    const db = admin.firestore();
    const testCollection = db.collection('test');
    const snapshot = await testCollection.limit(1).get();

    if (snapshot.empty) {
      res.json({ success: true, message: 'Firestore is connected but no documents found in "test" collection' });
    } else {
      res.json({ success: true, message: 'Firestore is connected', documents: snapshot.docs.map(doc => doc.data()) });
    }
  } catch (error) {
    console.error('Error accessing Firestore:', error);
    res.status(500).json({ success: false, message: error.message });
  }
});

// SIGN UP
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

// LOG IN
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
      return res.status(400).json({ error: 'Wrong email/password' });
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

// GET dog breeds
app.get('/dog/breeds', async (req, res) => {
  const client = await pool.connect();
  
  try {
    const result = await client.query(
      'SELECT * FROM dog_breeds'
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, message: 'Dog breeds not found' });
    }
    res.status(200).json({ success: true, data: result.rows });
  } catch (error) {
    console.error(error);
    res.status(500).json({ success: false, message: 'Error fetching pet' });
  }
});

// GET cat breeds
app.get('/cat/breeds', async (req, res) => {
  const client = await pool.connect();

  try {
    const result = await client.query(
      'SELECT * FROM cat_breeds'
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, message: 'Cat breeds not found' });
    }
    res.status(200).json({ success: true, data: result.rows });
  } catch (error) {
    console.error(error);
    res.status(500).json({ success: false, message: 'Error fetching pet' });
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

        const { name, species, breed, gender, age, description, status } = req.body;

        const query = `
          INSERT INTO pets (name, species, breed, gender, age, description, status, image_url)
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
          RETURNING *;
        `;
        const values = [name, species, breed, gender, age, description, status, publicUrl];

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

// READ all pets
app.get('/pets', async (req, res) => {
  try {
    const query = `
      SELECT 
        pets.id,
        pets.name,
        pets.species,
        pets.breed AS breed_id,
        CASE 
          WHEN pets.species = 'Dog' THEN (SELECT breed FROM dog_breeds WHERE dog_breeds.id = pets.breed::integer)
          WHEN pets.species = 'Cat' THEN (SELECT breed FROM cat_breeds WHERE cat_breeds.id = pets.breed::integer)
          ELSE NULL
        END AS breed_name,
        pets.gender,
        pets.age,
        pets.description,
        pets.status,
        pets.image_url,
        pets.created_at
      FROM pets;
    `;
    const result = await pool.query(query);
    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, message: 'Pet not found' });
    }
    res.status(200).json({ success: true, data: result.rows });
  } catch (error) {
    console.error(error);
    res.status(500).json({ success: false, message: 'Error fetching pet' });
  }
});

// READ a single pet by ID
app.get('/pets/:id', async (req, res) => {
  const { id } = req.params;

  try {
    const query = `
      SELECT 
        pets.id,
        pets.name,
        pets.species,
        pets.breed AS breed_id,
        CASE 
          WHEN pets.species = 'Dog' THEN (SELECT breed FROM dog_breeds WHERE dog_breeds.id = pets.breed::integer)
          WHEN pets.species = 'Cat' THEN (SELECT breed FROM cat_breeds WHERE cat_breeds.id = pets.breed::integer)
          ELSE NULL
        END AS breed_name,
        pets.gender,
        pets.age,
        pets.description,
        pets.status,
        pets.image_url,
        pets.created_at
      FROM pets
      WHERE pets.id = $1;
    `;
    const result = await pool.query(query, [id]);
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
  const { name, species, breed, gender, age, description, status } = req.body;

  try {
    let imageUrl = req.body.image;

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
      SET name = $1, species = $2, breed = $3, gender = $4, age = $5, description = $6, status = $7, image_url = $8
      WHERE id = $9
      RETURNING *;
    `;
    const values = [name, species, breed, gender, age, description, status, imageUrl, id];

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

// READ all applications
app.get('/applications', async (req, res) => {
  try {
    const query = `
      SELECT * FROM applications;
    `;
    const result = await pool.query(query);
    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, message: 'Applications not found' });
    }
    res.status(200).json({ success: true, data: result.rows });
  } catch (error) {
    console.error(error);
    res.status(500).json({ success: false, message: 'Error fetching applications' });
  }
});

// CREATE application
app.post('/application', async (req, res) => {
  const {
    user_id,
    pet_id,
    adoptionReason,       
    livingSituation,      
    experience,          
    householdMembers,     
    workSchedule,         
    petTypesCaredFor,    
    travelFrequency,      
    timeCommitment,      
    outdoorSpace,         
    petAllergies,        
    petTraining,          
    petPreferences,       
  } = req.body;

  // Validate required fields
  if (
    !user_id ||
    !pet_id ||
    !adoptionReason ||
    !livingSituation ||
    !experience ||
    !householdMembers ||
    !workSchedule
  ) {
    return res.status(400).json({ error: 'All required fields must be provided.' });
  }

  try {
    // Insert the new application into the database
    const result = await pool.query(
      `
      INSERT INTO applications (
        user_id, pet_id, experience, work_schedule, time_commitment, 
        living_situation, outdoor_space, travel_frequency, household_members, 
        pet_allergies, pet_types_cared_for, pet_training, adoption_reason, created_at, updated_at
      ) VALUES (
        $1, $2, $3, $4, $5, 
        $6, $7, $8, $9, 
        $10, $11, $12, $13, $14, $15
      ) RETURNING *;
      `,
      [
        user_id, 
        pet_id, 
        experience,
        workSchedule,
        timeCommitment, 
        livingSituation, 
        outdoorSpace, 
        travelFrequency || null, 
        householdMembers, 
        petAllergies || null, 
        petTypesCaredFor || null,
        petTraining || null, 
        adoptionReason,
        new Date(), 
        new Date(), 
      ]
    );

    // Respond with the newly created application
    const newApplication = result.rows[0];
    res.status(201).json({
      message: 'Application submitted successfully.',
      application: newApplication,
    });
  } catch (error) {
    console.error('Error inserting application:', error);
    res.status(500).json({ error: 'An error occurred while processing your application.' });
  }
});


// UPDATE Application Status
app.put('/applications/:id/status', (req, res) => {
  const { id } = req.params;
  const { status } = req.body; 

  const application = applications.find((app) => app.id === parseInt(id));

  if (!application) {
    return res.status(404).json({ error: 'Application not found.' });
  }

  if (status !== 1 && status !== 0) {
    return res.status(400).json({ error: 'Invalid status. Use 1 for Approved or 0 for Rejected.' });
  }

  application.status = status;
  application.updated_at = new Date();

  const statusText = status === 1 ? 'Approved' : 'Rejected';
  res.json({ message: `Application ${statusText} successfully.`, application });
});

app.get('/', (req, res) => {
  res.sendFile(path.resolve(__dirname, 'index.html'));
});

const PORT = process.env.PORT || 3010;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
