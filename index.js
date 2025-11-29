const express = require("express");
const cors = require("cors");
require("dotenv").config();
const { MongoClient, ServerApiVersion, ObjectId } = require("mongodb");
const stripe = require("stripe")(process.env.STRIPE_SECRET);
const crypto = require("crypto");

const admin = require("firebase-admin");

const serviceAccount = require("./zap-shift-firebase-adminsdk.json");

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
});

const app = express();
const port = process.env.PORT || 3000;

// generate tracking id
const generateTrackingId = () => {
  const prefix = "ZAP";
  const date = new Date().toISOString().slice(0, 10).replace(/-/g, "");
  const random = crypto.randomBytes(3).toString("hex").toUpperCase();
  return `${prefix}-${date}-${random}`;
};

// middleware
app.use(express.json());
app.use(cors());

const verifyFBToken = async (req, res, next) => {
  const token = req.headers.authorization;
  // console.log(token);
  if (!token) {
    res.status(401).send({ message: "unauthorize access" });
  }
  try {
    const tokenId = token.split(" ")[1];
    const decoded = await admin.auth().verifyIdToken(tokenId);
    req.decoded_email = decoded.email;
    next();
  } catch (error) {
    return res.status(401).send({ message: "unauthorize access" });
  }
};

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

    const verifyAdmin = async (req, res, next) => {
      const email = req.decoded_email;
      const query = { email };
      const user = await usersCollection.findOne(query);
      console.log(user);
      if (user.role !== "admin") {
        res.status(403).send({ message: "forbidden access" });
      }

      next();
    };

    // database & collections
    const db = client.db("zap_shift");
    const usersCollection = db.collection("users");
    const parcelsCollection = db.collection("parcels");
    const paymentsCollection = db.collection("payments");
    const ridersCollection = db.collection("riders");

    // users related apis
    app.get("/users", async (req, res) => {
      const result = await usersCollection.find().toArray();
      res.send(result);
    });
    app.get("/users/:id", async (req, res) => {});
    app.get("/users/:email/role", async (req, res) => {
      const email = req.params.email;
      const query = { email };
      const result = await usersCollection.findOne(query);
      res.send({ role: result?.role || "user" });
    });
    app.post("/users", async (req, res) => {
      const user = req.body;
      user.role = "user";
      const email = user.email;
      const isExistUser = await usersCollection.findOne({ email });
      if (isExistUser) {
        return res.send({ message: "user already exist" });
      }
      const result = await usersCollection.insertOne(user);
      res.send(result);
    });
    app.patch(
      "/users/:id/role",
      verifyFBToken,
      verifyAdmin,
      async (req, res) => {
        const { id } = req.params;
        const updatedInfo = req.body;
        const query = { _id: new ObjectId(id) };
        const updateUserRole = {
          $set: { role: updatedInfo.role },
        };
        const result = await usersCollection.updateOne(query, updateUserRole);
        res.send(result);
      }
    );

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

    // payment related apis
    app.post("/create-payment-session", async (req, res) => {
      const paymentInfo = req.body;
      const amount = parseInt(paymentInfo.price) * 100;
      const session = await stripe.checkout.sessions.create({
        line_items: [
          {
            price_data: {
              currency: "USD",
              unit_amount: amount,
              product_data: {
                name: paymentInfo.parcelName,
              },
            },
            quantity: 1,
          },
        ],
        metadata: {
          parcelId: paymentInfo.parcelId,
          parcelName: paymentInfo.parcelName,
        },
        customer_email: paymentInfo.senderEmail,
        mode: "payment",
        success_url: `${process.env.SITE_DOMAIN}/dashboard/payment-success?session_id={CHECKOUT_SESSION_ID}`,
        cancel_url: `${process.env.SITE_DOMAIN}/dashboard/payment-cancelled`,
      });
      res.send({ url: session.url });
    });
    app.patch("/verify-payment", async (req, res) => {
      const sessionId = req.query.session_id;
      const session = await stripe.checkout.sessions.retrieve(sessionId);
      // console.log(session);
      if (session.payment_status === "paid") {
        const id = session.metadata.parcelId;
        const query = { _id: new ObjectId(id) };
        const trackingId = generateTrackingId();
        const update = {
          $set: {
            paymentStatus: "paid",
            trackingId: trackingId,
          },
        };
        const result = await parcelsCollection.updateOne(query, update);
        const transactionId = session.payment_intent;
        const paymentQuery = { transactionId: transactionId };
        const isPaymentExist = await paymentsCollection.findOne(paymentQuery);
        if (isPaymentExist) {
          return res.send({
            message: "payment already exist",
            isPaymentExist,
          });
        }

        const payment = {
          price: session.amount_total / 100,
          currency: session.currency,
          customerEmail: session.customer_email,
          parcelId: session.metadata.parcelId,
          parcelName: session.metadata.parcelName,
          transactionId: session.payment_intent,
          paymentStatus: session.payment_status,
          trackingId: trackingId,
          paidAt: new Date(),
        };
        if (session.payment_status === "paid") {
          const paymentResult = await paymentsCollection.insertOne(payment);
          res.send({
            status: true,
            modifyParcel: result,
            paymentInfo: paymentResult,
            trackingId: generateTrackingId(),
            transactionId: session.payment_intent,
          });
        }
      }

      // res.send({ success: false });
    });
    app.get("/payment", verifyFBToken, async (req, res) => {
      const { email } = req.query;
      const query = {};
      console.log(req.headers);
      if (email) {
        query.customerEmail = email;
        if (email !== req.decoded_email) {
          return res.status(403).send({ message: "forbidden access" });
        }
      }
      const result = await paymentsCollection.find(query).toArray();
      res.send(result);
    });

    // riders related apis
    app.get("/riders", async (req, res) => {
      const query = {};
      if (req.query.status) {
        query.status = req.query.status;
      }
      const result = await ridersCollection.find(query).toArray();
      res.send(result);
    });
    app.post("/riders", async (req, res) => {
      const rider = req.body;
      rider.status = "pending";
      rider.createdAt = new Date();
      const result = await ridersCollection.insertOne(rider);
      res.send(result);
    });
    app.patch("/riders/:id", verifyFBToken, async (req, res) => {
      const { status } = req.body;
      const { id } = req.params;
      const query = { _id: new ObjectId(id) };
      const update = {
        $set: {
          status: status,
        },
      };
      const result = await ridersCollection.updateOne(query, update);
      if (status === "approved") {
        const email = req.body.email;
        const userQuery = { email };
        const updateUser = {
          $set: {
            role: "rider",
          },
        };
        const updateUserResult = await usersCollection.updateOne(
          userQuery,
          updateUser
        );
        res.send(updateUserResult);
      }
      res.send(result);
    });
    // TODO delete user role api

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
