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
      'SELECT id, email, password, is_admin FROM users WHERE email = $1',
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

    res.json({ token, user: { id: user.id, email: user.email, is_admin: user.is_admin } });
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
          expires: "03-01-2500",
        });

        const { name, species, breed, gender, age, description, status } = req.body;

        // Insert the new pet and immediately return breed_name
        const query = `
          INSERT INTO pets (name, species, breed, gender, age, description, status, image_url)
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
          RETURNING id;
        `;
        const values = [name, species, breed, gender, age, description, status, publicUrl];

        const result = await pool.query(query, values);
        const newPetId = result.rows[0].id;

        // Fetch pet with breed_name
        const fetchQuery = `
          SELECT 
            pets.id,
            pets.name,
            pets.species,
            pets.breed AS breed_id,
            COALESCE(dog_breeds.breed, cat_breeds.breed) AS breed_name,
            pets.gender,
            pets.age,
            pets.description,
            pets.status,
            pets.image_url,
            pets.created_at
          FROM pets
          LEFT JOIN dog_breeds ON pets.species = 'Dog' AND dog_breeds.id = pets.breed::integer
          LEFT JOIN cat_breeds ON pets.species = 'Cat' AND cat_breeds.id = pets.breed::integer
          WHERE pets.id = $1;
        `;

        const petResult = await pool.query(fetchQuery, [newPetId]);

        res.status(201).json({ success: true, data: petResult.rows[0] });
      } catch (error) {
        console.error(error);
        res.status(500).json({ success: false, message: "Error creating pet", error: error.message });
      }
    });

    blobStream.end(file.buffer);
  } catch (error) {
    console.error(error);
    res.status(500).json({ success: false, message: "Unexpected error", error: error.message });
  }
});

// READ all pets
app.get('/pets', async (req, res) => {
  const { status } = req.query;
  try {
    let query = `
      SELECT 
        pets.id,
        pets.name,
        pets.species,
        pets.breed AS breed_id,
        COALESCE(dog_breeds.breed, cat_breeds.breed) AS breed_name,
        pets.gender,
        pets.age,
        pets.description,
        pets.status,
        pets.image_url,
        pets.created_at
      FROM pets
      LEFT JOIN dog_breeds ON pets.species = 'Dog' AND dog_breeds.id = pets.breed::integer
      LEFT JOIN cat_breeds ON pets.species = 'Cat' AND cat_breeds.id = pets.breed::integer
    `;

    // If `status` query param is provided, filter by status
    if (status !== undefined) {
      query += ` WHERE pets.status = $1`;
    }

    const result = await pool.query(query, status !== undefined ? [status] : []);

    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, message: 'No pets found' });
    }

    res.status(200).json({ success: true, data: result.rows });
  } catch (error) {
    console.error(error);
    res.status(500).json({ success: false, message: 'Error fetching pets' });
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
  const { id } = req.query;

  try {
    const query = `
      SELECT 
          applications.id,
          applications.user_id,
          applications.pet_id,
          applications.experience,
          applications.work_schedule,
          applications.time_commitment,
          applications.living_situation,
          applications.outdoor_space,
          applications.travel_frequency,
          applications.household_members,
          applications.pet_allergies,
          applications.pet_types_cared_for,
          applications.pet_training,
          applications.adoption_reason,
          applications.status,

          -- User details
          users.first_name,
          users.last_name,
          users.country_code,
          users.phone_number,
          users.email,

          -- Pet details
          pets.name AS pet_name,
          pets.species,
          pets.gender,
          pets.age,

          -- Breed name via JOIN instead of subquery
          COALESCE(dog_breeds.breed, cat_breeds.breed) AS breed_name

      FROM applications
      JOIN users ON applications.user_id = users.id
      JOIN pets ON applications.pet_id = pets.id
      LEFT JOIN dog_breeds ON pets.species = 'Dog' AND dog_breeds.id = pets.breed::integer
      LEFT JOIN cat_breeds ON pets.species = 'Cat' AND cat_breeds.id = pets.breed::integer
      ${id ? "WHERE applications.user_id = $1" : ""}
    `;

    const values = id ? [id] : [];

    const result = await pool.query(query, values);

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
        pet_allergies, pet_types_cared_for, pet_training, adoption_reason, status, created_at, updated_at
      ) VALUES (
        $1, $2, $3, $4, $5, 
        $6, $7, $8, $9, 
        $10, $11, $12, $13, $14, $15, $16
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
        0,
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
    res.status(500).json({ error: 'An error occurred while processing your application.', message: error.message });
  }
});


// UPDATE Application Status
app.put('/applications/:id/status', async (req, res) => {
  const { id } = req.params;
  const { status, petId } = req.body;

  // Validate the status
  if (![1, 0, -1].includes(status)) {
    return res.status(400).json({
      success: false,
      error: 'Invalid status. Use 1 for Approved, 0 for Pending, or -1 for Rejected.',
    });
  }

  try {

    const result = await pool.query(
      `
      UPDATE applications
      SET status = $1, updated_at = NOW()
      WHERE id = $2
      RETURNING *;
      `,
      [status, id]
    );

    if (status === 1) {
      await pool.query(
        `UPDATE pets SET status = 2 WHERE id = $1;`,
        [petId]
      );
    } else if (status === -1) {
      await pool.query(
        `UPDATE pets SET status = 1 WHERE id = $1;`,
        [petId]
      );
    }

    if (result.rowCount === 0) {
      return res.status(404).json({ success: false, error: 'Application not found.' });
    }

    res.json({
      success: true,
      message: `Application status updated successfully.`,
      application: result.rows[0],
    });
  } catch (error) {
    console.error('Error updating application status:', error);
    res.status(500).json({ success: false, error: 'An error occurred while updating the application status.' });
  }
});


// DELETE an application by ID
app.delete('/applications/:id', async (req, res) => {
  const { id } = req.params;

  try {
    const result = await pool.query('DELETE FROM applications WHERE id = $1;', [id]);
    if (result.rowCount === 0) {
      return res.status(404).json({ success: false, message: 'Application not found' });
    }
    res.status(200).json({ success: true, message: 'Application deleted successfully' });
  } catch (error) {
    console.error(error);
    res.status(500).json({ success: false, message: 'Error deleting application' });
  }
});

app.get('/', (req, res) => {
  res.sendFile(path.resolve(__dirname, 'index.html'));
});

const PORT = process.env.PORT || 3010;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
