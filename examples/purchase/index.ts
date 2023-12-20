import { Resonate, Context } from "../../lib/resonate";
import express, { Request, Response } from "express";

type User = {
  id: number;
};

type Song = {
  id: number;
  price: number;
};

type Status = {
  charged: boolean;
  granted: boolean;
};

async function purchase(ctx: Context, user: User, song: Song): Promise<Status> {
  const charged = await ctx.run(charge, user, song);
  const granted = await ctx.run(access, user, song);

  return { charged, granted };
}

async function charge(ctx: Context, user: User, song: Song): Promise<boolean> {
  console.log(`Charged user:${user.id} $${song.price}.`);
  return true;
}

async function access(ctx: Context, user: User, song: Song): Promise<boolean> {
  console.log(`Granted user:${user.id} access to song:${song.id}.`);
  return true;
}

// Initialize Resonate app
const resonate = new Resonate({url: "http://0.0.0.0:8001"});
resonate.register("purchase", purchase);

// Initialize Express app
const app = express();
app.use(express.json())

app.post("/purchase", async (req: Request, res: Response) => {
  const user = { id: req.body?.user ?? 1 };
  const song = { id: req.body?.song ?? 1, price: 1.99 };

  // id uniquely identifies the purchase
  const id = `purchase-${user.id}-${song.id}`;

  try {
    res.send(await resonate.run("purchase", id, user, song));
  } catch (err) {
    console.error(err);
    res.status(500).send("Could not purchase song");
  }
});

app.listen(3000, () => {
  console.log("Listening on port 3000");
});