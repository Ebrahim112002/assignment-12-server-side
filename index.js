const express = require('express');
const cors = require('cors');
const dotenv = require('dotenv');
const { MongoClient, ServerApiVersion, ObjectId } = require('mongodb');

const app = express();
const port = process.env.PORT || 3000;
dotenv.config();

// Middleware
app.use(cors({ origin: 'http://localhost:5173', credentials: true }));
app.use(express.json());

// Placeholder authentication middleware (replace with your actual auth logic)
const authenticate = (req, res, next) => {
  const token = req.headers.authorization?.split(' ')[1];
  if (!token) {
    return res.status(401).json({ error: 'Unauthorized: No token provided' });
  }
  // Example: verify token here (Firebase/JWT)
  next();
};

// MongoDB Connection
const uri = `mongodb+srv://${process.env.DB_USER}:${process.env.DB_PASS}@cluster0.dit9xra.mongodb.net/?retryWrites=true&w=majority&appName=Cluster0`;
const client = new MongoClient(uri, {
  serverApi: {
    version: ServerApiVersion.v1,
    strict: true,
    deprecationErrors: true,
  },
});

async function run() {
  try {
    await client.connect();
    const db = client.db('matrimonial');
    const usersCollection = db.collection('users');
    const membersCollection = db.collection('members');
    const success_counters = db.collection('success_counter');
    const favouritesCollection = db.collection('favourites');

    // Create or update user
    app.post('/users', async (req, res) => {
      try {
        const { name, email, photoURL, role, uid } = req.body;
        if (!email || !uid) {
          return res.status(400).json({ error: 'Email and UID are required' });
        }
        const user = {
          name: name || 'Unnamed User',
          email,
          photoURL: photoURL || '',
          role: role || 'user',
          uid,
        };
        const result = await usersCollection.updateOne(
          { email },
          { $set: user },
          { upsert: true }
        );
        res.status(201).json({ message: 'User created/updated successfully', result });
      } catch (error) {
        console.error('Error creating/updating user:', error);
        res.status(500).json({ error: 'Failed to create/update user' });
      }
    });

    // Get user by email
    app.get('/users/:email', async (req, res) => {
      try {
        const email = req.params.email;
        const user = await usersCollection.findOne({ email });
        if (!user) {
          return res.status(404).json({ error: 'User not found' });
        }
        res.json(user);
      } catch (error) {
        console.error('Error fetching user:', error);
        res.status(500).json({ error: 'Failed to fetch user' });
      }
    });

    // Success counter
    app.get('/success-counter', async (req, res) => {
      try {
        const success = await success_counters.find().toArray();
        res.json(success);
      } catch (error) {
        console.error('Error fetching success counters:', error);
        res.status(500).json({ error: 'Failed to fetch success counters' });
      }
    });

    // Get all members
    app.get('/biodatas', async (req, res) => {
      try {
        const members = await membersCollection.find().toArray();
        res.json(members);
      } catch (error) {
        console.error('Error fetching members:', error);
        res.status(500).json({ error: 'Failed to fetch members' });
      }
    });

    // Get single member by ID (handles both ObjectId and string _id)
    app.get('/biodatas/:id', async (req, res) => {
      try {
        const id = req.params.id;
        console.log("Requested ID:", id);

        let member = null;

        if (ObjectId.isValid(id)) {
          member = await membersCollection.findOne({ _id: new ObjectId(id) });
        }

        // fallback in case _id was stored as string
        if (!member) {
          member = await membersCollection.findOne({ _id: id });
        }

        if (!member) {
          return res.status(404).json({ error: `No member found with ID: ${id}` });
        }

        res.json(member);
      } catch (error) {
        console.error(`Error fetching member with ID ${req.params.id}:`, error);
        res.status(500).json({ error: 'Failed to fetch member', details: error.message });
      }
    });

    // Add to favourites
    app.post('/favourites', authenticate, async (req, res) => {
      try {
        const { userEmail, biodataId } = req.body;
        if (!userEmail || !biodataId) {
          return res.status(400).json({ error: 'User email and biodata ID are required' });
        }

        const favourite = {
          userEmail,
          biodataId: ObjectId.isValid(biodataId) ? new ObjectId(biodataId) : biodataId,
          addedAt: new Date(),
        };

        const result = await favouritesCollection.insertOne(favourite);
        res.status(201).json({ message: 'Biodata added to favourites', result });
      } catch (error) {
        console.error('Error adding to favourites:', error);
        res.status(500).json({ error: 'Failed to add to favourites' });
      }
    });

    // MongoDB ping
    await client.db('admin').command({ ping: 1 });
    console.log('Connected to MongoDB successfully');
  } catch (error) {
    console.error('MongoDB connection error:', error);
  }
}

run().catch(console.dir);

// Root route
app.get('/', (req, res) => {
  res.send('Love Matrimony server is running...');
});

// Start server
app.listen(port, () => {
  console.log(`Server running on port ${port}`);
});
