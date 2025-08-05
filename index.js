const express = require('express');
const cors = require('cors');
const dotenv = require('dotenv');
const { MongoClient, ServerApiVersion } = require('mongodb');

const app = express();
const port = process.env.PORT || 3000;
dotenv.config();

// Middleware
app.use(cors({ origin: 'http://localhost:5173', credentials: true }));
app.use(express.json());

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

    // Create or update user
    app.post('/users', async (req, res) => {
      try {
        const { name, email, photoURL, role, uid } = req.body;
        if (!email || !uid) {
          return res.status(400).json({ error: 'Email and UID are required' });
        }
        const user = { name: name || 'Unnamed User', email, photoURL: photoURL || '', role: role || 'user', uid };
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

    await client.db('admin').command({ ping: 1 });
    console.log('Connected to MongoDB successfully');
  } catch (error) {
    console.error('MongoDB connection error:', error);
  }
}
run().catch(console.dir);

// Root route
app.get('/', (req, res) => {
  res.send('Matrimonial server is running...');
});

// Start server
app.listen(port, () => {
  console.log(`Server running on port ${port}`);
});
