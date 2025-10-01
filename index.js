const express = require('express');
const cors = require('cors');
const dotenv = require('dotenv');
const { MongoClient, ServerApiVersion, ObjectId } = require('mongodb');
const multer = require('multer');
const axios = require('axios');
const axiosRetry = require('axios-retry').default;
const FormData = require('form-data');
const admin = require('firebase-admin');
const sharp = require('sharp');

const app = express();
const port = process.env.PORT || 3000;

// Load environment variables
dotenv.config();

// Validate environment variables
const requiredEnvVars = ['FIREBASE_PROJECT_ID', 'FIREBASE_PRIVATE_KEY', 'FIREBASE_CLIENT_EMAIL', 'DB_USER', 'DB_PASS', 'IMGBB_KEY'];
const missingEnvVars = requiredEnvVars.filter((varName) => !process.env[varName]);
if (missingEnvVars.length > 0) {
  console.error(`Missing required environment variables: ${missingEnvVars.join(', ')}`);
  process.exit(1);
}

// Initialize Firebase Admin SDK
try {
  admin.initializeApp({
    credential: admin.credential.cert({
      projectId: process.env.FIREBASE_PROJECT_ID,
      privateKey: process.env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, '\n'),
      clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
    }),
  });
} catch (error) {
  console.error('Failed to initialize Firebase Admin SDK:', error.message);
  process.exit(1);
}

// Middleware
app.use(cors({ origin: 'http://localhost:5173', credentials: true }));
app.use(express.json());

// Multer setup for file uploads
const storage = multer.memoryStorage();
const upload = multer({
  storage,
  limits: { fileSize: 5 * 1024 * 1024 }, // Limit to 5MB
});

// Authentication middleware
const authenticate = async (req, res, next) => {
  const token = req.headers.authorization?.split(' ')[1];
  if (!token) {
    return res.status(401).json({ error: 'Unauthorized: No token provided' });
  }
  try {
    const decoded = await admin.auth().verifyIdToken(token);
    req.user = { email: decoded.email, uid: decoded.uid };
    next();
  } catch (error) {
    console.error('Authentication error:', error.message);
    res.status(401).json({ error: 'Unauthorized: Invalid token', details: error.message });
  }
};

// Admin authorization middleware
const authorizeAdmin = async (req, res, next) => {
  try {
    const user = await client.db('matrimonial').collection('users').findOne({ email: req.user.email });
    if (!user || user.role !== 'admin') {
      return res.status(403).json({ error: 'Forbidden: Admin access required' });
    }
    next();
  } catch (error) {
    console.error('Admin authorization error:', error.message);
    res.status(500).json({ error: 'Failed to verify admin status', details: error.message });
  }
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

    // Configure axios-retry for ImgBB requests
    axiosRetry(axios, {
      retries: 3,
      retryDelay: (retryCount) => axiosRetry.exponentialDelay(retryCount),
      retryCondition: (error) => {
        return axiosRetry.isNetworkOrIdempotentRequestError(error) || error.response?.status >= 500;
      },
    });

    // Upload image to ImgBB
    async function uploadImageToImgBB(imageBuffer) {
      if (!imageBuffer || imageBuffer.length === 0) {
        throw new Error("No image data provided");
      }

      // Validate image format
      let imageInfo;
      try {
        imageInfo = await sharp(imageBuffer).metadata();
        if (!['jpeg', 'png'].includes(imageInfo.format)) {
          throw new Error('Only JPEG and PNG images are supported');
        }
      } catch (err) {
        console.error("❌ Image validation failed:", err.message);
        throw new Error("Invalid image format");
      }

      // Compress image
      let compressedBuffer;
      try {
        compressedBuffer = await sharp(imageBuffer)
          .resize({ width: 1024 })
          .jpeg({ quality: 80 })
          .toBuffer();
        console.log("✅ Image compressed:", compressedBuffer.length, "bytes");
      } catch (err) {
        console.error("❌ Compression failed:", err.message);
        throw new Error("Failed to compress image");
      }

      // Prepare FormData
      const formData = new FormData();
      formData.append('key', process.env.IMGBB_KEY);
      formData.append('image', compressedBuffer, {
        filename: 'image.jpg',
        contentType: 'image/jpeg',
      });

      try {
        const response = await axios.post(
          'https://api.imgbb.com/1/upload',
          formData,
          {
            headers: formData.getHeaders(),
            timeout: 30000,
          }
        );
        console.log("🎉 ImgBB upload successful:", response.data.data.url);
        return response.data.data.url;
      } catch (err) {
        console.error("❌ ImgBB upload failed:", {
          message: err.message,
          response: err.response?.data,
          status: err.response?.status,
        });
        throw new Error(
          `Failed to upload image to ImgBB: ${err.response?.data?.error?.message || err.message}`
        );
      }
    }

    // Create user (only if not exists)
    app.post('/users', authenticate, async (req, res) => {
      try {
        const { name, photoURL, role } = req.body;
        const { email, uid } = req.user;
        if (!email || !uid) {
          return res.status(400).json({ error: 'Email and UID are required' });
        }
        const existingUser = await usersCollection.findOne({ email });
        if (existingUser) {
          return res.status(409).json({ error: 'User already exists' });
        }
        const user = {
          name: name || 'Unnamed User',
          email,
          photoURL: photoURL || '',
          role: role || 'user',
          uid,
          createdAt: new Date(),
          updatedAt: new Date(),
        };
        const result = await usersCollection.insertOne(user);
        res.status(201).json({ message: 'User created successfully', result });
      } catch (error) {
        console.error('Error creating user:', error.message);
        res.status(500).json({ error: 'Failed to create user', details: error.message });
      }
    });

    // Get all users (admin only)
    app.get('/users', authenticate, authorizeAdmin, async (req, res) => {
      try {
        const users = await usersCollection.find().toArray();
        res.json(users);
      } catch (error) {
        console.error('Error fetching users:', error.message);
        res.status(500).json({ error: 'Failed to fetch users', details: error.message });
      }
    });

    // Get user by email (authenticated users can get their own or all if admin)
    app.get('/users/:email', authenticate, async (req, res) => {
      try {
        const email = req.params.email;
        if (!email) {
          return res.status(400).json({ error: 'Email is required' });
        }
        // Allow fetching own user or all if admin
        const userDoc = await usersCollection.findOne({ email });
        if (!userDoc) {
          return res.status(404).json({ error: 'User not found' });
        }
        // If not admin and not own email, forbid
        if (req.user.email !== email) {
          const currentUser = await usersCollection.findOne({ email: req.user.email });
          if (!currentUser || currentUser.role !== 'admin') {
            return res.status(403).json({ error: 'Forbidden: Can only fetch own user data' });
          }
        }
        res.json(userDoc);
      } catch (error) {
        console.error('Error fetching user:', error.message);
        res.status(500).json({ error: 'Failed to fetch user', details: error.message });
      }
    });

    // Update user role (admin only)
    app.patch('/users/:email/role', authenticate, authorizeAdmin, async (req, res) => {
      try {
        const emailToUpdate = req.params.email.toLowerCase();
        const { role } = req.body;

        if (!emailToUpdate) return res.status(400).json({ error: 'Email is required' });
        if (!['admin', 'user'].includes(role)) return res.status(400).json({ error: 'Role must be "admin" or "user"' });

        const userToUpdate = await usersCollection.findOne({ email: emailToUpdate });
        if (!userToUpdate) return res.status(404).json({ error: 'User not found' });

        // Prevent updating your own role
        if (req.user.email.toLowerCase() === emailToUpdate) {
          return res.status(403).json({ error: 'Cannot change your own role' });
        }

        const result = await usersCollection.updateOne(
          { email: emailToUpdate },
          { $set: { role, updatedAt: new Date() } }
        );

        if (result.matchedCount === 0) {
          return res.status(404).json({ error: 'User not found' });
        }

        res.status(200).json({ message: `User role updated to ${role} successfully`, updatedRole: role });
      } catch (err) {
        console.error('Error updating user role:', err.message);
        res.status(500).json({ error: 'Failed to update user role', details: err.message });
      }
    });

    // Success counter
    app.get('/success-counter', async (req, res) => {
      try {
        const success = await success_counters.find().toArray();
        res.json(success);
      } catch (error) {
        console.error('Error fetching success counters:', error.message);
        res.status(500).json({ error: 'Failed to fetch success counters', details: error.message });
      }
    });

    // Get biodata by _id
    app.get('/biodatas/:id', async (req, res) => {
      try {
        const id = req.params.id;
        console.log('Requested _id:', id);

        if (!ObjectId.isValid(id)) {
          return res.status(400).json({ error: `Invalid _id format: ${id}` });
        }

        let member = await membersCollection.findOne({ _id: new ObjectId(id) });

        if (!member) {
          member = await membersCollection.findOne({ _id: id });
        }

        if (!member) {
          const existingDoc = await membersCollection.findOne({ _id: new ObjectId(id) }, { projection: {} });
          if (existingDoc) {
            console.log('Incomplete document found for _id:', id, existingDoc);
            return res.status(404).json({ error: `Incomplete biodata found with _id: ${id}`, document: existingDoc });
          }
          return res.status(404).json({ error: `No biodata found with _id: ${id}` });
        }

        res.json(member);
      } catch (error) {
        console.error(`Error fetching member with _id ${req.params.id}:`, error.message);
        res.status(500).json({ error: 'Failed to fetch member', details: error.message });
      }
    });

    // Get all biodatas or by email
    app.get('/biodatas', async (req, res) => {
      try {
        const email = req.query.email;
        let members;
        if (email) {
          members = await membersCollection.find({ email }).toArray();
        } else {
          members = await membersCollection.find().toArray();
        }
        res.json(members);
      } catch (error) {
        console.error('Error fetching members:', error.message);
        res.status(500).json({ error: 'Failed to fetch members', details: error.message });
      }
    });

    // Create biodata
    app.post('/biodatas', authenticate, upload.single('profileImage'), async (req, res) => {
      try {
        const biodata = req.body;
        const { email } = req.user;

        if (!email) {
          return res.status(400).json({ error: 'Email is required' });
        }

        const existingBiodata = await membersCollection.findOne({ email });
        if (existingBiodata) {
          return res.status(400).json({ error: 'Biodata already exists for this user' });
        }

        if (!req.file) {
          return res.status(400).json({ error: 'Profile image is required' });
        }

        const profileImageURL = await uploadImageToImgBB(req.file.buffer);

        const newBiodata = {
          biodataType: biodata.biodataType || '',
          name: biodata.name || '',
          dob: biodata.dateOfBirth || '',
          height: biodata.height || '',
          weight: biodata.weight || '',
          age: parseInt(biodata.age, 10) || 0,
          occupation: biodata.occupation || '',
          race: biodata.race || '',
          fatherName: biodata.fatherName || '',
          motherName: biodata.motherName || '',
          permanentDivision: biodata.permanentDivision || '',
          presentDivision: biodata.presentDivision || '',
          partnerAge: biodata.expectedPartnerAge || '',
          partnerHeight: biodata.expectedPartnerHeight || '',
          partnerWeight: biodata.expectedPartnerWeight || '',
          contactEmail: biodata.contactEmail || email,
          mobileNumber: biodata.mobileNumber || '',
          maritalStatus: biodata.maritalStatus || '',
          profileImage: profileImageURL,
          email,
          isPremium: false,
          createdAt: new Date(),
          updatedAt: new Date(),
        };

        const result = await membersCollection.insertOne(newBiodata);
        res.status(201).json({
          message: 'Biodata created successfully',
          result,
          updatedBiodata: { _id: result.insertedId.toString(), ...newBiodata },
        });
      } catch (error) {
        console.error('Error creating biodata:', {
          message: error.message,
          stack: error.stack,
        });
        res.status(500).json({ error: 'Failed to create biodata', details: error.message });
      }
    });

    // Update biodata by _id
    app.patch('/biodatas/:id', authenticate, upload.single('profileImage'), async (req, res) => {
      try {
        const id = req.params.id;
        console.log('Requested _id:', id);

        const biodata = req.body;
        const { email } = req.user;

        if (!ObjectId.isValid(id)) {
          return res.status(400).json({ error: 'Invalid _id format' });
        }

        const query = { _id: new ObjectId(id) };
        const existingBiodata = await membersCollection.findOne(query);
        if (!existingBiodata) {
          return res.status(404).json({ error: `No biodata found with _id: ${id}` });
        }

        if (existingBiodata.email !== email) {
          return res.status(403).json({ error: 'Unauthorized: You can only update your own biodata' });
        }

        let profileImageURL = existingBiodata.profileImage;
        if (req.file) {
          try {
            profileImageURL = await uploadImageToImgBB(req.file.buffer);
          } catch (imgError) {
            console.warn('Image upload failed, proceeding with existing image:', imgError.message);
          }
        }

        const updatedBiodata = {
          biodataType: biodata.biodataType || existingBiodata.biodataType || '',
          name: biodata.name || existingBiodata.name || '',
          dob: biodata.dateOfBirth || existingBiodata.dob || '',
          height: biodata.height || existingBiodata.height || '',
          weight: biodata.weight || existingBiodata.weight || '',
          age: parseInt(biodata.age, 10) || existingBiodata.age || 0,
          occupation: biodata.occupation || existingBiodata.occupation || '',
          race: biodata.race || existingBiodata.race || '',
          fatherName: biodata.fatherName || existingBiodata.fatherName || '',
          motherName: biodata.motherName || existingBiodata.motherName || '',
          permanentDivision: biodata.permanentDivision || existingBiodata.permanentDivision || '',
          presentDivision: biodata.presentDivision || existingBiodata.presentDivision || '',
          partnerAge: biodata.expectedPartnerAge || existingBiodata.partnerAge || '',
          partnerHeight: biodata.expectedPartnerHeight || existingBiodata.partnerHeight || '',
          partnerWeight: biodata.expectedPartnerWeight || existingBiodata.partnerWeight || '',
          contactEmail: biodata.contactEmail || existingBiodata.contactEmail || email,
          mobileNumber: biodata.mobileNumber || existingBiodata.mobileNumber || '',
          maritalStatus: biodata.maritalStatus || existingBiodata.maritalStatus || '',
          profileImage: profileImageURL,
          email: existingBiodata.email,
          isPremium: existingBiodata.isPremium || false,
          updatedAt: new Date(),
          createdAt: existingBiodata.createdAt || new Date(),
        };

        const result = await membersCollection.replaceOne(query, updatedBiodata);

        if (result.matchedCount === 0) {
          return res.status(404).json({ error: `No biodata found with _id: ${id}` });
        }

        res.json({
          message: 'Biodata updated successfully',
          result,
          updatedBiodata,
        });
      } catch (error) {
        console.error('Error updating biodata:', {
          message: error.message,
          stack: error.stack,
        });
        res.status(500).json({ error: 'Failed to update biodata', details: error.message });
      }
    });

    // Add to favourites
    app.post('/favourites', authenticate, async (req, res) => {
      try {
        const { biodata_id } = req.body;
        const { email } = req.user;

        if (!biodata_id || typeof biodata_id !== "string") {
          return res.status(400).json({ error: 'Valid biodata_id (string) is required' });
        }

        const existingFavorite = await favouritesCollection.findOne({
          userEmail: email,
          biodata_id: biodata_id,
        });

        if (existingFavorite) {
          return res.status(400).json({ error: 'Biodata already in favorites' });
        }

        const favourite = {
          userEmail: email,
          biodata_id: biodata_id,
          addedAt: new Date(),
        };

        const result = await favouritesCollection.insertOne(favourite);
        res.status(201).json({ message: 'Biodata added to favourites', result });
      } catch (error) {
        console.error('Error adding to favourites:', error.message);
        res.status(500).json({ error: 'Failed to add to favourites', details: error.message });
      }
    });

    // Get user favourites
    app.get('/favourites', async (req, res) => {
      try {
        const { email } = req.query;

        const biodatas = await favouritesCollection.aggregate([
          {
            '$match': {
              'userEmail': email
            }
          }, {
            '$lookup': {
              'from': 'members',
              'localField': 'biodata_id',
              'foreignField': '_id',
              'as': 'biodata'
            }
          }
        ]).toArray();

        res.json(biodatas);
      } catch (error) {
        console.error('Error fetching favourites:', error.message);
        res.status(500).json({ error: 'Failed to fetch favourites', details: error.message });
      }
    });

    app.delete("/favourites/:id", authenticate, async (req, res) => {
      const { id } = req.params;
      const email = req.user.email;

      const result = await favouritesCollection.deleteOne({
        _id: new ObjectId(id),
        userEmail: email,
      });

      if (result.deletedCount === 0) {
        return res.status(404).json({ error: "Favorite not found" });
      }

      res.json({ message: "Favorite removed successfully" });
    });

    // MongoDB ping
    await client.db('admin').command({ ping: 1 });
    console.log('MongoDB connected successfully');
  } catch (error) {
    console.error('MongoDB connection error:', error.message);
    process.exit(1);
  }
}

run().catch((error) => {
  console.error('Failed to start server:', error.message);
  process.exit(1);
});

// Root route
app.get('/', (req, res) => {
  res.send('Love Matrimony server is running...');
});

// Start server
app.listen(port, () => {
  console.log(`Server running on port ${port}`);
});