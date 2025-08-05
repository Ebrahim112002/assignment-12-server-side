// index.js
const express = require("express");
const cors = require("cors");
const dotenv = require("dotenv");

dotenv.config();

const app = express();
const port = process.env.PORT || 3000;
// middle were
app.use(cors());
app.use(express.json());













app.get("/", (req, res) => {
  res.send("Matrimonial server is running...");
});

app.listen(port, () => {
  console.log(`Server running on port ${port}`);
});
