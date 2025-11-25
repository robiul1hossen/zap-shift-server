const express = require("express");
const cors = require("cors");
require("dotenv").config();
const { MongoClient, ServerApiVersion, ObjectId } = require("mongodb");
const app = express();
const port = process.env.PORT || 3000;

// middleware
app.use(express.json());
app.use(cors());

// mongodbURI
const uri = `mongodb+srv://${process.env.DB_USER}:${process.env.DB_PASS}@cluster0.d2halvx.mongodb.net/?appName=Cluster0`;

//   mongodb connection
const client = new MongoClient(uri, {
  serverApi: {
    version: ServerApiVersion.v1,
    strict: true,
    deprecationErrors: true,
  },
});
async function run() {
  try {
    // Connect the client to the server	(optional starting in v4.7)
    await client.connect();

    // database & collections
    const db = client.db("zap_shift");
    const parcelsCollection = db.collection("parcels");

    // parcels related apis
    app.get("/parcels", async (req, res) => {
      const { email } = req.query;
      const query = {};
      if (email) {
        query.senderEmail = email;
      }
      const options = { sort: { createdAt: -1 } };
      const result = await parcelsCollection.find(query, options).toArray();
      res.send(result);
    });
    app.post("/parcels", async (req, res) => {
      try {
        const newParcel = req.body;
        newParcel.createdAt = new Date();
        const result = await parcelsCollection.insertOne(newParcel);
        res.send(result);
      } catch (error) {
        res.send({ message: error.message });
      }
    });
    app.delete("/parcels/:id", async (req, res) => {
      const { id } = req.params;
      const query = { _id: new ObjectId(id) };
      const result = await parcelsCollection.deleteOne(query);
      res.send(result);
    });
    app.get("/parcels/:id", async (req, res) => {
      const { id } = req.params;
      const query = { _id: new ObjectId(id) };
      const result = await parcelsCollection.findOne(query);
      res.send(result);
    });
    // Send a ping to confirm a successful connection
    await client.db("admin").command({ ping: 1 });
    console.log(
      "Pinged your deployment. You successfully connected to MongoDB!"
    );
  } finally {
    // Ensures that the client will close when you finish/error
    // await client.close();
  }
}
run().catch(console.dir);

app.get("/", (req, res) => {
  res.send("Zap Shift server is running");
});

app.listen(port, () => {
  console.log(`Example app listening on port ${port}`);
});
